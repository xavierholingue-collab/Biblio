/* =========================================================================
   LA TARIFICATION EXISTANTE SURVIT À LA LIVRAISON

   La migration 19 dimensionne le quota sur le nombre de membres. Une
   bibliothèque déjà réglée à la main — 100 000 appels, 20 $ — doit passer en
   régime « manuelle » et ne plus bouger : sans cela, la première invitation
   qui suit la livraison la ramènerait à dix appels et bloquerait son
   propriétaire. C'est exactement ce qui est arrivé le 25/08/2026.

   ---------------------------------------------------------------------------
   POURQUOI CE FICHIER EST SÉPARÉ DE « test-sieges.mjs » — 05/09/2026

   Ces vérifications y vivaient, dans un second « ouvrirBanc({ jusqua }) ».
   En local, chaque appel monte SON PostgreSQL dans un dossier neuf : les
   deux bancs étaient isolés, et tout passait. Dans la chaîne de livraison,
   « PGURL » est posé et les deux appels partagent LA MÊME base — le second
   rejouait donc 01→18 sur une base où la 17 avait déjà supprimé
   « possessions.statut », et la reprise de 03 échouait sur une colonne
   absente.

   L'isolation était une SUPPOSITION : vraie sur mon poste, fausse là où ça
   compte. Un fichier qui éprouve une reprise a donc besoin de sa propre
   base, c'est-à-dire de sa propre ligne « lancer » dans la chaîne.
   « ouvrirBanc » refuse désormais un « jusqua » sur une base déjà peuplée,
   pour que cette confusion ne puisse plus être silencieuse.

   USAGE
     node tests/test-reprise-sieges.mjs
   ========================================================================= */

import { ouvrirBanc } from "./banc-postgres.mjs";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

/* On s'arrête AVANT 19 : la base est alors dans l'état du serveur. */
const banc = await ouvrirBanc({ port: 55519, jusqua: "19-" });

/* CE QUE VAUT UN SIÈGE, LU À SA SOURCE D'ALORS.

   « quota_par_siege() » n'existe pas encore — c'est la 19 qui la déclare. La
   valeur de référence avant elle est le DÉFAUT DE LA COLONNE, et c'est
   exactement ce à quoi la reprise compare pour décider du régime. On la lit
   donc là, plutôt que de recopier un nombre qui se périmerait en silence. */
const defaut = async (colonne) => (await banc.q(
  `select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants'
      and column_name = $1`, [colonne]))[0]?.column_default;

const PAR_SIEGE     = Number(await defaut("quota_ia_mois"));
const PLAFOND_SIEGE = Number(await defaut("plafond_usd"));

verifier("les valeurs d'un siège sont lisibles avant la migration",
  Number.isFinite(PAR_SIEGE) && PAR_SIEGE > 0
    && Number.isFinite(PLAFOND_SIEGE) && PLAFOND_SIEGE > 0,
  JSON.stringify({ PAR_SIEGE, PLAFOND_SIEGE })
  + " — sans elles, la reprise serait comparée à rien");


const reglee = await banc.locataire("deja-reglee", "privee");
const neuve  = await banc.locataire("au-tarif",    "privee");

await banc.q("update tenants set quota_ia_mois = 100000, plafond_usd = 20.000 "
              + "where id = $1", [reglee]);
await banc.q("update tenants set quota_ia_mois = $1, plafond_usd = $2 "
              + "where id = $3", [PAR_SIEGE, PLAFOND_SIEGE, neuve]);

const compteA = await banc.compte(reglee, "a@controle.fr");
await banc.compte(neuve, "b@controle.fr");

await banc.appliquerLaSuite();

const lire = async (t) => (await banc.q(
  "select quota_ia_mois, plafond_usd::text as plafond, tarification "
  + "from tenants where id = $1", [t]))[0];

const r = await lire(reglee);
verifier("après la livraison, une bibliothèque déjà réglée est « manuelle »",
  r.tarification === "manuelle", JSON.stringify(r));
verifier("… et elle a gardé ses valeurs",
  r.quota_ia_mois === 100000 && Number(r.plafond) === 20, JSON.stringify(r));

const n = await lire(neuve);
verifier("… tandis qu'une bibliothèque au tarif reste « sieges »",
  n.tarification === "sieges", JSON.stringify(n));

/* ET LA SUITE LE PROUVE : inviter quelqu'un chez la première ne bouge
   rien, chez la seconde ajoute un siège. */
await banc.compte(reglee, "a2@controle.fr", "membre");
await banc.compte(neuve,  "b2@controle.fr", "membre");

const r2 = await lire(reglee);
verifier("une invitation ne touche pas la bibliothèque réglée",
  r2.quota_ia_mois === 100000, JSON.stringify(r2));

const n2 = await lire(neuve);
verifier("… et ajoute bien un siège à celle qui est au tarif",
  n2.quota_ia_mois === 2 * Number(PAR_SIEGE), JSON.stringify(n2));

/* On se sert de « compteA » pour que la variable ne soit pas un décor
   inutile : la bibliothèque réglée a bien deux membres à la fin. */
const membres = await banc.q(
  "select count(*)::int n from membres where tenant_id = $1", [reglee]);
verifier("le décor a bien deux membres, dont celui d'avant la livraison",
  membres[0].n === 2 && Boolean(compteA), JSON.stringify(membres[0]));

await banc.fermer();

console.log("\n=== Reprise de la tarification ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
