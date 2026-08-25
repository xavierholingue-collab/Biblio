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

/* Tout serveur ouvert ici doit être fermé ici. Le faux fournisseur OIDC a
   été ajouté sans l'être : le fichier finissait ses contrôles et ne rendait
   jamais la main, parce qu'une socket en écoute maintient Node en vie. Un
   test qui ne se termine pas ne DIT rien — il finit tué par un délai, et son
   verdict n'est jamais imprimé. */
const aFermer = [];
const fermer = async () => {
  for (const p of serveurs) p.kill();
  await new Promise(r => faussaire.close(r));
  for (const s of aFermer) await new Promise(r => s.close(r));
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

/* UN ENVOI RÉUSSI LAISSE UNE TRACE. Sans elle, un journal muet signifie
   aussi bien « aucune demande » que « demande réussie » — et l'on ne peut
   pas répondre à « le lien est-il parti ? ». Mais SANS l'adresse : le
   journal d'un serveur n'a pas à dire qui utilise le service. */
verifier("un envoi réussi est journalisé",
  /lien de connexion envoyé \(resend\)/.test(resend.lire()), resend.lire().slice(-200));
verifier("… sans jamais nommer le destinataire",
  !resend.lire().includes("xavier@exemple.fr"), "l'adresse figure dans le journal");
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

/* ---------------------------------------------------------------------
   CHANGER D'IP NE DOIT PLUS ROUVRIR LE ROBINET — 21/08/2026

   Le limiteur ne comptait que les IP. Son commentaire annonçait pourtant
   protéger « quelqu'un dont on connaît l'adresse » du harcèlement — et
   changer d'IP est à la portée de n'importe qui. La protection annoncée
   n'existait pas, et rien ne le disait : le contrôle ci-dessus passait au
   vert parce qu'il tirait toujours depuis la même IP.

   C'est le défaut le plus tenace de cette base de code : UN CONTRÔLE QUI
   MESURE UN SUBSTITUT. Ici, l'IP tenait lieu de personne.

   Ce contrôle-ci tire depuis des IP TOUTES DIFFÉRENTES vers UNE SEULE
   adresse. Sur l'ancien limiteur, les vingt passaient. */
{
  let passees = 0;
  for (let i = 0; i < 20; i++) {
    const r = await appel(frais.port, "/api/lien",
      { courriel: "victime@exemple.fr" },
      { "x-forwarded-for": `203.0.113.${i + 1}` });
    if (r.statut === 200) passees += 1;
  }
  /* CINQ EXACTEMENT, pas « au plus quinze ». La borne large laissait passer
     une version sans normalisation de la casse : deux seaux de cinq font
     dix, et dix est inférieur à quinze. Un seuil qui n'exclut pas la version
     fautive ne mesure rien. */
  verifier("changer d'IP ne relance pas le compteur d'une adresse",
    passees === 5, `${passees} courriels partis vers la même adresse`);
}

/* Et la réciproque : une IP partagée — un opérateur mobile en sert des
   milliers — ne doit pas condamner les autres. Le plafond par adresse est
   propre à chaque adresse, sinon le premier venu bloque tout son réseau. */
{
  const r = await appel(frais.port, "/api/lien",
    { courriel: "quelquun-dautre@exemple.fr" },
    { "x-forwarded-for": "203.0.113.7" });
  verifier("une autre adresse depuis une IP déjà vue passe encore",
    r.statut === 200, `statut ${r.statut}`);
}

/* La casse ne crée pas un second seau : sinon le plafond se contourne en
   changeant une majuscule, ce qui n'est pas une attaque, c'est une faute
   de frappe qui l'annule. */
{
  let passees = 0;
  for (let i = 0; i < 20; i++) {
    const r = await appel(frais.port, "/api/lien",
      { courriel: i % 2 ? "Cible@Exemple.FR" : "cible@exemple.fr" },
      { "x-forwarded-for": `198.51.100.${i + 1}` });
    if (r.statut === 200) passees += 1;
  }
  verifier("… et changer la casse de l'adresse non plus",
    passees === 5, `${passees} courriels partis vers la même boîte`);
}

/* ---------------------------------------------------------------------
   LE PLAFOND JOURNALIER PAR ADRESSE MORD-IL VRAIMENT ?

   Il ne pouvait pas être éprouvé, et je l'ai découvert en mutant : retirer
   entièrement ce compteur ne faisait tomber AUCUNE vérification. La raison
   n'est pas un oubli d'écriture, elle est structurelle — une fenêtre de
   vingt-quatre heures ne se déclenche jamais dans un contrôle qui dure trois
   secondes, puisque le plafond du quart d'heure arrête tout avant.

   Un garde-fou hors de portée des contrôles est un garde-fou dont on croit
   disposer. C'est exactement le motif du 15/08, où un garde-fou de migration
   comptait depuis l'intérieur du cloisonnement qu'il devait surveiller.

   D'où une instance dédiée qui RESSERRE le plafond journalier à deux : il
   passe alors sous celui du quart d'heure, et devient celui qui mord. Ce que
   ce contrôle prouve n'est pas la valeur — quinze est un choix — mais que le
   compteur EXISTE, qu'il est consulté, et qu'il est propre à chaque adresse.
   --------------------------------------------------------------------- */
const journalier = await lancer("plafond-jour", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
  LIENS_PAR_JOUR_ADRESSE: "2",
  /* PORT_BASE + 7 : les six premiers sont pris, et le neuvième est celui de
     la fausse messagerie. Réutiliser un port déjà servi ne lève pas — la
     seconde instance échoue en silence et les appels vont à la PREMIÈRE.
     Constaté à l'instant : trois contrôles d'un autre chapitre se sont mis
     à échouer, en accusant le code qu'ils testaient. */
}, PORT_BASE + 7);

{
  let passees = 0;
  for (let i = 0; i < 10; i++) {
    const r = await appel(journalier.port, "/api/lien",
      { courriel: "cible-jour@exemple.fr" },
      { "x-forwarded-for": `192.0.2.${i + 1}` });
    if (r.statut === 200) passees += 1;
  }
  verifier("le plafond journalier par adresse est bien consulté",
    passees === 2, `${passees} acceptée(s) pour un plafond de 2`);

  /* Et il n'est pas global : une seconde adresse a son propre compte. */
  const autre = await appel(journalier.port, "/api/lien",
    { courriel: "voisin-jour@exemple.fr" },
    { "x-forwarded-for": "192.0.2.99" });
  verifier("… et propre à chaque adresse, pas commun à toutes",
    autre.statut === 200, `statut ${autre.statut}`);
}

/* =====================================================================
   4 bis. S'INSCRIRE SOI-MÊME — ET NE RIEN CRÉER AVANT LA PREUVE

   La règle « aucun appel au modèle avant vérification » n'est écrite nulle
   part dans le code, et c'est voulu : sans compte il n'y a pas de session,
   donc pas d'appel. Ce qu'il faut éprouver n'est donc pas la règle, c'est ce
   qui la rend inutile — QUE RIEN N'EXISTE avant que le lien soit ouvert.
   ===================================================================== */

const compter = async () =>
  (await q("select count(*)::int n from tenants"))[0].n;

/* --- Porte fermée : le comportement d'avant ne bouge pas --------------- */
const fermee = await lancer("porte-fermee", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
}, PORT_BASE + 8);

{
  const avant = recus.length, locatairesAvant = await compter();
  const r = await appel(fermee.port, "/api/lien", { courriel: "inconnu@exemple.fr" });
  verifier("porte fermée : une adresse inconnue ne reçoit rien",
    recus.length === avant, `${recus.length - avant} envoi(s)`);
  verifier("… et la réponse ne le dit pas", r.statut === 200, `statut ${r.statut}`);
  verifier("… et aucun locataire n'est apparu",
    (await compter()) === locatairesAvant, "des locataires ont été créés");
}

/* --- Porte ouverte ----------------------------------------------------- */
const ouverte = await lancer("porte-ouverte", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
  INSCRIPTION_OUVERTE: "1",
}, PORT_BASE + 10);

const lienDuDernierCourriel = () => {
  const corps = recus.at(-1)?.corps ?? {};
  const m = String(corps.text ?? corps.textContent ?? corps.html ?? "")
    .match(/jeton=([A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
};

let jetonNeuf = null, locatairesAvantDemande = 0;
{
  locatairesAvantDemande = await compter();
  const r = await appel(ouverte.port, "/api/lien",
    { courriel: "nouvelle@exemple.fr" },
    { "x-forwarded-for": "203.0.114.1" });
  verifier("porte ouverte : une adresse inconnue reçoit un lien",
    r.statut === 200 && !!lienDuDernierCourriel(), `statut ${r.statut}`);

  /* LE CONTRÔLE QUI TIENT TOUTE LA CONCEPTION. Si un locataire naissait ici,
     mille demandes vers mille adresses feraient mille bibliothèques vides,
     mille identifiants d'URL réservés, et autant de lignes à nettoyer. */
  verifier("… mais RIEN n'est créé avant qu'il soit ouvert",
    (await compter()) === locatairesAvantDemande,
    `${await compter()} locataires contre ${locatairesAvantDemande} avant`);

  const message = JSON.stringify(recus.at(-1)?.corps ?? {});
  verifier("… et le courriel dit une première venue, pas une connexion",
    /[Bb]ienvenue/.test(message) && !/lien de connexion/.test(message),
    message.slice(0, 120));

  jetonNeuf = lienDuDernierCourriel();
}

/* --- La réponse HTTP ne distingue jamais les trois cas ------------------ */
{
  const connu = await appel(ouverte.port, "/api/lien",
    { courriel: "xavier@exemple.fr" }, { "x-forwarded-for": "203.0.114.2" });
  const inconnu = await appel(ouverte.port, "/api/lien",
    { courriel: "personne@exemple.fr" }, { "x-forwarded-for": "203.0.114.3" });
  const closPort = await appel(fermee.port, "/api/lien",
    { courriel: "personne@exemple.fr" }, { "x-forwarded-for": "203.0.114.4" });

  verifier("la réponse HTTP est la même, compte connu ou non",
    connu.statut === inconnu.statut &&
    JSON.stringify(connu.corps) === JSON.stringify(inconnu.corps),
    JSON.stringify([connu.corps, inconnu.corps]));
  verifier("… et la même encore, porte ouverte ou fermée",
    inconnu.statut === closPort.statut &&
    JSON.stringify(inconnu.corps) === JSON.stringify(closPort.corps),
    JSON.stringify([inconnu.corps, closPort.corps]));
}

/* --- Ouvrir le lien : c'est là que la bibliothèque naît ----------------- */
{
  const r = await appel(ouverte.port, "/api/connexion-lien", { jeton: jetonNeuf });
  verifier("ouvrir le lien ouvre une session", r.statut === 200,
    `statut ${r.statut} — ${JSON.stringify(r.corps)}`);
  verifier("… et crée le locataire à ce moment-là",
    (await compter()) === locatairesAvantDemande + 1,
    `${await compter()} locataires`);

  const [neuf] = await q(
    `select t.identifiant, t.visibilite, t.quota_ia_mois, t.nom
       from tenants t join comptes c on c.tenant_id = t.id
      where c.courriel = 'nouvelle@exemple.fr'`);
  verifier("… privé par défaut", neuf?.visibilite === "privee", JSON.stringify(neuf));
  verifier("… avec le quota d'un compte neuf, pas celui de personne d'autre",
    neuf?.quota_ia_mois === 10, String(neuf?.quota_ia_mois));

  /* L'IDENTIFIANT NE VIENT PAS DU COURRIEL. Le dériver aurait publié la
     partie locale d'une adresse le jour où la bibliothèque devient publique
     — une donnée que personne n'a choisi de publier. */
  verifier("… et son adresse d'URL ne trahit pas son courriel",
    !!neuf?.identifiant && !/nouvelle/.test(neuf.identifiant), String(neuf?.identifiant));

  /* Un lien ne sert qu'une fois : le rejouer ne doit pas faire un second
     locataire, ni rendre une session. */
  const rejoue = await appel(ouverte.port, "/api/connexion-lien", { jeton: jetonNeuf });
  verifier("rejouer le lien ne donne pas de session",
    rejoue.statut !== 200, `statut ${rejoue.statut}`);
  verifier("… et ne fabrique pas un second locataire",
    (await compter()) === locatairesAvantDemande + 1, `${await compter()} locataires`);
}

/* --- Le nouveau venu est cloisonné comme les autres --------------------- */
{
  const [neuf] = await q(
    `select t.id from tenants t join comptes c on c.tenant_id = t.id
      where c.courriel = 'nouvelle@exemple.fr'`);

  /* ÉCHOUER PAR UN NOM, PAS PAR UN PLANTAGE. Ce garde-fou est né d'une
     mutation : rendre le nouveau locataire PUBLIC faisait refuser l'insertion
     par la politique, donc aucun locataire, donc « neuf » indéfini, donc une
     TypeError qui tuait le fichier AVANT l'affichage des verdicts. Le lot de
     mutations affichait alors zéro échec — c'est-à-dire un succès.

     Troisième fois que ce défaut se présente dans cette base de code. Un
     contrôle qui plante ne dit pas ce qui ne va pas ; pire, il emporte avec
     lui les contrôles qui, eux, avaient quelque chose à dire. */
  if (!neuf) {
    verifier("le locataire du parcours réel existe", false,
      "aucun locataire pour nouvelle@exemple.fr — l'inscription n'a rien créé");
  } else {
    const [x] = await q("select id from tenants where identifiant = 'xavier'");
    const vus = await banc.dans(neuf.id, "select count(*)::int n from livres");
    const chezXavier = await q(
      "select count(*)::int n from possessions where tenant_id = $1", [x.id]);
    verifier("un locataire créé par le parcours réel ne voit rien des autres",
      vus[0].n === 0, `${vus[0].n} ouvrage(s) vus, ${chezXavier[0].n} existent chez Xavier`);
  }
}

/* =====================================================================
   4 ter. SE CONNECTER AVEC GOOGLE — LES DEUX ROUTES, DE BOUT EN BOUT

   test-oidc.mjs éprouve le MODULE : il refuse-t-il les jetons qu'il doit
   refuser. Ici on éprouve le BRANCHEMENT : le state, le cookie de transit,
   le rattachement au bon compte, et le refus d'une adresse non vérifiée.

   Deux choses ne peuvent se voir qu'ici. La portée du cookie de transit —
   « Strict » le rendrait invisible au retour de Google, et la connexion
   échouerait en accusant une falsification. Et le rattachement, qui touche
   la base et dépend de comptes existants.
   ===================================================================== */

const { generateKeyPairSync, createSign } = await import("node:crypto");
const paire = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkG = { ...paire.publicKey.export({ format: "jwk" }),
               kid: "g-1", alg: "RS256", use: "sig" };
const CLIENT_G = "lisia.apps.googleusercontent.com";
const PORT_G = PORT_BASE + 11;

let prochaineIdentite = {};
let nonceDuDepart = null;   // ce que le fournisseur a reçu au départ
const b64j = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const fauxGoogle = createServer(async (req, rep) => {
  const chemin = new URL(req.url, "http://x").pathname;
  if (chemin === "/clefs") {
    rep.writeHead(200, { "content-type": "application/json" });
    return rep.end(JSON.stringify({ keys: [jwkG] }));
  }
  if (chemin === "/jeton") {
    /* LE NONCE NE VIENT PAS DE L'ÉCHANGE — première version fautive, et elle
       a fait échouer six contrôles en accusant le branchement.

       Le nonce voyage dans la requête d'AUTORISATION : le fournisseur le
       reçoit là, le retient le temps de l'aller-retour, et le recopie dans le
       jeton. Ma doublure le cherchait dans le corps de l'échange, où il n'est
       jamais. Elle produisait donc un jeton sans nonce — que le module
       refusait, à juste titre.

       Une doublure qui ne reproduit pas le comportement réel n'éprouve rien :
       elle invente un monde où le code échoue pour la mauvaise raison. */
    let brut = ""; for await (const m of req) brut += m;
    const nonce = nonceDuDepart;
    const t = Math.floor(Date.now() / 1000);
    const corps = {
      iss: `http://127.0.0.1:${PORT_G}`, aud: CLIENT_G,
      sub: "google-1", email: "alice@exemple.fr", email_verified: true,
      iat: t, exp: t + 3600, nonce, ...prochaineIdentite,
    };
    delete corps._nonce;
    const tete = `${b64j({ alg: "RS256", kid: "g-1", typ: "JWT" })}.${b64j(corps)}`;
    const sg = createSign("RSA-SHA256"); sg.update(tete); sg.end();
    rep.writeHead(200, { "content-type": "application/json" });
    return rep.end(JSON.stringify({
      id_token: `${tete}.${sg.sign(paire.privateKey).toString("base64url")}` }));
  }
  rep.writeHead(404); rep.end();
});
await new Promise(r => fauxGoogle.listen(PORT_G, "127.0.0.1", r));
aFermer.push(fauxGoogle);

const avecGoogle = await lancer("google", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://lisia.y-factor.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
  INSCRIPTION_OUVERTE: "1",
  OIDC_URL: `http://127.0.0.1:${PORT_G}/`,
  OIDC_GOOGLE_ID: CLIENT_G,
  OIDC_GOOGLE_SECRET: "secret-de-controle",
}, PORT_BASE + 12);

/* « redirect: manual » : ces routes REDIRIGENT, et suivre la redirection
   ferait perdre l'en-tête qu'on veut lire. */
const brut = (chemin, entetes = {}) =>
  fetch(`http://127.0.0.1:${avecGoogle.port}${chemin}`,
        { redirect: "manual", headers: entetes });

/* Partir en retenant ce que le fournisseur retiendrait : le state, le nonce,
   et le cookie de transit. */
const partir = async () => {
  const d = await brut("/api/oidc/depart");
  const vers = new URL(d.headers.get("location"));
  nonceDuDepart = vers.searchParams.get("nonce");
  return {
    reponse: d,
    etat: vers.searchParams.get("state"),
    cookie: (d.headers.get("set-cookie").match(/(?:__Host-)?oidc=([^;]+)/) ?? [])[1],
  };
};

{
  const depart = await partir();
  const r = depart.reponse;
  const vers = r.headers.get("location") ?? "";
  const cookie = r.headers.get("set-cookie") ?? "";

  verifier("le départ redirige vers le fournisseur",
    r.status === 302 && vers.includes(`127.0.0.1:${PORT_G}`), `${r.status} → ${vers.slice(0, 60)}`);

  /* LA PORTÉE DU COOKIE EST LA SEULE CHOSE SUBTILE ICI. Google renvoie par
     une navigation venue d'un AUTRE site : un cookie « Strict » ne serait pas
     envoyé, le state serait introuvable, et l'on accuserait une falsification
     alors que rien n'a été falsifié. */
  verifier("… en posant un cookie de transit en SameSite=Lax",
    /SameSite=Lax/i.test(cookie) && !/SameSite=Strict/i.test(cookie),
    cookie.slice(0, 90));
  verifier("… HttpOnly, pour qu'aucun script ne le lise",
    /HttpOnly/i.test(cookie), cookie.slice(0, 90));

  const etatEnvoye = depart.etat, jetonTransit = depart.cookie;

  /* --- Le retour nominal : une inscription --- */
  const avantG = await compter();
  const retour = await brut(`/api/oidc/retour?code=abc&state=${etatEnvoye}`,
    { cookie: `__Host-oidc=${jetonTransit}` });

  verifier("le retour ouvre une session et renvoie à la bibliothèque",
    retour.status === 302 && /ma-bibliotheque/.test(retour.headers.get("location") ?? ""),
    `${retour.status} → ${retour.headers.get("location")}`);
  verifier("… en posant la session, elle en Strict",
    /session=/.test(retour.headers.get("set-cookie") ?? "")
    && /SameSite=Strict/i.test(retour.headers.get("set-cookie") ?? ""),
    (retour.headers.get("set-cookie") ?? "").slice(0, 90));
  verifier("… et le locataire est créé",
    (await compter()) === avantG + 1, `${await compter()} locataires`);

  const [neuf] = await q(
    `select c.oidc_sub, c.courriel from comptes c where c.courriel = 'alice@exemple.fr'`);
  verifier("… rattaché à son identifiant Google, pas à son adresse",
    neuf?.oidc_sub === "google-1", JSON.stringify(neuf));
}

/* --- UN STATE QUI NE CORRESPOND PAS EST REFUSÉ --------------------------
   C'est la protection contre la falsification de requête : sans elle,
   n'importe qui peut faire aboutir une connexion dans le navigateur d'un
   autre. */
{
  const d = await partir();
  const r = await brut("/api/oidc/retour?code=abc&state=un-etat-fabrique",
    { cookie: `__Host-oidc=${d.cookie}` });
  verifier("un state qui ne correspond pas au cookie est refusé",
    /oidc=expire/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));
}

/* --- SANS COOKIE DE TRANSIT, RIEN NE PASSE ---------------------------- */
{
  const d = await partir();
  const r = await brut(`/api/oidc/retour?code=abc&state=${d.etat}`);
  verifier("… et sans cookie du tout, non plus",
    /oidc=expire/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));
}

/* --- L'ADRESSE NON VÉRIFIÉE EST REFUSÉE FRANCHEMENT --------------------
   Décidé le 22/08 : un repli silencieux sur le lien magique ferait croire à
   une panne, et la personne chercherait le défaut là où il n'est pas. */
{
  prochaineIdentite = { sub: "google-2", email: "bob@exemple.fr", email_verified: false };
  const avantR = await compter();
  const d = await partir();
  const r = await brut(`/api/oidc/retour?code=abc&state=${d.etat}`,
    { cookie: `__Host-oidc=${d.cookie}` });

  verifier("une adresse non vérifiée est refusée, et le dit",
    /oidc=non-verifiee/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));
  verifier("… et aucun compte n'est créé au passage",
    (await compter()) === avantR, `${await compter()} locataires`);
}

/* --- LE RATTACHEMENT À UN COMPTE VENU DU LIEN MAGIQUE -------------------
   « nouvelle@exemple.fr » s'est inscrite plus haut par lien magique. Elle
   revient par Google : on doit retrouver SA bibliothèque, pas en créer une
   seconde. */
{
  prochaineIdentite = { sub: "google-3", email: "nouvelle@exemple.fr", email_verified: true };
  const avantL = await compter();
  const d = await partir();
  const r = await brut(`/api/oidc/retour?code=abc&state=${d.etat}`,
    { cookie: `__Host-oidc=${d.cookie}` });

  verifier("revenir par Google retrouve le compte du lien magique",
    r.status === 302 && /oidc=ok/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));
  verifier("… sans créer une seconde bibliothèque",
    (await compter()) === avantL, `${await compter()} locataires`);

  const [rattache] = await q(
    "select oidc_sub from comptes where courriel = 'nouvelle@exemple.fr'");
  verifier("… et le compte porte désormais son identifiant Google",
    rattache?.oidc_sub === "google-3", JSON.stringify(rattache));
}
/* --- LE SUB EST CHERCHÉ AVANT LE COURRIEL, ET C'EST TESTÉ ---------------

   Ajouté après une mutation : inverser l'ordre — chercher le courriel
   d'abord — ne faisait tomber AUCUN contrôle. Aucun de mes cas ne mettait
   les deux clés en désaccord.

   Or c'est précisément là que l'ordre compte. « alice@exemple.fr » s'est
   inscrite par Google sous le sub « google-1 ». Elle revient avec la MÊME
   identité Google et une adresse CHANGÉE — mariage, domaine, alias devenu
   principal. Cherché par sub, on la reconnaît. Cherché par courriel, on ne
   trouve rien et on lui offre une bibliothèque vide alors que la sienne
   existe : elle ne comprendrait pas, et nous non plus. */
{
  prochaineIdentite = { sub: "google-1", email: "alice.mariee@exemple.fr",
                        email_verified: true };
  const avantS = await compter();
  const d = await partir();
  const r = await brut(`/api/oidc/retour?code=abc&state=${d.etat}`,
    { cookie: `__Host-oidc=${d.cookie}` });

  verifier("une adresse Google changée retrouve le même compte",
    r.status === 302 && /oidc=ok/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));
  verifier("… sans créer une bibliothèque de plus",
    (await compter()) === avantS, `${await compter()} locataires`);

  const [suivi] = await q("select courriel from comptes where oidc_sub = 'google-1'");
  verifier("… et le courriel suit, puisqu'il n'est qu'un attribut",
    suivi?.courriel === "alice.mariee@exemple.fr", JSON.stringify(suivi));
}

/* --- LA PRISE DE CONTRÔLE, ET SON REFUS ---------------------------------

   LE CONTRÔLE LE PLUS IMPORTANT DE CETTE SECTION, et il manquait. Une
   mutation retirant la vérification dans la branche de rattachement n'a rien
   fait tomber : mon cas « non vérifiée » portait une adresse INCONNUE, qui
   part en création — une branche où la vérification est testée ailleurs.

   Le scénario réel est celui-ci. Quelqu'un crée un Google Workspace sur un
   domaine qu'il contrôle, y déclare l'adresse d'un inscrit, et se présente.
   Google rend « email_verified: false » — il n'a pas prouvé cette adresse.
   Sans la condition, on rattacherait, et l'attaquant entrerait dans la
   bibliothèque de sa victime. */
{
  prochaineIdentite = { sub: "google-pirate", email: "nouvelle@exemple.fr",
                        email_verified: false };
  const d = await partir();
  const r = await brut(`/api/oidc/retour?code=abc&state=${d.etat}`,
    { cookie: `__Host-oidc=${d.cookie}` });

  verifier("une adresse NON VÉRIFIÉE ne prend pas un compte existant",
    /oidc=non-verifiee/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));

  const [victime] = await q(
    "select oidc_sub from comptes where courriel = 'nouvelle@exemple.fr'");
  verifier("… et le compte visé garde son identifiant Google d'origine",
    victime?.oidc_sub === "google-3",
    `${JSON.stringify(victime)} — l'attaquant s'est rattaché`);
}

prochaineIdentite = {};

/* =====================================================================
   4 bis. LES INSCRIPTIONS FERMÉES — LES DEUX PORTES, PAS UNE SEULE

   POURQUOI CETTE SECTION N'EXISTAIT PAS, ET CE QUE CELA A COÛTÉ

   Tous les serveurs de ce fichier étaient lancés avec
   « INSCRIPTION_OUVERTE: "1" ». Le drapeau n'était donc JAMAIS éprouvé dans
   la position où il protège. Une suite entièrement verte, et un contrôle qui
   n'avait jamais été mis en position de refuser quoi que ce soit.

   Le défaut est sorti en production le 24/08/2026 : drapeau à 0, le lien
   magique refusait les inconnus, et une connexion Google a créé une
   bibliothèque neuve. « connexionParOidc » ne recevait pas le drapeau.

   D'où un serveur de plus, fermé celui-là, et les deux portes essayées
   dessus. La troisième vérification est la contrepartie indispensable :
   fermer les INSCRIPTIONS ne doit pas fermer les CONNEXIONS.
   ===================================================================== */

const ferme = await lancer("ferme", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://lisia.y-factor.fr",
  COURRIEL_SERVICE: "resend",
  COURRIEL_CLEF: "cle-de-controle",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
  INSCRIPTION_OUVERTE: "0",
  OIDC_URL: `http://127.0.0.1:${PORT_G}/`,
  OIDC_GOOGLE_ID: CLIENT_G,
  OIDC_GOOGLE_SECRET: "secret-de-controle",
}, PORT_BASE + 13);

const brutF = (chemin, entetes = {}) =>
  fetch(`http://127.0.0.1:${ferme.port}${chemin}`,
        { redirect: "manual", headers: entetes });

const partirF = async () => {
  const d = await brutF("/api/oidc/depart");
  const vers = new URL(d.headers.get("location"));
  nonceDuDepart = vers.searchParams.get("nonce");
  return {
    etat: vers.searchParams.get("state"),
    cookie: (d.headers.get("set-cookie").match(/(?:__Host-)?oidc=([^;]+)/) ?? [])[1],
  };
};

const nbLocataires = async () =>
  Number((await q("select count(*) as n from tenants"))[0].n);

/* --- La porte Google, fermée -------------------------------------------- */
{
  const avant = await nbLocataires();

  prochaineIdentite = { sub: "google-inconnu", email: "inconnu@exemple.fr",
                        email_verified: true };
  const d = await partirF();
  const r = await brutF(`/api/oidc/retour?code=abc&state=${d.etat}`,
    { cookie: `__Host-oidc=${d.cookie}` });

  verifier("inscriptions fermées : Google le DIT, il ne fait pas semblant",
    /oidc=fermee/.test(r.headers.get("location") ?? ""),
    r.headers.get("location"));

  /* LA VÉRIFICATION QUI COMPTE. La redirection seule ne prouve rien : c'est
     précisément ce qu'un message d'erreur posé par-dessus une création
     réussie afficherait aussi. */
  verifier("… et AUCUNE bibliothèque n'a été créée",
    (await nbLocataires()) === avant,
    `${avant} → ${await nbLocataires()} — la porte Google crée encore`);

  const [compte] = await q(
    "select id from comptes where courriel = 'inconnu@exemple.fr'");
  verifier("… ni aucun compte", compte === undefined, JSON.stringify(compte));
}

/* --- La porte du courriel, fermée --------------------------------------- */
{
  const avant = await nbLocataires();
  recus.length = 0;

  const r = await appel(ferme.port, "/api/lien", { courriel: "autre-inconnu@exemple.fr" });

  /* La réponse reste « envoyé » : dire « adresse inconnue » livrerait la
     liste des inscrits à qui l'essaie. Le silence est le comportement voulu,
     et c'est le COMPTAGE qui prouve qu'il ne cache pas une création. */
  verifier("inscriptions fermées : le lien magique ne crée rien non plus",
    (await nbLocataires()) === avant,
    `${avant} → ${await nbLocataires()}`);
  verifier("… et aucun courriel n'est parti", recus.length === 0, String(recus.length));
}

/* --- Fermer les inscriptions ne ferme pas les connexions ---------------- */
{
  prochaineIdentite = { sub: "google-1", email: "alice.mariee@exemple.fr",
                        email_verified: true };
  const d = await partirF();
  const r = await brutF(`/api/oidc/retour?code=abc&state=${d.etat}`,
    { cookie: `__Host-oidc=${d.cookie}` });

  const ou = r.headers.get("location") ?? "";
  /* « __Host-session » et non « session » : ce serveur est lancé avec
     DERRIERE_PROXY=1, et server.js préfixe alors le cookie. */
  verifier("un inscrit se connecte TOUJOURS, inscriptions fermées ou non",
    /oidc=ok/.test(ou) && /__Host-session=/.test(r.headers.get("set-cookie") ?? ""),
    `${ou} — le drapeau a débordé sur la connexion`);
}

prochaineIdentite = {};

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

/* UNE CLEF TRONQUÉE. Le défaut du 17/08/2026, constaté en production.
   L'interface de Brevo n'affiche la clef entière qu'à sa création ; copiée
   depuis la liste, on emporte les points de suspension. « fetch » refuse
   alors de la mettre dans un en-tête, avec un message qui ne nomme ni la
   clef, ni le courriel, ni le fournisseur. */
const tronquee = await lancer("clef tronquée", {
  DERRIERE_PROXY: "1",
  ADRESSE_PUBLIQUE: "https://biblio.exemple.fr",
  COURRIEL_SERVICE: "brevo",
  COURRIEL_CLEF: "xkeysib-…",
  COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
}, PORT_BASE + 6);
recus.length = 0;
const clefFautive = await appel(tronquee.port, "/api/lien", { courriel: "xavier@exemple.fr" });
verifier("une clef contenant un caractère interdit est refusée AVANT l'envoi",
  clefFautive.statut === 503, `statut ${clefFautive.statut}`);
verifier("… et rien n'est parti", recus.length === 0, `${recus.length} envoi(s)`);
verifier("… et le journal nomme la variable fautive et la position",
  /COURRIEL_CLEF contient un caractère interdit en position 9/.test(tronquee.lire()),
  tronquee.lire().slice(-300));

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
