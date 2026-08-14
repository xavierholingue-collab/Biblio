/* =========================================================================
   PAGINATION DES OUVRAGES

   S'EXÉCUTE SUR LE VPS. Lit /etc/biblio/env, jamais affiché.
   Le loger dans /opt/outils : /opt/biblio-api est écrasé à chaque livraison.

   DEUX SOURCES, TROIS ISSUES — même discipline que pour les couvertures.

     trouvee     — une pagination est connue, elle est enregistrée ;
     absente     — les deux sources ont répondu, aucune ne l'a ;
     injoignable — le réseau a échoué, ou le service a refusé. RIEN n'est
                   écrit : marquer « absente » sur un incident réseau
                   condamnerait l'ouvrage à ne plus jamais être cherché.

   CE QU'ON NE FAIT PAS
   On n'estime pas. Ni zéro, ni moyenne du rayon, ni fourchette d'après le
   format. Une pagination inventée serait indiscernable d'une pagination
   mesurée, et fausserait tous les totaux sans que rien ne le signale.

   USAGE
     node vps-pages.mjs              # mesure seule, n'écrit rien
     node vps-pages.mjs --appliquer
     node vps-pages.mjs --appliquer --limite 40
   ========================================================================= */

import fs from "node:fs";
import pg from "pg";

const APPLIQUER = process.argv.includes("--appliquer");
const iLim = process.argv.indexOf("--limite");
const LIMITE = iLim > -1 ? Number(process.argv[iLim + 1]) : Infinity;
const ENVF = process.env.ENVF ?? "/etc/biblio/env";

function lireEnv(f) {
  if (!fs.existsSync(f)) { console.error(`  ECHEC ${f} introuvable.`); process.exit(1); }
  const env = {};
  for (const l of fs.readFileSync(f, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = lireEnv(ENVF);
const CLE_GOOGLE = env.CLE_GOOGLE_BOOKS ?? "";

const bd = new pg.Pool({
  host: env.PGHOST ?? "127.0.0.1", port: Number(env.PGPORT ?? 5432),
  user: env.PGUSER ?? "biblio", password: env.PGPASSWORD,
  database: env.PGDATABASE ?? "biblio", max: 2,
});

const pause = ms => new Promise(r => setTimeout(r, ms));

async function avecDelai(url, ms) {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), ms);
  try { return await fetch(url, { signal: stop.signal }); }
  finally { clearTimeout(t); }
}

/* Une pagination plausible. Un ouvrage de 3 pages est une notice, un ouvrage
   de 15 000 une erreur de saisie du catalogue. Les deux fausseraient les
   totaux ; mieux vaut les traiter comme inconnus. */
const plausible = n => Number.isInteger(n) && n >= 8 && n <= 5000;

async function googleBooks(isbn) {
  if (!CLE_GOOGLE) return { issue: "injoignable", detail: "pas de clef Google" };
  const url = "https://www.googleapis.com/books/v1/volumes?q=isbn:"
    + encodeURIComponent(isbn) + "&key=" + encodeURIComponent(CLE_GOOGLE);
  try {
    const r = await avecDelai(url, 15000);
    if (r.status === 429 || r.status === 403) return { issue: "injoignable", detail: "quota " + r.status };
    if (!r.ok) return { issue: "injoignable", detail: "HTTP " + r.status };
    const d = await r.json();
    const n = d.items?.[0]?.volumeInfo?.pageCount;
    if (!plausible(n)) return { issue: "absente", detail: n === undefined ? "" : "valeur " + n };
    return { issue: "trouvee", pages: n };
  } catch (e) {
    return { issue: "injoignable", detail: e.name === "AbortError" ? "délai dépassé" : e.message };
  }
}

async function openLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}`
    + "&format=json&jscmd=data";
  try {
    const r = await avecDelai(url, 15000);
    if (!r.ok) return { issue: "injoignable", detail: "HTTP " + r.status };
    const d = await r.json();
    const n = d[`ISBN:${isbn}`]?.number_of_pages;
    if (!plausible(n)) return { issue: "absente", detail: n === undefined ? "" : "valeur " + n };
    return { issue: "trouvee", pages: n };
  } catch (e) {
    return { issue: "injoignable", detail: e.name === "AbortError" ? "délai dépassé" : e.message };
  }
}

/* --------------------------------------------------------------- Marche */

(async () => {
  console.log("== Pagination ==");
  console.log(APPLIQUER ? "   MODE ÉCRITURE\n" : "   mesure seule — aucune écriture\n");
  if (!CLE_GOOGLE) console.log("  (aucune clef Google : cette source est ignorée)\n");

  const { rows } = await bd.query(
    `select id, isbn, titre, sous_categorie from books
     where isbn is not null and isbn <> ''
       and pages is null
       and coalesce(pages_statut, '') <> 'absente'
     order by auteur, titre`);

  const aTraiter = rows.slice(0, LIMITE);
  console.log(`  ${rows.length} ouvrage(s) sans pagination, ${aTraiter.length} traité(s)\n`);
  if (!aTraiter.length) { await bd.end(); return; }

  const bilan = { trouvee: 0, absente: 0, injoignable: 0 };
  const parSource = { google: 0, openlibrary: 0 };
  const aEcrire = [];
  const echecs = [];

  for (const [i, l] of aTraiter.entries()) {
    let r = await googleBooks(l.isbn);
    let source = "google";
    const raisons = [];
    if (r.issue === "injoignable") raisons.push("GB:" + (r.detail ?? "?"));

    if (r.issue !== "trouvee") {
      await pause(600);
      const o = await openLibrary(l.isbn);
      if (o.issue === "trouvee") { r = o; source = "openlibrary"; }
      else if (o.issue === "injoignable") raisons.push("OL:" + (o.detail ?? "?"));
      else if (r.issue !== "injoignable") r = { issue: "absente" };
    }

    // « absente » seulement si AUCUNE source n'a échoué pour cause de réseau.
    if (r.issue !== "trouvee") {
      r = raisons.length ? { issue: "injoignable", detail: raisons.join(" / ") } : { issue: "absente" };
    }

    bilan[r.issue]++;
    if (r.issue === "trouvee") {
      parSource[source]++;
      aEcrire.push({ id: l.id, pages: r.pages });
    } else if (r.issue === "absente") {
      aEcrire.push({ id: l.id, pages: null });
    } else {
      echecs.push(`${l.isbn}  ${l.titre.slice(0, 42)} — ${r.detail ?? "?"}`);
    }

    if ((i + 1) % 25 === 0 || i === aTraiter.length - 1) {
      console.log(`  ${String(i + 1).padStart(3)}/${aTraiter.length}` +
        `  trouvées ${bilan.trouvee}  absentes ${bilan.absente}  injoignables ${bilan.injoignable}`);
    }
    await pause(150);
  }

  console.log("\n-- Bilan --");
  console.log(`  trouvées     ${bilan.trouvee}  (Google ${parSource.google}, Open Library ${parSource.openlibrary})`);
  console.log(`  absentes     ${bilan.absente}   les deux sources ont répondu, aucune ne l'a`);
  console.log(`  injoignables ${bilan.injoignable}   réseau ou quota — RIEN ne sera écrit`);
  if (echecs.length) {
    console.log("\n  Non conclus (à relancer) :");
    echecs.slice(0, 8).forEach(e => console.log("    " + e));
    if (echecs.length > 8) console.log(`    … et ${echecs.length - 8} autre(s)`);
  }

  const part = bilan.injoignable / aTraiter.length;
  if (part > 0.2) {
    console.log(`\n  ATTENTION ${Math.round(part * 100)} % d'injoignables — relancez plus tard.`);
  }

  if (!APPLIQUER) {
    console.log(`\n  Aucune écriture. Pour enregistrer : --appliquer`);
    console.log(`  ${aEcrire.length} ouvrage(s) seraient modifiés.`);
    await bd.end();
    return;
  }

  const c = await bd.connect();
  try {
    await c.query("begin");
    for (const e of aEcrire) {
      await c.query(
        "update books set pages = $2, pages_statut = $3 where id = $1",
        [e.id, e.pages, e.pages === null ? "absente" : "trouvee"]);
    }
    await c.query("commit");
    console.log(`\n  OK   ${aEcrire.length} ouvrage(s) mis à jour`);
  } catch (e) {
    await c.query("rollback");
    console.error("  ECHEC écriture, retour arrière : " + e.message);
    process.exitCode = 1;
  } finally { c.release(); }

  const v = await bd.query(
    `select count(*)::int as total,
            count(pages)::int as avec,
            coalesce(sum(pages), 0)::bigint as volume
     from books`);
  const { total, avec, volume } = v.rows[0];
  console.log("\n-- État de la base --");
  console.log(`  ${avec} ouvrage(s) paginés sur ${total} — ${Math.round(avec / total * 100)} % de couverture`);
  console.log(`  ${Number(volume).toLocaleString("fr-FR")} pages connues`);
  console.log("\n  Ce volume ne porte QUE sur les ouvrages paginés. Il n'est pas");
  console.log("  le volume de la bibliothèque, et ne doit jamais être présenté");
  console.log("  comme tel.");

  await bd.end();
})().catch(async e => {
  console.error("  ECHEC " + (e?.stack ?? e));
  try { await bd.end(); } catch { /* rien */ }
  process.exit(1);
});
