/* =========================================================================
   LES PAGES LÉGALES DISENT-ELLES CE QUE LE CODE FAIT ?

   ---------------------------------------------------------------------------
   LE VRAI RISQUE N'EST PAS L'ABSENCE, C'EST LA DÉRIVE

   Écrire une politique de confidentialité est facile. Ce qui est difficile,
   c'est qu'elle reste vraie : on ajoute un service, on change de prestataire
   d'envoi, on branche une API de plus — et la page continue d'affirmer, avec
   la même assurance, une liste de destinataires qui n'est plus la bonne.

   Une politique périmée est PIRE que pas de politique : elle promet.

   D'où le contrôle central : chaque hôte que le code appelle réellement doit
   être déclaré. Un tiers nouveau, non déclaré, fait échouer la livraison —
   avec son nom, pour qu'on sache quoi écrire.

   ---------------------------------------------------------------------------
   ET LE RESTE, QUI EST PLUS BÊTE MAIS TOUT AUSSI FATAL

   Une page de mentions atteignable seulement par son adresse n'est pas
   publiée, elle est cachée. Chaque écran doit y mener.

   Et ces deux pages ne portent AUCUN script : quelqu'un qui vient lire ce
   qu'on fait de ses données ne doit pas être mesuré en le lisant.

   USAGE
     node tests/test-pages-legales.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const RACINE = [".", "..", path.join("..", "..")]
  .find(c => fs.existsSync(path.join(c, "web", "index.html")))
  ?? [".", "..", path.join("..", "..")]
    .find(c => fs.existsSync(path.join(c, "docker", "web", "index.html")));

if (!RACINE) {
  console.log("  (web/ hors de portée dans cette disposition — non exécuté)");
  console.log("\n  0 vérifications, aucune erreur.");
  process.exit(0);
}
const sous = fs.existsSync(path.join(RACINE, "docker", "web"));
const WEB = path.join(RACINE, ...(sous ? ["docker", "web"] : ["web"]));
const API = path.join(RACINE, ...(sous ? ["docker", "api"] : ["api"]));
const lire = (f) => fs.readFileSync(f, "utf8");

const MENTIONS = "mentions-legales.html";
const CONFID   = "confidentialite.html";

/* ===================================================================== */
/* 1. ELLES EXISTENT, ET SONT ATTEIGNABLES DEPUIS PARTOUT                 */
/* ===================================================================== */

for (const p of [MENTIONS, CONFID]) {
  verifier(`« ${p} » existe`, fs.existsSync(path.join(WEB, p)));
}

/* Toutes les pages de l'application, LUES DU RÉPERTOIRE. Une liste écrite
   ici oublierait la page suivante — et c'est précisément l'oubli qu'on
   cherche à empêcher. */
const pages = fs.readdirSync(WEB).filter(f => f.endsWith(".html"));
verifier("des pages ont été trouvées", pages.length >= 3, pages.join(", "));

for (const p of pages.filter(f => f !== MENTIONS && f !== CONFID)) {
  const t = lire(path.join(WEB, p));
  verifier(`« ${p} » mène aux deux pages légales`,
    t.includes(`/${MENTIONS}`) && t.includes(`/${CONFID}`),
    "un écran sans pied légal est un écran où l'information est cachée");
}

/* ===================================================================== */
/* 2. ELLES SONT LISIBLES, ET NE MESURENT PERSONNE                        */
/* ===================================================================== */

for (const p of [MENTIONS, CONFID]) {
  const t = lire(path.join(WEB, p));

  verifier(`« ${p} » ne porte aucun script`,
    !/<script/i.test(t),
    "on ne mesure pas quelqu'un pendant qu'il lit ce qu'on fait de ses données");

  /* Les écrans de l'application sont en « noindex » — c'est voulu. Ces deux
     pages-là ne doivent PAS l'être : une mention légale introuvable ne
     remplit pas son office. */
  verifier(`« ${p} » reste indexable`,
    !/name=["']robots["'][^>]*noindex/i.test(t),
    "elle porte « noindex » : personne ne la trouvera");

  verifier(`« ${p} » nomme un contact`,
    /mailto:[^"']+@/.test(t), "aucune adresse de contact");
}

/* ===================================================================== */
/* 3. LE CONTRÔLE CENTRAL : AUCUN TIERS NON DÉCLARÉ                       */
/* ===================================================================== */

/* Ce que la politique DOIT nommer, hôte par hôte. « null » signifie : ce
   tiers ne reçoit aucune donnée personnelle, et la raison est écrite ici.

   AJOUTER UN SERVICE OBLIGE À PASSER PAR CETTE TABLE. C'est le but : le
   contrôle échoue avec le nom de l'hôte inconnu, et l'on doit alors décider
   — et écrire — ce qu'il reçoit. */
const DECLARES = {
  "api.anthropic.com":      "Anthropic",
  "api.brevo.com":          "Brevo",
  "api.resend.com":         "Resend",
  "accounts.google.com":    "Google",
  "oauth2.googleapis.com":  "Google",
  "www.googleapis.com":     "Google",

  /* Interrogés PAR LE SERVEUR avec un ISBN ou un DOI. Le navigateur ne les
     contacte pas, et ils n'apprennent rien de la personne. La politique le
     dit, donc on exige quand même qu'ils y soient nommés. */
  "openlibrary.org":        "Open Library",
  "covers.openlibrary.org": "Open Library",
  "api.crossref.org":       "Crossref",
  "doi.org":                "doi.org",
  "catalogue.bnf.fr":       "BnF",

  /* Notre propre domaine : pas un tiers. */
  "lisia.y-factor.fr":      null,
};

const hotes = new Set();
for (const f of fs.readdirSync(API).filter(f => /\.m?js$/.test(f))) {
  for (const m of lire(path.join(API, f)).matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    hotes.add(m[1].toLowerCase());
  }
}

verifier("des appels sortants ont été trouvés dans l'API",
  hotes.size >= 8, `${hotes.size} : ${[...hotes].sort().join(", ")}`);

const inconnus = [...hotes].filter(h => !(h in DECLARES));
verifier("aucun tiers appelé par le code n'est INCONNU de cette table",
  inconnus.length === 0,
  `non déclaré(s) : ${inconnus.join(", ")} — décidez ce qu'ils reçoivent, `
  + "puis écrivez-le dans la politique et ici");

const politique = lire(path.join(WEB, CONFID));
const muets = [...hotes]
  .map(h => DECLARES[h])
  .filter(nom => nom && !politique.includes(nom));
verifier("chaque tiers déclaré est NOMMÉ dans la politique",
  muets.length === 0,
  `absents de la page : ${[...new Set(muets)].join(", ")}`);

/* ===================================================================== */
/* 4. CE QUE LA POLITIQUE PROMET, LE CODE LE FAIT                         */
/* ===================================================================== */

verifier("la politique annonce la suppression de compte",
  /supprimer|suppression/i.test(politique), "le droit à l'effacement n'est pas mentionné");

const serveur = lire(path.join(API, "server.js"));
verifier("… et la route de suppression existe vraiment",
  /chemin === "\/api\/compte" && req\.method === "DELETE"/.test(serveur),
  "la page promet une porte qui n'est pas percée");

verifier("la politique nomme la CNIL",
  /cnil/i.test(politique), "le droit de réclamation n'est pas indiqué");

/* La page affirme que les fiches du catalogue commun survivent. C'est vrai
   parce qu'« ouvrages » n'a pas de « tenant_id » ; si un jour elle en
   recevait un, la promesse deviendrait fausse en silence. */
const catalogue = fs.readdirSync(path.join(RACINE, ...(sous ? ["docker", "db"] : ["db"])))
  .filter(f => f.endsWith(".sql"))
  .map(f => lire(path.join(RACINE, ...(sous ? ["docker", "db"] : ["db"]), f)))
  .join("\n");
const ouvragesCloisonnes =
  /create table[^(]*public\.ouvrages[\s\S]{0,900}?tenant_id/.test(catalogue)
  || /alter table public\.ouvrages[^;]*add column[^;]*tenant_id/.test(catalogue);
verifier("« ouvrages » reste un catalogue COMMUN, comme la page l'affirme",
  !ouvragesCloisonnes,
  "ouvrages porte désormais un tenant_id : la promesse « les fiches survivent » est à revoir");

/* ===================================================================== */

for (const n of ok) console.log("  ok   " + n);
for (const n of ko) console.log("  KO   " + n);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length} erreur(s).`);
process.exit(ko.length ? 1 : 0);
