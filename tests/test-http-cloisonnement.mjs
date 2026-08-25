/* =========================================================================
   LE CLOISONNEMENT TIENT-IL À TRAVERS L'API, ET PAS SEULEMENT EN SQL ?

   test-cloisonnement.mjs éprouve les politiques PostgreSQL. test-contexte.mjs
   éprouve la pose du locataire. Ni l'un ni l'autre ne dit si le SERVEUR s'en
   sert : une route qui appellerait le pool directement passerait entre les
   deux, et c'est exactement le genre d'oubli qu'on fait en migrant vingt
   requêtes à la main.

   Ce contrôle-ci lance le vrai server.js et lui parle en HTTP.

   ---------------------------------------------------------------------------
   POURQUOI PAS PGlite ICI — une erreur commise puis corrigée le 15/08/2026

   La première version de ce fichier montait PGlite, comme les deux autres
   contrôles. Deux vérifications tombaient : « effacer un ouvrage d'un autre
   locataire » semblait réussir. C'était FAUX, et d'une façon instructive.

   PGlite n'a qu'UNE session de base : celle du pont réseau et celle des
   requêtes de vérification sont la même. Quand l'API pose « set role app »,
   l'observateur devient app lui aussi — et ne voit donc plus les ouvrages
   qu'il vient d'écrire. Le contrôle ne mesurait pas l'effacement, il
   mesurait sa propre cécité.

   Un banc où l'observateur et l'observé partagent une session ne peut pas
   juger d'un cloisonnement. On monte donc un vrai PostgreSQL.

   ---------------------------------------------------------------------------
   LA CONFIGURATION REPRODUITE EST CELLE DE LA PRODUCTION

     « biblio » possède les tables, mais n'est ni superutilisateur ni
     BYPASSRLS. C'est « force row level security » qui le soumet aux
     politiques — sans ce mot, le propriétaire les traverserait, et rien
     ici ne le signalerait.

   USAGE
     node tests/test-http-cloisonnement.mjs
     PGURL=... PGURL_OEIL=... node tests/test-http-cloisonnement.mjs   (CI)

   PGURL      : le compte de l'API — sans privilège, comme en production.
   PGURL_OEIL : le compte d'observation — privilégié, pour constater ce que
                la base contient réellement.
   ========================================================================= */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const MDP = "mot-de-passe-de-controle";
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55491 });
const { q, semer, locataire } = banc;

const [{ usesuper, rolbypassrls }] = await banc.appli.query(
  `select u.usesuper, r.rolbypassrls from pg_user u join pg_roles r on r.rolname = u.usename
    where u.usename = current_user`).then(r => r.rows);
verifier("le compte de l'API n'est ni superutilisateur ni BYPASSRLS",
  usesuper === false && rolbypassrls === false, `usesuper=${usesuper} bypassrls=${rolbypassrls}`);

/* --------------------------------------------------- Deux bibliothèques */

const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
const bob = await locataire("bob", "privee");

await semer({ tenant: xavier.id, id: "x-public", isbn: "9780000000001", visibilite: "publique" });
await semer({ tenant: xavier.id, id: "x-prive",  isbn: "9780000000002", visibilite: "privee" });
// Publique, mais chez un locataire privé : le verrou maître doit primer.
await semer({ tenant: bob,       id: "b-public", isbn: "9780000000003", visibilite: "publique" });
await semer({ tenant: bob,       id: "b-prive",  isbn: "9780000000004", visibilite: "privee" });

/* ------------------------------------------------------- Lancer l'API */

const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT),
    MOT_DE_PASSE: MDP,
    SECRET_SESSION: "un-secret-de-controle-suffisamment-long-pour-passer",
    ANTHROPIC_API_KEY: "",
    FICHIER_AMORCE: "/inexistant",
    TENANT_DEFAUT: "xavier",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
serveur.stdout.on("data", d => { journal += d; });
serveur.stderr.on("data", d => { journal += d; });

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
let debout = false;
for (let i = 0; i < 40 && !debout; i++) {
  try { debout = (await fetch(`${BASE}/api/sante`)).ok; } catch { await dormir(500); }
}

const fermer = async () => { serveur.kill(); await banc.fermer(); };

if (!debout) {
  console.error("  ECHEC l API n a pas démarré\n" + journal);
  await fermer(); process.exit(1);
}

const appel = async (chemin, { cookie, methode = "GET", corps } = {}) => {
  const r = await fetch(BASE + chemin, {
    method: methode,
    headers: { ...(cookie ? { cookie } : {}), ...(corps ? { "content-type": "application/json" } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { statut: r.status, cookie: r.headers.get("set-cookie"), corps: await r.json().catch(() => null) };
};
const ids = (liste) => (Array.isArray(liste) ? liste.map(l => l.id).sort() : liste);

/* ------------------------------------------------------------ Visiteur */

const vueVisiteur = await appel("/api/livres");
verifier("le visiteur ne voit QUE le public du locataire public",
  JSON.stringify(ids(vueVisiteur.corps)) === JSON.stringify(["x-public"]),
  JSON.stringify(ids(vueVisiteur.corps)));

const statsVisiteur = await appel("/api/statistiques");
verifier("les statistiques publiques comptent le même périmètre",
  statsVisiteur.corps?.total === 1, JSON.stringify(statsVisiteur.corps?.total));

verifier("le visiteur ne peut pas écrire",
  (await appel("/api/livres", { methode: "PUT", corps: { id: "intrus", titre: "T", auteur: "A", categorie: "Roman", sous_categorie: "Classique" } })).statut === 401);

verifier("le visiteur ne peut pas supprimer",
  (await appel("/api/livres/x-public", { methode: "DELETE" })).statut === 401);

/* ------------------------------------------------------------- Connecté */

const connexion = await appel("/api/connexion", { methode: "POST", corps: { motDePasse: MDP } });
verifier("le mot de passe ouvre une session", connexion.statut === 200, JSON.stringify(connexion.corps));
const cookie = (connexion.cookie ?? "").split(";")[0];

const vueXavier = await appel("/api/livres", { cookie });
verifier("connecté, la bibliothèque entière est visible — et rien de plus",
  JSON.stringify(ids(vueXavier.corps)) === JSON.stringify(["x-prive", "x-public"]),
  JSON.stringify(ids(vueXavier.corps)));

verifier("les ouvrages de bob restent invisibles une fois connecté",
  Array.isArray(vueXavier.corps) && !vueXavier.corps.some(l => String(l.id).startsWith("b-")));

/* Une session forgée pour le locataire de bob : le jeton est signé pour
   xavier, en changer le locataire doit casser la signature. */
const [, signature] = decodeURIComponent(cookie.replace("session=", "")).split(".");
const usurpe = "session=" + Buffer.from(JSON.stringify({
  t: bob, expire: Date.now() + 1e9,
})).toString("base64url") + "." + signature;
const vueUsurpee = await appel("/api/livres", { cookie: usurpe });
verifier("un cookie dont on a changé le locataire est rejeté",
  JSON.stringify(ids(vueUsurpee.corps)) === JSON.stringify(["x-public"]),
  JSON.stringify(ids(vueUsurpee.corps)));

/* Un jeton PARFAITEMENT SIGNÉ mais sans locataire — la forme qu'avaient les
   sessions avant la bascule. Le contrôle connaît le secret, il peut donc en
   fabriquer un vrai : c'est le seul moyen d'éprouver le refus explicite,
   puisqu'un attaquant, lui, ne saurait pas signer. */
const chargeSansLocataire = Buffer.from(JSON.stringify({
  expire: Date.now() + 1e9,
})).toString("base64url");
const ancien = "session=" + chargeSansLocataire + "." +
  createHmac("sha256", "un-secret-de-controle-suffisamment-long-pour-passer")
    .update(chargeSansLocataire).digest("base64url");
const vueAncienne = await appel("/api/livres", { cookie: ancien });
verifier("une session valide mais sans locataire ne donne rien de plus qu'un visiteur",
  JSON.stringify(ids(vueAncienne.corps)) === JSON.stringify(["x-public"]),
  `statut ${vueAncienne.statut}, ${JSON.stringify(ids(vueAncienne.corps))}`);

/* ------------------------------------------------- Écriture et effacement */

await appel("/api/livres", {
  cookie, methode: "PUT",
  corps: { id: "x-neuf", titre: "Neuf", auteur: "Auteur", categorie: "Roman",
           sous_categorie: "Classique", sphere: "Pro" },
});
const [neuf] = await q("select tenant_id from possessions where id = 'x-neuf'");
verifier("un ouvrage créé porte le locataire de la session",
  neuf?.tenant_id === xavier.id, JSON.stringify(neuf));

/* Un ouvrage envoyé AVEC un tenant_id étranger dans le corps JSON : le
   champ ne doit même pas être regardé. */
await appel("/api/livres", {
  cookie, methode: "PUT",
  corps: { id: "x-force", titre: "Force", auteur: "Auteur", categorie: "Roman",
           sous_categorie: "Classique", sphere: "Pro", tenant_id: bob },
});
const [force] = await q("select tenant_id from possessions where id = 'x-force'");
verifier("un tenant_id envoyé par le client est ignoré",
  force?.tenant_id === xavier.id, JSON.stringify(force));

/* La tentative qui compte : effacer chez le voisin. La route ne vérifie
   aucun propriétaire — c'est la politique qui doit refuser. */
const effacement = await appel("/api/livres/b-prive", { cookie, methode: "DELETE" });
const [survivant] = await q("select id from possessions where id = 'b-prive'");
verifier("effacer un ouvrage d'un autre locataire ne l'efface pas",
  survivant?.id === "b-prive", `statut ${effacement.statut}, reste ${JSON.stringify(survivant)}`);

/* Idem pour la couverture : la route boucle sur des identifiants fournis
   par le client, sans les rattacher à personne.

   « trouvee » et non « trouve » — la valeur est contrainte par le schéma.
   Une première version écrivait « trouve » : la requête tombait en 500 sur
   la contrainte, la couverture n'était donc pas modifiée, et le contrôle
   passait au vert SANS QUE LA RLS AIT EU À SE PRONONCER. Un contrôle qui
   réussit pour la mauvaise raison ne protège rien ; on exige donc aussi
   que la réponse soit un 200. */
const intrusion = await appel("/api/couvertures", {
  cookie, methode: "POST",
  corps: [{ id: "b-prive", cover_url: "https://intrus.example/x.jpg", cover_statut: "trouvee" }],
});
const [couv] = await q(`select o.cover_url from ouvrages o
     join possessions p on p.ouvrage_id = o.id where p.id = 'b-prive'`);
verifier("modifier la couverture d'un autre locataire n'aboutit pas",
  intrusion.statut === 200 && couv?.cover_url === null,
  `statut ${intrusion.statut}, ${JSON.stringify(couv)}`);

/* ------------------------------------------------- ET CHEZ SOI, ÇA MARCHE ?

   Ajouté le 15/08/2026 après une mutation restée impunie. Faire écrire la
   suppression HORS contexte — « bd.query » au lieu de « dans » — ne faisait
   tomber AUCUNE vérification : sans locataire posé, la politique ne laisse
   rien passer, donc rien n'était effacé chez le voisin non plus.

   Le contrôle était donc satisfait par une application qui n'efface plus
   rien du tout. Vérifier qu'on protège les autres ne dit pas qu'on rend
   encore service au propriétaire : il faut les deux. */

const maMiseAJour = await appel("/api/couvertures", {
  cookie, methode: "POST",
  corps: [{ id: "x-prive", cover_url: "https://exemple.fr/couv.jpg", cover_statut: "trouvee" }],
});
const [maCouv] = await q(`select o.cover_url from ouvrages o
     join possessions p on p.ouvrage_id = o.id where p.id = 'x-prive'`);
verifier("modifier SA PROPRE couverture fonctionne toujours",
  maMiseAJour.statut === 200 && maCouv?.cover_url === "https://exemple.fr/couv.jpg",
  `statut ${maMiseAJour.statut}, ${JSON.stringify(maCouv)}`);

const monEffacement = await appel("/api/livres/x-neuf", { cookie, methode: "DELETE" });
const restant = await q("select id from possessions where id = 'x-neuf'");
verifier("supprimer SON PROPRE ouvrage fonctionne toujours",
  monEffacement.statut === 200 && restant.length === 0,
  `statut ${monEffacement.statut}, reste ${JSON.stringify(restant)}`);

/* ==========================================================================
   LA PORTE DE SORTIE, À TRAVERS HTTP — ET NON EN APPELANT LA BASE

   CE CONTRÔLE MANQUAIT, ET SON ABSENCE A COÛTÉ UN DÉFAUT EN PRODUCTION.

   « test-suppression.mjs » appelle « supprimer_locataire() » directement : il
   prouve que la base efface bien, et rien d'autre. Le 25/08/2026, la route
   HTTP lisait l'adresse à confirmer par « select courriel from comptes
   limit 1 » — sans clause « where ».

   « comptes » est la seule table métier SANS politique de cloisonnement, et
   c'est voulu : se connecter exige de chercher une adresse à travers TOUS
   les comptes. La connexion de locataire ne restreignait donc rien, et la
   requête rendait l'adresse d'un compte quelconque. Résultat en production :
   impossible de supprimer le sien, et une confirmation qui comparait la
   saisie à l'adresse d'un inconnu.

   Deux locataires sont indispensables ici. Avec un seul, « limit 1 » rend la
   bonne ligne par accident, et le contrôle passe au vert en ne prouvant
   rien.
   ========================================================================== */

await q("delete from comptes where tenant_id in ($1, $2)", [xavier.id, bob]);

/* L'ORDRE D'INSERTION N'EST PAS INDIFFÉRENT, ET C'EST TOUT L'INTÉRÊT.

   Une première rédaction insérait Xavier d'abord. « limit 1 » sans « order
   by » rendait alors SA ligne — la bonne — et la mutation qui remettait le
   défaut a survécu : le contrôle passait au vert en ne prouvant rien.

   Bob est donc inséré EN PREMIER. Sur une table neuve, le parcours suit
   l'ordre d'insertion : « limit 1 » rend l'adresse de Bob pendant que la
   session est celle de Xavier, ce qui est exactement la situation de
   production — un compte créé le 14 août, un autre le 24. */
await q("insert into comptes (tenant_id, courriel) values ($1, 'bob@controle.fr')",
  [bob]);
await q("insert into comptes (tenant_id, courriel) values ($1, 'xavier@controle.fr')",
  [xavier.id]);

/* Ce que la suppression doit annoncer, LU en base plutôt que deviné. Une
   première rédaction affirmait « 2 » ; il y en avait 3, et l'assertion
   fausse est ce qui a masqué la survie de la mutation. */
const attenduOuvrages = Number((await q(
  "select count(*) as n from possessions where tenant_id = $1", [xavier.id]))[0].n);

/* 1. L'ADRESSE DU VOISIN NE CONFIRME RIEN. C'est la vérification qui
      attrape le défaut : avec « limit 1 », c'est précisément celle-là qui
      était acceptée. */
const avecVoisine = await appel("/api/compte",
  { cookie, methode: "DELETE", corps: { confirmation: "bob@controle.fr" } });
verifier("l'adresse d'un AUTRE compte ne confirme pas la suppression",
  avecVoisine.statut === 400,
  `statut ${avecVoisine.statut} — ${JSON.stringify(avecVoisine.corps)}`);

const [intacte] = await q("select id from tenants where id = $1", [xavier.id]);
verifier("… et rien n'a été effacé au passage",
  intacte !== undefined, "la bibliothèque a disparu sur une confirmation étrangère");

/* 2. UNE SAISIE VIDE NON PLUS — sinon la confirmation serait décorative. */
verifier("une confirmation vide est refusée",
  (await appel("/api/compte",
    { cookie, methode: "DELETE", corps: { confirmation: "" } })).statut === 400);

/* 3. SA PROPRE ADRESSE SUPPRIME — et la casse ne doit pas y faire obstacle :
      quelqu'un qui recopie depuis son courrielleur peut hériter d'une
      majuscule. */
const sienne = await appel("/api/compte",
  { cookie, methode: "DELETE", corps: { confirmation: "Xavier@Controle.FR" } });
verifier("sa propre adresse supprime, quelle qu'en soit la casse",
  sienne.statut === 200 && sienne.corps?.supprime === true,
  `statut ${sienne.statut} — ${JSON.stringify(sienne.corps)}`);

verifier("… et la réponse dit combien d'ouvrages sont partis",
  sienne.corps?.ouvrages === attenduOuvrages,
  `${JSON.stringify(sienne.corps)} — attendu ${attenduOuvrages}`);

/* 4. LE VOISIN N'A RIEN PERDU. */
const restants = await q("select identifiant from tenants order by identifiant");
verifier("… tandis que le locataire voisin est toujours là",
  restants.length === 1 && restants[0].identifiant === "bob",
  JSON.stringify(restants));

const bobIntact = await q("select id from possessions where tenant_id = $1", [bob]);
verifier("… avec ses deux ouvrages",
  bobIntact.length === 2, `${bobIntact.length} ouvrage(s)`);

/* 5. LA SESSION NE SURVIT PAS À LA BIBLIOTHÈQUE QU'ELLE DÉSIGNAIT. */
verifier("le cookie de session est effacé par la réponse",
  /=;|Max-Age=0/.test(sienne.cookie ?? ""), sienne.cookie);

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Cloisonnement à travers HTTP ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
