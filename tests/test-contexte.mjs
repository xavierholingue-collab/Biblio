/* =========================================================================
   LE CONTEXTE DE LOCATAIRE NE FUIT PAS D'UNE REQUÊTE À L'AUTRE

   Éprouve avecContexte() avec un pool d'UNE SEULE connexion — de sorte que
   toutes les requêtes se succèdent forcément sur la même, ce qui est
   précisément le cas dangereux.

   POURQUOI UNE SEULE CONNEXION

   La fuite par recyclage est invisible en développement : il faut que le
   pool rende la même connexion à deux locataires différents. Avec huit
   connexions et deux requêtes, cela n'arrive jamais. En production, sous
   charge, cela arrive tout le temps.

   Forcer max=1 rend le cas certain plutôt qu'improbable. Un contrôle qui ne
   déclenche la condition qu'une fois sur mille ne contrôle rien.

   USAGE
     node tests/test-contexte.mjs
   ========================================================================= */

import pg from "pg";
import { ouvrirBanc } from "./banc-postgres.mjs";
import { avecContexte, avecVisiteur, locataireCourant } from "../api/locataire.mjs";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const banc = await ouvrirBanc({ port: 55505 });
const { q, semer, locataire } = banc;

const alice = await locataire("alice", "privee");
const bob   = await locataire("bob",   "privee");

await semer({ tenant: alice, id: "a1", isbn: "9791000000001" });
await semer({ tenant: alice, id: "a2", isbn: "9791000000002" });
await semer({ tenant: bob,   id: "b1", isbn: "9791000000003" });

/* Le pool tel que l'API le monte, mais bridé à UNE connexion. Aucun
   « set role » ici : le compte est déjà celui de la production, soumis aux
   politiques par « force row level security ». */
const bd = new pg.Pool({
  host: banc.env.PGHOST, port: Number(banc.env.PGPORT),
  user: banc.env.PGUSER, password: banc.env.PGPASSWORD,
  database: banc.env.PGDATABASE, max: 1,
});

const [verif] = (await bd.query(
  `select usesuper from pg_user where usename = current_user`)).rows;
verifier("le pool se connecte avec un compte non privilégié",
  verif?.usesuper === false, JSON.stringify(verif));

const compter = (client) => client.query("select id from livres order by id")
  .then(r => r.rows.map(x => x.id));

/* ------------------------------------------------------ Ce qu'on attend */

verifier("alice ne voit que ses ouvrages",
  JSON.stringify(await avecContexte(bd, alice, compter)) === JSON.stringify(["a1", "a2"]),
  JSON.stringify(await avecContexte(bd, alice, compter)));

verifier("bob ne voit que le sien",
  JSON.stringify(await avecContexte(bd, bob, compter)) === JSON.stringify(["b1"]),
  JSON.stringify(await avecContexte(bd, bob, compter)));

/* ------------------------------------- Le cas qui motive tout ce fichier */

// Alice, puis un VISITEUR, sur la même connexion. Les deux bibliothèques
// sont privées : le visiteur ne doit rien voir du tout.
await avecContexte(bd, alice, compter);
const vuParVisiteur = await avecVisiteur(bd, compter);
verifier("un visiteur n'hérite pas du locataire précédent",
  vuParVisiteur.length === 0, JSON.stringify(vuParVisiteur));

await avecContexte(bd, alice, compter);
const vuParBob = await avecContexte(bd, bob, compter);
verifier("bob n'hérite pas du contexte d'alice",
  JSON.stringify(vuParBob) === JSON.stringify(["b1"]), JSON.stringify(vuParBob));

// Et après une transaction qui ÉCHOUE : le rollback doit aussi défaire le
// contexte. Une erreur applicative ne doit pas laisser un locataire posé.
try {
  await avecContexte(bd, alice, async (c) => {
    await c.query("select 1");
    throw new Error("panne simulée en plein travail");
  });
} catch { /* attendu */ }
const apresEchec = await avecVisiteur(bd, compter);
verifier("après une transaction en échec, le contexte est défait",
  apresEchec.length === 0, JSON.stringify(apresEchec));

/* LE CAS QUI JUSTIFIE LA PORTÉE « TRANSACTION ».

   Une requête lancée SANS passer par avecContexte — bd.query() directement.
   Si set_config était posé pour la SESSION, elle hériterait du locataire de
   la requête précédente sur la même connexion, et rendrait ses ouvrages.

   Vérifié le 15/08/2026 : sans ce contrôle, remplacer « true » par « false »
   dans locataire.mjs ne faisait échouer aucune vérification. La
   justification écrite en tête du fichier était juste, mais rien ne
   l'éprouvait. */
await avecContexte(bd, alice, compter);
const horsContexte = (await bd.query("select id from livres order by id")).rows.map(r => r.id);
verifier("une requête hors contexte n'hérite d'aucun locataire",
  horsContexte.length === 0, JSON.stringify(horsContexte));

/* On interroge la BASE, pas l'application : ce que PostgreSQL applique
   réellement, et non ce que le code croit avoir posé. */
const dansLaBase = await avecContexte(bd, bob, locataireCourant);
verifier("la base voit bien le locataire demandé", dansLaBase === bob,
  `${dansLaBase} au lieu de ${bob}`);
const chezLeVisiteur = await avecVisiteur(bd, locataireCourant);
verifier("le contexte visiteur est vide côté base", chezLeVisiteur === null,
  String(chezLeVisiteur));

/* ------------------------------------------------- Un identifiant douteux */

for (const [nom, valeur] of [
  ["une chaîne quelconque", "pas-un-uuid"],
  ["une tentative d'injection", "', true); drop table possessions; --"],
  ["une chaîne vide", ""],
]) {
  let refuse = false;
  try { await avecContexte(bd, valeur, compter); } catch { refuse = true; }
  verifier(`refus : ${nom}`, refuse);
}
const survivants = await avecContexte(bd, alice, compter);
verifier("la table des possessions existe toujours", survivants.length === 2,
  JSON.stringify(survivants));

/* --------------------------------------------------------------- Bilan */

await bd.end();
await banc.fermer();

console.log("\n=== Contexte de locataire ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
