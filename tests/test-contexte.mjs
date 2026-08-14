/* =========================================================================
   LE CONTEXTE DE LOCATAIRE NE FUIT PAS D'UNE REQUÊTE À L'AUTRE

   Éprouve avecContexte() sur un vrai PostgreSQL, avec un pool d'UNE SEULE
   connexion — de sorte que toutes les requêtes se succèdent forcément sur la
   même, ce qui est précisément le cas dangereux.

   POURQUOI UNE SEULE CONNEXION

   La fuite par recyclage de connexion est invisible en développement : il
   faut que le pool rende la même connexion à deux locataires différents.
   Avec huit connexions et deux requêtes, cela n'arrive jamais. En
   production, sous charge, cela arrive tout le temps.

   Forcer max=1 rend le cas certain plutôt qu'improbable. Un contrôle qui ne
   déclenche la condition qu'une fois sur mille ne contrôle rien.

   USAGE
     node tests/test-contexte.mjs
   ========================================================================= */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { avecContexte, avecVisiteur, locataireCourant } from "../api/locataire.mjs";

const CANDIDATS = ["db", path.join("..", "db"), path.join(process.cwd(), "db")];
const DB = CANDIDATS.find(c => fs.existsSync(path.join(c, "01-schema.sql")));
if (!DB) { console.error("  ECHEC db/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const pglite = await PGlite.create();
for (const f of ["01-schema.sql", "02-multi-locataire.sql"]) {
  await pglite.exec(fs.readFileSync(path.join(DB, f), "utf8"));
}

const [alice] = (await pglite.query(
  `insert into tenants (identifiant, nom, visibilite) values ('alice','Alice','privee')
   returning id`)).rows;
const [bob] = (await pglite.query(
  `insert into tenants (identifiant, nom, visibilite) values ('bob','Bob','privee')
   returning id`)).rows;

const poser = (tenant, id) => pglite.query(
  `insert into books (id,isbn,titre,auteur,categorie,sous_categorie,sphere,tenant_id)
   values ($1,'978'||$1,'T'||$1,'A','Académique','Philosophie','Pro',$2)`, [id, tenant]);
await poser(alice.id, "a1");
await poser(alice.id, "a2");
await poser(bob.id, "b1");

await pglite.exec(`
  create role app nosuperuser nobypassrls login password 'x';
  grant usage on schema public to app;
  grant select, insert, update, delete on all tables in schema public to app;
`);

const serveur = new PGLiteSocketServer({ db: pglite, port: 55460, host: "127.0.0.1" });
await serveur.start();

/* UNE SEULE connexion : toutes les requêtes se suivent sur la même. */
const bd = new pg.Pool({
  host: "127.0.0.1", port: 55460, user: "app", database: "postgres", max: 1,
});

/* « set role » à chaque nouvelle connexion — et il faut dire pourquoi.

   Le pont PGlite IGNORE l'utilisateur demandé dans la chaîne de connexion :
   vérifié le 15/08/2026, current_user vaut « postgres », superutilisateur.
   Or un superutilisateur contourne toute la RLS. Sans cette ligne, ce
   fichier passait au vert en montrant à chacun la bibliothèque de tous.

   En production, l'API se connecte réellement comme « biblio », qui n'est
   ni superutilisateur ni BYPASSRLS (vérifié le 15/08/2026). Le « set role »
   ne fait donc que rétablir ici la condition qui existe là-bas — il ne
   masque rien, il corrige le banc d'essai. */
bd.on("connect", (c) => { c.query("set role app"); });
await bd.query("select 1");

const compter = (client) => client.query("select id from books order by id")
  .then(r => r.rows.map(x => x.id));

/* ------------------------------------------------------ Ce qu'on attend */

verifier("alice ne voit que ses ouvrages",
  JSON.stringify(await avecContexte(bd, alice.id, compter)) === JSON.stringify(["a1", "a2"]),
  JSON.stringify(await avecContexte(bd, alice.id, compter)));

verifier("bob ne voit que le sien",
  JSON.stringify(await avecContexte(bd, bob.id, compter)) === JSON.stringify(["b1"]),
  JSON.stringify(await avecContexte(bd, bob.id, compter)));

/* ------------------------------------- Le cas qui motive tout ce fichier */

// Alice, puis un VISITEUR, sur la même connexion. Le visiteur ne doit rien
// hériter : les deux bibliothèques sont privées, il ne voit donc rien.
await avecContexte(bd, alice.id, compter);
const vuParVisiteur = await avecVisiteur(bd, compter);
verifier("un visiteur n'hérite pas du locataire précédent",
  vuParVisiteur.length === 0, JSON.stringify(vuParVisiteur));

// Alice, puis Bob, sur la même connexion.
await avecContexte(bd, alice.id, compter);
const vuParBob = await avecContexte(bd, bob.id, compter);
verifier("bob n'hérite pas du contexte d'alice",
  JSON.stringify(vuParBob) === JSON.stringify(["b1"]), JSON.stringify(vuParBob));

// Et après une transaction qui ÉCHOUE : le rollback doit aussi défaire le
// contexte. Une erreur applicative ne doit pas laisser un locataire posé.
try {
  await avecContexte(bd, alice.id, async (c) => {
    await c.query("select 1");
    throw new Error("panne simulée en plein travail");
  });
} catch { /* attendu */ }
const apresEchec = await avecVisiteur(bd, compter);
verifier("après une transaction en échec, le contexte est défait",
  apresEchec.length === 0, JSON.stringify(apresEchec));

/* LE CAS QUI JUSTIFIE LA PORTÉE « TRANSACTION ».

   Une requête lancée SANS passer par avecContexte — bd.query() directement,
   comme le fait tout le code existant du serveur. Si set_config était posé
   pour la SESSION, cette requête hériterait du locataire de la requête
   précédente sur la même connexion, et rendrait ses ouvrages.

   Vérifié le 15/08/2026 : sans ce contrôle, remplacer « true » par « false »
   dans locataire.mjs ne faisait échouer aucune vérification. La justification
   écrite en tête du fichier était donc juste, mais rien ne l'éprouvait. */
await avecContexte(bd, alice.id, compter);
const horsContexte = (await bd.query("select id from books order by id")).rows.map(r => r.id);
verifier("une requête hors contexte n'hérite d'aucun locataire",
  horsContexte.length === 0, JSON.stringify(horsContexte));

/* On interroge la BASE, pas l'application : ce que PostgreSQL applique
   réellement, et non ce que le code croit avoir posé. */
const dansLaBase = await avecContexte(bd, bob.id, locataireCourant);
verifier("la base voit bien le locataire demandé", dansLaBase === bob.id,
  `${dansLaBase} au lieu de ${bob.id}`);
const chezLeVisiteur = await avecVisiteur(bd, locataireCourant);
verifier("le contexte visiteur est vide côté base", chezLeVisiteur === null,
  String(chezLeVisiteur));

/* ------------------------------------------------- Un identifiant douteux */

for (const [nom, valeur] of [
  ["une chaîne quelconque", "pas-un-uuid"],
  ["une tentative d'injection", "', true); drop table books; --"],
  ["une chaîne vide", ""],
]) {
  let refuse = false;
  try { await avecContexte(bd, valeur, compter); } catch { refuse = true; }
  verifier(`refus : ${nom}`, refuse);
}
const survivants = await avecContexte(bd, alice.id, compter);
verifier("la table books existe toujours", survivants.length === 2);

/* --------------------------------------------------------------- Bilan */

await bd.end(); await serveur.stop();

console.log("\n=== Contexte de locataire ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
