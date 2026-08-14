/* =========================================================================
   LA MATRICE DE VISIBILITÉ, ÉPROUVÉE CAS PAR CAS

   Trois niveaux de réglage — bibliothèque, rayon, ouvrage — font huit
   combinaisons. Une règle de visibilité ne se vérifie pas « en gros » : ce
   sont les cas particuliers qui font sortir une donnée, et ils ne se
   présentent jamais pendant qu'on regarde.

   LA RÈGLE, EN DEUX PHRASES

     La bibliothèque est un VERROU MAÎTRE : privée, elle ferme tout, sans
     exception. Un ouvrage explicitement public dans une bibliothèque privée
     reste invisible. C'est la seule règle qu'on tient en tête, et la seule
     où le geste de panique — « je passe tout en privé » — fonctionne.

     Sous ce verrou, le plus précis l'emporte : l'ouvrage prime sur le rayon,
     qui prime sur la bibliothèque. Et SANS AUCUNE DÉCISION, rien ne sort.

   ---------------------------------------------------------------------------
   CE FICHIER TOURNAIT SUR PGlite JUSQU'AU 15/08/2026.

   Deux raisons de l'avoir déplacé sur un vrai PostgreSQL :

     — PGlite n'a qu'UNE session. L'observateur et l'observé la partagent,
       et le contrôle finit par mesurer sa propre cécité.
     — son unique rôle est superutilisateur, qui traverse toutes les
       politiques EN SILENCE. Ce fichier a passé au vert, deux fois, en
       montrant à chacun la bibliothèque de tous.

   USAGE
     node tests/test-cloisonnement.mjs
   ========================================================================= */

import { ouvrirBanc } from "./banc-postgres.mjs";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const banc = await ouvrirBanc({ port: 55503 });
const { q, dans, semer, resumer, locataire } = banc;

/* --------------------------------------------------------- Le montage */

const alice = await locataire("alice", "publique");
const bob   = await locataire("bob",   "privee");

// Chez alice, bibliothèque PUBLIQUE.
await semer({ tenant: alice, id: "a-pub",  isbn: "9790000000001", visibilite: "publique" });
await semer({ tenant: alice, id: "a-priv", isbn: "9790000000002", visibilite: "privee" });
await semer({ tenant: alice, id: "a-her",  isbn: "9790000000003", visibilite: "heritee" });
await semer({ tenant: alice, id: "a-her-rayonpriv", isbn: "9790000000004",
              sous_categorie: "Économie", visibilite: "heritee" });
await semer({ tenant: alice, id: "a-pub-rayonpriv", isbn: "9790000000005",
              sous_categorie: "Économie", visibilite: "publique" });
await semer({ tenant: alice, id: "a-her-rayonpub", isbn: "9790000000006",
              sous_categorie: "Innovation & entrepreneuriat", visibilite: "heritee" });

await q(`insert into rayons_reglages (tenant_id, categorie, sous_categorie, visibilite)
         values ($1,'Académique','Économie','privee'),
                ($1,'Académique','Innovation & entrepreneuriat','publique')`, [alice]);

// Chez bob, bibliothèque PRIVÉE — dont un ouvrage explicitement public.
await semer({ tenant: bob, id: "b-pub", isbn: "9790000000007", visibilite: "publique" });
await semer({ tenant: bob, id: "b-her", isbn: "9790000000008", visibilite: "heritee" });

/* --------------------------------------------- Le rôle applicatif n'est pas roi */

const [privileges] = await q(
  `select r.rolsuper, r.rolbypassrls from pg_roles r
    where r.rolname = (select usename from pg_user u
                        where u.usename = current_user limit 1)`);
const [qui] = await banc.appli.query(
  `select current_user as nom, usesuper from pg_user where usename = current_user`)
  .then(r => r.rows);
verifier("le rôle qui interroge n'est PAS superutilisateur",
  qui.usesuper === false, JSON.stringify(qui));

/* -------------------------------------------------- Cloisonnement de base */

const vusAlice = (await dans(alice, "select id from livres order by id")).map(r => r.id);
verifier("alice voit ses six ouvrages, et eux seuls",
  vusAlice.length === 6, JSON.stringify(vusAlice));
verifier("alice ne voit AUCUN ouvrage de bob",
  !vusAlice.some(x => x.startsWith("b-")), JSON.stringify(vusAlice));

const vusBob = (await dans(bob, "select id from livres order by id")).map(r => r.id);
verifier("bob ne voit que les siens",
  JSON.stringify(vusBob) === JSON.stringify(["b-her", "b-pub"]), JSON.stringify(vusBob));

/* ------------------------------------------------------- Le visiteur */

const vusVisiteur = (await dans(null, "select id from livres order by id")).map(r => r.id);
verifier("sans locataire, un visiteur ne voit QUE du public",
  JSON.stringify(vusVisiteur) === JSON.stringify(["a-her-rayonpub", "a-pub", "a-pub-rayonpriv"]),
  JSON.stringify(vusVisiteur));

/* ==========================================================================
   LA MATRICE, CAS PAR CAS

   « a-her » est absent des visibles, et c'est voulu : depuis le 15/08/2026,
   un ouvrage hérité dont le rayon n'a AUCUN réglage reste privé.

   Avant, il suivait la bibliothèque et devenait public. test-api.mjs l'a
   montré en clair — un ouvrage personnel créé après la bascule apparaissait
   sur la page publique. Une visibilité par défaut répond à la question
   « que fait-on quand personne n'a rien décidé ? », et la seule réponse
   défendable pour une bibliothèque personnelle est : rien ne sort.

   Ce que cela ne change PAS : les ouvrages déjà publics. La migration leur
   pose « publique » explicitement à partir de la sphère Pro, et l'API fait
   de même pour les nouveaux.
   ========================================================================== */

const CAS = [
  ["biblio publique + ouvrage public",                "a-pub",           true],
  ["biblio publique + ouvrage privé",                 "a-priv",          false],
  ["biblio publique + ouvrage hérité, aucun réglage", "a-her",           false],
  ["biblio publique + rayon public + ouvrage hérité", "a-her-rayonpub",  true],
  ["biblio publique + rayon privé + ouvrage hérité",  "a-her-rayonpriv", false],
  ["biblio publique + rayon privé + ouvrage public",  "a-pub-rayonpriv", true],
  ["biblio PRIVÉE + ouvrage public — le verrou maître prime", "b-pub",   false],
  ["biblio PRIVÉE + ouvrage hérité",                  "b-her",           false],
];

for (const [nom, id, attendu] of CAS) {
  const visible = vusVisiteur.includes(id);
  verifier(nom, visible === attendu, `visible=${visible}, attendu=${attendu}`);
}

/* ------------------------------------------------------- Les résumés */

const [ouvragePublic] = await q("select ouvrage_id from possessions where id = 'a-pub'");
const [ouvragePrive]  = await q("select ouvrage_id from possessions where id = 'a-priv'");
await resumer(ouvragePublic.ouvrage_id, "fr", "Résumé visible");
await resumer(ouvragePublic.ouvrage_id, "en", "Visible summary");
await resumer(ouvragePrive.ouvrage_id,  "fr", "Résumé confidentiel");

const lusParVisiteur = await dans(null, "select resume from resumes_ouvrages order by resume");
verifier("le visiteur lit les deux langues d'un ouvrage public",
  lusParVisiteur.length === 2, JSON.stringify(lusParVisiteur.map(r => r.resume)));

verifier("mais rien de l'ouvrage privé — l'existence du résumé le trahirait",
  !lusParVisiteur.some(r => r.resume === "Résumé confidentiel"),
  JSON.stringify(lusParVisiteur.map(r => r.resume)));

verifier("bob non plus ne lit pas le résumé privé d'alice",
  (await dans(bob, "select resume from resumes_ouvrages")).length === 2);

/* ---------------------------------------------- Écrire chez le voisin */

await dans(bob, "update possessions set statut = 'Lu' where id = 'a-pub'");
const [intact] = await q("select statut from possessions where id = 'a-pub'");
verifier("bob ne peut pas modifier une possession d'alice",
  intact?.statut === "A lire", JSON.stringify(intact));

await dans(bob, "delete from possessions where id = 'a-priv'");
const restant = await q("select id from possessions where id = 'a-priv'");
verifier("bob ne peut pas effacer une possession d'alice",
  restant.length === 1, JSON.stringify(restant));

let refuse = false;
try {
  await dans(bob, `insert into possessions (tenant_id, id, ouvrage_id, categorie, sous_categorie)
                   values ($1, 'intrus', $2, 'Roman', 'Classique')`,
             [alice, ouvragePublic.ouvrage_id]);
} catch { refuse = true; }
verifier("bob ne peut pas écrire une possession AU NOM d'alice", refuse);

/* --------------------------------------------------------------- Bilan */

await banc.fermer();

console.log("\n=== Cloisonnement et visibilité ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
