/* =========================================================================
   LE CATALOGUE PARTAGÉ : RIEN NE SE PERD, RIEN NE FUIT

   Deux questions distinctes, et il faut les deux.

   LA MIGRATION PERD-ELLE QUELQUE CHOSE ? Une reprise de données ne signale
   pas ses oublis : une jointure qui ne trouve pas sa clé rend moins de
   lignes, sans erreur. Le 15/08/2026, cette migration perdait TOUTE la
   sphère personnelle — elle s'exécutait sous le cloisonnement qu'elle
   migrait, et ne voyait donc que les ouvrages publics.

   LE PARTAGE FAIT-IL FUIR ? Mutualiser le catalogue et les résumés, c'est
   accepter que des données traversent la frontière entre bibliothèques. Ce
   qui traverse doit être exactement : ce que le livre EST. Jamais ce qu'on
   en fait, ni le fait qu'on le possède.

   USAGE
     node tests/test-catalogue.mjs
     PGURL=... PGURL_OEIL=... node tests/test-catalogue.mjs        (CI)
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

process.on("uncaughtException",  (e) => bilan(e));
process.on("unhandledRejection", (e) => bilan(e instanceof Error ? e : new Error(String(e))));

const DB = ["db", path.join("..", "db")].find(c => fs.existsSync(path.join(c, "01-schema.sql")));
if (!DB) { console.error("  ECHEC db/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const FICHIERS = ["01-schema.sql", "02-multi-locataire.sql", "03-catalogue.sql"];

/* --------------------------------------------------- Monter PostgreSQL */

let moteur = null, url = process.env.PGURL;
if (!url) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  moteur = new EmbeddedPostgres({
    databaseDir: fs.mkdtempSync("/tmp/biblio-cat-"),
    user: "postgres", password: "postgres", port: 55499, persistent: false,
  });
  await moteur.initialise();
  await moteur.start();
  const admin = new pg.Client({
    host: "127.0.0.1", port: 55499, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("create role biblio login password 'controle' nosuperuser nobypassrls");
  await admin.query("create database biblio owner biblio");
  await admin.end();
  url = "postgres://biblio:controle@127.0.0.1:55499/biblio";
}

const u = new URL(url);
const appli = new pg.Client({ connectionString: url });   // le compte de l'API
await appli.connect();

/* L'observateur est privilégié et SÉPARÉ : il doit voir ce que la base
   contient réellement, y compris ce que le cloisonnement cache à l'API. */
const oeil = new pg.Client(process.env.PGURL_OEIL ?? {
  host: u.hostname, port: u.port, database: u.pathname.slice(1),
  user: "postgres", password: "postgres",
});
await oeil.connect();
const q = (t, p) => oeil.query(t, p).then(r => r.rows);

/* Le schéma est appliqué par le PROPRIÉTAIRE — comme sur le serveur. */
for (const f of FICHIERS.slice(0, 2)) {
  await appli.query(fs.readFileSync(path.join(DB, f), "utf8"));
}

/* ------------------------------------------- Des données représentatives */

const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
const [amie] = await q(
  `insert into tenants (identifiant, nom, visibilite) values ('amie','Amie','publique')
   returning id`);

const poser = (tenant, id, isbn, titre, visibilite, sphere = "Pro") => q(
  `insert into books (id,isbn,titre,auteur,categorie,sous_categorie,sphere,tenant_id,visibilite)
   values ($1,$2,$3,'Auteur','Savoirs','Philosophie',$4,$5,$6)`,
  [id, isbn, titre, sphere, tenant, visibilite]);

// Le même ISBN, écrit différemment : les tirets ne doivent pas empêcher
// la mise en commun.
await poser(xavier.id, "x1", "978-2-07-036822-8", "Ouvrage commun", "publique");
await poser(amie.id,  "a1", "9782070368228",     "Ouvrage commun", "publique");

// LE CAS QUI A RÉVÉLÉ LE DÉFAUT : un ouvrage privé, personnel.
await poser(xavier.id, "x-prive", "9782020000001", "Journal intime", "privee", "Perso");

// Un ASIN Amazon déguisé en ISBN : il ne doit RIEN mutualiser.
await poser(xavier.id, "x-asin", "978B0DBJSMPWV", "Chez xavier",  "publique");
await poser(amie.id,  "a-asin", "978B0DBJSMPWV", "Chez l amie",   "publique");

// Deux résumés pour le même ouvrage : le plus récent doit gagner.
await q(`insert into resumes (tenant_id,book_id,langue,resume,modele,fiabilite,genere_le)
         values ($1,'x1','fr','Ancien résumé','m','haute', now() - interval '2 days'),
                ($2,'a1','fr','Résumé récent','m','haute', now()),
                ($1,'x-prive','fr','Ce que je lis en secret','m','haute', now())`,
        [xavier.id, amie.id]);

const avant = (await q("select count(*)::int n from books"))[0].n;

/* ------------------------------------------------------- La migration */

await appli.query(fs.readFileSync(path.join(DB, "03-catalogue.sql"), "utf8"));

/* ------------------------------------------------------ Rien ne se perd */

const possessions = await q("select tenant_id, id, ouvrage_id from possessions order by id");
verifier("autant de possessions que d'ouvrages d'origine",
  possessions.length === avant, `${possessions.length} au lieu de ${avant}`);

verifier("L'OUVRAGE PRIVÉ A SURVÉCU À LA MIGRATION",
  possessions.some(p => p.id === "x-prive"),
  JSON.stringify(possessions.map(p => p.id)));

const perdus = await q(
  `select b.id from books b
    where not exists (select 1 from possessions p
                       where p.tenant_id = b.tenant_id and p.id = b.id)`);
verifier("aucun ouvrage n'est resté en arrière", perdus.length === 0,
  JSON.stringify(perdus.map(r => r.id)));

/* ------------------------------------------------------- La mutualisation */

const ouvrages = await q("select id, cle, isbn, titre from ouvrages order by cle");
verifier("le même ISBN, écrit avec ou sans tirets, ne fait qu'un ouvrage",
  ouvrages.filter(o => o.isbn === "9782070368228").length === 1,
  JSON.stringify(ouvrages.map(o => o.cle)));

const commun = possessions.filter(p => ["x1", "a1"].includes(p.id));
verifier("les deux bibliothèques pointent le même ouvrage",
  commun.length === 2 && commun[0].ouvrage_id === commun[1].ouvrage_id,
  JSON.stringify(commun));

const asins = possessions.filter(p => p.id.endsWith("asin"));
verifier("un ASIN déguisé en ISBN ne mutualise RIEN",
  asins.length === 2 && asins[0].ouvrage_id !== asins[1].ouvrage_id,
  JSON.stringify(asins));

verifier("les ouvrages sans ISBN portent une clé qui le dit",
  ouvrages.filter(o => o.cle.startsWith("local:")).length === 2,
  JSON.stringify(ouvrages.map(o => o.cle)));

/* ---------------------------------------------------------- Les résumés */

const partages = await q(
  `select o.cle, r.resume from resumes_ouvrages r join ouvrages o on o.id = r.ouvrage_id
    order by o.cle`);
verifier("un seul résumé pour l'ouvrage commun",
  partages.filter(p => p.cle === "isbn:9782070368228").length === 1,
  JSON.stringify(partages));

verifier("et c'est le plus récent qui a été retenu",
  partages.find(p => p.cle === "isbn:9782070368228")?.resume === "Résumé récent",
  JSON.stringify(partages.find(p => p.cle === "isbn:9782070368228")));

/* ============================================================ CE QUI FUIT

   À partir d'ici on interroge la base COMME L'APPLICATION : par le compte
   « biblio », soumis aux politiques, avec un locataire posé ou non.
   ========================================================================= */

const dans = async (tenant, requete, params) => {
  await appli.query("begin");
  await appli.query("select set_config('app.tenant_id', $1, true)", [tenant ?? ""]);
  try { return (await appli.query(requete, params)).rows; }
  finally { await appli.query("commit"); }
};

/* Le catalogue est lisible par tous : c'est le principe même du partage,
   et il ne contient que des faits bibliographiques. */
const catalogueVisiteur = await dans(null, "select cle from ouvrages");
verifier("un visiteur peut lire le catalogue",
  catalogueVisiteur.length === ouvrages.length,
  `${catalogueVisiteur.length} au lieu de ${ouvrages.length}`);

/* Mais il ne dit RIEN de qui possède quoi. */
const vuVisiteur = await dans(null, "select id from livres order by id");
verifier("le visiteur ne voit que les possessions publiques",
  JSON.stringify(vuVisiteur.map(r => r.id)) === JSON.stringify(["a-asin", "a1", "x-asin", "x1"]),
  JSON.stringify(vuVisiteur.map(r => r.id)));

const vuXavier = await dans(xavier.id, "select id from livres order by id");
verifier("xavier voit ses trois ouvrages, et eux seuls",
  JSON.stringify(vuXavier.map(r => r.id)) === JSON.stringify(["x-asin", "x-prive", "x1"]),
  JSON.stringify(vuXavier.map(r => r.id)));

/* LE POINT DÉLICAT DU PARTAGE.

   Le résumé d'un ouvrage que seule xavier possède, et qu'il garde privé, ne
   doit pas être lisible par l'amie — l'existence même du résumé dirait
   qu'il possède ce livre. */
const [ouvragePrive] = await q(
  `select ouvrage_id from possessions where id = 'x-prive'`);
const chezLAmie = await dans(amie.id,
  "select resume from resumes_ouvrages where ouvrage_id = $1", [ouvragePrive.ouvrage_id]);
verifier("le résumé d'un ouvrage privé d'autrui n'est pas lisible",
  chezLAmie.length === 0, JSON.stringify(chezLAmie));

const chezXavier = await dans(xavier.id,
  "select resume from resumes_ouvrages where ouvrage_id = $1", [ouvragePrive.ouvrage_id]);
verifier("mais son propriétaire le lit sans peine",
  chezXavier[0]?.resume === "Ce que je lis en secret", JSON.stringify(chezXavier));

/* Et le résumé d'un ouvrage public se lit de partout — sans quoi les pages
   publiques n'auraient rien à montrer. */
const [ouvrageCommun] = await q("select ouvrage_id from possessions where id = 'x1'");
const chezVisiteur = await dans(null,
  "select resume from resumes_ouvrages where ouvrage_id = $1", [ouvrageCommun.ouvrage_id]);
verifier("le résumé d'un ouvrage public se lit même sans compte",
  chezVisiteur[0]?.resume === "Résumé récent", JSON.stringify(chezVisiteur));

/* ------------------------------------------- Écrire dans le bien commun */

let refuse = false;
try {
  await dans(null, `insert into ouvrages (cle, titre, auteur) values ('isbn:0000000000000','Intrus','X')`);
} catch { refuse = true; }
verifier("un visiteur anonyme ne peut pas écrire dans le catalogue", refuse);

/* Corriger un ouvrage qu'on ne possède pas changerait l'affichage de tous
   les autres. La politique ne le permet pas — et une modification refusée
   par la RLS ne lève PAS d'erreur : elle touche zéro ligne. C'est donc le
   contenu qu'il faut regarder, pas l'absence d'exception. */
const [asinDeLAmie] = await q("select ouvrage_id from possessions where id = 'a-asin'");
await dans(xavier.id,
  "update ouvrages set titre = 'TITRE REECRIT PAR UN INTRUS' where id = $1",
  [asinDeLAmie.ouvrage_id]);
const [apres] = await q("select titre from ouvrages where id = $1", [asinDeLAmie.ouvrage_id]);
verifier("on ne corrige pas un ouvrage qu'on ne possède pas",
  apres?.titre === "Chez l amie", JSON.stringify(apres));

/* Alors qu'un ouvrage qu'on possède, oui : c'est ainsi que les couvertures
   et les paginations s'améliorent pour tout le monde. */
const [aSoi] = await q("select ouvrage_id from possessions where id = 'x-asin'");
await dans(xavier.id,
  "update ouvrages set pages = 314 where id = $1", [aSoi.ouvrage_id]);
const [corrige] = await q("select pages from ouvrages where id = $1", [aSoi.ouvrage_id]);
verifier("mais on corrige bien le sien",
  corrige?.pages === 314, JSON.stringify(corrige));

/* ------------------------------------------------------ Rejouer la migration */

await appli.query(fs.readFileSync(path.join(DB, "03-catalogue.sql"), "utf8"));
const apresRejeu = (await q("select count(*)::int n from possessions"))[0].n;
verifier("rejouer la migration ne duplique rien",
  apresRejeu === possessions.length, `${apresRejeu} au lieu de ${possessions.length}`);

const forceRemise = await q(
  `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'books'`);
verifier("le cloisonnement de books est bien remis après la reprise",
  forceRemise[0]?.relrowsecurity === true && forceRemise[0]?.relforcerowsecurity === true,
  JSON.stringify(forceRemise[0]));

/* -------------------------------------------- Un contrôle sur la FORME

   Retirer « security_invoker » de la vue ne fait tomber aucun contrôle de
   comportement, et c'est explicable : le propriétaire de la vue est
   « biblio », c'est-à-dire le rôle même dont l'API se sert, et « force row
   level security » le soumet aux politiques. Les deux configurations se
   comportent donc pareil ICI.

   Elles cessent de se comporter pareil dès que la vue est créée par
   quelqu'un d'autre — un correctif appliqué à la main en superutilisateur,
   par exemple. La vue traverserait alors toutes les politiques, en ayant
   l'air d'un simple raccourci de lecture.

   On vérifie donc l'attribut lui-même. C'est un contrôle de forme, moins
   satisfaisant qu'un contrôle de comportement, et il vaut mieux le dire
   que de laisser croire que la propriété est éprouvée. */
const [vue] = await q(
  `select reloptions from pg_class where relname = 'livres' and relkind = 'v'`);
verifier("la vue livres porte bien security_invoker",
  (vue?.reloptions ?? []).some(o => /^security_invoker=(true|on)$/i.test(o)),
  JSON.stringify(vue?.reloptions));

/* --------------------------------------------------------------- Bilan */

await bilan();

/* Le bilan doit sortir MÊME SI LE SCRIPT S'EFFONDRE.

   Mesuré le 15/08/2026 : en faisant repasser la migration sous le
   cloisonnement — le défaut qui détruisait la sphère personnelle — le
   fichier mourait sur un « Cannot read properties of undefined » et
   n'imprimait rien. Les trois vérifications qui avaient déjà échoué ne
   s'affichaient pas.

   Un banc d'essai qui meurt sans rien dire est indiscernable, pour qui lit
   la sortie, d'un banc qui n'a rien trouvé. */
async function bilan(erreur) {
  await appli.end().catch(() => {});
  await oeil.end().catch(() => {});
  if (moteur) await moteur.stop().catch(() => {});

  if (erreur) ko.push("le contrôle s'est interrompu : " + erreur.message);

  console.log("\n=== Catalogue partagé ===\n");
  ok.forEach(o => console.log("  ok   " + o));
  if (ko.length) {
    console.log("");
    ko.forEach(e => console.log("  KO   " + e));
    console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
    process.exit(1);
  }
  console.log(`\n${ok.length} vérifications, aucune erreur.`);
}
