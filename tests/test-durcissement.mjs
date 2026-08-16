/* =========================================================================
   LES PROTECTIONS AJOUTÉES PAR LA REVUE DE SÉCURITÉ DU 16/08/2026

   Chacune répond à un défaut nommé. Sans ce fichier, elles seraient du code
   que rien n'éprouve — et du code de sécurité que rien n'éprouve finit par
   être supprimé un jour où il gêne, sans que personne ne mesure ce qu'on perd.

   ---------------------------------------------------------------------------
   CE QUI EST VÉRIFIÉ, ET CONTRE QUOI

   1. L'ORIGINE DES ÉCRITURES.
      SameSite=Strict protège des sites tiers. Mais « site » se compte au
      domaine enregistrable : blog.xavier-holingue.eu est le MÊME site que
      biblio.xavier-holingue.eu pour le navigateur, qui joint donc le cookie
      de session. Un POST de formulaire depuis un voisin part sans
      vérification préalable et s'exécute.

   2. UN COOKIE ABÎMÉ NE DOIT PAS FAIRE TOMBER LA PAGE.
      decodeURIComponent lève sur « %ZZ ». L'exception remontait au routeur,
      qui répondait 500 : un cookie posé de travers rendait le site
      inutilisable pour la personne visée, pages publiques comprises.

   3. LE NOM DU COOKIE.
      « __Host- » interdit au navigateur d'accepter un cookie de même nom
      posé par un sous-domaine voisin. On vérifie qu'il est bien émis en
      production, et que l'ancien nom reste accepté — sans quoi la livraison
      qui l'introduit déconnecterait tout le monde.

   4. LES MESSAGES D'ERREUR.
      Une erreur PostgreSQL nomme la table, la colonne, la contrainte, et
      parfois la valeur fautive. Renvoyée au client, elle dessine la base.

   5. LA TAILLE DES LOTS.
      Huit connexions au pool. Une transaction de cinquante mille fiches les
      immobilise, et le service devient muet pour tout le monde.

   6. LA SORTIE DU MODÈLE EST UNE ENTRÉE.
      Les titres du catalogue PARTAGÉ entrent dans la consigne. Un titre
      écrit pour la détourner peut faire produire au modèle une « année »
      contenant du HTML, affichée chez le lecteur.

   USAGE
     node tests/test-durcissement.mjs
     PGURL=... PGURL_OEIL=... node tests/test-durcissement.mjs            (CI)
   ========================================================================= */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const SECRET = "un-secret-de-controle-suffisamment-long-pour-passer";
const MDP = "mot-de-passe-de-controle";
const PORT = 3461, MODELE_PORT = 3462;
const BASE = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55487 });
const { q, semer } = banc;
const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
await q("update tenants set visibilite = 'publique', quota_ia_mois = 50 where id = $1",
        [xavier.id]);
await semer({ tenant: xavier.id, id: "d-public", isbn: "9780000000301",
              visibilite: "publique" });
await semer({ tenant: xavier.id, id: "d-prive", isbn: "9780000000302",
              visibilite: "privee" });

/* ------------------------------------------------- Un modèle qui répond

   Il joue les DEUX appels de la recommandation, et on garde ce qu'il a reçu :
   c'est le seul moyen de vérifier que le second n'a pas vu la bibliothèque.

   Sa suggestion porte une ANNÉE en HTML — exactement ce qu'un titre
   malveillant du catalogue partagé chercherait à obtenir. */
const consignesRecues = [];
const faussaire = createServer(async (req, rep) => {
  let corps = "";
  for await (const m of req) corps += m;
  let recu = { texte: "", outils: [] };
  try {
    const j = JSON.parse(corps);
    recu = { texte: j.messages[0].content,
             outils: (j.tools ?? []).map(t => t.name ?? t.type) };
  } catch { /* corps illisible : on garde la trace vide */ }
  const texte = recu.texte;
  consignesRecues.push(recu);

  // Le second appel est celui qui demande des ouvrages extérieurs.
  const externe = texte.includes("Propose 2 à 3 ouvrages");
  const charge = externe
    ? { suggestions: [{
        titre: "Ouvrage suggéré", auteur: "Auteur Suggéré", editeur: "Éditeur",
        annee: "<img src=x onerror=alert(1)>", isbn: "978-2-07-031901-5",
        pourquoi: "un motif" }] }
    : { lecture_de_la_demande: "Une demande de contrôle.",
        parcours: [{ id: "d-public", ordre: 1, pourquoi: "parce que",
                     a_chercher: "le chapitre 3" }],
        lacune: "il manque un ouvrage sur ce point précis" };

  rep.writeHead(200, { "content-type": "application/json" });
  rep.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(charge) }] }));
});
await new Promise(r => faussaire.listen(MODELE_PORT, "127.0.0.1", r));

/* ------------------------------------------------------- Lancer l'API

   DERRIERE_PROXY=1 : c'est la configuration de production, et c'est elle qui
   décide du nom du cookie. L'éprouver sans ce réglage ne dirait rien du
   comportement réel. */
const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT), MOT_DE_PASSE: MDP, SECRET_SESSION: SECRET,
    DERRIERE_PROXY: "1",
    ANTHROPIC_API_KEY: "clef-de-controle-sans-valeur",
    ANTHROPIC_URL: `http://127.0.0.1:${MODELE_PORT}/v1/messages`,
    FICHIER_AMORCE: "/inexistant", TENANT_DEFAUT: "xavier",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
serveur.stdout.on("data", d => { journal += d; });
serveur.stderr.on("data", d => { journal += d; });

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
let debout = false;
for (let i = 0; i < 40 && !debout; i++) {
  try { debout = (await fetch(`${BASE}/api/sante`)).ok; } catch { await dormir(400); }
}
const fermer = async () => {
  serveur.kill();
  await new Promise(r => faussaire.close(r));
  await banc.fermer();
};
if (!debout) { console.error("  ECHEC l API n a pas démarré\n" + journal); await fermer(); process.exit(1); }

const appel = async (chemin, { entetes = {}, methode = "GET", corps } = {}) => {
  const r = await fetch(BASE + chemin, {
    method: methode,
    headers: { ...(corps ? { "content-type": "application/json" } : {}), ...entetes },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  return { statut: r.status, entetes: r.headers, corps: await r.json().catch(() => null) };
};

const jetonValide = (() => {
  const charge = Buffer.from(JSON.stringify({
    t: xavier.id, expire: Date.now() + 3600_000 })).toString("base64url");
  return charge + "." + createHmac("sha256", SECRET).update(charge).digest("base64url");
})();

/* =====================================================================
   1. L'ORIGINE DES ÉCRITURES
   ===================================================================== */

const ecrire = (entetes) => appel("/api/reglages/livre", {
  methode: "PUT", entetes: { cookie: `__Host-session=${jetonValide}`, ...entetes },
  corps: { id: "d-public", visibilite: "publique" },
});

verifier("une écriture sans en-tête Origin passe (curl, contrôles, scripts)",
  (await ecrire({})).statut === 200);

verifier("une écriture depuis la bonne origine passe",
  (await ecrire({ origin: `http://127.0.0.1:${PORT}` })).statut === 200);

verifier("une écriture depuis un VOISIN DE DOMAINE est refusée",
  (await ecrire({ origin: "https://blog.xavier-holingue.eu" })).statut === 403);

verifier("une écriture depuis un site tiers est refusée",
  (await ecrire({ origin: "https://exemple-malveillant.test" })).statut === 403);

verifier("une origine illisible est refusée",
  (await ecrire({ origin: "pas-une-url" })).statut === 403);

/* La LECTURE publique doit rester ouverte à tous, y compris depuis ailleurs :
   c'est une page publique. Refuser ici casserait un usage légitime sans rien
   protéger — il n'y a rien à voler dans ce qui est déjà publié. */
verifier("une LECTURE depuis un site tiers reste autorisée",
  (await appel("/api/livres", { entetes: { origin: "https://exemple.test" } })).statut === 200);

verifier("la connexion elle-même est protégée par l'origine",
  (await appel("/api/connexion", { methode: "POST",
    entetes: { origin: "https://blog.xavier-holingue.eu" },
    corps: { motDePasse: MDP } })).statut === 403);

/* =====================================================================
   2. UN COOKIE ABÎMÉ
   ===================================================================== */

/* UN CONTRÔLE NE DOIT PAS PLANTER QUAND IL TROUVE CE QU'IL CHERCHE.
   Première version : « abime.corps.map(...) » dans le message d'échec. Avec
   la protection retirée, la réponse devient un objet d'erreur, « .map »
   n'existe pas, et le contrôle s'interrompait par une exception AVANT
   d'imprimer son bilan. Dans le harnais de mutation, cela ressemblait à une
   protection non couverte alors qu'elle l'était.
   Un message d'échec qui suppose la réussite ne sert que quand tout va
   bien — c'est-à-dire jamais quand on en a besoin. */
const abime = await appel("/api/livres", { entetes: { cookie: "__Host-session=%ZZ" } });
const idsAbime = Array.isArray(abime.corps) ? abime.corps.map(l => l.id) : null;
verifier("un cookie mal encodé ne provoque pas d'erreur 500",
  abime.statut === 200, "statut " + abime.statut + " : " + JSON.stringify(abime.corps));
verifier("… et son porteur est traité comme un visiteur",
  idsAbime !== null && !idsAbime.includes("d-prive"),
  JSON.stringify(idsAbime ?? abime.corps));

/* =====================================================================
   3. LE NOM DU COOKIE
   ===================================================================== */

const connexion = await appel("/api/connexion", { methode: "POST", corps: { motDePasse: MDP } });
const pose = connexion.entetes.get("set-cookie") ?? "";
verifier("en production, le cookie porte le préfixe __Host-",
  /^__Host-session=/.test(pose), pose.slice(0, 60));
verifier("… et il est Secure, sans Domain, de chemin racine",
  /Secure/.test(pose) && !/Domain=/i.test(pose) && /Path=\/;/.test(pose), pose.slice(0, 120));
verifier("… HttpOnly et SameSite=Strict, comme avant",
  /HttpOnly/i.test(pose) && /SameSite=Strict/i.test(pose), pose.slice(0, 120));

/* L'ANCIEN NOM RESTE ACCEPTÉ. Sans cela, la livraison qui introduit le
   préfixe déconnecte tout le monde — et une déconnexion inexpliquée est
   exactement ce qu'on s'est promis d'éviter. */
const ancien = await appel("/api/livres", { entetes: { cookie: `session=${jetonValide}` } });
verifier("une session posée sous l'ANCIEN nom fonctionne encore",
  Array.isArray(ancien.corps) && ancien.corps.some(l => l.id === "d-prive"),
  JSON.stringify(ancien.corps?.map(l => l.id)));

const sortie = await appel("/api/deconnexion", { methode: "POST",
  entetes: { cookie: `__Host-session=${jetonValide}` }, corps: {} });
const effaces = String(sortie.entetes.getSetCookie?.() ?? sortie.entetes.get("set-cookie"));
verifier("la déconnexion efface LES DEUX noms",
  /__Host-session=;/.test(effaces) && /(^|,|\s)session=;/.test(effaces), effaces.slice(0, 200));

/* =====================================================================
   4. LES MESSAGES D'ERREUR
   ===================================================================== */

/* Une note qui n'est pas un nombre : PostgreSQL refuse, et son message
   nomme le type et la valeur. C'est ce message qui ne doit pas sortir. */
const casse = await appel("/api/livres", {
  methode: "PUT", entetes: { cookie: `__Host-session=${jetonValide}` },
  corps: { id: "d-casse", titre: "T", auteur: "A", categorie: "Roman",
           sous_categorie: "Classique", sphere: "Pro", note: "pas-un-nombre" },
});
verifier("une erreur interne rend bien 500", casse.statut === 500, "statut " + casse.statut);
verifier("… et son message ne raconte RIEN de la base",
  casse.corps?.error === "Erreur interne.", JSON.stringify(casse.corps));
verifier("… mais le détail est journalisé côté serveur",
  /numeric|invalid|syntax|erreur/i.test(journal), journal.slice(-200));

/* =====================================================================
   5. LA TAILLE DES LOTS
   ===================================================================== */

const lot = Array.from({ length: 1001 }, (_, i) => ({
  id: "d-lot-" + i, titre: "T", auteur: "A", categorie: "Roman",
  sous_categorie: "Classique", sphere: "Pro",
}));
verifier("un lot de plus de mille ouvrages est refusé",
  (await appel("/api/livres", { methode: "PUT",
    entetes: { cookie: `__Host-session=${jetonValide}` }, corps: lot })).statut === 413);

verifier("… et rien n'a été écrit",
  (await q("select count(*)::int n from possessions where id like 'd-lot-%'"))[0].n === 0);

/* =====================================================================
   6. LA SORTIE DU MODÈLE
   ===================================================================== */

const reco = await appel("/api/recommandation", {
  methode: "POST", entetes: { cookie: `__Host-session=${jetonValide}` },
  corps: { intention: "quelque chose à comprendre", inclureExternes: true },
});
const suggestion = reco.corps?.suggestions_externes?.[0];
verifier("la recommandation aboutit", reco.statut === 200, "statut " + reco.statut);

/* =====================================================================
   LA SÉPARATION DES DEUX APPELS

   C'est la seule barrière contre l'exfiltration par détournement de
   consigne : le modèle qui VOIT la bibliothèque n'a aucun outil, celui qui
   a la recherche web ne voit pas la bibliothèque.

   On ne se contente donc pas de vérifier la réponse : on inspecte ce que
   chaque appel a REÇU. Une régression future — remettre les deux dans le
   même appel « pour la qualité » — ne se verrait dans aucune sortie.
   ===================================================================== */
const [premier, second] = consignesRecues.slice(-2);

/* LE CONTRÔLE QUI COMPTE LE PLUS, et qui manquait à la première version de
   ce fichier : on vérifiait ce que le second appel RECEVAIT, jamais que le
   premier était DÉSARMÉ. Rendre la recherche web au premier appel n'aurait
   fait tomber aucune vérification — c'est-à-dire que la barrière aurait pu
   disparaître en silence. */
verifier("le premier appel n'a AUCUN outil : rien ne peut sortir",
  premier !== undefined && premier.outils.length === 0,
  JSON.stringify(premier?.outils));

verifier("le second appel a bien la recherche web",
  second?.outils.includes("web_search"), JSON.stringify(second?.outils));

verifier("la recommandation fait bien DEUX appels distincts",
  consignesRecues.length >= 2, `${consignesRecues.length} appel(s)`);

verifier("le premier appel voit la bibliothèque",
  premier?.texte.includes("SA BIBLIOTHÈQUE") && premier?.texte.includes("d-prive"),
  (premier?.texte ?? "").slice(0, 120));

verifier("le second appel ne voit AUCUN titre de la bibliothèque",
  second !== undefined && !second.texte.includes("d-prive") && !second.texte.includes("d-public")
    && !second.texte.includes("SA BIBLIOTHÈQUE"),
  (second?.texte ?? "").slice(0, 200));

/* La lacune est produite APRÈS lecture des données privées : la transmettre
   au modèle qui a le web rouvrirait le canal avec l'air d'être prudent. */
verifier("… ni la « lacune » écrite par le premier",
  second !== undefined && !second.texte.includes("il manque un ouvrage sur ce point"),
  (second?.texte ?? "").slice(0, 200));

verifier("… mais il reçoit bien l'intention, écrite par l'utilisateur",
  second?.texte.includes("quelque chose à comprendre"), (second?.texte ?? "").slice(0, 120));
verifier("une année qui n'est pas un nombre est écartée",
  suggestion && suggestion.annee === null, JSON.stringify(suggestion?.annee));
verifier("aucun champ de la suggestion ne contient de balise",
  suggestion && !JSON.stringify(suggestion).includes("<img"),
  JSON.stringify(suggestion));
verifier("l'ISBN de la suggestion est normalisé",
  suggestion?.isbn === "9782070319015", suggestion?.isbn);

/* =====================================================================
   7. LES LECTURES PUBLIQUES SONT BORNÉES

   Le contrôle vient AVANT celui du limiteur de connexion : celui-ci bloque
   l'adresse pour un quart d'heure, et tout ce qui suivrait mesurerait ce
   blocage plutôt que la limitation des lectures.
   ===================================================================== */

let statutLecture = 200, faites = 0;
while (statutLecture === 200 && faites < 200) {
  statutLecture = (await appel("/api/livres")).statut;
  faites += 1;
}
verifier("une boucle de lecture publique finit par être refusée",
  statutLecture === 429, `statut ${statutLecture} après ${faites} requêtes`);
verifier("… et elle passe largement le nombre qu'un visiteur ferait",
  faites > 30, `bloqué dès la ${faites}e requête`);

/* CE QUI DOIT CONTINUER DE PASSER. Un limiteur qui bloque aussi les
   personnes connectées ferait de la protection un incident. */
const connecte = await appel("/api/livres", {
  entetes: { cookie: `__Host-session=${jetonValide}` } });
verifier("une personne connectée n'est pas limitée",
  connecte.statut === 200 && Array.isArray(connecte.corps),
  "statut " + connecte.statut);

/* =====================================================================
   8. LE LIMITEUR DE TENTATIVES TIENT TOUJOURS
   ===================================================================== */

let dernier = 0;
for (let i = 0; i < 12; i++) {
  dernier = (await appel("/api/connexion", { methode: "POST",
    corps: { motDePasse: "mauvais-" + i } })).statut;
}
verifier("après dix essais, la connexion est bloquée", dernier === 429, "statut " + dernier);

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Durcissement — revue du 16/08/2026 ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
