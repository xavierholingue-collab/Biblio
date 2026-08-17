/* =========================================================================
   LA CONNEXION PAR LIEN, DE BOUT EN BOUT

   Le module d'authentification était écrit et éprouvé depuis le 14/08, mais
   server.js ne l'importait pas : on entrait encore par un mot de passe
   unique partagé. Ce fichier éprouve la chaîne complète — demande, envoi,
   échange, session — contre un faux service de courriel.

   ---------------------------------------------------------------------------
   CE QU'IL REGARDE, ET POURQUOI CE N'EST PAS LA RÉPONSE HTTP

   Une route qui répond « envoyé » ne prouve rien. Le faux service conserve
   ce qu'il a REÇU : adresse appelée, en-têtes, corps. C'est le seul moyen de
   vérifier qu'on parle bien à Resend comme Resend l'attend — et qu'une
   bascule vers Brevo, annoncée pour plus tard, n'aura pas à être découverte
   le jour où l'on est pressé.

   ---------------------------------------------------------------------------
   LES QUATRE PROPRIÉTÉS QUI COMPTENT

   1. AUCUNE ÉNUMÉRATION. Demander un lien pour une adresse inconnue répond
      exactement comme pour une adresse connue. Sans cela, ce point d'entrée
      devient un annuaire des utilisateurs du service.

   2. USAGE UNIQUE, garanti par la base et non par une vérification en deux
      temps.

   3. L'ADRESSE DU LIEN NE VIENT PAS DE LA REQUÊTE. « Host » est fourni par
      le client : le lire pour fabriquer le lien reviendrait à laisser un
      inconnu choisir où atterrit votre jeton de connexion.

   4. ON N'INONDE PAS UNE BOÎTE AUX LETTRES. Cinq demandes par quart d'heure.
      Ce n'est pas le service qu'on protège, c'est la personne visée.

   USAGE
     node tests/test-lien-magique.mjs
     PGURL=... PGURL_OEIL=... node tests/test-lien-magique.mjs           (CI)
   ========================================================================= */

import { spawn } from "node:child_process";
import http, { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const PORT_BASE = 3470;
const banc = await ouvrirBanc({ port: 55483 });
const { q, semer } = banc;

const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
await semer({ tenant: xavier.id, id: "l-prive", isbn: "9780000000401", visibilite: "privee" });
await q(`insert into comptes (tenant_id, courriel) values ($1, 'xavier@exemple.fr')
         on conflict (courriel) do nothing`, [xavier.id]);

/* ------------------------------------------------- Le faux service d'envoi */

const recus = [];
let refuser = false;
const PORT_COURRIEL = PORT_BASE + 9;
const faussaire = createServer(async (req, rep) => {
  let brut = "";
  for await (const m of req) brut += m;
  recus.push({
    chemin: req.url,
    entetes: req.headers,
    corps: (() => { try { return JSON.parse(brut); } catch { return null; } })(),
  });
  if (refuser) { rep.writeHead(422); rep.end('{"message":"refus de controle"}'); return; }
  rep.writeHead(200, { "content-type": "application/json" });
  rep.end('{"id":"controle"}');
});
await new Promise(r => faussaire.listen(PORT_COURRIEL, "127.0.0.1", r));

/* ------------------------------------------------------ Lancer une API

   Plusieurs configurations sont nécessaires — Resend, Brevo, sans
   expéditeur, sans adresse publique. On monte donc l'API à la demande,
   chacune sur son port. */

const serveurs = [];
const lancer = async (nom, env, port) => {
  const p = spawn(process.execPath, [path.join(API, "server.js")], {
    env: {
      ...process.env, ...banc.env,
      PORT: String(port),
      MOT_DE_PASSE: "mot-de-passe-de-controle",
      SECRET_SESSION: "un-secret-de-controle-suffisamment-long-pour-passer",
      ANTHROPIC_API_KEY: "",
      FICHIER_AMORCE: "/inexistant",
      TENANT_DEFAUT: "xavier",
      COURRIEL_URL: `http://127.0.0.1:${PORT_COURRIEL}/envoi`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let journal = "";
  p.stdout.on("data", d => { journal += d; });
  p.stderr.on("data", d => { journal += d; });
  serveurs.push(p);

  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/sante`)).ok) {
        return { port, lire: () => journal };
      }
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error(`l'API « ${nom} » n'a pas démarré :\n${journal}`);
};

const appel = async (port, chemin, corps, entetes = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${chemin}`, {
    method: corps === undefined ? "GET" : "POST",
    headers: { ...(corps !== undefined ? { "content-type": "application/json" } : {}), ...entetes },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  return { statut: r.status, entetes: r.headers, corps: await r.json().catch(() => null) };
};

const fermer = async () => {
  for (const p of serveurs) p.kill();
  await new Promise(r => faussaire.close(r));
  await banc.fermer();
};

try {

/* =====================================================================
   1. RESEND : CE QUI PART RÉELLEMENT
   ===================================================================== */

const resend = await lancer("resend", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
}, PORT_BASE);

recus.length = 0;
const demande = await appel(resend.port, "/api/lien", { courriel: "xavier@exemple.fr" });
verifier("une demande de lien aboutit", demande.statut === 200 && demande.corps?.envoye === true,
  JSON.stringify(demande.corps));

const envoi = recus[0];
verifier("un courriel est bien parti", recus.length === 1, `${recus.length} envoi(s)`);
verifier("Resend : autorisation par jeton porteur",
  envoi?.entetes.authorization === "Bearer cle-de-controle", envoi?.entetes.authorization);
verifier("Resend : les champs sont ceux qu'il attend",
  envoi?.corps?.from === "biblio@exemple.fr"
    && Array.isArray(envoi?.corps?.to) && envoi.corps.to[0] === "xavier@exemple.fr"
    && typeof envoi?.corps?.subject === "string"
    && typeof envoi?.corps?.text === "string",
  JSON.stringify(envoi?.corps && Object.keys(envoi.corps)));

/* L'ADRESSE DU LIEN. C'est ici que se joue le vol de jeton par en-tête
   « Host » : elle doit venir de la configuration, jamais de la requête. */
const lienEnvoye = (envoi?.corps?.text ?? "").match(/https?:\/\/\S+/)?.[0] ?? "";
verifier("le lien pointe vers l'adresse CONFIGURÉE",
  lienEnvoye.startsWith("https://biblio.exemple.fr/ma-bibliotheque.html?jeton="),
  lienEnvoye.slice(0, 80));

/* LA DÉMONSTRATION, ET NON LA SUPPOSITION.

   On refait une demande en annonçant un hôte choisi par l'attaquant. C'est
   l'attaque complète : il demande un lien POUR VOTRE adresse, en annonçant
   « Host: chez-moi ». Vous recevez un courriel envoyé par le vrai service,
   signé par le vrai domaine — et dont le lien pointe chez lui. Vous cliquez,
   il tient un jeton valable à votre nom.

   « fetch » interdit de poser l'en-tête Host ; on passe donc par une requête
   HTTP brute, ce qui est de toute façon ce que ferait un attaquant. */
recus.length = 0;
await new Promise((resoudre) => {
  const charge = JSON.stringify({ courriel: "xavier@exemple.fr" });
  const r = http.request({
    host: "127.0.0.1", port: resend.port, path: "/api/lien", method: "POST",
    headers: { "content-type": "application/json",
               "content-length": Buffer.byteLength(charge),
               host: "chez-l-attaquant.example" },
  }, (rep) => { rep.resume(); rep.on("end", resoudre); });
  r.on("error", resoudre);
  r.end(charge);
});
const lienForge = (recus[0]?.corps?.text ?? "").match(/https?:\/\/\S+/)?.[0] ?? "";
verifier("un « Host » falsifié ne détourne pas le lien",
  lienForge.startsWith("https://biblio.exemple.fr/"),
  lienForge.slice(0, 80) || "aucun envoi");

/* LE MESSAGE NE DIT RIEN DE LA BIBLIOTHÈQUE. Un courriel traverse des
   serveurs qu'on ne choisit pas. */
verifier("le message ne contient que le lien et sa durée",
  !/l-prive|Titre |bibliothèque de/i.test(envoi?.corps?.text ?? ""),
  (envoi?.corps?.text ?? "").slice(0, 120));

/* =====================================================================
   2. AUCUNE ÉNUMÉRATION
   ===================================================================== */

recus.length = 0;
const inconnu = await appel(resend.port, "/api/lien", { courriel: "personne@exemple.fr" });
verifier("une adresse inconnue reçoit la MÊME réponse",
  inconnu.statut === demande.statut
    && JSON.stringify(inconnu.corps) === JSON.stringify(demande.corps),
  `${inconnu.statut} ${JSON.stringify(inconnu.corps)}`);
verifier("… et aucun courriel n'est parti", recus.length === 0, `${recus.length} envoi(s)`);

const malForme = await appel(resend.port, "/api/lien", { courriel: "pas-une-adresse" });
verifier("une adresse mal formée est refusée — la forme n'est pas un secret",
  malForme.statut === 400, `statut ${malForme.statut}`);

/* =====================================================================
   3. LE LIEN OUVRE UNE SESSION, UNE SEULE FOIS
   ===================================================================== */

const jeton = decodeURIComponent(lienEnvoye.split("jeton=")[1] ?? "");
verifier("le jeton est assez long pour n'être pas devinable",
  jeton.length >= 40, `${jeton.length} caractères`);

/* IL N'EST PAS STOCKÉ EN CLAIR. Une copie de la base ne doit pas permettre
   de se connecter. */
const empreinteAttendue = createHash("sha256").update(jeton, "utf8").digest("base64url");
const enBase = await q("select empreinte from liens_connexion where empreinte = $1",
                       [empreinteAttendue]);
verifier("la base ne garde qu'une empreinte du jeton", enBase.length === 1);
verifier("… et le jeton lui-même n'y figure nulle part",
  (await q("select count(*)::int n from liens_connexion where empreinte = $1", [jeton]))[0].n === 0);

const echange = await appel(resend.port, "/api/connexion-lien", { jeton });
const cookie = echange.entetes.get("set-cookie") ?? "";
verifier("le jeton s'échange contre une session", echange.statut === 200, `statut ${echange.statut}`);
verifier("le cookie est celui de production, préfixé et protégé",
  /^__Host-session=/.test(cookie) && /HttpOnly/i.test(cookie)
    && /SameSite=Strict/i.test(cookie) && /Secure/.test(cookie),
  cookie.slice(0, 80));

/* LA SESSION OUVRE BIEN LA BONNE BIBLIOTHÈQUE — et pas une autre. */
const session = cookie.split(";")[0];
const vue = await appel(resend.port, "/api/livres", undefined, { cookie: session });
verifier("la session donne accès aux ouvrages privés du bon locataire",
  Array.isArray(vue.corps) && vue.corps.some(l => l.id === "l-prive"),
  JSON.stringify(vue.corps?.map(l => l.id)));

const rejeu = await appel(resend.port, "/api/connexion-lien", { jeton });
verifier("le même lien ne sert pas deux fois", rejeu.statut === 401, `statut ${rejeu.statut}`);

/* UN LIEN PÉRIMÉ. On le fabrique en base plutôt que d'attendre un quart
   d'heure : ce qu'on éprouve est la clause « expire_le > now() », pas la
   patience. */
const [compte] = await q("select id from comptes where courriel = 'xavier@exemple.fr'");
const vieux = "jeton-perime-de-controle-aaaaaaaaaaaaaaaaaaaa";
await q(`insert into liens_connexion (empreinte, compte_id, expire_le)
         values ($1, $2, now() - interval '1 minute')`,
        [createHash("sha256").update(vieux, "utf8").digest("base64url"), compte.id]);
verifier("un lien périmé est refusé",
  (await appel(resend.port, "/api/connexion-lien", { jeton: vieux })).statut === 401);

verifier("un jeton inventé est refusé",
  (await appel(resend.port, "/api/connexion-lien", { jeton: "n-importe-quoi" })).statut === 401);

/* =====================================================================
   4. ON N'INONDE PAS UNE BOÎTE AUX LETTRES
   ===================================================================== */

/* SUR UNE INSTANCE NEUVE, et ce n'est pas un détail de confort.

   Première version : on comptait les essais sur le serveur déjà utilisé
   plus haut. Les demandes précédentes — dont celle à l'en-tête falsifié —
   avaient entamé le budget, et le contrôle annonçait « bloqué au 2e » sur un
   limiteur qui en autorise cinq. Il mesurait la somme des essais du fichier,
   pas le seuil.

   Un limiteur en mémoire est propre à son processus : une instance neuve
   donne un compte exact, et le contrôle dit alors quelque chose de vrai. */
const frais = await lancer("limiteur", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
}, PORT_BASE + 5);

let acceptees = 0, dernier = 200;
for (let i = 0; i < 20 && dernier !== 429; i++) {
  dernier = (await appel(frais.port, "/api/lien", { courriel: "xavier@exemple.fr" })).statut;
  if (dernier === 200) acceptees += 1;
}
verifier("les demandes répétées finissent refusées", dernier === 429, `statut ${dernier}`);
verifier("… au seuil annoncé : cinq par quart d'heure",
  acceptees === 5, `${acceptees} acceptée(s) avant le refus`);

/* =====================================================================
   5. BREVO : LE MÊME CODE, UN AUTRE SERVICE

   Éprouvé maintenant alors que la migration est seulement envisagée. Écrire
   ce chemin « le jour venu » reviendrait à écrire du code non éprouvé un
   jour où l'on est pressé — on migre en général quand quelque chose ne va
   plus.
   ===================================================================== */

const brevo = await lancer("brevo", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "brevo",
  COURRIEL_CLEF: "cle-brevo-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
}, PORT_BASE + 1);

recus.length = 0;
await appel(brevo.port, "/api/lien", { courriel: "xavier@exemple.fr" });
const envoiB = recus[0];
verifier("Brevo : autorisation par en-tête « api-key »",
  envoiB?.entetes["api-key"] === "cle-brevo-de-controle", envoiB?.entetes["api-key"]);
verifier("Brevo : les champs sont ceux qu'il attend",
  envoiB?.corps?.sender?.email === "biblio@exemple.fr"
    && envoiB?.corps?.to?.[0]?.email === "xavier@exemple.fr"
    && typeof envoiB?.corps?.textContent === "string",
  JSON.stringify(envoiB?.corps && Object.keys(envoiB.corps)));

/* =====================================================================
   6. CE QUI DOIT REFUSER PLUTÔT QUE DE MAL FAIRE
   ===================================================================== */

/* Sans expéditeur : on refuse au lieu d'envoyer un message qui sera rejeté
   par le destinataire — et de laisser croire qu'il est parti. */
const bancal = await lancer("sans expéditeur", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle",
  COURRIEL_EXPEDITEUR: "",
}, PORT_BASE + 2);
verifier("sans expéditeur configuré, la route refuse proprement",
  (await appel(bancal.port, "/api/lien", { courriel: "xavier@exemple.fr" })).statut === 503);

/* En production, le mode « journal » écrirait le lien en clair dans le
   journal du serveur. On refuse. */
const muet = await lancer("production sans courriel", {
  DERRIERE_PROXY: "1",
  ENVIRONNEMENT: "production",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
}, PORT_BASE + 3);
verifier("en production sans expéditeur, la connexion par lien refuse",
  (await appel(muet.port, "/api/lien", { courriel: "xavier@exemple.fr" })).statut === 503);
verifier("… mais le mot de passe fonctionne toujours",
  (await appel(muet.port, "/api/connexion",
     { motDePasse: "mot-de-passe-de-controle" })).statut === 200);

/* SANS ADRESSE PUBLIQUE, derrière un proxy, on ne sait pas fabriquer un
   lien sûr — et on ne va pas le fabriquer avec l'en-tête « Host ». */
const sansAdresse = await lancer("sans adresse publique", {
  DERRIERE_PROXY: "1",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
}, PORT_BASE + 4);
recus.length = 0;
const refus = await appel(sansAdresse.port, "/api/lien", { courriel: "xavier@exemple.fr" });
verifier("sans ADRESSE_PUBLIQUE, aucun lien n'est fabriqué",
  refus.statut >= 500, `statut ${refus.statut}`);
verifier("… et surtout, rien n'est parti", recus.length === 0, `${recus.length} envoi(s)`);

/* LE SERVICE DE COURRIEL EN PANNE. L'utilisateur doit l'apprendre, pas
   attendre un message qui ne viendra jamais. */
refuser = true;
const enPanne = await appel(resend.port, "/api/lien", { courriel: "xavier@exemple.fr" });
refuser = false;
verifier("un service de courriel qui refuse est signalé, pas masqué",
  enPanne.statut >= 400 && enPanne.corps?.envoye !== true,
  `statut ${enPanne.statut}, ${JSON.stringify(enPanne.corps)}`);

/* La clef ne doit PAS ressortir dans la réponse, même en cas d'échec. */
verifier("… sans jamais renvoyer la clef ni l'adresse du service",
  !JSON.stringify(enPanne.corps ?? {}).includes("cle-de-controle")
    && !JSON.stringify(enPanne.corps ?? {}).includes("127.0.0.1"),
  JSON.stringify(enPanne.corps));

/* --------------------------------------------------------------- Bilan */

} finally {
  await fermer();
}

console.log("\n=== Connexion par lien de courriel ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
