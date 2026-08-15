/* =========================================================================
   LA RECETTE SE VOIT, LA PRODUCTION NE SE DÉGUISE PAS

   Un environnement d'essai qui ressemble à la production est un piège : on
   y efface des données en croyant être ailleurs. Le bandeau n'est donc pas
   un ornement, c'est un dispositif de sécurité — et comme tout dispositif
   de sécurité, il doit être éprouvé DANS LES DEUX SENS.

     — absent en recette : l'avertissement ne prévient personne ;
     — présent en production : il devient un décor qu'on cesse de lire, et
       le jour où il compte vraiment, il ne dit plus rien.

   LE DÉFAUT PAR DÉFAUT EST « PRODUCTION », et c'est délibéré. Une variable
   oubliée doit produire le comportement le plus PRUDENT : une recette qui
   se fait passer pour la production est dangereuse ; un bandeau oublié en
   production n'est qu'embarrassant.

   ---------------------------------------------------------------------------
   OÙ VIT CE SCRIPT, ET POURQUOI ÇA COMPTE

   Une première version l'avait glissé dans le dernier bloc de la page — qui
   se trouve être le module du scanner de codes-barres. Le bandeau dépendait
   donc d'un module sans rapport : s'il échoue, l'avertissement disparaît
   exactement quand on en aurait besoin. jsdom, qui n'exécute pas les
   modules, l'a révélé.

   USAGE
     node tests/test-environnement.mjs
   ========================================================================= */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
const WEB = ["web", path.join("..", "web")].find(c => fs.existsSync(path.join(c, "index.html")));

/* LA LISTE DES PAGES N'EST PLUS ÉCRITE À LA MAIN.
 *
 * Elle l'était — « index.html » et « ma-bibliotheque.html » — et il a suffi
 * d'ajouter reglages.html le 16/08/2026 pour qu'une page échappe au
 * contrôle. Elle aurait pu servir la recette SANS bandeau, sans qu'aucune
 * vérification ne tombe : la seule chose que le contrôle savait faire,
 * c'était vérifier les pages qu'on avait pensé à lui nommer.
 *
 * On lit donc le dossier. Une page nouvelle est éprouvée d'office. */
const PAGES = fs.readdirSync(WEB).filter(f => f.endsWith(".html")).sort();
if (!PAGES.length) { console.error("  ECHEC aucune page dans web/"); process.exit(1); }
if (!API || !WEB) { console.error("  ECHEC api/ ou web/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

// Une page qui lève une exception ne doit pas emporter le contrôle avec
// elle : on veut le bilan, pas une pile d'appels.
const incidents = [];
process.on("uncaughtException", (e) => incidents.push(e.message));

const banc = await ouvrirBanc({ port: 55511 });

const lancer = (env, port) => spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env, PORT: String(port),
    MOT_DE_PASSE: "mot-de-passe-de-controle",
    SECRET_SESSION: "un-secret-de-controle-suffisamment-long-pour-passer",
    ANTHROPIC_API_KEY: "", FICHIER_AMORCE: "/inexistant", TENANT_DEFAUT: "xavier",
    ...env,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const attendre = async (port) => {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/sante`)).ok) return true; }
    catch { await new Promise(r => setTimeout(r, 400)); }
  }
  return false;
};

const CAS = [
  ["recette",                        { ENVIRONNEMENT: "recette" },    3471, true],
  ["production",                     { ENVIRONNEMENT: "production" }, 3472, false],
  ["variable absente",               {},                              3473, false],
  ["valeur inattendue (« staging »)", { ENVIRONNEMENT: "staging" },   3474, false],
];

for (const [nom, env, port, attendu] of CAS) {
  const serveur = lancer(env, port);
  if (!(await attendre(port))) {
    verifier(`${nom} : l'API démarre`, false); serveur.kill(); continue;
  }

  const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json();
  verifier(`${nom} : l'API annonce « ${session.environnement} »`,
    session.environnement === (attendu ? "recette" : "production"),
    JSON.stringify(session));

  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(WEB, page), "utf8");
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: `http://127.0.0.1:${port}/`,
      beforeParse(w) {
        /* fetch doit exister AVANT que jsdom n'exécute les scripts : ils
           partent dès la construction du DOM. Le poser après revient à le
           poser trop tard — c'est ce qui a d'abord fait croire que le
           bandeau ne s'affichait jamais. */
        w.fetch = (u, o) => fetch(new URL(u, `http://127.0.0.1:${port}`), o);
        // Lacunes de jsdom, pas de la page.
        w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
        w.cancelAnimationFrame = (id) => clearTimeout(id);
      },
    });
    await new Promise(r => setTimeout(r, 700));
    const b = dom.window.document.getElementById("bandeau-recette");
    verifier(`${nom} / ${page} : bandeau ${attendu ? "VISIBLE" : "caché"}`,
      Boolean(b) && b.hidden === !attendu, b ? `hidden=${b.hidden}` : "élément absent");
    dom.window.close();
  }
  serveur.kill();
}

/* Le bandeau ne doit dépendre d'AUCUN module : un module qui ne se charge
   pas emporterait l'avertissement avec lui. On vérifie la forme, parce que
   le comportement, lui, ne distingue pas les deux cas dans un navigateur
   qui fonctionne. */
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(WEB, page), "utf8");
  const apres = html.slice(html.indexOf('id="bandeau-recette"'));
  const bloc = apres.slice(0, apres.indexOf("</script>") + 9);
  verifier(`${page} : le bandeau a son propre script classique`,
    /<script>/.test(bloc) && !/<script[^>]+type=["']module/.test(bloc),
    bloc.slice(0, 120));
}

await banc.fermer();

console.log("\n=== Environnement annoncé ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (incidents.length) {
  console.log("");
  incidents.slice(0, 3).forEach(i => console.log("  (incident de page ignoré : " + i + ")"));
}
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
