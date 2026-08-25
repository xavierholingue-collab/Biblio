/* =========================================================================
   UNE SEULE PORTE PAR OÙ NAÎT UNE BIBLIOTHÈQUE

   ---------------------------------------------------------------------------
   POURQUOI CE CONTRÔLE EXISTE — 24/08/2026

   « INSCRIPTION_OUVERTE » n'était passé qu'à « demanderLien ».
   « connexionParOidc » créait un locataire sans jamais le consulter.

   Le drapeau s'appelait « inscription ouverte » et ne fermait qu'une porte
   sur deux. Constaté en production, pas en relecture : le drapeau valait 0,
   le lien magique refusait les inconnus, et une connexion Google a créé une
   bibliothèque neuve. C'est un compte réellement créé qui l'a montré.

   Aucun contrôle ne pouvait le voir : les dix-huit suites lançaient leurs
   serveurs avec « INSCRIPTION_OUVERTE: "1" ». Le drapeau n'a jamais été
   éprouvé dans la position où il protège. Une suite verte peut n'avoir
   jamais mis un contrôle en situation de refuser.

   ---------------------------------------------------------------------------
   CE QU'IL VÉRIFIE, ET POURQUOI PAS AUTRE CHOSE

   On pourrait chercher « chaque fonction qui crée un locataire consulte-t-elle
   le drapeau ? ». Ce serait deviner l'avenir : la porte suivante s'appellera
   autrement, et la recherche ne la trouverait pas.

   On vérifie donc l'invariant STRUCTUREL, qui lui ne dépend d'aucun nom :
   « public.creer_locataire » n'est appelé QU'À UN SEUL ENDROIT dans tout
   docker/api. Une porte future devra passer par cette fonction, et cette
   fonction exige le drapeau — avec « false » par défaut, de sorte que
   l'oubli ferme au lieu d'ouvrir.

   L'invariant était d'ailleurs DÉJÀ AFFIRMÉ en tête de « oidc.mjs » :
   « un seul endroit sait créer un locataire ». Il était faux depuis le jour
   où il a été écrit. Un commentaire n'est pas un contrôle.

   La seconde partie vérifie que les messages ne dérivent pas : chaque valeur
   d'« oidc= » que le serveur peut émettre doit exister dans la table de la
   page, et réciproquement. Une valeur émise et non traduite s'affiche comme
   un silence — la personne voit une page normale et croit que rien ne s'est
   passé.

   USAGE
     node tests/test-portes-inscription.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

/* On CHERCHE la racine au lieu de la calculer : « path.join("..","..") » a
   déjà grimpé un niveau de trop dans ce dépôt, et l'erreur était muette. */
const RACINE = [".", "..", path.join("..", "..")]
  .find(c => fs.existsSync(path.join(c, "api", "authentification.mjs")))
  ?? [".", "..", path.join("..", "..")]
    .find(c => fs.existsSync(path.join(c, "docker", "api", "authentification.mjs")));

if (!RACINE) {
  console.log("  (docker/api hors de portée dans cette disposition — non exécuté)");
  console.log("\n  0 vérifications, aucune erreur.");
  process.exit(0);
}

const sousDocker = fs.existsSync(path.join(RACINE, "docker", "api"));
const API = path.join(RACINE, ...(sousDocker ? ["docker", "api"] : ["api"]));
const WEB = path.join(RACINE, ...(sousDocker ? ["docker", "web"] : ["web"]));

const lire = (f) => fs.readFileSync(f, "utf8");
const fichiersApi = fs.readdirSync(API)
  .filter(f => f.endsWith(".mjs") || f.endsWith(".js"))
  .map(f => [f, lire(path.join(API, f))]);

/* ===================================================================== */
/* 1. UNE SEULE PORTE                                                     */
/* ===================================================================== */

const appels = [];
for (const [nom, texte] of fichiersApi) {
  texte.split("\n").forEach((ligne, i) => {
    /* Le commentaire qui EXPLIQUE la porte cite son nom : on ne compte que
       les appels, c'est-à-dire ce qui est suivi d'une parenthèse ouvrante. */
    if (/creer_locataire\s*\(/.test(ligne)) appels.push(`${nom}:${i + 1}`);
  });
}

verifier("« public.creer_locataire » n'est appelé QU'À UN SEUL ENDROIT",
  appels.length === 1,
  `${appels.length} appels : ${appels.join(", ")} — une porte échappe au drapeau`);

const auth = lire(path.join(API, "authentification.mjs"));

verifier("… et cette porte s'appelle « creerLocataire »",
  /async function creerLocataire\s*\(/.test(auth),
  "la fonction porte n'existe pas sous ce nom");

/* LE DÉFAUT DOIT FERMER, PARTOUT. Si « inscriptionOuverte » valait vrai par
   défaut, l'appelant qui oublie de se prononcer obtiendrait l'ouverture —
   exactement le défaut qu'on corrige, sous une autre forme.

   On vérifie TOUTES les signatures qui portent ce paramètre, pas seulement
   celles qu'on connaît aujourd'hui. Une première rédaction ne contrôlait que
   « creerLocataire » : une mutation mettant le défaut de « demanderLien » à
   « true » a survécu. Nommer les fonctions, c'était encore une liste à la
   main. */
const defauts = [...auth.matchAll(/(\w+)\s*\([^)]*inscriptionOuverte\s*=\s*(\w+)/g)]
  .map(m => [m[1], m[2]]);

verifier("chaque fonction qui prend le drapeau existe et le déclare",
  defauts.length >= 2, `${defauts.length} signature(s) : ${JSON.stringify(defauts)}`);

const ouvertes = defauts.filter(([, v]) => v !== "false").map(([f]) => f);
verifier("… et TOUTES refusent par défaut",
  ouvertes.length === 0,
  `ouvre(nt) par défaut : ${ouvertes.join(", ")} — l'oubli ouvrirait la porte`);

verifier("… et elle LÈVE au lieu de rendre un témoin qu'on peut ignorer",
  /inscriptionFermee\s*=\s*true[\s\S]{0,120}throw\s+e/.test(auth),
  "le refus ne lève pas");

/* Les deux portes connues doivent transmettre ce qu'on leur donne. */
for (const porte of ["consommerLien", "connexionParOidc"]) {
  const corps = auth.slice(auth.indexOf(`export async function ${porte}`));
  verifier(`« ${porte} » accepte et transmet le drapeau`,
    /options\s*=\s*\{\s*\}/.test(corps.slice(0, 400))
    && /creerLocataire\([^)]*options/.test(corps.slice(0, 4000)),
    `${porte} ne fait pas suivre ses options`);
}

/* Et le serveur doit le lui donner — à CHACUNE, nommément.
   J'avais d'abord écrit « il doit y avoir deux passages », et ce contrôle a
   refusé : il y en a trois. « demanderLien » ferme à l'émission du lien,
   « consommerLien » à son usage, « connexionParOidc » chez Google.
   Compter n'aurait rien dit de QUI reçoit le drapeau — c'est précisément le
   travers que ce fichier existe pour attraper. On nomme donc. */
const serveur = lire(path.join(API, "server.js"));
for (const porte of ["demanderLien", "consommerLien", "connexionParOidc"]) {
  const r = new RegExp(`${porte}\\([^;]*inscriptionOuverte:\\s*INSCRIPTION_OUVERTE`, "s");
  verifier(`server.js passe le drapeau à « ${porte} »`, r.test(serveur),
    `${porte} est appelé sans le drapeau`);
}

/* ===================================================================== */
/* 2. AUCUN MESSAGE ÉMIS SANS TRADUCTION                                  */
/* ===================================================================== */

const emises = new Set();
for (const m of serveur.matchAll(/(?:fini|versEcran)\(\s*"([a-z-]+)"/g)) emises.add(m[1]);
for (const m of serveur.matchAll(/oidc=([a-z-]+)/g))                     emises.add(m[1]);
/* Le cas ternaire : « oidc=${x ? "bienvenue" : "ok"} ». Les deux branches
   sont des valeurs émises, et aucune des deux n'apparaît en littéral. */
for (const bloc of serveur.matchAll(/oidc=\$\{([^}]*)\}/g))
  for (const m of bloc[1].matchAll(/"([a-z-]+)"/g)) emises.add(m[1]);

const page = lire(path.join(WEB, "ma-bibliotheque.html"));
const table = page.slice(page.indexOf("const RETOURS"));
const traduites = new Set(
  [...table.slice(0, table.indexOf("};")).matchAll(/"([a-z-]+)":\s*\[/g)].map(m => m[1]));

verifier("le serveur émet au moins les six cas connus",
  emises.size >= 6, `${emises.size} : ${[...emises].sort().join(", ")}`);

const orphelines = [...emises].filter(v => !traduites.has(v));
verifier("toute valeur émise par le serveur est traduite par la page",
  orphelines.length === 0,
  `non traduites : ${orphelines.join(", ")} — elles s'afficheront comme un silence`);

const inutiles = [...traduites].filter(v => !emises.has(v));
verifier("… et la page ne traduit rien que le serveur n'émette",
  inutiles.length === 0,
  `jamais émises : ${inutiles.join(", ")}`);

verifier("le refus « fermee » fait partie des deux",
  emises.has("fermee") && traduites.has("fermee"),
  `émise: ${emises.has("fermee")}, traduite: ${traduites.has("fermee")}`);

/* ===================================================================== */

for (const n of ok) console.log("  ok   " + n);
for (const n of ko) console.log("  KO   " + n);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length} erreur(s).`);
process.exit(ko.length ? 1 : 0);
