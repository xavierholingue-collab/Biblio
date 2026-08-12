/* =========================================================================
   RÉCUPÉRATION DES COUVERTURES

   S'EXÉCUTE SUR LE VPS. Lit /etc/biblio/env pour joindre la base.

   POURQUOI CE SCRIPT
   L'application sait déjà chercher une couverture — Open Library, puis
   Google Books — mais seulement pour les ouvrages qu'un navigateur affiche,
   et l'enregistrement du résultat exige une session ouverte. Un visiteur ne
   mémorise rien. Résultat : les 242 ouvrages sont restés en « inconnu ».
   Ce script fait le travail une fois pour toutes, côté serveur.

   CE QU'IL NE FAIT PAS, ET POURQUOI
   Il ne va pas chercher chez Babelio. Babelio n'expose aucune interface
   publique, ses conditions d'utilisation interdisent l'aspiration
   automatisée, et pointer vers des images hébergées chez eux ferait
   dépendre votre site d'un tiers qui n'a rien promis. Les deux sources
   utilisées ici publient des interfaces prévues pour cet usage.

   TROIS ISSUES, ET LA TROISIÈME EST LA PLUS IMPORTANTE
     trouvee     — une couverture existe, son adresse est enregistrée ;
     absente     — les deux sources ont répondu « je n'ai pas » ;
     injoignable — le réseau a échoué, ou le service a refusé.

   La distinction entre « absente » et « injoignable » est le cœur du
   script. Marquer « absente » un ouvrage dont la requête a simplement
   échoué reviendrait à graver une panne passagère dans la base : plus
   jamais on ne rechercherait sa couverture. Une coupure réseau de trente
   secondes suffirait à condamner définitivement quelques dizaines
   d'ouvrages, sans que rien ne le signale.

   USAGE
     node vps-couvertures.mjs              # mesure seule, n'écrit rien
     node vps-couvertures.mjs --appliquer  # écrit les résultats
     node vps-couvertures.mjs --appliquer --limite 20
   ========================================================================= */

import fs from "node:fs";
import pg from "pg";

const APPLIQUER = process.argv.includes("--appliquer");
const iLimite = process.argv.indexOf("--limite");
const LIMITE = iLimite > -1 ? Number(process.argv[iLimite + 1]) : Infinity;

const ENVF = process.env.ENVF ?? "/etc/biblio/env";

/* ------------------------------------------------------- Configuration --- */

function lireEnv(fichier) {
  // Le fichier systemd est du CLE=valeur, une par ligne. On ne l'affiche
  // jamais : il contient le mot de passe de la base et la clef Anthropic.
  if (!fs.existsSync(fichier)) {
    console.error(`  ECHEC ${fichier} introuvable. Ce script s'exécute sur le VPS.`);
    process.exit(1);
  }
  const env = {};
  for (const ligne of fs.readFileSync(fichier, "utf8").split("\n")) {
    const m = ligne.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = lireEnv(ENVF);
const bd = new pg.Pool({
  host: env.PGHOST ?? "127.0.0.1",
  port: Number(env.PGPORT ?? 5432),
  user: env.PGUSER ?? "biblio",
  password: env.PGPASSWORD,
  database: env.PGDATABASE ?? "biblio",
  max: 2,
});

/* ------------------------------------------------------- Les deux sources */

const pause = ms => new Promise(r => setTimeout(r, ms));

async function avecDelai(url, ms, options = {}) {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), ms);
  try { return await fetch(url, { ...options, signal: stop.signal }); }
  finally { clearTimeout(t); }
}

/* Open Library. « default=false » est essentiel : sans ce paramètre, le
   service renvoie une image grise de remplacement avec un code 200, et
   l'on enregistrerait 242 fois la même vignette vide. */
async function openLibrary(isbn) {
  const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false`;
  try {
    const r = await avecDelai(url, 15000);
    if (r.status === 404) return { issue: "absente" };
    if (!r.ok) return { issue: "injoignable", detail: "HTTP " + r.status };
    // Une réponse de moins d'un kilo-octet n'est pas une couverture.
    const octets = (await r.arrayBuffer()).byteLength;
    if (octets < 1000) return { issue: "absente", detail: octets + " octets" };
    return { issue: "trouvee", url, octets };
  } catch (e) {
    return { issue: "injoignable", detail: e.name === "AbortError" ? "délai dépassé" : e.message };
  }
}

/* Google Books.
   MESURE DU 04/08/2026 : sans clef, depuis le VPS, 23 appels sur 23 ont
   reçu un 429. Ce n'est pas un rythme trop soutenu — le premier appel était
   déjà refusé. Google restreint fortement les requêtes anonymes venant d'un
   centre de données ; ralentir n'y change rien.

   Avec une clef (gratuite, 1 000 requêtes par jour), le service répond
   normalement. La clef se pose dans /etc/biblio/env, sous le nom
   CLE_GOOGLE_BOOKS. Sans elle, ce script n'interroge tout simplement pas
   Google : mieux vaut ne pas appeler que collectionner des refus. */
const CLE_GOOGLE = env.CLE_GOOGLE_BOOKS ?? "";

async function googleBooks(isbn) {
  if (!CLE_GOOGLE) return { issue: "injoignable", detail: "pas de clef Google" };
  const url = "https://www.googleapis.com/books/v1/volumes?q=isbn:"
    + encodeURIComponent(isbn) + "&key=" + encodeURIComponent(CLE_GOOGLE);
  try {
    const r = await avecDelai(url, 15000);
    if (r.status === 429 || r.status === 403) return { issue: "injoignable", detail: "quota " + r.status };
    if (!r.ok) return { issue: "injoignable", detail: "HTTP " + r.status };
    const d = await r.json();
    const img = d.items?.[0]?.volumeInfo?.imageLinks;
    const u = img?.thumbnail || img?.smallThumbnail;
    if (!u) return { issue: "absente" };
    return { issue: "trouvee", url: u.replace(/^http:/, "https:") };
  } catch (e) {
    return { issue: "injoignable", detail: e.name === "AbortError" ? "délai dépassé" : e.message };
  }
}

/* Open Library, recherche par titre et auteur.
   Dernier recours, quand l'ISBN n'est pas indexé — ce qui arrive souvent
   pour les éditions françaises, et toujours pour un identifiant maison
   comme « SI11411085050 ».

   DANGER, et c'est pour cela que le contrôle ci-dessous est strict : une
   recherche textuelle renvoie volontiers un homonyme, une autre édition,
   voire un autre ouvrage. Afficher la couverture d'un livre à la place d'un
   autre est pire que n'afficher aucune couverture : la première erreur est
   invisible, la seconde est honnête. On exige donc que le titre ET le nom
   de l'auteur concordent. */
const normaliser = s => (s ?? "")
  .toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // sans accents
  .replace(/[^a-z0-9 ]+/g, " ")
  .replace(/\s+/g, " ").trim();

function memeOuvrage(titreVoulu, auteurVoulu, titreTrouve, auteursTrouves) {
  const a = normaliser(titreVoulu), b = normaliser(titreTrouve);
  if (!a || !b) return false;
  // Le titre trouvé doit contenir le titre voulu, ou l'inverse : les
  // sous-titres varient d'une édition à l'autre.
  const titreOk = a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
  if (!titreOk) return false;

  // Le nom de famille de l'auteur doit figurer parmi ceux annoncés. La base
  // les stocke en « Nom Prénom » : le premier mot est donc le nom.
  const nom = normaliser(auteurVoulu).split(" ")[0];
  if (!nom || nom.length < 3) return false;
  return (auteursTrouves ?? []).some(x => normaliser(x).includes(nom));
}

async function openLibraryRecherche(titre, auteur) {
  const u = "https://openlibrary.org/search.json?limit=5&fields=title,author_name,cover_i&q="
    + encodeURIComponent(`${titre} ${auteur}`);
  try {
    const r = await avecDelai(u, 20000);
    if (!r.ok) return { issue: "injoignable", detail: "HTTP " + r.status };
    const d = await r.json();
    for (const doc of d.docs ?? []) {
      if (!doc.cover_i) continue;
      if (!memeOuvrage(titre, auteur, doc.title, doc.author_name)) continue;
      return {
        issue: "trouvee",
        url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
        approchee: true,
        vu: `${doc.title} — ${(doc.author_name ?? []).join(", ")}`,
      };
    }
    return { issue: "absente" };
  } catch (e) {
    return { issue: "injoignable", detail: e.name === "AbortError" ? "délai dépassé" : e.message };
  }
}

/* --------------------------------------------------------------- Marche --- */

(async () => {
  console.log("== Couvertures ==");
  console.log(APPLIQUER ? "   MODE ÉCRITURE\n" : "   mesure seule — aucune écriture\n");

  const { rows } = await bd.query(
    `select id, isbn, titre, auteur, sphere from books
     where isbn is not null and isbn <> ''
       and cover_url is null
       and coalesce(cover_statut, 'inconnu') <> 'absente'
     order by auteur, titre`);

  const aTraiter = rows.slice(0, LIMITE);
  console.log(`  ${rows.length} ouvrage(s) sans couverture, ${aTraiter.length} traité(s)\n`);
  if (!aTraiter.length) { await bd.end(); return; }

  const bilan = { trouvee: 0, absente: 0, injoignable: 0 };
  const parSource = { isbn_openlibrary: 0, isbn_google: 0, recherche_openlibrary: 0 };
  const echecs = [];
  const approchees = [];
  const aEcrire = [];
  let nonConclus = 0;

  if (!CLE_GOOGLE) {
    console.log("  (aucune clef Google : cette source est ignorée)\n");
  }

  for (const [i, l] of aTraiter.entries()) {
    /* Trois sources, de la plus sûre à la moins sûre.
       1. Open Library par ISBN     — identité certaine ;
       2. Google Books par ISBN     — identité certaine, demande une clef ;
       3. Open Library par titre    — identité VRAISEMBLABLE seulement.
       On s'arrête à la première qui aboutit. */
    let r = await openLibrary(l.isbn);
    let source = "isbn_openlibrary";
    const raisons = [];
    if (r.issue === "injoignable") raisons.push("OL:" + (r.detail ?? "?"));

    if (r.issue !== "trouvee" && CLE_GOOGLE) {
      await pause(400);
      const g = await googleBooks(l.isbn);
      if (g.issue === "trouvee") { r = g; source = "isbn_google"; }
      else if (g.issue === "injoignable") raisons.push("GB:" + (g.detail ?? "?"));
      else if (r.issue !== "injoignable") r = { issue: "absente" };
    }

    if (r.issue !== "trouvee") {
      await pause(700);                        // Open Library demande de la mesure
      const s = await openLibraryRecherche(l.titre, l.auteur);
      if (s.issue === "trouvee") {
        r = s; source = "recherche_openlibrary";
        approchees.push(`${l.titre.slice(0, 38)} / ${l.auteur.slice(0, 20)}  ->  ${s.vu.slice(0, 60)}`);
      } else if (s.issue === "injoignable") raisons.push("OLr:" + (s.detail ?? "?"));
    }

    // Une seule règle : on ne conclut « absente » que si AUCUNE source
    // n'a échoué pour cause de réseau ou de quota.
    if (r.issue !== "trouvee") {
      r = raisons.length ? { issue: "injoignable", detail: raisons.join(" / ") } : { issue: "absente" };
    }

    bilan[r.issue]++;
    if (r.issue === "trouvee") {
      parSource[source]++;
      aEcrire.push({ id: l.id, url: r.url, statut: "trouvee" });
    } else if (r.issue === "absente") {
      /* « absente » est DÉFINITIF : la requête du haut exclut ces ouvrages
         des passages suivants. Le mot ne peut donc signifier qu'une chose :
         toutes les sources prévues ont été interrogées et aucune n'a la
         couverture.

         Sans clef Google, une source manque à l'appel. Écrire « absente »
         reviendrait à condamner l'ouvrage sur un interrogatoire incomplet —
         et l'ajout de la clef demain ne le rattraperait jamais. On laisse
         donc « inconnu », qui dit exactement ce qui est : on n'a pas fini
         de chercher. */
      if (CLE_GOOGLE) aEcrire.push({ id: l.id, url: null, statut: "absente" });
      else nonConclus++;
    } else {
      echecs.push(`${l.isbn}  ${l.titre.slice(0, 42)} — ${r.detail ?? "?"}`);
    }

    if ((i + 1) % 25 === 0 || i === aTraiter.length - 1) {
      process.stdout.write(
        `  ${String(i + 1).padStart(3)}/${aTraiter.length}` +
        `  trouvées ${bilan.trouvee}  absentes ${bilan.absente}  injoignables ${bilan.injoignable}\n`);
    }
    await pause(120);
  }

  console.log("\n-- Bilan --");
  console.log(`  trouvées     ${bilan.trouvee}`);
  console.log(`     par ISBN, Open Library   ${parSource.isbn_openlibrary}   identité certaine`);
  console.log(`     par ISBN, Google Books   ${parSource.isbn_google}   identité certaine`);
  console.log(`     par titre, Open Library  ${parSource.recherche_openlibrary}   identité VRAISEMBLABLE, à relire`);
  if (CLE_GOOGLE) {
    console.log(`  absentes     ${bilan.absente}   les trois sources ont été interrogées, aucune ne l'a`);
  } else {
    console.log(`  sans réponse ${bilan.absente}   laissés en « inconnu » : Google n'a pas été interrogé,`);
    console.log(`                    l'interrogatoire est incomplet. Ils seront repris.`);
  }
  console.log(`  injoignables ${bilan.injoignable}   réseau ou quota — RIEN ne sera écrit pour celles-ci`);

  if (approchees.length) {
    console.log("\n  Trouvées par recherche textuelle — vérifiez que ce sont bien vos ouvrages :");
    approchees.slice(0, 15).forEach(a => console.log("    " + a));
    if (approchees.length > 15) console.log(`    … et ${approchees.length - 15} autre(s)`);
  }

  if (echecs.length) {
    console.log("\n  Ouvrages non conclus (à relancer plus tard) :");
    echecs.slice(0, 12).forEach(e => console.log("    " + e));
    if (echecs.length > 12) console.log(`    … et ${echecs.length - 12} autre(s)`);
  }

  // Un taux d'injoignables élevé signale un problème de réseau ou de quota,
  // pas une bibliothèque mal référencée. Mieux vaut s'arrêter et recommencer
  // que d'enregistrer un résultat partiel en croyant le travail fait.
  const partInjoignable = bilan.injoignable / aTraiter.length;
  if (partInjoignable > 0.2) {
    console.log(`\n  ATTENTION ${Math.round(partInjoignable * 100)} % d'injoignables.`);
    console.log("  Le réseau ou le quota Google est en cause, pas vos ISBN.");
    console.log("  Relancez plus tard ; les ouvrages non conclus seront repris.");
  }

  if (!APPLIQUER) {
    console.log(`\n  Aucune écriture. Pour enregistrer : --appliquer`);
    console.log(`  ${aEcrire.length} ouvrage(s) seraient modifiés`
      + (nonConclus ? `, ${nonConclus} laissé(s) en « inconnu » pour un passage ultérieur.` : "."));
    await bd.end();
    return;
  }

  const client = await bd.connect();
  try {
    await client.query("begin");
    for (const e of aEcrire) {
      await client.query(
        "update books set cover_url = $2, cover_statut = $3 where id = $1",
        [e.id, e.url, e.statut]);
    }
    await client.query("commit");
    console.log(`\n  OK   ${aEcrire.length} ouvrage(s) mis à jour`);
  } catch (e) {
    await client.query("rollback");
    console.error("  ECHEC écriture, retour arrière effectué : " + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  const v = await bd.query(
    `select coalesce(cover_statut,'inconnu') as statut, count(*)::int as n
     from books group by 1 order by 2 desc`);
  console.log("\n-- État de la base --");
  v.rows.forEach(r => console.log(`  ${String(r.n).padStart(4)}  ${r.statut}`));

  await bd.end();
})().catch(async e => {
  console.error("  ECHEC " + (e?.stack ?? e));
  try { await bd.end(); } catch { /* rien */ }
  process.exit(1);
});
