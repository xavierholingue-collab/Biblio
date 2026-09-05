/* =========================================================================
   AUTHENTIFICATION PAR LIEN MAGIQUE

   Chaque vérification correspond à une façon précise de se faire prendre.
   Elles sont écrites pour tomber si l'une des cinq propriétés disparaît.

   ---------------------------------------------------------------------------
   CE QUE CES CONTRÔLES ATTRAPENT — mesuré le 15/08/2026 en cassant le code
   exprès, une propriété à la fois :

     stocker le jeton en clair au lieu de l'empreinte ....... 3 échecs
     retirer « and utilise_le is null » .................... 2 échecs
     ignorer l'expiration du lien ......................... 1 échec
     répondre différemment sur adresse inconnue ........... 1 échec
     ne plus vérifier la signature de session ............. 2 échecs
     ignorer l'expiration de session ..................... 1 échec

   CE QU'ILS N'ATTRAPENT PAS, ET POURQUOI IL FAUT LE DIRE

     Remplacer timingSafeEqual() par « signature !== attendue » ne fait
     tomber AUCUNE vérification. C'est normal et irréductible : les deux
     comparaisons donnent le même résultat, elles ne diffèrent que par le
     temps mis à le donner. Une attaque temporelle mesure ce temps pour
     reconstituer la signature octet par octet.

     Un test de justesse ne peut pas voir cela. La ligne timingSafeEqual
     n'est donc protégée par rien d'autre que le commentaire qui l'entoure
     dans api/authentification.mjs — c'est une dette assumée, pas un oubli.

   USAGE
     node tests/test-authentification.mjs
   ========================================================================= */

import { PGlite } from "@electric-sql/pglite";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  demanderLien, consommerLien, purgerLiens,
  signerSession, verifierSession, empreinte, courrielPlausible,
} from "../api/authentification.mjs";

const CANDIDATS = ["db", path.join("..", "db"), path.join(process.cwd(), "db")];
const DB = CANDIDATS.find(c => fs.existsSync(path.join(c, "01-schema.sql")));
if (!DB) { console.error("  ECHEC db/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

/* TOUTES LES MIGRATIONS, DANS L'ORDRE DES NOMS — pas une liste écrite à la
   main.

   Elle portait « 01-schema.sql » et « 02-multi-locataire.sql ». Le 21/08/2026,
   10-inscription.sql a ajouté une colonne « courriel » à « liens_connexion » :
   ce fichier a continué de bâtir un schéma d'il y a six migrations, et la
   chaîne de livraison a échoué sur « column courriel does not exist » — dans
   un test d'authentification qui n'avait rien à voir avec l'inscription.

   C'est le défaut que vps-deployer-biblio.sh documente déjà pour lui-même :
   « cette liste portait 02 et 03 ; le 16/08, 04-reglages.sql est arrivé sans y
   être ajouté ». Deux endroits, deux listes manuelles, le même piège — et la
   seconde a mordu cinq jours après qu'on eut corrigé la première.

   Une liste qu'il faut penser à tenir à jour n'est pas tenue à jour. On lit
   donc le répertoire, comme le banc d'essai et le déployeur le font
   désormais tous les deux. */
const db = await PGlite.create();
for (const f of fs.readdirSync(DB).filter(f => f.endsWith(".sql")).sort()) {
  await db.exec(fs.readFileSync(path.join(DB, f), "utf8"));
}

const [alice] = (await db.query(
  `insert into tenants (identifiant, nom) values ('alice','Alice') returning id`)).rows;
const [compteAlice] = (await db.query(
  `insert into comptes (courriel) values ('alice@exemple.fr') returning id`)).rows;
await db.query(
  `insert into membres (compte_id, tenant_id, role) values ($1, $2, 'proprietaire')`,
  [compteAlice.id, alice.id]);

const client = { query: (t, p) => db.query(t, p) };

/* ------------------------------------------- 1. Le jeton n'est pas stocké */

const { jeton } = await demanderLien(client, "alice@exemple.fr");
verifier("un jeton est produit", typeof jeton === "string" && jeton.length >= 40,
  String(jeton).length);

const enBase = (await db.query("select empreinte from liens_connexion")).rows;
verifier("la base ne contient QUE l'empreinte, jamais le jeton",
  enBase.length === 1 && enBase[0].empreinte !== jeton && enBase[0].empreinte === empreinte(jeton));

/* ------------------------------------------------------- 2. Usage unique */

const premier = await consommerLien(client, jeton);
verifier("le lien ouvre bien la bonne bibliothèque",
  premier?.tenant_id === alice.id, JSON.stringify(premier));

const second = await consommerLien(client, jeton);
verifier("le MÊME lien ne fonctionne pas deux fois", second === null, JSON.stringify(second));

/* Deux consommations SIMULTANÉES : une seule doit gagner. Un contrôle
   « lire puis marquer » en deux temps laisserait passer les deux. */
const { jeton: j2 } = await demanderLien(client, "alice@exemple.fr");
const [a, b] = await Promise.all([consommerLien(client, j2), consommerLien(client, j2)]);
verifier("deux usages simultanés : un seul aboutit",
  [a, b].filter(Boolean).length === 1, JSON.stringify([a, b]));

/* ---------------------------------------------------- 3. Courte durée */

const { jeton: j3 } = await demanderLien(client, "alice@exemple.fr");
await db.query("update liens_connexion set expire_le = now() - interval '1 minute' where utilise_le is null");
verifier("un lien périmé est refusé", (await consommerLien(client, j3)) === null);

/* ------------------------------------------------ 4. Aucune énumération */

const inconnu = await demanderLien(client, "personne@exemple.fr");
verifier("une adresse inconnue rend la même forme de réponse",
  inconnu.envoye === true && inconnu.jeton === null, JSON.stringify(inconnu));

const lignesApres = (await db.query(
  "select count(*)::int as n from liens_connexion")).rows[0].n;
await demanderLien(client, "alice@exemple.fr");
verifier("aucun lien n'est créé pour une adresse inconnue",
  (await db.query("select count(*)::int as n from liens_connexion")).rows[0].n === lignesApres + 1);

verifier("un jeton inventé est refusé", (await consommerLien(client, "n-importe-quoi")) === null);
verifier("un jeton vide est refusé", (await consommerLien(client, "")) === null);
verifier("un jeton nul est refusé", (await consommerLien(client, null)) === null);

for (const [nom, valeur] of [
  ["adresse sans arobase", "alice.exemple.fr"],
  ["adresse vide", ""],
  ["espaces seulement", "   "],
]) {
  let refuse = false;
  try { await demanderLien(client, valeur); } catch { refuse = true; }
  verifier(`refus à la demande : ${nom}`, refuse);
}
verifier("la casse et les espaces ne créent pas de doublon",
  courrielPlausible("  Alice@Exemple.FR  "));
const casse = await demanderLien(client, "  ALICE@exemple.FR ");
verifier("une adresse en majuscules trouve le même compte", casse.jeton !== null);

/* ------------------------------------------------------- 5. La session */

const secret = "un-secret-de-controle-suffisamment-long";
const session = signerSession(secret, { compte_id: "c1", tenant_id: alice.id });
const relue = verifierSession(secret, session);
verifier("la session porte le locataire", relue?.tenant_id === alice.id, JSON.stringify(relue));

verifier("une session signée d'un autre secret est refusée",
  verifierSession("un-autre-secret", session) === null);

const [charge, sig] = session.split(".");
const falsifiee = Buffer.from(JSON.stringify({
  c: "c1", t: "00000000-0000-0000-0000-000000000000", expire: Date.now() + 1e6,
})).toString("base64url") + "." + sig;
verifier("changer le locataire dans le jeton invalide la signature",
  verifierSession(secret, falsifiee) === null);

/* Un jeton CORRECTEMENT SIGNÉ mais périmé — c'est le seul cas intéressant.
   Une première version bricolait ce jeton par substitution de chaîne dans un
   autre jeton : la signature ne correspondait donc plus, et le contrôle
   passait au vert en éprouvant la signature, pas l'expiration. Il faut
   signer soi-même pour isoler la propriété qu'on veut vérifier. */
const chargePerimee = Buffer.from(JSON.stringify({
  c: "c1", t: alice.id, expire: Date.now() - 1000,
})).toString("base64url");
const perimee = chargePerimee + "." +
  createHmac("sha256", secret).update(chargePerimee).digest("base64url");
verifier("une session correctement signée mais expirée est refusée",
  verifierSession(secret, perimee) === null);

for (const [nom, v] of [["vide", ""], ["nul", null], ["sans point", "abcdef"],
                        ["objet", {}], ["signature seule", ".xyz"]]) {
  verifier(`session refusée : ${nom}`, verifierSession(secret, v) === null);
}

/* ------------------------------------------------------------- Ménage */

await db.query("update liens_connexion set expire_le = now() - interval '2 days'");
await purgerLiens(client);
verifier("les liens périmés depuis longtemps sont purgés",
  (await db.query("select count(*)::int as n from liens_connexion")).rows[0].n === 0);

/* -------------------------------------------------------------- Bilan */

console.log("\n=== Authentification ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
