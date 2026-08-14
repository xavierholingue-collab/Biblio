/* =========================================================================
   CLOISONNEMENT ET VISIBILITÉ — le contrôle qui compte

   Éprouve la Row-Level Security et la règle de visibilité sur un PostgreSQL
   réel (PGlite), SOUS LE RÔLE APPLICATIF.

   POURQUOI « SOUS LE RÔLE APPLICATIF » EST ÉCRIT EN MAJUSCULES

   Le 15/08/2026, la première version de ce test s'exécutait en
   superutilisateur. Les politiques étaient en place, correctement écrites,
   et alice voyait les données de bob : un superutilisateur contourne toute
   la RLS, silencieusement. Le test aurait déclaré le cloisonnement conforme
   en ne prouvant strictement rien.

   Un contrôle de sécurité qui ne peut pas échouer est pire que pas de
   contrôle : il donne la tranquillité sans la garantie.

   USAGE
     node tests/test-cloisonnement.mjs
   ========================================================================= */

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const CANDIDATS = ["db", path.join("..", "db"), path.join(process.cwd(), "db")];
const DB = CANDIDATS.find(c => fs.existsSync(path.join(c, "01-schema.sql")));
if (!DB) { console.error("  ECHEC db/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, condition, detail) =>
  (condition ? ok : ko).push(nom + (condition ? "" : " — " + (detail ?? "")));

const db = await PGlite.create();
for (const f of ["01-schema.sql", "02-multi-locataire.sql"]) {
  await db.exec(fs.readFileSync(path.join(DB, f), "utf8"));
}
verifier("les deux schémas s'appliquent", true);

/* Deux locataires, et de quoi éprouver les huit combinaisons de visibilité. */
const t = async (sql, p) => (await db.query(sql, p)).rows;

const [alice] = await t(
  `insert into tenants (identifiant, nom, visibilite) values ('alice','Alice','publique')
   returning id`);
const [bob] = await t(
  `insert into tenants (identifiant, nom, visibilite) values ('bob','Bob','privee')
   returning id`);

const poser = async (tenant, id, sous, vis) =>
  db.query(`insert into books (id,isbn,titre,auteur,categorie,sous_categorie,sphere,tenant_id,visibilite)
            values ($1,'978'||$1,'T'||$1,'A','Académique',$2,'Pro',$3,$4)`,
           [id, sous, tenant, vis]);

// Chez alice (bibliothèque PUBLIQUE)
await poser(alice.id, "a-pub",  "Philosophie", "publique");
await poser(alice.id, "a-priv", "Philosophie", "privee");
await poser(alice.id, "a-her",  "Philosophie", "heritee");
await poser(alice.id, "a-her-rayonpriv", "Économie", "heritee");
await poser(alice.id, "a-pub-rayonpriv", "Économie", "publique");
await db.query(`insert into rayons_reglages (tenant_id,categorie,sous_categorie,visibilite)
                values ($1,'Académique','Économie','privee')`, [alice.id]);

// Chez bob (bibliothèque PRIVÉE) — dont un ouvrage explicitement public
await poser(bob.id, "b-pub", "Philosophie", "publique");
await poser(bob.id, "b-her", "Philosophie", "heritee");

/* Le rôle applicatif : ni superutilisateur, ni BYPASSRLS — comme « biblio »
   en production, vérifié le 15/08/2026 (rolsuper=f, rolbypassrls=f). */
await db.exec(`
  create role app nosuperuser nobypassrls;
  grant usage on schema public to app;
  grant select, insert, update, delete on all tables in schema public to app;
`);
await db.exec("set role app");

const titres = async () =>
  (await db.query("select id from books order by id")).rows.map(r => r.id);

/* ------------------------------------------------- 1. Le cloisonnement */

/* set_config() plutôt que SET : la commande SET n'accepte pas de paramètre.
   Côté API, cela compte doublement — interpoler un identifiant dans une
   chaîne SET ouvrirait une injection SQL au cœur du mécanisme censé isoler
   les locataires. La forme paramétrée est la seule sûre. */
const poserLocataire = (id) => db.query("select set_config('app.tenant_id', $1, false)", [id ?? ""]);

await poserLocataire("");
const vusVisiteur = await titres();
verifier("sans locataire, un visiteur ne voit QUE du public",
  JSON.stringify(vusVisiteur) === JSON.stringify(["a-her", "a-pub", "a-pub-rayonpriv"]),
  JSON.stringify(vusVisiteur));

await poserLocataire(alice.id);
const vusAlice = await titres();
verifier("alice voit ses cinq ouvrages", vusAlice.length === 5, JSON.stringify(vusAlice));
verifier("alice ne voit AUCUN ouvrage de bob",
  !vusAlice.some(x => x.startsWith("b-")), JSON.stringify(vusAlice));

await poserLocataire(bob.id);
const vusBob = await titres();
/* Un locataire connecté ne voit QUE sa bibliothèque — pas même les ouvrages
   publics des autres. Sans quoi sa liste, ses statistiques et sa mosaïque
   mêleraient les livres d'inconnus aux siens. */
verifier("bob ne voit aucun ouvrage d'alice, même public",
  !vusBob.some(x => x.startsWith("a-")), JSON.stringify(vusBob));
verifier("bob voit ses deux ouvrages", vusBob.length === 2, JSON.stringify(vusBob));

/* L'écriture aussi : lire n'est pas le seul risque. */
await poserLocataire(alice.id);
const maj = await db.query("update books set titre = 'DETOURNE' where id = 'b-pub'");
verifier("alice ne peut pas MODIFIER un ouvrage de bob",
  (maj.affectedRows ?? 0) === 0, `${maj.affectedRows} ligne(s) modifiée(s)`);

let refusInsertion = false;
try {
  await db.query(`insert into books (id,isbn,titre,auteur,categorie,sous_categorie,sphere,tenant_id)
                  values ('intrus','978x','X','A','Académique','Philosophie','Pro',$1)`, [bob.id]);
} catch { refusInsertion = true; }
verifier("alice ne peut pas ÉCRIRE chez bob", refusInsertion);

/* ------------------------------------ 2. La règle de visibilité publique */

await poserLocataire("");
const publics = await titres();

const attendu = [
  ["biblio publique + ouvrage public",              "a-pub",           true],
  ["biblio publique + ouvrage privé",               "a-priv",          false],
  ["biblio publique + ouvrage hérité",              "a-her",           true],
  ["biblio publique + rayon privé + ouvrage hérité","a-her-rayonpriv", false],
  ["biblio publique + rayon privé + ouvrage public","a-pub-rayonpriv", true],
  ["biblio PRIVÉE + ouvrage public → invisible",    "b-pub",           false],
  ["biblio PRIVÉE + ouvrage hérité",                "b-her",           false],
];
for (const [nom, id, doitEtreVisible] of attendu) {
  verifier(nom, publics.includes(id) === doitEtreVisible,
    publics.includes(id) ? "visible" : "invisible");
}

/* Le verrou maître : bob ferme, plus rien ne sort — même l'ouvrage public. */
await db.exec("reset role");
await db.query("update tenants set visibilite = 'publique' where id = $1", [bob.id]);
await db.exec("set role app");
await poserLocataire("");
verifier("bob ouvre sa bibliothèque : son ouvrage public apparaît",
  (await titres()).includes("b-pub"));

await db.exec("reset role");
await db.query("update tenants set visibilite = 'privee' where id = $1", [bob.id]);
await db.exec("set role app");
await poserLocataire("");
const apresFermeture = await titres();
verifier("bob referme : TOUT disparaît, y compris l'ouvrage public",
  !apresFermeture.some(x => x.startsWith("b-")), JSON.stringify(apresFermeture));

/* ------------------------------------------- 3. Les résumés suivent */

await db.exec("reset role");
await db.query(`insert into resumes (tenant_id, book_id, langue, resume)
                values ($1,'a-priv','fr','résumé d un ouvrage privé')`, [alice.id]);
await db.query(`insert into resumes (tenant_id, book_id, langue, resume)
                values ($1,'a-pub','fr','résumé public'), ($1,'a-pub','en','public summary')`,
               [alice.id]);
await db.exec("set role app");
await poserLocataire("");
const res = (await db.query("select book_id, langue from resumes order by book_id, langue")).rows;
verifier("le résumé d'un ouvrage privé n'est pas lisible publiquement",
  !res.some(r => r.book_id === "a-priv"), JSON.stringify(res));
verifier("les deux langues d'un ouvrage public sont lisibles",
  res.filter(r => r.book_id === "a-pub").length === 2, JSON.stringify(res));

/* --------------------------------------------------------------- Bilan */

console.log("\n=== Cloisonnement et visibilité ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
