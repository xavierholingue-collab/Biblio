/* =========================================================================
   API de la bibliothèque.
   Serveur HTTP sans framework, une seule dépendance : le client Postgres.
   Tout ce qui touche à la clé Anthropic reste ici, côté serveur.
   ========================================================================= */

import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { avecContexte, avecVisiteur } from "./locataire.mjs";
import {
  demanderLien, consommerLien, purgerLiens, connexionParOidc,
  signerTransit, verifierTransit,
  courrielPlausible, normaliserCourriel, DUREE_LIEN_MINUTES,
} from "./authentification.mjs";
import { commencer as oidcCommencer, terminer as oidcTerminer,
         etatOidc } from "./oidc.mjs";
import { envoyerCourriel, messageDeConnexion, messageDInscription,
         etatCourriel } from "./courriel.mjs";
import { chercherParIsbn, chercherParTexte, isbn13, etatCatalogues,
         couvertureDeSecours, chercherParDoi, chercherArticleParTexte,
         normaliserDoi, LIBELLES_SUPPORT } from "./bibliographie.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const MOT_DE_PASSE = process.env.MOT_DE_PASSE ?? "";
const CLE_ANTHROPIC = process.env.ANTHROPIC_API_KEY ?? "";
const MODELE = process.env.MODELE ?? "claude-sonnet-5";

/* =========================================================================
   LA VERSION DE L'OUTIL DE RECHERCHE WEB — UN SEUL ENDROIT, ET UNE SORTIE

   Mesuré le 18/08/2026 : après le passage des scans par les catalogues, le
   RÉSUMÉ représente 95 % du coût d'un livre — 16 098 et 14 230 jetons
   d'entrée sur les deux derniers, contre 877 pour le classement. Et ces
   jetons ne sont pas l'invite : ce sont les résultats de recherche, injectés
   dans le contexte et relus par le modèle à chaque tour.

   « web_search_20260209 » fait FILTRER CES RÉSULTATS PAR DU CODE avant qu'ils
   n'entrent dans le contexte. C'est le seul levier qui attaque cette part-là ;
   baisser « max_uses » ne toucherait que les frais de recherche, un cinquième
   du total.

   POURQUOI UNE VARIABLE D'ENVIRONNEMENT PLUTÔT QU'UNE CONSTANTE. Le filtrage
   dynamique s'exécute depuis le bac à sable d'exécution de code et demande un
   modèle qui sait appeler un outil par programme. Sonnet 5 remplit la
   condition annoncée (Claude 4.6 et suivants), mais je ne peux pas l'éprouver
   sans appeler l'API pour de vrai — les contrôles parlent à un faux serveur.

   Si l'API refuse, la réparation est « OUTIL_RECHERCHE=web_search_20250305 »
   dans le fichier d'environnement et un redémarrage. Pas une livraison, pas
   un correctif écrit sous la pression. C'est la même forme que COURRIEL_SERVICE
   le 17/08, dont la bascule a coûté un mot et zéro ligne de code.
   ========================================================================= */
const OUTIL_RECHERCHE = process.env.OUTIL_RECHERCHE ?? "web_search_20260209";
const FICHIER_AMORCE = process.env.FICHIER_AMORCE ?? "/seed/bibliotheque.json";
// Faux par défaut : un visiteur anonyme ne doit pas pouvoir dépenser vos crédits.
const IA_PUBLIQUE = process.env.IA_PUBLIQUE === "true";
const DUREE_SESSION = 30 * 24 * 3600 * 1000; // 30 jours

/* Le locataire auquel le mot de passe historique donne accès.
   Tant qu'il n'y a qu'une bibliothèque, MOT_DE_PASSE ouvre celle-ci. */
const TENANT_DEFAUT = process.env.TENANT_DEFAUT ?? "xavier";
let ID_TENANT_DEFAUT = null;   // résolu au démarrage, voir attendreLaBase()

/* Derrière un proxy inverse (Caddy sur le VPS), deux choses changent.
 *
 * 1. L'adresse du client n'est plus dans la socket : elle vaut 127.0.0.1
 *    pour tout le monde. Le limiteur de tentatives compterait alors les
 *    échecs de TOUS les visiteurs ensemble — dix essais ratés de
 *    n'importe qui vous verrouilleraient vous aussi pendant un quart
 *    d'heure. Un inconnu pourrait vous empêcher d'entrer chez vous.
 *
 * 2. Le cookie de session doit porter l'attribut Secure, sans quoi rien
 *    n'interdit au navigateur de le renvoyer en clair.
 *
 * En local (docker compose), DERRIERE_PROXY est absent : le comportement
 * d'origine est conservé, et le cookie reste utilisable sur http://localhost. */
const DERRIERE_PROXY = process.env.DERRIERE_PROXY === "1";

/* ===========================================================================
   LA PORTE D'INSCRIPTION EST FERMÉE PAR DÉFAUT

   « === "1" », donc fermée tant que personne ne l'ouvre explicitement. Ce
   n'est pas de la prudence de principe : les mentions légales et la
   politique de confidentialité doivent EXISTER avant qu'on collecte la
   première adresse d'un inconnu. Un défaut ouvert livrerait la collecte
   avant l'information, et la remettre après ne réparerait rien.

   L'interrupteur permet aussi ce que la recette sert à faire : ouvrir là-bas,
   éprouver le parcours entier sur de vraies adresses, et laisser la
   production fermée jusqu'à ce qu'on soit satisfait. Le même levier que
   « OUTIL_RECHERCHE » : une variable, un redémarrage, aucune livraison.
   =========================================================================== */
const INSCRIPTION_OUVERTE = process.env.INSCRIPTION_OUVERTE === "1";

/* QUEL ENVIRONNEMENT SERT CETTE PAGE.
 *
 * Renvoyé par /api/session, affiché en bandeau par les pages. On efface un
 * jour des données en croyant être ailleurs ; autant que « ailleurs » soit
 * écrit en haut de l'écran.
 *
 * La valeur par défaut est « production », et c'est le bon sens : un
 * environnement mal configuré doit se comporter comme le plus prudent, pas
 * comme le plus permissif. Un bandeau oublié en production serait gênant ;
 * une recette qui se fait passer pour la production serait dangereuse. */
const ENVIRONNEMENT = process.env.ENVIRONNEMENT === "recette" ? "recette" : "production";
const COOKIE_SECURE = DERRIERE_PROXY ? " Secure;" : "";

/* OÙ PART L'APPEL AU MODÈLE — et pourquoi c'est presque toujours figé.
 *
 * Les contrôles ont besoin d'un modèle qui répond sans dépenser d'argent ni
 * sortir de la machine. Sans cette possibilité, éprouver le quota exige soit
 * un vrai appel facturé, soit de ne pas l'éprouver du tout.
 *
 * MAIS UNE ADRESSE DE DESTINATION CONFIGURABLE EST UNE FUITE DE CLEF EN
 * PUISSANCE : c'est vers elle que part « x-api-key ». Une variable
 * d'environnement mal posée, et la clef s'en va chez quelqu'un d'autre.
 *
 * On n'accepte donc QUE la machine locale. Un banc d'essai tourne toujours
 * sur 127.0.0.1 ; une exfiltration, jamais. Toute autre valeur est ignorée
 * avec un avertissement plutôt que refusée en silence. */
const ANTHROPIC_URL = (() => {
  const voulue = process.env.ANTHROPIC_URL ?? "";
  const officielle = "https://api.anthropic.com/v1/messages";
  if (!voulue) return officielle;
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(voulue)) return voulue;
  console.warn(
    `ANTHROPIC_URL ignorée : « ${voulue} » n'est pas sur la machine locale. ` +
    "Les appels partent vers l'adresse officielle.");
  return officielle;
})();

/** Adresse réelle du client, telle que la voit le proxy de confiance. */
function adresseClient(req) {
  if (!DERRIERE_PROXY) return req.socket.remoteAddress ?? "?";

  /* On prend la DERNIÈRE valeur de X-Forwarded-For, pas la première.
   *
   * Un client peut envoyer lui-même un en-tête X-Forwarded-For falsifié ;
   * Caddy y ajoute alors l'adresse qu'il constate. La chaîne devient
   * « inventé, réel » — et seule la dernière valeur est digne de foi.
   * Prendre la première laisserait n'importe qui se choisir une identité
   * et contourner le limiteur en la changeant à chaque essai. */
  const chaine = req.headers["x-forwarded-for"];
  if (!chaine) return req.socket.remoteAddress ?? "?";
  const valeurs = String(chaine).split(",").map((v) => v.trim()).filter(Boolean);
  return valeurs.at(-1) ?? req.socket.remoteAddress ?? "?";
}

if (!MOT_DE_PASSE) {
  console.error("MOT_DE_PASSE absent du fichier .env — démarrage impossible.");
  process.exit(1);
}

/* SECRET DE SIGNATURE DES SESSIONS — pourquoi il doit survivre au redémarrage.
 *
 * Une première version le tirait au hasard à chaque démarrage. Pour un outil
 * personnel, c'était défendable : redémarrer déconnectait, et il n'y avait
 * qu'un utilisateur pour s'en apercevoir.
 *
 * Dès qu'il y a des invités, ce n'est plus tenable : CHAQUE LIVRAISON les
 * déconnecterait tous, sans explication et sans qu'on le voie passer. Le
 * secret vient donc de l'environnement.
 *
 * En production (derrière le proxy), son absence ARRÊTE le démarrage. Se
 * rabattre en silence sur un secret aléatoire produirait exactement le défaut
 * qu'on cherche à éviter, en plus discret : tout fonctionnerait, et les
 * sessions tomberaient à chaque déploiement sans que rien ne le signale. */
const SECRET = (() => {
  const fourni = process.env.SECRET_SESSION ?? "";
  if (fourni.length >= 32) return Buffer.from(fourni, "utf8");
  if (fourni) {
    console.error("SECRET_SESSION trop court : 32 caractères au minimum.");
    process.exit(1);
  }
  if (DERRIERE_PROXY) {
    console.error(
      "SECRET_SESSION absent. En production, un secret tiré au hasard\n" +
      "déconnecterait tout le monde à chaque livraison. Posez-le dans\n" +
      "/etc/biblio/env :  SECRET_SESSION=$(openssl rand -base64 48)");
    process.exit(1);
  }
  console.warn("SECRET_SESSION absent : secret volatil (développement local).");
  return randomBytes(32);
})();

const bd = new pg.Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "biblio",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? "biblio",
  // Huit connexions en service. Le banc d'essai local abaisse cette valeur
  // a 1 : PGlite, le PostgreSQL en WebAssembly qu'il utilise, n'accepte
  // qu'une connexion a la fois. Le pool serialise alors les requetes au lieu
  // de les paralleliser — c'est plus lent, et cela ne prouve rien sur le
  // comportement en concurrence, mais cela permet de faire passer les
  // requetes devant un vrai moteur avant de les livrer.
  max: Number(process.env.PGMAX ?? 8),
});

/* Plus de PGROLE ici.
 *
 * Une variable existait pour endosser un rôle restreint à l'ouverture de
 * chaque connexion. Elle ne servait qu'au banc d'essai PGlite, dont l'unique
 * rôle est superutilisateur — et un superutilisateur traverse toutes les
 * politiques EN SILENCE.
 *
 * Les contrôles tournent désormais sur un vrai PostgreSQL, avec le compte de
 * production. Le contournement n'a plus d'objet, et du code qui n'existe que
 * pour le banc d'essai finit toujours par être exécuté en production.
 */

/* ---------------------------------------------------------------- Outils */

const SOUS_CATEGORIES = {
  "Savoirs": [
    "Management & leadership", "Stratégie & marketing", "Industrie, opérations & lean",
    "Numérique, IA & SI", "Innovation & entrepreneuriat", "Économie",
    "Politique, société & géopolitique", "Philosophie", "Décision, biais & rationalité",
    "Communication & influence", "Psychologie & développement personnel",
    "Sciences & environnement",
    // « Non classé » est une valeur legitime, pas un echec. Voir la note
    // dans ma-bibliotheque.html : un rangement avoue vaut mieux qu'un
    // rangement invente.
    "Non classé",
  ],
  "BD": ["Aventure & historique", "Polar & thriller", "SF & fantastique",
         "Roman graphique & récit", "Humour & société", "Non classé"],
  "Roman": ["Polar & thriller", "Littérature générale", "SF & humour", "Classique", "Non classé"],
};

/* Les rayons effectivement disponibles : le socle figé dans le code, plus
   ceux que vous avez acceptés en cours de route. Relu à chaque appel — la
   liste change rarement, et une liste périmée rangerait mal. */
async function rayonsDisponibles(client) {
  const listes = {};
  for (const c of Object.keys(SOUS_CATEGORIES)) listes[c] = [...SOUS_CATEGORIES[c]];
  try {
    const { rows } = await client.query(
      "select categorie, libelle from rayons_ajoutes order by libelle");
    for (const r of rows) {
      if (!listes[r.categorie] || listes[r.categorie].includes(r.libelle)) continue;
      // « Non classé » reste en dernier : c'est le refuge, pas un rayon.
      listes[r.categorie].splice(listes[r.categorie].length - 1, 0, r.libelle);
    }
  } catch (e) {
    // La table peut manquer sur une base ancienne. Le socle suffit à
    // fonctionner, et le dire vaut mieux que d'échouer.
    console.error("rayons_ajoutes illisible, socle seul :", e.message);
  }
  return listes;
}

async function ajouterRayon(client, { categorie, libelle }) {
  const l = String(libelle ?? "").replace(/\s+/g, " ").trim();
  if (!SOUS_CATEGORIES[categorie]) { const e = new Error("Catégorie inconnue."); e.statut = 400; throw e; }
  if (l.length < 2 || l.length > 60) { const e = new Error("Le nom du rayon doit faire 2 à 60 caractères."); e.statut = 400; throw e; }
  if (l === "Non classé") { const e = new Error("« Non classé » existe déjà."); e.statut = 400; throw e; }

  /* tenant_id explicite : la colonne est NOT NULL et la politique d'écriture
     exige qu'elle vaille le locataire courant. On le lit dans le réglage de
     session plutôt que de le faire circuler dans les paramètres — une seule
     source, celle que PostgreSQL applique. */
  await client.query(
    `insert into rayons_ajoutes (categorie, libelle, tenant_id)
     values ($1, $2, nullif(current_setting('app.tenant_id', true), '')::uuid)
     on conflict do nothing`,
    [categorie, l]);
  return { categorie, libelle: l, rayons: await rayonsDisponibles(client) };
}

function json(rep, corps, statut = 200, entetes = {}) {
  const texte = JSON.stringify(corps);
  rep.writeHead(statut, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(texte),
    ...entetes,
  });
  rep.end(texte);
}

async function lireCorps(req) {
  const morceaux = [];
  let taille = 0;
  for await (const m of req) {
    taille += m.length;
    if (taille > 8 * 1024 * 1024) throw new Error("Corps de requête trop volumineux");
    morceaux.push(m);
  }
  if (!morceaux.length) return {};
  return JSON.parse(Buffer.concat(morceaux).toString("utf8"));
}

/* ------------------------------------------------------ Authentification */

function signer(charge) {
  const donnees = Buffer.from(JSON.stringify(charge)).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(donnees).digest("base64url");
  return `${donnees}.${signature}`;
}

function verifier(jeton) {
  if (!jeton || !jeton.includes(".")) return null;
  const [donnees, signature] = jeton.split(".");
  const attendue = createHmac("sha256", SECRET).update(donnees).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(attendue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const charge = JSON.parse(Buffer.from(donnees, "base64url").toString("utf8"));
    if (charge.expire < Date.now()) return null;
    return charge;
  } catch { return null; }
}

/* ===========================================================================
   LE NOM DU COOKIE DE SESSION, ET POURQUOI IL PORTE UN PRÉFIXE

   « __Host- » n'est pas décoratif : c'est une contrainte que le NAVIGATEUR
   fait respecter. Un cookie ainsi nommé n'est accepté que s'il est Secure,
   de chemin « / », et SANS attribut Domain.

   Ce que cela empêche concrètement : lisia.y-factor.fr partage son
   domaine parent avec blog.xavier-holingue.eu et le site principal. N'importe
   lequel de ces voisins peut poser un cookie « session » valable pour
   « .xavier-holingue.eu », qui serait alors envoyé à la bibliothèque en même
   temps que le vrai. Selon l'ordre choisi par le navigateur, l'application
   lirait celui de l'intrus — au mieux une déconnexion, au pire une session
   imposée. C'est le « cookie tossing », et il ne demande aucune faille : il
   suffit qu'un sous-domaine voisin serve un jour du contenu qu'on ne maîtrise
   pas entièrement.

   Un cookie « __Host- » ne peut PAS être posé de cette façon. Le navigateur
   le refuse à l'émission.

   EN LOCAL, PAS DE PRÉFIXE : il exige Secure, donc HTTPS, et la pile locale
   tourne en http://localhost. On garde donc l'ancien nom hors production.

   ON LIT LES DEUX, ON N'ÉCRIT QUE LE BON. Sans cela, la livraison qui
   introduit ce changement déconnecterait tout le monde — et une déconnexion
   inexpliquée est exactement ce qu'on s'est promis d'éviter depuis le 15/08. */
const COOKIE_SESSION = DERRIERE_PROXY ? "__Host-session" : "session";
const COOKIES_ACCEPTES = ["__Host-session", "session"];

function lireCookie(req, nom) {
  const brut = req.headers.cookie ?? "";
  for (const part of brut.split(";")) {
    const [c, ...v] = part.trim().split("=");
    if (c !== nom) continue;
    /* UN COOKIE MAL FORMÉ NE DOIT PAS FAIRE TOMBER LA REQUÊTE.
       decodeURIComponent lève sur « %ZZ ». Sans ce filet, l'exception
       remontait au routeur, qui répondait 500 : un cookie abîmé — posé par
       accident, ou par un voisin de domaine — rendait le site inutilisable
       pour la personne visée, y compris ses pages publiques. */
    try { return decodeURIComponent(v.join("=")); }
    catch { return null; }
  }
  return null;
}

/** Le jeton de session, quel que soit le nom sous lequel il est arrivé. */
function lireSession(req) {
  for (const nom of COOKIES_ACCEPTES) {
    const v = lireCookie(req, nom);
    if (v) return v;
  }
  return null;
}

/* ===========================================================================
   L'ORIGINE DE LA REQUÊTE, POUR LES ÉCRITURES

   SameSite=Strict protège des sites TIERS, et c'est déjà beaucoup. Mais
   « site » se compte au domaine enregistrable : blog.xavier-holingue.eu est
   le MÊME site que lisia.y-factor.fr du point de vue du navigateur.
   Une page servie par un voisin peut donc envoyer une requête avec votre
   cookie de session attaché.

   Pour les méthodes simples — un POST de formulaire — aucune vérification
   préalable n'est demandée par le navigateur : la requête part et s'exécute.
   L'attaquant ne lit pas la réponse, mais il n'en a pas besoin pour écrire.

   On exige donc que l'origine annoncée, QUAND ELLE EST ANNONCÉE, corresponde
   à l'hôte visé. Une origine absente — curl, un contrôle, un client qui n'est
   pas un navigateur — reste acceptée : les navigateurs, eux, en envoient
   toujours une sur les requêtes qui écrivent. Refuser l'absence casserait les
   outils sans rien protéger de plus.
   =========================================================================== */
function origineEtrangere(req) {
  const origine = req.headers.origin;
  if (!origine) return false;
  let hote;
  try { hote = new URL(origine).host; } catch { return true; }
  // Derrière Caddy, l'hôte demandé est celui de l'en-tête Host.
  return hote !== req.headers.host;
}

function motDePasseValide(propose) {
  const a = Buffer.from(String(propose ?? ""));
  const b = Buffer.from(MOT_DE_PASSE);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Limitation simple des tentatives, par adresse.
const tentatives = new Map();
function tropDeTentatives(ip) {
  const t = tentatives.get(ip);
  if (!t) return false;
  if (Date.now() - t.debut > 15 * 60 * 1000) { tentatives.delete(ip); return false; }
  return t.nombre >= 10;
}
function noterEchec(ip) {
  /* LE LIMITEUR NE DOIT PAS DEVENIR L'ATTAQUE.
     Chaque adresse ayant échoué une fois laissait une entrée, effacée
     seulement si cette même adresse revenait après un quart d'heure. Un
     attaquant changeant d'adresse à chaque essai — un /64 IPv6 en fournit
     des milliards — faisait donc grossir cette table jusqu'à la mémoire du
     serveur. Le dispositif censé protéger la connexion devenait le moyen
     d'arrêter le service.
     On balaie donc les entrées périmées dès que la table dépasse une taille
     raisonnable, et on refuse de dépasser un plafond dur. */
  if (tentatives.size > 5000) {
    const limite = Date.now() - 15 * 60 * 1000;
    for (const [cle, v] of tentatives) if (v.debut < limite) tentatives.delete(cle);
    // Toujours pleine après le balayage : ce sont des entrées récentes, donc
    // une attaque en cours. On cesse d'en accepter de nouvelles plutôt que
    // de grossir — les adresses déjà notées restent limitées.
    if (tentatives.size > 5000 && !tentatives.has(ip)) return;
  }
  const t = tentatives.get(ip) ?? { debut: Date.now(), nombre: 0 };
  t.nombre += 1;
  tentatives.set(ip, t);
}

/* ===========================================================================
   CE QUE COÛTE UNE LECTURE PUBLIQUE

   « GET /api/livres » rend aujourd'hui 246 ouvrages AVEC LEURS RÉSUMÉS
   ENTIERS — quelques centaines de kilooctets — sans authentification et sans
   cache. Une boucle sur cette adresse consomme la bande passante et le
   processeur du serveur, et l'ennui ne s'arrête pas à la bibliothèque : la
   machine héberge deux autres sites derrière le même Caddy.

   Soixante requêtes par minute et par adresse. Un visiteur ordinaire en fait
   trois ou quatre en ouvrant la page ; il ne s'en apercevra jamais. Une
   boucle, si.

   POURQUOI PAS DANS CADDY, qui serait le bon endroit : son module de
   limitation n'est pas dans la version standard, et reconstruire Caddy pour
   cela ajouterait une dépendance à maintenir sur un serveur qui sert aussi
   deux autres sites.

   ET COMME LE LIMITEUR DE CONNEXION, IL NE DOIT PAS DEVENIR L'ATTAQUE :
   même balayage, même plafond dur. Une table qui grossit sans fin protège
   d'un abus en en créant un autre.
   =========================================================================== */
const LECTURES_PAR_MINUTE = 60;
const lectures = new Map();

function tropDeLectures(ip) {
  const maintenant = Date.now();
  if (lectures.size > 5000) {
    for (const [cle, v] of lectures) if (maintenant - v.debut > 60_000) lectures.delete(cle);
    if (lectures.size > 5000 && !lectures.has(ip)) return true;  // fermé, pas ouvert
  }
  const t = lectures.get(ip);
  if (!t || maintenant - t.debut > 60_000) {
    lectures.set(ip, { debut: maintenant, nombre: 1 });
    return false;
  }
  t.nombre += 1;
  return t.nombre > LECTURES_PAR_MINUTE;
}

/* ===========================================================================
   L'ADRESSE QUI FIGURE DANS LE LIEN NE VIENT PAS DE LA REQUÊTE

   La tentation est d'écrire `https://${req.headers.host}/…` : c'est court,
   ça marche, et ça n'exige aucune configuration.

   C'est aussi une façon de faire voler les jetons. L'en-tête « Host » est
   fourni par le CLIENT. Quelqu'un qui demande un lien pour VOTRE adresse en
   annonçant « Host: chez-moi.example » vous ferait recevoir un courriel
   d'apparence normale, envoyé par le vrai service, signé par le vrai
   domaine — et dont le lien pointe chez lui. Vous cliquez, il récupère un
   jeton de connexion valable à votre nom.

   Caddy filtre déjà par nom d'hôte, ce qui rend l'attaque difficile ici.
   Mais « difficile grâce à la configuration d'un autre composant » n'est pas
   une propriété de ce code : elle disparaît le jour où l'on ajoute un
   domaine, ou où l'on passe derrière autre chose.

   L'adresse vient donc de la CONFIGURATION. En local, où il n'y a pas de
   proxy et où l'on veut pouvoir ouvrir localhost sur n'importe quel port, on
   accepte l'hôte de la requête — le risque n'existe pas sans destinataire
   extérieur.
   =========================================================================== */
const ADRESSE_PUBLIQUE = (process.env.ADRESSE_PUBLIQUE ?? "").replace(/\/+$/, "");

function adressePublique(req) {
  if (/^https?:\/\/[^\s/]+$/.test(ADRESSE_PUBLIQUE)) return ADRESSE_PUBLIQUE;

  if (DERRIERE_PROXY) {
    const e = new Error("ADRESSE_PUBLIQUE absente : impossible de fabriquer un lien sûr.");
    e.statut = 503;
    throw e;
  }
  return `http://${req.headers.host}`;
}

/* ===========================================================================
   LES DEMANDES DE LIEN DE CONNEXION

   Un limiteur À PART, et non celui des mots de passe, pour une raison de
   fond : ici, CHAQUE demande compte, réussie ou non. Le limiteur de mot de
   passe ne note que les échecs — c'est ce qu'on veut pour un mot de passe,
   et ce serait sans effet ici, puisqu'une demande de lien « réussit »
   toujours du point de vue du demandeur.

   ---------------------------------------------------------------------------
   IL COMPTAIT LES IP EN CROYANT PROTÉGER DES ADRESSES — corrigé le 21/08/2026

   Son propre commentaire disait ce qu'il protège : « qu'un inconnu fasse
   envoyer cinquante courriels à quelqu'un dont il connaît l'adresse ». Il
   comptait pourtant les IP. Or L'ADRESSE VISÉE NE CHANGE PAS quand
   l'attaquant change d'IP, et changer d'IP est à la portée de n'importe qui.
   La protection annoncée n'existait pas.

   L'inverse était vrai aussi, et gênait de vraies personnes : un opérateur
   mobile partage une IP entre des milliers d'abonnés. Cinq demandes pour
   tout un réseau, c'est un blocage de gens légitimes.

   Un contrôle qui mesure un substitut de ce qu'il prétend protéger — la
   famille de défaut la plus tenace de cette base de code. On compte donc
   maintenant les DEUX, chacun pour ce qu'il protège vraiment :

     par ADRESSE     protège la personne visée du harcèlement. DEUX
                     fenêtres, et la seconde est celle qui compte : cinq par
                     quart d'heure laisse encore passer quatre cent quatre-
                     vingts courriels par jour. C'est le plafond JOURNALIER
                     par adresse qui rend le harcèlement impossible ; celui
                     du quart d'heure ne fait que lisser.
     par IP          protège le service de l'énumération d'adresses.
     par JOUR        protège la réputation de l'expéditeur. Un domaine qui
                     envoie mille courriels non sollicités est classé
                     indésirable, et les liens des VRAIS utilisateurs
                     cessent d'arriver. Ce plafond-là ne protège pas contre
                     un attaquant : il protège contre le succès d'un
                     attaquant.

   LES SEUILS DU QUART D'HEURE NE BOUGENT PAS — cinq, comme avant. Une
   première version avait mis trois par adresse : le contrôle existant est
   tombé, et il avait raison. Quelqu'un dont le lien part en indésirables
   redemande, cherche, redemande. Resserrer l'usage courant pour gêner un
   attaquant que le plafond journalier arrête déjà, c'est payer en gêne
   quotidienne une protection qu'on a par ailleurs.

   ---------------------------------------------------------------------------
   EN MÉMOIRE, DONC PERDU AU REDÉMARRAGE. C'est assumé, et écrit pour ne pas
   avoir à le redécouvrir : l'API est un processus unique sous systemd, un
   redémarrage remet les compteurs à zéro. Le porter en base ajouterait une
   écriture par demande pour couvrir un cas — le redémarrage provoqué — qu'un
   inconnu ne peut pas déclencher. Si l'API passe un jour à deux processus,
   ce choix devient faux : les compteurs ne seraient plus partagés.
   =========================================================================== */
const LIENS_PAR_QUART_HEURE_IP      = 5;
const LIENS_PAR_QUART_HEURE_ADRESSE = 5;
const LIENS_PAR_JOUR                = 300;

/* LE PLAFOND JOURNALIER PAR ADRESSE SE RÈGLE, et ce n'est pas une commodité
   de test — c'est ce qui le rend ÉPROUVABLE.

   Il est le seul à protéger vraiment du harcèlement : cinq par quart d'heure
   laissent encore passer quatre cent quatre-vingts courriels par jour. Or
   une fenêtre de vingt-quatre heures ne peut pas se déclencher dans un
   contrôle qui dure trois secondes — le plafond du quart d'heure arrête
   tout avant lui. Retirer entièrement ce compteur ne faisait donc tomber
   aucune vérification : je l'ai constaté en mutant, le 21/08/2026.

   Un garde-fou qu'aucun contrôle ne peut atteindre est un garde-fou dont on
   croit disposer. Les deux valeurs se lisent donc dans l'environnement, avec
   les valeurs de production par défaut, et le contrôle les resserre pour
   voir le compteur mordre.

   Bénéfice d'exploitation au passage : si une adresse est prise pour cible,
   le plafond se resserre par une variable et un redémarrage, sans livraison
   — le même levier que « OUTIL_RECHERCHE » a rendu le 19/08. */
const LIENS_PAR_JOUR_ADRESSE =
  Number(process.env.LIENS_PAR_JOUR_ADRESSE ?? 15);
const FENETRE_JOUR_MS =
  Number(process.env.LIENS_FENETRE_JOUR_MS ?? 24 * 60 * 60 * 1000);

/* Un seau nommé, plutôt que trois copies de la même boucle d'expiration.
   La version précédente en tenait déjà deux — celle des tentatives et celle
   des liens — et elles avaient divergé. */
function seau(fenetreMs, plafond, tailleMax = 5000) {
  const vus = new Map();
  return function depasse(cle) {
    const t0 = Date.now();
    if (vus.size > tailleMax) {
      for (const [k, v] of vus) if (t0 - v.debut > fenetreMs) vus.delete(k);
      /* Toujours plein après le ménage : on ferme pour les clés inconnues
         plutôt que de grossir sans fin. Un limiteur qui consomme toute la
         mémoire devient l'attaque qu'il devait empêcher. */
      if (vus.size > tailleMax && !vus.has(cle)) return true;
    }
    const t = vus.get(cle);
    if (!t || t0 - t.debut > fenetreMs) { vus.set(cle, { debut: t0, nombre: 1 }); return false; }
    t.nombre += 1;
    return t.nombre > plafond;
  };
}

const parIp      = seau(15 * 60 * 1000, LIENS_PAR_QUART_HEURE_IP);
const parAdresse = seau(15 * 60 * 1000, LIENS_PAR_QUART_HEURE_ADRESSE, 20000);
const parAdresseJour = seau(FENETRE_JOUR_MS, LIENS_PAR_JOUR_ADRESSE, 20000);
const parJour    = seau(FENETRE_JOUR_MS, LIENS_PAR_JOUR, 4);

/**
 * Faut-il refuser cette demande de lien ?
 *
 * L'ADRESSE EST NORMALISÉE avant d'être comptée. Sans cela « X@Gmail.com »
 * et « x@gmail.com » sont deux seaux pour une seule boîte, et le plafond
 * se contourne en changeant une majuscule.
 *
 * Le refus NE DÉPEND PAS de l'existence du compte, et c'est essentiel :
 * un 429 qui n'arriverait que sur les adresses connues révélerait qui est
 * inscrit — précisément ce que le silence de « demanderLien » protège.
 */
function tropDeDemandesLien(ip, courrielBrut) {
  const adresse = normaliserCourriel(courrielBrut);
  /* Les trois sont évalués, sans court-circuit — mais PAS pour la raison que
     j'avais d'abord écrite. J'avais noté « sinon un attaquant bloqué par l'un
     repart à zéro dès qu'il change d'IP ». C'est faux, et la mutation l'a
     montré : quand le compteur d'IP se ferme, celui de l'adresse a déjà
     enregistré les cinq mêmes demandes. Changer d'IP ne rouvre rien.

     La vraie raison est plus modeste : le compteur GLOBAL doit voir chaque
     tentative, sinon le seuil journalier se déclenche trop tard et le signal
     d'abus sous-estime ce qui se passe. C'est un choix de DIAGNOSTIC, pas une
     protection — et aucun contrôle ne l'affirme, parce qu'il n'y a rien à
     affirmer. Écrit ici plutôt que laissé à croire. */
  const a = parAdresse(adresse) | parAdresseJour(adresse);
  const b = parIp(ip);
  const c = parJour("global");
  if (c) console.error(
    "PLAFOND JOURNALIER D'ENVOI ATTEINT — demandes refusées. "
    + "Ce n'est pas un incident d'usage : personne n'a besoin de "
    + `${LIENS_PAR_JOUR} liens en un jour.`);
  return a || b || c;
}

/* --------------------------------------------------------------- Données */

/* =========================================================================
   LE RÉSUMÉ N'EST PLUS DANS LA FICHE, IL EST À CÔTÉ — UN PAR LANGUE.

   Les colonnes books.resume* existent toujours : la migration les a
   recopiées dans « resumes », et les supprimer serait irréversible. Mais
   plus rien ne les lit ni ne les écrit. Une donnée écrite à deux endroits
   finit toujours par diverger, et c'est la copie périmée qui s'affiche.

   Les NOMS DE CHAMPS RENDUS PAR L'API NE CHANGENT PAS : la jointure les
   rebaptise. Le front-end continue de lire « resume », « resume_points » et
   les autres sans rien savoir de la table. C'est ce qui permet de faire
   cette bascule sans toucher aux pages.
   ========================================================================= */

/* On NOMME les colonnes plutôt que d'écrire « b.* ».
   La vue porte aussi tenant_id : l'étoile le renverrait au navigateur, et
   personne ne s'en apercevrait avant de lire une réponse JSON. */
const CHAMPS_LIVRE = `b.id, b.ouvrage_id, b.isbn, b.titre, b.auteur, b.editeur,
  b.annee, b.pages, b.statut, b.note, b.categorie, b.sous_categorie, b.sphere,
  b.cover_url, b.cover_statut, b.visibilite, b.avec_sources,
  b.type, b.doi, b.revue, b.volume, b.numero, b.citations, b.resume_editeur,
  b.support, b.pagination`;

const CHAMPS_RESUME = `r.resume, r.points as resume_points, r.themes as resume_themes,
  r.modele as resume_modele, r.fiabilite as resume_fiabilite,
  r.genere_le as resume_genere_le, r.langue as resume_langue`;

/* La langue est un PARAMÈTRE, jamais interpolée : elle vient de la requête
   HTTP. « $1 » ici oblige les appelants à la passer en tête de leurs
   propres paramètres — c'est contraignant, et c'est voulu : une jointure
   sans langue rendrait autant de lignes que de traductions. */
/* « livres » est la vue qui recolle le catalogue partagé et vos possessions.
   Le résumé se rattache à l'OUVRAGE, pas à la possession : c'est tout
   l'intérêt du partage. Sa lisibilité est décidée par la politique
   resumes_ouvrages_lecture, pas ici. */
const LIVRES_AVEC_RESUME = `select ${CHAMPS_LIVRE}, ${CHAMPS_RESUME}
  from livres b
  left join resumes_ouvrages r
    on r.ouvrage_id = b.ouvrage_id and r.langue = $1`;

const LANGUES = ["fr", "en"];

/** Langue demandée : le paramètre d'URL prime, puis celle du locataire. */
async function langueDemandee(client, url, session) {
  const voulue = url?.searchParams?.get("langue");
  if (LANGUES.includes(voulue)) return voulue;
  if (!session) return "fr";
  // « tenants » n'est pas cloisonnée : c'est la table qui DÉFINIT les
  // locataires, elle ne peut pas dépendre de l'un d'eux.
  const { rows } = await client.query(
    "select langue from tenants where id = $1", [session.t]);
  return LANGUES.includes(rows[0]?.langue) ? rows[0].langue : "fr";
}

/* PLUS AUCUN FILTRE ÉCRIT ICI — et c'est le point de toute la bascule.
 *
 * Avant, cette fonction ajoutait « where sphere = 'Pro' » pour un visiteur.
 * Un filtre écrit à la main ne protège que la requête où on a pensé à
 * l'écrire : il suffit d'une nouvelle route, d'un oubli, d'une jointure, et
 * la donnée privée sort.
 *
 * Désormais le périmètre est décidé par PostgreSQL, à partir du locataire
 * posé dans la transaction. Une requête qui oublie le filtre ne rend pas
 * trop de lignes : elle n'en rend aucune. */
async function listerLivres(client, langue) {
  const { rows } = await client.query(
    `${LIVRES_AVEC_RESUME} order by b.auteur, b.titre`, [langue]);
  return rows;
}

// Statistiques de la page d'accueil, calculées sur le périmètre visible.
async function statistiques(client, session, langue) {
  const [general, resumes, sousCats, decennies, auteurs, recents] = await Promise.all([
    client.query(`select
        count(*)::int                                          as total,
        count(*) filter (where statut = 'Lu')::int              as lus,
        count(*) filter (where statut = 'En cours')::int        as en_cours,
        count(*) filter (where statut = 'A lire')::int          as a_lire,
        count(distinct auteur)::int                            as auteurs,
        count(distinct sous_categorie)::int                     as rayons,
        round(avg(note)::numeric, 2)                                    as note_moyenne,
        -- Sur combien d'ouvrages cette moyenne porte-t-elle ? avg() ignore
        -- silencieusement les valeurs nulles : sans ce compte, « 4,32 »
        -- s'affiche a cote de « 242 ouvrages » et se lit comme si les 242
        -- etaient notes. Ils sont 57. Une moyenne sans son effectif est une
        -- affirmation qu'on ne peut pas evaluer.
        count(note)::int                                       as notes,
        -- Le volume ET l'effectif sur lequel il porte, toujours ensemble.
        -- sum() ignore les valeurs nulles : « 68 000 pages » a cote de
        -- « 244 ouvrages » se lirait comme le volume de la bibliotheque
        -- entiere, alors qu'il ne couvre que les ouvrages pagines.
        coalesce(sum(pages), 0)::bigint                         as pages_volume,
        count(pages)::int                                      as pages_connues,
        min(annee)::int                                        as annee_min,
        max(annee)::int                                        as annee_max
      from livres`),

    /* Le compte des résumés, dans une requête à part et PAR LANGUE.
     *
     * Une première version le calculait par sous-requête corrélée dans
     * l'agrégat, ce qui imposait un « group by » — et un group by sur une
     * bibliothèque VIDE ne rend aucune ligne : general.rows[0] devenait
     * indéfini et la page d'accueil tombait. Le cas vide est précisément
     * celui d'un nouvel invité.
     *
     * La jointure porte sur les deux clés : sans book_id, on compterait
     * les résumés d'ouvrages effacés. */
    client.query(
      /* Compté à travers « livres », comme tout le reste de cette fonction.
       *
       * Une première version interrogeait possessions directement, avec un
       * simple « exists ». Depuis que la politique de lecture est permissive
       * — à vous OU public —, ce « exists » attrapait aussi les ouvrages
       * publics des autres : les statistiques de votre bibliothèque
       * grossissaient à mesure que des invités rendaient des livres publics.
       *
       * La vue porte déjà la distinction « ma bibliothèque » / « ce qui est
       * public ». S'en servir, c'est n'avoir qu'un seul endroit où cette
       * règle est écrite. */
      `select count(*)::int as n
         from livres l
         join resumes_ouvrages r
           on r.ouvrage_id = l.ouvrage_id and r.langue = $1
        where r.resume is not null`,
      [langue]),

    client.query(`select sous_categorie, categorie, count(*)::int as n,
                     count(*) filter (where statut = 'Lu')::int as lus,
                     coalesce(sum(pages), 0)::bigint as pages_volume,
                     count(pages)::int as pages_connues
              from livres
              group by sous_categorie, categorie
              order by n desc`),
    client.query(`select (annee / 10 * 10)::int as decennie, count(*)::int as n
              from livres where annee is not null
              group by 1 order by 1`),
    client.query(`select auteur, count(*)::int as n
              from livres
              group by auteur having count(*) > 1
              order by n desc, auteur limit 10`),
    client.query(`select id, titre, auteur, annee, sous_categorie
              from livres where annee is not null
              order by annee desc, titre limit 8`),
  ]);

  return {
    /* « public » et non « professionnel ».
     *
     * L'étiquette datait de l'époque où le périmètre visible ÉTAIT la sphère
     * Pro. Depuis le menu de réglages, un visiteur peut voir un roman
     * personnel que le propriétaire a choisi de publier — et c'est arrivé le
     * soir même de la livraison. La page d'accueil annonçait alors
     * « ouvrages académiques » en affichant deux Douglas Adams.
     *
     * Une étiquette qui décrit une règle disparue est un mensonge tranquille :
     * personne ne la relit, et elle finit par être crue. */
    perimetre: session ? "complet" : "public",
    langue,
    ...general.rows[0],
    avec_resume: resumes.rows[0].n,
    note_moyenne: general.rows[0].note_moyenne === null ? null : Number(general.rows[0].note_moyenne),
    // pg rend les BIGINT en CHAINE, pour ne pas perdre de precision au-dela
    // de 2^53. Sans cette conversion, « volume + volume » concatenerait deux
    // textes au lieu d'additionner deux nombres.
    pages_volume: Number(general.rows[0].pages_volume ?? 0),
    sous_categories: sousCats.rows.map(r => ({ ...r, pages_volume: Number(r.pages_volume ?? 0) })),
    decennies: decennies.rows,
    auteurs_recurrents: auteurs.rows,
    plus_recents: recents.rows,
  };
}

// Insertion ou mise à jour d'un lot d'ouvrages, en une seule requête.
/* Le refus de la base, traduit en quelque chose d'actionnable.
 *
 * Le nom de la contrainte est lu tel quel — c'est lui qui distingue « vous
 * possédez déjà cet ouvrage » d'un autre doublon. Le comparer par égalité
 * plutôt que par « contient » : une contrainte future dont le nom
 * contiendrait celui-ci hériterait sinon d'un message faux. */
const CONTRAINTE_DOUBLON = "possessions_tenant_id_ouvrage_id_key";

/* Le vocabulaire des provenances. Composables par « + », dans l'ordre où les
 * sources ont répondu : « bnf », « bnf+openlibrary », « bnf:autre-edition ».
 * La base contraint la forme, cette expression contraint le sens. */
const SOURCES_CONNUES =
  /^(bnf|bnf:autre-edition|openlibrary|googlebooks|modele)(\+(bnf|bnf:autre-edition|openlibrary|googlebooks|modele)){0,3}$/;

function traduireConflit(e) {
  if (e.code !== "23505" || e.constraint !== CONTRAINTE_DOUBLON) return e;
  const q = new Error(
    "Vous possédez déjà cet ouvrage. Ouvrez sa fiche pour la modifier "
    + "plutôt que d'en créer une seconde.");
  q.statut = 409;
  return q;
}

async function enregistrerLivres(client, livres) {
  if (!livres.length) return 0;

  /* =======================================================================
     ENREGISTRER, C'EST DÉSORMAIS DEUX GESTES DISTINCTS

       1. le CATALOGUE   — ce que le livre est. Partagé.
       2. la POSSESSION  — ce que vous en faites. À vous.

     Et un troisième, facultatif : corriger le catalogue. Il vient EN
     DERNIER, une fois la possession écrite, parce que la politique
     « ouvrages_correction » n'autorise à corriger que ce qu'on possède.
     Dans l'autre ordre, votre première correction serait refusée.
     ======================================================================= */

  const norme = (v) => String(v ?? "").replace(/[^0-9Xx]/g, "");
  const entrees = livres.map((l) => {
    const isbn = norme(l.isbn);
    const sphere = l.sphere ?? (l.categorie === "Savoirs" ? "Pro" : "Perso");
    return {
      id: l.id,
      isbn: isbn.length === 13 ? isbn : null,
      titre: l.titre,
      auteur: l.auteur,
      editeur: l.editeur || null,
      annee: l.annee ?? null,
      pages: l.pages ?? null,
      cover_url: l.cover_url ?? l.coverUrl ?? null,
      cover_statut: l.cover_statut ?? l.coverStatut ?? "inconnu",
      statut: l.statut ?? "A lire",
      note: l.note ?? null,
      /* « Académique » traduite à L'ENTRÉE, pour la durée de la transition.
       *
       * Le renommage du 19/08 a retiré cette valeur de la contrainte. Une page
       * laissée ouverte dans un navigateur — un téléphone posé sur une
       * étagère — l'enverra pourtant après la livraison, et la base la
       * refuserait par un 500 que l'utilisateur n'aurait pas mérité.
       *
       * Traduire vaut mieux que refuser POUR CE CAS PRÉCIS : la valeur est
       * connue, sans ambiguïté, et son remplacement est exactement ce que la
       * migration a fait aux 265 lignes existantes. Le refus en base reste le
       * dernier mot pour tout le reste.
       *
       * À RETIRER quand plus aucune page ancienne ne peut traîner — disons
       * après quelques semaines. Une compatibilité sans date de péremption
       * devient une seconde définition permanente. */
      categorie: l.categorie === "Académique" ? "Savoirs" : l.categorie,
      sous_categorie: l.sous_categorie ?? l.sousCategorie,
      sphere,

      /* LA PROVENANCE, FILTRÉE ICI PLUTÔT QUE CRUE.
       *
       * Elle vient du navigateur, qui la tient de notre propre réponse — mais
       * un client modifié écrit ce qu'il veut. La base borne déjà la FORME ;
       * ici on borne le VOCABULAIRE, parce que c'est en JavaScript qu'il vit
       * et qu'il changera avec les sources.
       *
       * Ce qui ne correspond pas devient NULL, pas une erreur : refuser
       * l'enregistrement d'un livre parce qu'une métadonnée de diagnostic est
       * mal formée serait disproportionné. */
      source: SOURCES_CONNUES.test(String(l.source ?? "")) ? String(l.source) : null,

      /* TROIS ÉTATS, et « null » n'est pas « false ». Un booléen mal typé —
         une chaîne « false », un 0 — deviendrait « je sais que non » au lieu
         de « je ne sais pas ». On n'accepte donc que de vrais booléens. */
      avec_sources: typeof l.avec_sources === "boolean" ? l.avec_sources : null,

      /* CE QU'UN ARTICLE PORTE ET QU'UN LIVRE N'A PAS.
       *
       * Nuls pour un livre, et c'est voulu : une seule table, donc une seule
       * mécanique de partage, de cloisonnement et de quota. Ce sont les
       * ÉCRANS qui séparent les deux mondes, pas le schéma.
       *
       * « type » est borné en base ; ici on refuse simplement tout ce qui
       * n'est pas « article », plutôt que de faire confiance au client sur
       * une valeur qui décide de la clé de mutualisation. */
      type: l.type === "article" ? "article" : "livre",
      doi: normaliserDoi(l.doi),
      revue: l.revue || null,
      volume: l.volume || null,
      numero: l.numero || null,
      citations: Number.isInteger(l.citations) ? l.citations : null,
      resume_editeur: l.resume_editeur || l.resumeEditeur || null,
      /* Le support dit CE QU'EST le contenant : une revue, un ouvrage, un
       * dépôt de préprint. Sans lui, l'écran appelle « revue » le recueil
       * dans lequel un chapitre a paru — constaté en production le 21/08. */
      support: l.support || null,
      pagination: l.pagination || null,

      /* VISIBILITÉ : NULL SIGNIFIE « JE NE ME PRONONCE PAS ».
       *
       * Le piège que j'avais signalé le 15/08 en écrivant ce fichier, et qui
       * est réparé ici le 16/08.
       *
       * L'ancienne version calculait toujours une valeur — Pro public, Perso
       * privé — et la mise à jour l'écrasait sans condition. Conséquence :
       * ouvrir un livre réglé « privé », changer sa note, enregistrer, et le
       * livre redevenait public. Silencieusement. Le menu de réglages aurait
       * donc défait ses propres réglages à la première modification.
       *
       * Désormais l'absence d'information n'est plus une information. La
       * valeur retenue, côté base, est la première qui existe :
       *   ce que le client demande explicitement,
       *   sinon ce qui était déjà réglé,
       *   sinon le point de départ historique (Pro public, Perso privé).
       *
       * Régler la visibilité reste un GESTE, par /api/reglages/livre. */
      visibilite: l.visibilite ?? null,
    };
  });

  /* Un seul paramètre : le tableau d'objets, décomposé par PostgreSQL.
     Cent livres feraient sinon mille quatre cents paramètres numérotés à la
     main, et une erreur de décalage y serait indétectable à la lecture. */
  const charge = JSON.stringify(entrees);

  /* La CLÉ est calculée côté base, à partir du locataire courant — jamais
     d'un champ envoyé par le client. Un ouvrage sans ISBN valide reçoit une
     identité locale : mieux vaut ne rien mutualiser que mutualiser sur une
     clé fausse. */
  /* LE DOI PASSE DEVANT L'ISBN, et l'ordre n'est pas indifférent : un article
     n'a pas d'ISBN, un livre n'a pas de DOI, mais un chapitre d'ouvrage
     pourrait un jour porter les deux. Le DOI désigne alors la partie, l'ISBN
     le volume — et c'est la partie qu'on catalogue. */
  const CLE = `case when e.doi is not null then 'doi:' || e.doi
                    when e.isbn is not null then 'isbn:' || e.isbn
                    else 'local:' || current_setting('app.tenant_id', true) || ':' || e.id end`;

  const SOURCE = `jsonb_to_recordset($1::jsonb) as e(
      id text, isbn text, titre text, auteur text, editeur text, annee int,
      pages int, cover_url text, cover_statut text, statut text, note numeric,
      categorie text, sous_categorie text, sphere text, visibilite text,
      source text, avec_sources boolean,
      type text, doi text, revue text, volume text, numero text,
      citations int, resume_editeur text, support text, pagination text)`;

  const MOI = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

  /* ENREGISTRER SANS L'ISBN NE DOIT PAS DÉTACHER LE LIVRE DU CATALOGUE.
   *
   * Défaut trouvé le 15/08/2026. Une fiche renvoyée sans son ISBN — parce
   * que le champ est vide, parce qu'un formulaire ne le porte pas — se
   * voyait attribuer une clé LOCALE, donc un ouvrage neuf, donc PLUS AUCUN
   * RÉSUMÉ. Un texte payé disparaissait sur une sauvegarde anodine.
   *
   * Règle retenue : on ne change l'ouvrage rattaché QUE si la fiche porte
   * un ISBN valide. Sans ISBN, on garde le rattachement existant. Changer
   * d'identité est un geste délibéré ; l'absence d'information n'en est
   * pas un.
   *
   * Conséquence sur l'étape 1 : inutile de créer un ouvrage local pour une
   * possession qui en a déjà un — ce serait une entrée orpheline dans un
   * catalogue partagé. */

  // 1. Le catalogue. « do nothing » : un enregistrement en lot ne réécrit
  //    jamais un ouvrage déjà connu — la correction est un geste séparé.
  await client.query(
    `insert into ouvrages (cle, isbn, titre, auteur, editeur, annee, pages,
                           cover_url, cover_statut, source, source_le, avec_sources,
                           type, doi, revue, volume, numero, citations, citations_le,
                           resume_editeur, support, pagination)
     select distinct on (cle) * from (
       select ${CLE} as cle, e.isbn, e.titre, e.auteur, e.editeur, e.annee,
              e.pages, e.cover_url, coalesce(e.cover_statut, 'inconnu'),
              e.source, case when e.source is not null then now() end,
              e.avec_sources,
              e.type, e.doi, e.revue, e.volume, e.numero, e.citations,
              case when e.citations is not null then now() end,
              e.resume_editeur, e.support, e.pagination
         from ${SOURCE}
         left join possessions p on p.tenant_id = ${MOI} and p.id = e.id
        where e.isbn is not null or p.id is null) t
     on conflict (cle) do nothing`, [charge]);

  /* 2. La possession. Le locataire vient du réglage de session, celui-là
   *    même que la politique d'écriture vérifie.
   *
   * POURQUOI CETTE ÉCRITURE PEUT ÉCHOUER, ET CE QU'ON EN DIT.
   *
   * « on conflict (tenant_id, id) » ne couvre QUE la clé primaire. Il existe
   * une seconde contrainte — « unique (tenant_id, ouvrage_id) » — qui interdit
   * de posséder deux fois le même ouvrage, et celle-là n'est rattrapée par
   * rien. Une fiche neuve, donc un « id » neuf, ne heurte pas la première et
   * heurte la seconde.
   *
   * Sans le traitement ci-dessous, PostgreSQL lève un 23505 qui traverse tout
   * et ressort en « Erreur interne. » — un message qui ne dit ni ce qui s'est
   * passé, ni quoi faire. Constaté en production le 18/08 : l'utilisateur a
   * conclu que l'application était cassée, et n'a compris qu'en allant
   * consulter sa bibliothèque depuis un autre appareil.
   *
   * On nomme donc l'échec. Le 409 n'est pas décoratif : il dit à l'interface
   * que ce n'est ni une panne (500) ni une faute de saisie (400), mais un état
   * du monde — et qu'il y a quelque chose à proposer plutôt qu'à réessayer. */
  await client.query(
    `insert into possessions (tenant_id, id, ouvrage_id, statut, note,
                              categorie, sous_categorie, sphere, visibilite, maj_le)
     select ${MOI}, e.id,
            case when e.doi is not null or e.isbn is not null then o.id
                 else coalesce(p.ouvrage_id, o.id) end,
            coalesce(e.statut, 'A lire'), e.note,
            e.categorie, e.sous_categorie, e.sphere,
            /* L'ordre de ce coalesce EST la règle : une demande explicite,
               sinon le réglage existant, sinon le point de départ. La
               jointure « p » plus bas est ce qui rend le deuxième terme
               possible — sans elle, tout enregistrement écraserait. */
            coalesce(e.visibilite, p.visibilite,
                     case when e.sphere = 'Pro' then 'publique' else 'privee' end),
            now()
       from ${SOURCE}
       left join possessions p on p.tenant_id = ${MOI} and p.id = e.id
       left join ouvrages o on o.cle = ${CLE}
      where o.id is not null or p.ouvrage_id is not null
     on conflict (tenant_id, id) do update set
       ouvrage_id = excluded.ouvrage_id, statut = excluded.statut,
       note = excluded.note, categorie = excluded.categorie,
       sous_categorie = excluded.sous_categorie, sphere = excluded.sphere,
       visibilite = excluded.visibilite, maj_le = now()`, [charge])
    .catch((e) => { throw traduireConflit(e); });

  /* 3. La correction du catalogue, pour les ouvrages qu'on possède.
   *
   * C'est ici que se paie le partage : corriger un titre le corrige POUR
   * TOUS ceux qui ont la même édition. C'est voulu — une coquille est une
   * coquille pour tout le monde — mais cela veut dire qu'une saisie
   * approximative se propage aussi.
   *
   * La politique « ouvrages_correction » limite la casse : on ne touche
   * qu'à ce qu'on possède. Une modification qu'elle refuse ne lève pas
   * d'erreur, elle touche zéro ligne. */
  /* UN CHAMP VIDE N'EST PAS UNE CORRECTION — 18/08/2026.
   *
   * Les pages et la couverture étaient déjà protégées par « coalesce ». Le
   * titre, l'auteur, l'éditeur et l'année, non : ils étaient écrasés sans
   * condition. Une notice PLUS PAUVRE effaçait donc une notice PLUS RICHE.
   *
   * Constaté en production : un livre identifié par Google Books, qui rend
   * rarement l'éditeur, serait venu vider l'éditeur d'une notice que la BnF
   * avait correctement renseignée. L'enregistrement a échoué pour une autre
   * raison — un doublon — et la transaction a tout annulé. Sans ce hasard,
   * la donnée était perdue.
   *
   * ET LE CATALOGUE EST PARTAGÉ. L'effacement n'aurait pas touché la seule
   * bibliothèque à l'origine du geste : il vaut pour tous les possesseurs de
   * la même édition. C'est le seul défaut de cette série qui DÉTRUIT.
   *
   * « nullif(…, '') » parce que le vide arrive en chaîne vide, pas en NULL :
   * un formulaire non rempli envoie "". Sans lui, coalesce garderait le vide
   * et le correctif ne corrigerait rien.
   *
   * Ce que cela interdit, et c'est assumé : on ne peut plus EFFACER un champ
   * du catalogue en le vidant. Corriger reste possible — on remplace par une
   * valeur — mais vider demande un geste d'administration. C'est le bon sens
   * de l'asymétrie : une correction est rare et réfléchie, un champ vide est
   * le plus souvent un accident. */
  await client.query(
    `update ouvrages o set
       titre = coalesce(nullif(e.titre, ''), o.titre),
       auteur = coalesce(nullif(e.auteur, ''), o.auteur),
       editeur = coalesce(nullif(e.editeur, ''), o.editeur),
       annee = coalesce(e.annee, o.annee),
       /* La provenance suit la même règle que le reste : une fiche qui ne dit
          pas d'où elle vient n'efface pas ce qu'on savait. « source_le » ne
          bouge que si « source » bouge, sinon la date daterait le dernier
          enregistrement plutôt que la dernière identification. */
       source = coalesce(nullif(e.source, ''), o.source),
       source_le = case when nullif(e.source, '') is not null then now()
                        else o.source_le end,
       /* Même règle que partout : une fiche qui ne se prononce pas n'efface
          pas un jugement déjà porté. « null » veut dire « je ne sais pas », et
          « je ne sais pas » n'écrase pas « je sais ». */
       avec_sources = coalesce(e.avec_sources, o.avec_sources),
       /* Même règle : ce qui se tait n'efface pas. « citations » fait
          exception dans un sens — un compte plus récent remplace l'ancien,
          avec sa date, parce que c'est un instantané et non un fait stable. */
       revue = coalesce(nullif(e.revue, ''), o.revue),
       volume = coalesce(nullif(e.volume, ''), o.volume),
       numero = coalesce(nullif(e.numero, ''), o.numero),
       resume_editeur = coalesce(nullif(e.resume_editeur, ''), o.resume_editeur),
       support = coalesce(nullif(e.support, ''), o.support),
       pagination = coalesce(nullif(e.pagination, ''), o.pagination),
       citations = coalesce(e.citations, o.citations),
       citations_le = case when e.citations is not null then now()
                           else o.citations_le end,
       pages = coalesce(e.pages, o.pages),
       cover_url = coalesce(e.cover_url, o.cover_url),
       cover_statut = case when e.cover_url is not null
                           then coalesce(e.cover_statut, 'inconnu')
                           else o.cover_statut end,
       maj_le = now()
       from ${SOURCE}
      where o.cle = ${CLE} and e.isbn is not null`, [charge]);

  return livres.length;
}

// Amorçage au premier démarrage, depuis l'export JSON de l'ancienne application.
async function amorcerSiVide(client) {
  const { rows } = await client.query("select count(*)::int as n from possessions");
  if (rows[0].n > 0) {
    console.log(`Base déjà peuplée : ${rows[0].n} ouvrages.`);
    return;
  }
  let contenu;
  try {
    // L'export du navigateur préfixe le fichier d'un BOM UTF-8, que JSON.parse refuse.
    const brut = (await readFile(FICHIER_AMORCE, "utf8")).replace(/^\uFEFF/, "");
    contenu = JSON.parse(brut);
  } catch (e) {
    console.log(`Base vide, amorçage impossible depuis ${FICHIER_AMORCE} : ${e.message}`);
    return;
  }
  if (!Array.isArray(contenu) || !contenu.length) return;
  const lot = 200;
  for (let i = 0; i < contenu.length; i += lot) {
    await enregistrerLivres(client, contenu.slice(i, i + lot));
  }
  console.log(`Amorçage : ${contenu.length} ouvrages importés.`);
}

/* ===========================================================================
   LES RÉGLAGES

   Trois niveaux de visibilité, et l'ordre entre eux est fixé par
   possession_publique() dans 03-catalogue.sql — PAS ici.

   Ces fonctions ne décident rien : elles écrivent un réglage, et relisent ce
   que la base en fait. C'est délibéré. Une règle de visibilité recopiée dans
   l'API finirait par diverger de celle de la base, et c'est toujours la
   copie affichée qui rassure pendant que l'autre publie.

   D'où « publies » dans la liste des rayons : ce n'est pas un calcul de
   l'API, c'est un COMPTE de ce que PostgreSQL laisse effectivement sortir.
   =========================================================================== */

const VISIBILITES_BIBLIOTHEQUE = ["privee", "publique"];
const VISIBILITES_HERITABLES = ["heritee", "privee", "publique"];

const refuser = (message, statut = 400) => {
  const e = new Error(message); e.statut = statut; throw e;
};

async function lireReglages(client) {
  const [tenant, rayons, exceptions] = await Promise.all([
    client.query(
      `select identifiant, nom, langue, visibilite, quota_ia_mois
         from tenants
        where id = nullif(current_setting('app.tenant_id', true), '')::uuid`),
    client.query(
      `select categorie, sous_categorie, reglage, livres, publies
         from rayons_visibilite order by categorie, sous_categorie`),
    /* Les livres réglés À LA MAIN, et eux seuls. Lister les 324 servirait
       surtout à noyer les trois qui comptent — ce sont les exceptions qu'on
       oublie, pas la règle. */
    client.query(
      `select id, titre, auteur, visibilite, categorie, sous_categorie
         from livres
        where visibilite <> 'heritee'
        order by auteur, titre`),
  ]);

  const t = tenant.rows[0];
  if (!t) refuser("Bibliothèque introuvable.", 404);

  /* Le compte des appels vient de la base, jamais d'un calcul local : c'est
     le MÊME décompte que celui qui refuse, sans quoi la jauge afficherait
     « 4 sur 10 » pendant que le service répond « quota atteint ». */
  const { rows: [q] } = await client.query("select appels_ia_du_mois() as consomme");

  return {
    identifiant: t.identifiant, nom: t.nom,
    langue: t.langue, visibilite: t.visibilite,
    quota: {
      plafond: t.quota_ia_mois,
      consomme: q.consomme,
      mois: new Date().toISOString().slice(0, 7),
    },
    rayons: rayons.rows,
    exceptions: exceptions.rows,
    // Ce que la page publique montrerait à cet instant, tous niveaux confondus.
    publies: rayons.rows.reduce((n, r) => n + r.publies, 0),
    livres: rayons.rows.reduce((n, r) => n + r.livres, 0),
  };
}

/* ATTENTION AU « 0 LIGNE MODIFIÉE ».
 *
 * Sous RLS, écrire chez quelqu'un d'autre ne lève PAS d'erreur : la clause
 * USING de la politique retire simplement la ligne du périmètre, et
 * PostgreSQL rapporte zéro ligne touchée. Une route qui ne regarde pas ce
 * compte répondrait « enregistré » à une écriture qui n'a rien écrit.
 *
 * Mesuré le 15/08/2026 sur PostgreSQL 18 : une tentative de modifier un
 * autre locataire rend rowCount = 0, sans exception. */
const exigerUneLigne = (r, quoi) => {
  if (r.rowCount !== 1) refuser(`Aucun ${quoi} à modifier ici.`, 404);
  return r.rowCount;
};

async function reglerBibliotheque(client, { langue, visibilite }) {
  const champs = [], valeurs = [];
  if (langue !== undefined) {
    if (!LANGUES.includes(langue)) refuser("Langue inconnue.");
    valeurs.push(langue); champs.push(`langue = $${valeurs.length}`);
  }
  if (visibilite !== undefined) {
    if (!VISIBILITES_BIBLIOTHEQUE.includes(visibilite)) {
      /* Pas de « heritee » ici, et ce n'est pas un oubli : la bibliothèque
         est le niveau du haut. Elle n'a rien dont hériter. */
      refuser("Une bibliothèque est privée ou publique.");
    }
    valeurs.push(visibilite); champs.push(`visibilite = $${valeurs.length}`);
  }
  if (!champs.length) refuser("Rien à modifier.");

  /* Pas de « where id = ... ». La politique tenants_reglages borne déjà
     l'écriture à sa propre ligne, et c'est ELLE qui doit faire foi : un
     filtre écrit ici en doublon donnerait l'illusion que la sécurité tient
     au code de l'API. Elle tient à PostgreSQL. */
  exigerUneLigne(await client.query(`update tenants set ${champs.join(", ")}`, valeurs),
                 "réglage");
  return lireReglages(client);
}

async function reglerRayon(client, { categorie, sousCategorie, visibilite }) {
  if (!SOUS_CATEGORIES[categorie]) refuser("Catégorie inconnue.");
  const rayon = String(sousCategorie ?? "").trim();
  if (!rayon) refuser("Rayon manquant.");
  if (!VISIBILITES_HERITABLES.includes(visibilite)) refuser("Visibilité inconnue.");

  const MOI = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

  /* « heritee » n'est pas une valeur à stocker, c'est l'ABSENCE de décision.
     La garder en base créerait deux façons de dire la même chose, et la
     table finirait pleine de lignes qui ne règlent rien. */
  if (visibilite === "heritee") {
    await client.query(
      `delete from rayons_reglages
        where tenant_id = ${MOI} and categorie = $1 and sous_categorie = $2`,
      [categorie, rayon]);
  } else {
    await client.query(
      `insert into rayons_reglages (tenant_id, categorie, sous_categorie, visibilite)
       values (${MOI}, $1, $2, $3)
       on conflict (tenant_id, categorie, sous_categorie)
         do update set visibilite = excluded.visibilite`,
      [categorie, rayon, visibilite]);
  }
  return lireReglages(client);
}

async function reglerLivre(client, { id, visibilite }) {
  if (!id) refuser("Ouvrage manquant.");
  if (!VISIBILITES_HERITABLES.includes(visibilite)) refuser("Visibilité inconnue.");
  exigerUneLigne(
    await client.query(
      "update possessions set visibilite = $2, maj_le = now() where id = $1",
      [String(id), visibilite]),
    "ouvrage");
  return lireReglages(client);
}

/* -------------------------------------------------------------- Anthropic */

const OUTIL_RESUME = {
  name: "enregistrer_resume",
  description: "Enregistre le résumé de l'ouvrage dans la fiche de lecture.",
  input_schema: {
    type: "object",
    properties: {
      resume: { type: "string", description: "6 à 8 phrases en français : la thèse centrale, la manière dont l'auteur l'établit, ce que le lecteur en retire. Pas de superlatifs commerciaux." },
      points: { type: "array", items: { type: "string" }, description: "3 à 5 idées-clés, une phrase chacune." },
      themes: { type: "array", items: { type: "string" }, description: "5 à 8 mots-clés thématiques en minuscules." },
      fiabilite: { type: "string", enum: ["haute", "moyenne", "faible"], description: "Certitude sur l'identification de l'ouvrage." },
    },
    required: ["resume", "points", "themes", "fiabilite"],
  },
};

/* ===========================================================================
   LE SEUL ENDROIT DE L'APPLICATION QUI DÉPENSE DE L'ARGENT

   Et c'est pourquoi le quota se décompte ICI, et nulle part ailleurs.

   Le mettre dans le routeur aurait été plus simple, mais faux : un résumé
   déjà en cache ne coûte rien, et le facturer ferait mentir la jauge. Le
   mettre dans chacune des trois fonctions appelantes marcherait aujourd'hui
   et serait oublié à la quatrième.

   Ici, l'oubli est impossible par construction : on ne peut plus appeler le
   modèle sans fournir « dans » — donc sans identité de payeur. Une nouvelle
   route qui négligerait le quota ne dépenserait pas trop : elle ne
   compilerait pas la première fois qu'on l'essaie.

   @param dans   Ouvre un contexte de locataire. C'est LUI qui identifie qui paie.
   @param route  Ce qui est inscrit au journal. Sert à répondre « d'où viennent
                 mes 40 appels ? », question qu'un simple compteur ne sait pas traiter.
   =========================================================================== */
async function appelerAnthropic(dans, route, corps) {
  if (!CLE_ANTHROPIC) {
    const e = new Error("ANTHROPIC_API_KEY absente du fichier .env");
    e.statut = 503;
    throw e;
  }

  /* AVANT l'appel, pas après. Ce qui coûte, c'est la tentative — le modèle
     facture une requête refusée en aval comme une autre. Décompter après
     laisserait une panne de réseau au mauvais moment effacer la trace d'un
     appel déjà payé.

     La fonction lève si aucun locataire n'est posé : un appel anonyme ne peut
     pas être décompté, donc il n'a pas lieu. C'est la propriété qui rend le
     plafond réel plutôt que décoratif. */
  /* Le modèle vient du CORPS, pas de la variable d'environnement.
   *
   * C'est « corps.model » qui est réellement facturé. Lire MODELE ici
   * enregistrerait ce que l'application croit employer, et le jour où un
   * appelant passera un modèle différent — la première passe sur un modèle
   * moins cher est une piste ouverte — la mesure attribuerait la dépense au
   * mauvais tarif sans que rien ne le signale. */
  let appelId = null;
  try {
    const { rows } = await dans((c) =>
      c.query("select * from consommer_appel_ia($1, $2)", [route, corps?.model ?? null]));
    appelId = rows?.[0]?.appel_id ?? null;
  } catch (e) {
    // 53400 : configuration_limit_exceeded. « Revenez le mois prochain »
    // n'est pas une panne, et ne doit pas s'afficher comme telle.
    if (e.code === "53400") {
      const q = new Error("Quota mensuel d'appels atteint. Il se remet à zéro le 1er du mois.");
      q.statut = 429;
      throw q;
    }
    if (e.code === "42501") {
      const q = new Error("Connectez-vous : un appel au modèle doit être rattaché à une bibliothèque.");
      q.statut = 401;
      throw q;
    }
    throw e;
  }

  /* NOTER CE QUE L'APPEL A COÛTÉ, SANS JAMAIS FAIRE ÉCHOUER L'APPEL.
   *
   * L'utilisateur a son résumé ; une écriture de comptabilité ratée ne doit
   * pas le lui retirer. Mais un échec silencieux nous ramènerait au point de
   * départ — un compteur qu'on croit tenu et qui ne l'est plus.
   *
   * D'où le partage : ici on journalise, et la vue « appels_ia_sans_mesure »
   * garde la trace durable. Le journal se perd à la rotation, la ligne en base
   * reste. Un contrôle qui ne vit que dans un journal n'est pas un contrôle. */
  const noter = async (issue, usage) => {
    if (appelId === null) return;
    try {
      await dans((c) => c.query(
        "select enregistrer_usage_ia($1::bigint, $2, $3, $4, $5)",
        [appelId, issue,
         usage?.input_tokens ?? null,
         usage?.output_tokens ?? null,
         usage?.server_tool_use?.web_search_requests ?? null]));
    } catch (e) {
      console.error(`usage de l'appel ${appelId} non enregistré (${issue}) —`, e.message);
    }
  };

  let r;
  try {
    r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLE_ANTHROPIC,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(corps),
    });
  } catch (e) {
    /* Réseau coupé, service muet. L'appel est décompté — c'est la règle du
       16/08 : ce qui coûte est la tentative — et il faut pouvoir distinguer
       cette ligne d'une ligne dont la mesure a été perdue. */
    await noter("echec");
    throw e;
  }

  if (!r.ok) {
    await noter("echec");
    const detail = (await r.text()).slice(0, 300);
    const e = new Error(`Le modèle a refusé la requête (HTTP ${r.status}) : ${detail}`);
    e.statut = 502;
    throw e;
  }

  const reponse = await r.json();

  /* « sans_mesure » plutôt que « ok » sans jetons : l'appel a abouti, mais la
     réponse ne portait pas d'« usage ». C'est le signe que le fournisseur a
     changé la forme de sa réponse, et c'est précisément ce qu'on ne veut pas
     découvrir six mois plus tard en s'étonnant d'un total trop bas. */
  await noter(reponse?.usage ? "ok" : "sans_mesure", reponse?.usage);

  return reponse;
}

function extraireJson(texte) {
  const d = texte.indexOf("{"), f = texte.lastIndexOf("}");
  if (d === -1 || f === -1) throw new Error("Réponse du modèle illisible");
  // Les caracteres de controle bruts dans une chaine cassent JSON.parse.
  return JSON.parse(texte.slice(d, f + 1).replace(/[\u0000-\u001f]/g, " "));
}

/* ------------------------------------------------------------- Endpoints */

/* « dans » et non « client » — la différence tient à la durée.
 *
 * Un appel au modèle avec recherche web dure des dizaines de secondes. Le
 * tenir à l'intérieur d'une transaction immobiliserait une connexion du pool
 * tout ce temps, et il n'y en a que huit : quelques résumés simultanés et
 * l'application entière cesse de répondre, y compris pour la page publique.
 *
 * On ouvre donc DEUX contextes courts — un pour lire, un pour écrire — et le
 * modèle est appelé entre les deux, sans connexion en main. */
async function resumerLivre(dans, langue, { bookId, forcer }) {
  const rows = await dans((c) =>
    c.query(`${LIVRES_AVEC_RESUME} where b.id = $2`, [langue, bookId]).then(r => r.rows));
  const l = rows[0];
  if (!l) { const e = new Error("Ouvrage introuvable"); e.statut = 404; throw e; }

  /* Le cache est PAR LANGUE. Un résumé français déjà écrit ne dispense pas
     d'en produire un anglais : sans ce détail, demander l'anglais rendrait
     le français, et personne ne s'en apercevrait avant de le lire. */
  if (l.resume && !forcer) {
    return { resume: l.resume, points: l.resume_points ?? [], themes: l.resume_themes ?? [],
             langue, cache: true };
  }

  const consigne = `Tu résumes un ouvrage pour la fiche de lecture d'une bibliothèque personnelle.

Ouvrage : "${l.titre}"
Auteur : ${l.auteur}
Éditeur : ${l.editeur ?? "inconnu"}
Année : ${l.annee ?? "inconnue"}
ISBN : ${l.isbn ?? "inconnu"}
Rayon : ${l.categorie} / ${l.sous_categorie}

Vérifie d'abord par recherche web de quel ouvrage il s'agit.
Si tu ne parviens pas à l'identifier avec certitude, dis-le dans le champ "resume"
et mets "fiabilite" à "faible" plutôt que d'inventer.

Termine en appelant l'outil enregistrer_resume. N'écris rien d'autre.`;

  const d = await appelerAnthropic(dans, "/api/resume", {
    model: MODELE,
    max_tokens: 2000,
    messages: [{ role: "user", content: consigne }],
    tools: [
      { type: OUTIL_RECHERCHE, name: "web_search", max_uses: 2 },
      OUTIL_RESUME,
    ],
  });

  const blocs = d.content ?? [];
  const appel = blocs.find(b => b.type === "tool_use" && b.name === OUTIL_RESUME.name);
  const info = appel?.input
    ?? extraireJson(blocs.filter(b => b.type === "text").map(b => b.text).join("\n"));

  /* Le locataire vient du réglage de session, pas des paramètres : c'est
     celui-là même que la politique d'écriture vérifie. */
  /* Le résumé se range sous l'OUVRAGE : produit une fois, lu par tous ceux
     qui possèdent la même édition. C'est l'économie principale de la
     découpe — la génération est la seule opération qui coûte de l'argent. */
  await dans((c) => c.query(
    `insert into resumes_ouvrages (ouvrage_id, langue, resume, points, themes,
                                   modele, fiabilite, genere_le)
     select p.ouvrage_id, $2, $3, $4, $5, $6, $7, now()
       from possessions p
      where p.id = $1
        and p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
     on conflict (ouvrage_id, langue) do update
        set resume = excluded.resume, points = excluded.points,
            themes = excluded.themes, modele = excluded.modele,
            fiabilite = excluded.fiabilite, genere_le = excluded.genere_le`,
    [bookId, langue, info.resume ?? null,
     Array.isArray(info.points) ? info.points : null,
     Array.isArray(info.themes) ? info.themes.map(t => String(t).toLowerCase()) : null,
     MODELE, info.fiabilite ?? null]));

  return { resume: info.resume ?? "", points: info.points ?? [], themes: info.themes ?? [],
           fiabilite: info.fiabilite ?? null, langue, cache: false };
}

async function recommander(dans, langue, { intention, sphere, inclureExternes }) {
  intention = String(intention ?? "").trim().slice(0, 600);
  if (intention.length < 3) { const e = new Error("Décrivez ce que vous voulez apprendre."); e.statut = 400; throw e; }

  const perimetreValide = sphere === "Perso" || sphere === "Pro" ? sphere : null;
  const livres = await dans((c) => (perimetreValide
    ? c.query(`${LIVRES_AVEC_RESUME} where b.sphere = $2 order by b.auteur`, [langue, perimetreValide])
    : c.query(`${LIVRES_AVEC_RESUME} order by b.auteur`, [langue])).then(r => r.rows));

  if (!livres.length) { const e = new Error("Aucun ouvrage dans ce périmètre"); e.statut = 400; throw e; }

  const catalogue = livres.map(l => {
    const themes = (l.resume_themes ?? []).slice(0, 5).join(", ");
    return `${l.id} | ${l.titre} | ${l.auteur} | ${l.annee ?? "?"} | ${l.sous_categorie} | ${l.sphere} | ${l.statut}${l.note ? ` | note ${l.note}/5` : ""}${themes ? ` | ${themes}` : ""}`;
  }).join("\n");

  const perimetre = perimetreValide
    ? `\nPÉRIMÈTRE : recherche restreinte aux lectures ${perimetreValide === "Pro" ? "professionnelles" : "personnelles"}. Le catalogue ci-dessous est déjà filtré.`
    : "";

  const consigne = `Tu es le bibliothécaire personnel du propriétaire de cette bibliothèque.
Il te dit ce qu'il veut apprendre ou approfondir ; tu lui construis un parcours de lecture.

CE QU'IL VEUT APPRENDRE :
"""${intention}"""${perimetre}

SA BIBLIOTHÈQUE (${livres.length} ouvrages)
Format : id | titre | auteur | année | rayon | perso ou pro | statut
${catalogue}

RÈGLES
- Choisis 3 à 6 ouvrages de SA bibliothèque, dans un ordre de lecture qui a du sens.
- Chaque "id" doit exister exactement dans la liste ci-dessus. N'invente aucun id.
- Explique en une ou deux phrases ce que CE livre précisément apporte à CETTE question.
- Un livre déjà "Lu" reste recommandable : dis ce qu'une relecture ciblée apporterait.
- Si sa bibliothèque couvre mal le sujet, dis-le franchement plutôt que de forcer des titres.
- N'ajoute aucune suggestion extérieure : ce n'est pas ton rôle ici.

Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises Markdown :
{
  "lecture_de_la_demande": "1 à 2 phrases : ce que tu comprends de sa question.",
  "parcours": [ { "id": "x042", "ordre": 1, "pourquoi": "...", "a_chercher": "le chapitre à viser" } ],
  "lacune": "1 à 2 phrases, ou chaîne vide."
}`;

  /* =======================================================================
     PREMIER APPEL : IL VOIT TOUT, IL NE PEUT RIEN ENVOYER.

     AUCUN OUTIL. C'est la seule barrière qui tienne contre un détournement
     de consigne, et il faut dire pourquoi les autres ne tiennent pas.

     Cette consigne contient la bibliothèque entière — titres, auteurs,
     thèmes, ouvrages personnels compris. Or ces titres viennent du
     CATALOGUE PARTAGÉ, table qu'un autre locataire peut écrire dès qu'il
     possède le même ISBN. Il peut donc y déposer un texte rédigé pour
     s'adresser au modèle plutôt qu'au lecteur.

     Tant que le même appel disposait de la recherche web, ce texte pouvait
     demander une recherche dont la REQUÊTE contenait vos titres privés. Les
     données sortaient sans jamais passer par une réponse que vous auriez
     lue. Aucune consigne de prudence n'y change quoi que ce soit : une
     instruction qui demande d'ignorer les instructions reste une
     instruction, et c'est au modèle de trancher entre les deux.

     Un modèle sans outil ne peut divulguer que dans sa réponse — laquelle
     est assainie plus bas, et vous revient à vous seul.
     ======================================================================= */
  const d = await appelerAnthropic(dans, "/api/recommandation", {
    model: MODELE,
    max_tokens: 4000,
    messages: [{ role: "user", content: consigne }],
  });

  const info = extraireJson((d.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"));

  const connus = new Set(livres.map(l => l.id));
  info.parcours = (Array.isArray(info.parcours) ? info.parcours : [])
    .filter(p => connus.has(p.id))
    .sort((a, b) => (a.ordre ?? 99) - (b.ordre ?? 99));

  /* ===================================================================
     LA RÉPONSE DU MODÈLE EST UNE ENTRÉE COMME UNE AUTRE.

     « parcours » était filtré — chaque id devait exister —, mais
     « suggestions_externes » sortait brut. Or l'année y était interpolée
     SANS échappement dans la page, l'auteur ayant supposé un nombre.

     Ce que cela ouvre : le modèle reçoit dans sa consigne des titres et des
     auteurs venus du CATALOGUE PARTAGÉ, c'est-à-dire de tables qu'un autre
     locataire peut écrire. Un titre rédigé pour détourner la consigne peut
     donc faire produire au modèle une « année » contenant du HTML, qui
     s'exécuterait dans le navigateur du LECTEUR — pas de celui qui l'a posé.

     Aujourd'hui il n'y a qu'un locataire, donc pas de chemin réel. C'est
     précisément pour cela qu'on répare maintenant : le jour où il y en a
     deux, le chemin existe sans que rien ne l'annonce.

     On borne donc chaque champ à son type et à sa longueur, ici, une fois,
     plutôt que de compter sur l'échappement de chaque page. */
  const texteCourt = (v, n) =>
    String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, n);

  info.lecture_de_la_demande = texteCourt(info.lecture_de_la_demande, 600);
  info.lacune = texteCourt(info.lacune, 600);
  for (const p of info.parcours) {
    p.pourquoi = texteCourt(p.pourquoi, 600);
    p.a_chercher = texteCourt(p.a_chercher, 300);
    p.ordre = Number.isFinite(Number(p.ordre)) ? Number(p.ordre) : 99;
  }

  /* =======================================================================
     SECOND APPEL : IL PEUT ENVOYER, IL N'A RIEN À DIRE.

     Un appel séparé, avec la recherche web, pour les lectures que vous ne
     possédez pas. Ce qu'il reçoit est ce qui compte :

       — VOTRE INTENTION, que vous avez écrite vous-même. Personne d'autre
         ne peut la rédiger.
       — LES NOMS DES RAYONS, tirés d'une liste fixée dans le code.

     Et rien d'autre. Ni titre, ni auteur, ni thème venu de votre
     bibliothèque.

     CE QU'ON NE LUI PASSE SURTOUT PAS : la « lacune » produite par le
     premier appel. Elle serait pourtant utile — c'est exactement ce qui
     manque. Mais elle a été écrite APRÈS avoir lu vos données, donc par un
     modèle qui aurait pu être détourné. La passer ici rouvrirait le canal
     par la porte de derrière, avec l'air d'être prudent.

     CE QUE ÇA COÛTE, honnêtement : les suggestions ignorent ce que vous
     possédez déjà, et peuvent donc proposer un livre de vos étagères. On
     les compare à votre bibliothèque APRÈS coup, ici, sans rien envoyer.
     ======================================================================= */
  info.suggestions_externes = [];

  if (inclureExternes !== false) {
    const rayons = Object.entries(SOUS_CATEGORIES)
      .map(([c, l]) => `${c} : ${l.filter(s => s !== "Non classé").join(", ")}`).join("\n");

    const consigneExterne = `Quelqu'un cherche à comprendre ceci :
"""${intention}"""

Propose 2 à 3 ouvrages qui répondent à cette question. Vérifie leur existence
par recherche web : titre, auteur, éditeur et année doivent être exacts.
N'invente rien ; si tu n'es sûr que de deux titres, n'en donne que deux.

Range chacun dans l'un de ces rayons, en reprenant les libellés exactement :
${rayons}

Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises Markdown :
{ "suggestions": [ { "titre": "", "auteur": "Nom Prénom", "editeur": "", "annee": 2020, "isbn": "", "pourquoi": "en une phrase" } ] }`;

    /* Une route distincte au journal des appels : « d'où viennent mes
       appels » doit pouvoir distinguer les deux moitiés de la fonction. */
    const dExt = await appelerAnthropic(dans, "/api/recommandation-externe", {
      model: MODELE,
      max_tokens: 1500,
      messages: [{ role: "user", content: consigneExterne }],
      tools: [{ type: OUTIL_RECHERCHE, name: "web_search", max_uses: 4 }],
    });

    let brut = [];
    try {
      brut = extraireJson((dExt.content ?? []).filter(b => b.type === "text")
        .map(b => b.text).join("\n")).suggestions ?? [];
    } catch {
      /* Une suggestion illisible ne doit pas emporter le parcours, qui est
         la partie utile et qui a déjà coûté un appel. */
      brut = [];
    }

    /* Ce que vous avez déjà, comparé ICI et non là-bas. L'ISBN d'abord ;
       à défaut, titre et auteur mis à plat — accents, casse et ponctuation
       retirés, car « H2G2, tome 1 » et « h2g2 tome 1 » sont le même livre. */
    const aplatir = (s) => String(s ?? "").normalize("NFD")
      .replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const isbnsPossedes = new Set(livres.map(l => l.isbn).filter(Boolean));
    const titresPossedes = new Set(livres.map(l => aplatir(l.titre) + "|" + aplatir(l.auteur)));

    info.suggestions_externes = (Array.isArray(brut) ? brut : [])
      .slice(0, 5)
      .map(s => ({
        titre: texteCourt(s.titre, 300),
        auteur: texteCourt(s.auteur, 200),
        editeur: texteCourt(s.editeur, 150),
        // Un nombre, ou rien. Jamais une chaîne venue du modèle.
        annee: Number.isInteger(Number(s.annee)) && Number(s.annee) > 0
               && Number(s.annee) < 2200 ? Number(s.annee) : null,
        isbn: String(s.isbn ?? "").replace(/[^0-9Xx]/g, "").slice(0, 13),
        pourquoi: texteCourt(s.pourquoi, 600),
      }))
      .filter(s => s.titre)
      .filter(s => !(s.isbn && isbnsPossedes.has(s.isbn)))
      .filter(s => !titresPossedes.has(aplatir(s.titre) + "|" + aplatir(s.auteur)));
  }

  await dans((c) => c.query(
    `insert into reading_quests (intention, reponse, modele, tenant_id)
     values ($1, $2, $3, nullif(current_setting('app.tenant_id', true), '')::uuid)`,
    [perimetreValide ? `[${perimetreValide}] ${intention}` : intention, info, MODELE]));

  return info;
}

async function chercherLivre(dans, { requete }) {
  requete = String(requete ?? "").trim().slice(0, 300);
  if (!requete) { const e = new Error("Indiquez un ISBN ou un titre."); e.statut = 400; throw e; }

  /* ==========================================================================
     LE LIVRE QUE VOUS AVEZ DÉJÀ — LA QUESTION SE POSE EN PREMIER

     Constaté le 18/08/2026 en production. Scanner un ouvrage déjà possédé
     menait au bout du chemin : catalogues interrogés, modèle appelé, formulaire
     rempli, vérifié, enregistré — et REFUSÉ à la dernière ligne par la
     contrainte « unique (tenant_id, ouvrage_id) ». Sans message visible, parce
     que l'échec s'affichait dans l'en-tête pendant que l'œil était dans la
     modale. On ne l'apprenait qu'en allant voir sa bibliothèque.

     La bonne réponse à « retrouve-moi ce livre » quand on le possède déjà
     n'est pas une fiche : c'est « vous l'avez ». Elle ne coûte rien, elle
     n'appelle personne, et elle arrive avant qu'on ait fait perdre du temps.

     CE N'EST PAS UNE ERREUR, DONC PAS UN CODE D'ERREUR. Le corps porte
     « deja » et l'interface décide quoi en faire — proposer d'ouvrir la fiche
     existante, par exemple. Un 409 obligerait le navigateur à passer par son
     chemin d'exception et perdrait l'identifiant en route.

     La contrainte reste le dernier mot : ce contrôle-ci évite le gâchis, il
     ne remplace pas le refus de la base. Une saisie manuelle simultanée, un
     import, une reprise de données ne passeront pas par ici.
     ========================================================================== */
  const isbnDemande = isbn13(requete);
  if (isbnDemande) {
    const [deja] = await dans((c) => c.query(
      `select p.id, o.titre, o.auteur
         from possessions p
         join ouvrages o on o.id = p.ouvrage_id
        where p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          and o.isbn = $1
        limit 1`, [isbnDemande]).then(r => r.rows));

    if (deja) {
      return { deja: { id: deja.id, titre: deja.titre, auteur: deja.auteur },
               isbn: isbnDemande };
    }
  }

  // La liste proposee au modele doit inclure les rayons que vous avez
  // acceptes depuis : sinon il rangerait en « Non classé » un ouvrage dont
  // le rayon existe desormais.
  const RAYONS = await dans((c) => rayonsDisponibles(c));

  /* ==========================================================================
     LE CATALOGUE D'ABORD. LE MODÈLE POUR CE QU'IL EST SEUL À SAVOIR FAIRE.

     Un seul appel faisait jusqu'ici deux métiers : IDENTIFIER l'ouvrage — ce
     qu'une bibliothèque nationale fait gratuitement et mieux — et le CLASSER
     dans un rayon, ce qu'aucun catalogue ne sait faire parce que les rayons
     sont les vôtres.

     Mesuré le 18/08/2026 : l'identification par le modèle coûtait 0,075 € par
     livre, et sur les deux ISBN qui avaient résisté ce soir-là, la BnF a
     répondu juste là où le modèle proposait une édition erronée « sans
     pouvoir confirmer ».

     Quand le catalogue répond, LES DONNÉES BIBLIOGRAPHIQUES NE SONT MÊME PAS
     SOUMISES AU MODÈLE : on ne lui demande que le rayon et l'ordre du nom. Ce
     qu'on ne lui demande pas, il ne peut pas le déformer. */
  const catalogue = isbn13(requete) ? await chercherParIsbn(requete) : null;

  if (catalogue?.issue === "trouvee") return await classerDepuisCatalogue(
    dans, catalogue.livre, catalogue.source, RAYONS);

  const consigne = `Trouve les informations bibliographiques du livre correspondant à : "${requete}".
Utilise la recherche web pour vérifier. N'invente aucune donnée : si une information
est introuvable, mets une chaîne vide ou null.

Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises Markdown :
{"titre":"","auteur":"Nom Prénom","editeur":"","annee":2020,"isbn":"","categorie":"","sousCategorie":"","rayonSuggere":"","motif":"","avecSources":null}

- "auteur" au format « Nom Prénom » (exemple : « Kahneman Daniel »).
- "isbn" au format ISBN-13 sans tirets.
- "categorie" vaut exactement l'une de : "Savoirs", "Roman", "BD".
- "sousCategorie" vaut exactement l'une des valeurs autorisées pour cette catégorie :
Savoirs : ${RAYONS["Savoirs"].join(" | ")}
Roman : ${RAYONS["Roman"].join(" | ")}
BD : ${RAYONS["BD"].join(" | ")}

CE QUE TU FAIS QUAND AUCUN RAYON NE CONVIENT

Ne force pas un rangement approximatif. Un ouvrage rangé dans un rayon qui
ne lui correspond pas est introuvable ensuite, et l'erreur ne se voit jamais.

Si aucun rayon de la liste ne convient réellement :
- mets "sousCategorie" à "Non classé" ;
- mets dans "rayonSuggere" le nom court du rayon qui manquerait à cette
  classification (deux à quatre mots, dans le même style que les autres) ;
- mets dans "motif" une phrase disant pourquoi aucun rayon existant ne va.

Exemple : un catalogue d'exposition de peinture n'entre ni dans les rayons
académiques, ni dans le roman, ni dans la bande dessinée — il appellerait un
rayon « Art & histoire de l'art ».

Si en revanche un rayon convient, laisse "rayonSuggere" et "motif" vides.`;

  const d = await appelerAnthropic(dans, "/api/recherche-livre", {
    model: MODELE,
    max_tokens: 1200,
    messages: [{ role: "user", content: consigne }],
    tools: [{ type: OUTIL_RECHERCHE, name: "web_search", max_uses: 3 }],
  });

  const info = extraireJson((d.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"));

  /* D'OÙ VIENT CETTE FICHE — ET POURQUOI CE CHAMP EXISTE.
   *
   * La cascade distingue « absente » (les catalogues ont répondu qu'ils ne
   * connaissent pas) de « injoignable » (ils se sont tus). J'ai défendu cette
   * distinction longuement dans « bibliographie.mjs »… et en mutant le code,
   * j'ai constaté qu'elle ne changeait RIEN : les deux cas tombaient sur le
   * même chemin, la mutation qui les confondait ne faisait tomber aucun
   * contrôle. Une distinction sans conséquence est un commentaire, pas une
   * propriété.
   *
   * Elle en a une désormais, et elle est utile aux deux bouts. Pour la
   * personne : « aucun catalogue n'a répondu » invite à réessayer plus tard,
   * « aucun catalogue ne connaît cet ISBN » non. Pour nous : le jour où le
   * coût des scans remontera, ce champ dira si c'est parce que la BnF était
   * en panne ou parce que les ouvrages sont réellement inconnus — deux
   * causes, deux remèdes. */
  info.identification =
      catalogue?.issue === "injoignable" ? "modele-catalogues-muets"
    : catalogue?.issue === "absente"     ? "modele-catalogues-sans-notice"
    :                                      "modele-sans-isbn";

  if (catalogue?.issue === "injoignable") {
    console.warn(`catalogues muets (${catalogue.muettes.join(", ")}) — `
               + `identification par le modèle, à revérifier`);
  }

  return normaliserFiche(info, RAYONS);
}

/* ==========================================================================
   LE CLASSEMENT SEUL — SANS RECHERCHE WEB

   Appelé quand un catalogue a déjà identifié l'ouvrage. Deux différences avec
   le chemin complet, et les deux comptent.

   ① PAS D'OUTIL DE RECHERCHE. C'est là qu'était l'argent : deux tiers du coût
     d'un scan venaient des résultats de recherche réinjectés dans le contexte
     et relus à chaque tour. Ici l'invite fait quelques centaines de jetons et
     n'en reçoit aucun en retour.

   ② UNE ROUTE DISTINCTE AU JOURNAL. « /api/recherche-livre-classement » plutôt
     que « /api/recherche-livre » : sans cela, les deux chemins se mélangeraient
     dans « cout_ia_par_mois » et l'on ne pourrait pas prouver le gain. Une
     optimisation qu'on ne peut pas mesurer est une opinion.
   ========================================================================== */
async function classerDepuisCatalogue(dans, livre, source, RAYONS, contexte = "") {
  const consigne = `Un catalogue de bibliothèque a identifié cet ouvrage. Les données ci-dessous
font foi : ne les corrige pas, ne les complète pas, ne cherche rien.

Titre : ${livre.titre}
Auteur (tel que catalogué) : ${livre.auteur || "inconnu"}
Éditeur : ${livre.editeur || "inconnu"}
Année : ${livre.annee ?? "inconnue"}${contexte}

Tu as DEUX choses à faire, et rien d'autre.

1. Remettre le nom de l'auteur dans l'ordre « Nom Prénom » (exemple :
   « Augereau, Sylvie » et « Sylvie Augereau » donnent tous deux
   « Augereau Sylvie »). N'ajoute aucun mot qui ne soit pas dans le nom fourni.
   Si l'auteur est inconnu, laisse la chaîne vide.

2. Ranger l'ouvrage dans un rayon.

3. Dire si l'ouvrage porte un APPAREIL CRITIQUE : notes, bibliographie, index,
   références vérifiables. Mets "avecSources" à true ou false SEULEMENT si tu
   le sais. Dans le doute, mets null — c'est la réponse attendue le plus
   souvent, et elle vaut mieux qu'une supposition.
   Ce n'est pas un jugement de qualité : un beau livre sans bibliographie
   n'est pas moins bon, il est autre chose.

Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises Markdown :
{"auteur":"Nom Prénom","categorie":"","sousCategorie":"","rayonSuggere":"","motif":"","avecSources":null}

- "categorie" vaut exactement l'une de : "Savoirs", "Roman", "BD".
- "sousCategorie" vaut exactement l'une des valeurs autorisées pour cette catégorie :
Savoirs : ${RAYONS["Savoirs"].join(" | ")}
Roman : ${RAYONS["Roman"].join(" | ")}
BD : ${RAYONS["BD"].join(" | ")}

Si aucun rayon ne convient réellement, mets "sousCategorie" à "Non classé",
"rayonSuggere" au nom court du rayon qui manquerait (deux à quatre mots, dans
le même style que les autres), et "motif" à une phrase disant pourquoi.
Sinon laisse "rayonSuggere" et "motif" vides.`;

  const d = await appelerAnthropic(dans, "/api/recherche-livre-classement", {
    model: MODELE,
    max_tokens: 600,
    messages: [{ role: "user", content: consigne }],
  });

  const rendu = extraireJson((d.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"));

  /* LE MODÈLE PEUT RÉORDONNER UN NOM, PAS L'INVENTER.
   *
   * On lui demande une permutation ; rien ne l'oblige à s'y tenir, et un nom
   * fabriqué serait indétectable à l'œil sur une fiche qu'on ne relit pas.
   * On compare donc les MOTS, sans ordre ni accents ni casse : s'ils ne
   * correspondent pas à ceux du catalogue, on garde le nom du catalogue.
   * Une fiche mal ordonnée se corrige ; une fiche fausse se propage. */
  const mots = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(" ");
  const auteur = mots(rendu.auteur) === mots(livre.auteur)
    ? String(rendu.auteur ?? "").trim()
    : livre.auteur;

  /* Les données du catalogue écrasent tout ce que le modèle aurait pu dire :
     elles ne lui ont pas été demandées, elles ne peuvent pas venir de lui. */
  return normaliserFiche({
    ...rendu,
    titre: livre.titre,
    auteur,
    editeur: livre.editeur,
    annee: livre.annee,
    isbn: livre.isbn,
    source,
    identification: "catalogue",
    /* Ce qui est DÉDUIT doit se distinguer de ce qui est MESURÉ. L'éditeur
       peut venir d'une autre édition du même ouvrage ; l'interface doit
       pouvoir le dire plutôt que de le présenter comme une donnée de la
       notice scannée. */
    editeurAutreEdition: livre.editeur_autre_edition === true,
    avecSources: rendu.avecSources,
  }, RAYONS);
}

/* Ce que les DEUX chemins doivent subir avant de traverser l'API. Écrit une
   fois : deux copies d'une règle de nettoyage divergent, et c'est la copie
   oubliée qui laisse passer. */
function normaliserFiche(info, RAYONS) {
  /* La categorie reste contrainte a la liste fermee : elle commande le reste
     de l'application. Le RAYON, lui, retombe desormais sur « Non classé »
     plutot que sur une chaine vide.

     La difference n'est pas cosmetique. Un champ vide ne dit pas s'il est
     vide parce que le modele a echoue, parce que le livre est introuvable,
     ou parce que la classification n'a pas ce rayon. « Non classé » repond a
     la question, et rayonSuggere dit ce qu'il faudrait ajouter. */
  if (!RAYONS[info.categorie]) { info.categorie = ""; info.sousCategorie = ""; }
  else if (!RAYONS[info.categorie].includes(info.sousCategorie)) info.sousCategorie = "Non classé";

  // Texte libre venu du modele : borne et nettoye avant de traverser l'API.
  const propre = (v, n) =>
  /* LES CARACTÈRES DE CONTRÔLE, EN ÉCHAPPEMENTS ET NON EN LITTÉRAL.
   *
   * Cette regex retirait les caractères de contrôle en EN CONTENANT — un
   * octet nul et un \x1F, tapés tels quels. Invisibles à la relecture, et
   * avec une conséquence qu'on ne devine pas : l'octet nul fait passer
   * server.js pour un fichier BINAIRE aux yeux de grep.
   *
   * Le contrôle du déployeur qui déduit les modules importés de ce fichier
   * n'en trouvait donc AUCUN — « modules de l API presents (0 importes) »
   * — et passait au vert. Une protection écrite le 18/08 n'a jamais rien
   * protégé, à cause de deux octets écrits ailleurs. */
  String(v ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);
  info.rayonSuggere = propre(info.rayonSuggere, 60);
  info.motif = propre(info.motif, 300);
  // Une suggestion n'a de sens que si le livre est effectivement non classe.
  if (info.sousCategorie !== "Non classé") { info.rayonSuggere = ""; info.motif = ""; }

  if (info.isbn) info.isbn = String(info.isbn).replace(/[^0-9Xx]/g, "");

  /* LE MODÈLE PROPOSE, LA FORME DÉCIDE. Il rend parfois la chaîne "true" ou
     "null" au lieu du booléen. Tout ce qui n'est pas un vrai booléen devient
     null — c'est-à-dire « on ne sait pas », qui est la valeur honnête quand
     la réponse est mal formée. */
  info.avecSources = typeof info.avecSources === "boolean" ? info.avecSources : null;

  return info;
}

/* ---------------------------------------------------------------- Routage */

const serveur = createServer(async (req, rep) => {
  const url = new URL(req.url, "http://interne");
  const chemin = url.pathname;
  const ip = adresseClient(req);

  try {
    if (chemin === "/api/sante") return json(rep, { ok: true });

    /* TOUTE ÉCRITURE DOIT VENIR D'ICI.
       Placé avant la connexion elle-même : sans cela, une page voisine
       pourrait ouvrir une session dans votre navigateur avec un mot de passe
       qu'elle connaît, et l'utiliser ensuite pour écrire chez vous. */
    if (req.method !== "GET" && req.method !== "HEAD" && origineEtrangere(req)) {
      return json(rep, { error: "Origine non autorisée." }, 403);
    }

    /* --- Connexion --- */
    if (chemin === "/api/connexion" && req.method === "POST") {
      if (tropDeTentatives(ip)) return json(rep, { error: "Trop de tentatives. Réessayez dans un quart d'heure." }, 429);
      const { motDePasse } = await lireCorps(req);
      if (!motDePasseValide(motDePasse)) {
        noterEchec(ip);
        await new Promise(r => setTimeout(r, 400));
        return json(rep, { error: "Mot de passe incorrect" }, 401);
      }
      tentatives.delete(ip);
      if (!ID_TENANT_DEFAUT) return json(rep, { error: "Bibliothèque non configurée." }, 503);
      const jeton = signer({ t: ID_TENANT_DEFAUT, expire: Date.now() + DUREE_SESSION });
      return json(rep, { ok: true }, 200, {
        "Set-Cookie": `${COOKIE_SESSION}=${jeton}; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION / 1000}`,
      });
    }

    /* =====================================================================
       CONNEXION PAR LIEN — DEMANDE

       LA RÉPONSE EST LA MÊME QUE LE COMPTE EXISTE OU NON, et c'est la
       propriété qui compte le plus ici. Sans elle, ce point d'entrée devient
       un annuaire : on y teste des adresses jusqu'à trouver un compte, et
       l'on apprend qui utilise le service.

       Conséquence assumée : quelqu'un qui se trompe d'adresse n'aura aucun
       message d'erreur, et attendra un courriel qui ne viendra pas. C'est le
       prix, et il est plus faible que celui de l'inverse.
       ===================================================================== */
    if (chemin === "/api/lien" && req.method === "POST") {
      const etat = etatCourriel();

      /* EN PRODUCTION, LE MODE « JOURNAL » N'EST PAS UNE OPTION.
         Il écrit le lien en clair dans le journal du serveur : acceptable en
         recette, dont l'accès est déjà protégé, inacceptable ailleurs. On
         refuse plutôt que d'envoyer un lien que personne ne recevra — ou
         pire, que quelqu'un d'autre lirait. */
      if (ENVIRONNEMENT === "production" && etat.mode === "journal") {
        return json(rep, {
          error: "La connexion par courriel n'est pas encore configurée ici.",
        }, 503);
      }
      if (!etat.pret) {
        console.error("courriel mal configuré :", etat.detail);
        return json(rep, { error: "La connexion par courriel est indisponible." }, 503);
      }

      /* LE CORPS EST LU AVANT LE LIMITEUR, maintenant qu'il compte aussi les
         adresses. L'ordre inverse laissait passer une demande par adresse
         sans jamais l'avoir vue. */
      const { courriel } = await lireCorps(req);
      /* Le seul refus explicite : une adresse qui n'en est pas une. Il ne
         révèle rien — la forme d'une adresse n'est pas un secret. */
      if (!courrielPlausible(courriel)) {
        return json(rep, { error: "Cette adresse ne ressemble pas à un courriel." }, 400);
      }

      if (tropDeDemandesLien(ip, courriel)) {
        return json(rep, { error: "Trop de demandes. Réessayez dans un quart d'heure." },
                    429, { "Retry-After": "900" });
      }

      const demande = await avecVisiteur(bd, (c) =>
        demanderLien(c, courriel, { inscriptionOuverte: INSCRIPTION_OUVERTE }));

      if (demande.jeton) {
        const lien = `${adressePublique(req)}/ma-bibliotheque.html`
                   + `?jeton=${encodeURIComponent(demande.jeton)}`;
        /* Deux messages, choisis par ce que la base a répondu — jamais par ce
           que le visiteur a prétendu. */
        const { sujet, texte, html } = demande.inscription
          ? messageDInscription(lien, DUREE_LIEN_MINUTES)
          : messageDeConnexion(lien, DUREE_LIEN_MINUTES);
        try {
          const envoi = await envoyerCourriel({ a: courriel, sujet, texte, html });
          /* UNE TRACE EN CAS DE SUCCÈS, ET PAS SEULEMENT D'ÉCHEC.
             Sans elle, « le lien est-il parti ? » n'a pas de réponse : un
             journal muet signifie aussi bien « aucune demande » que
             « demande réussie ». Constaté le 17/08/2026, en cherchant
             pourquoi rien n'arrivait.
             SANS L'ADRESSE DU DESTINATAIRE : elle répondrait à la question
             « qui utilise ce service ? », que personne n'a besoin de poser
             au journal d'un serveur. */
          console.log(`lien ${demande.inscription ? "d'inscription" : "de connexion"} `
                      + `envoyé (${envoi.mode})`);
        } catch (e) {
          /* L'envoi a échoué : on le dit. Répondre « c'est parti » à qui
             n'aura jamais rien serait le laisser attendre indéfiniment.
             Cela ne révèle rien : le message ne distingue pas un compte
             inconnu d'un service en panne. */
          console.error("envoi du lien impossible :", e.message);
          return json(rep, { error: "L'envoi a échoué. Réessayez dans un moment." },
                      e.statut ?? 502);
        }
      }

      return json(rep, { envoye: true });
    }

    /* --- CONNEXION PAR LIEN — USAGE ------------------------------------ */
    if (chemin === "/api/connexion-lien" && req.method === "POST") {
      const { jeton } = await lireCorps(req);

      let compte;
      try {
        compte = await avecVisiteur(bd, (c) =>
          consommerLien(c, jeton, { inscriptionOuverte: INSCRIPTION_OUVERTE }));
      } catch (e) {
        /* Un lien émis pendant que les inscriptions étaient ouvertes, ouvert
           après leur fermeture. Rare, mais il faut le dire vrai : un 500
           laisserait croire à une panne. */
        if (!e.inscriptionFermee) throw e;
        return json(rep, { error: "Les inscriptions sont fermées pour le moment." }, 403);
      }

      if (!compte) {
        /* Un seul message pour trois cas — jeton inconnu, déjà utilisé,
           périmé. Les distinguer dirait à un attaquant lequel de ses essais
           a existé un jour. */
        await new Promise(r => setTimeout(r, 400));
        return json(rep, { error: "Ce lien n'est plus valable. Demandez-en un nouveau." }, 401);
      }

      const signe = signer({
        c: compte.compte_id, t: compte.tenant_id,
        expire: Date.now() + DUREE_SESSION,
      });
      return json(rep, { ok: true }, 200, {
        "Set-Cookie": `${COOKIE_SESSION}=${signe}; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION / 1000}`,
      });
    }

    /* =====================================================================
       SE CONNECTER AVEC GOOGLE

       DEUX ROUTES ET UN COOKIE, dont la portée est la seule chose subtile.

       « SameSite=Lax » SUR LE COOKIE DE TRANSIT, ET C'EST OBLIGATOIRE.
       Google renvoie la personne par une navigation venue d'un AUTRE site.
       Un cookie « Strict » ne serait pas envoyé sur cette requête-là : le
       state serait introuvable, et la connexion échouerait avec un message
       parlant de falsification alors que rien n'a été falsifié.

       C'est exactement le genre de défaut qui coûte une soirée : tout est
       correct, et rien ne marche. « Lax » envoie le cookie sur les
       navigations de premier niveau en GET — le cas, et seulement lui.

       Le cookie de SESSION, lui, reste « Strict » : il n'a aucune raison de
       voyager depuis un site tiers.
       ===================================================================== */
    const COOKIE_TRANSIT = DERRIERE_PROXY ? "__Host-oidc" : "oidc";
    const effacerTransit =
      `${COOKIE_TRANSIT}=; HttpOnly;${COOKIE_SECURE} SameSite=Lax; Path=/; Max-Age=0`;

    /* Le retour se fait dans un NAVIGATEUR, pas en XHR : on redirige, on ne
       rend pas du JSON. Le message voyage donc en paramètre, et la page le
       traduit — elle seule sait comment le dire à sa manière. */
    const versEcran = (ennui) => ({
      statut: 302,
      entetes: { Location: `/ma-bibliotheque.html${ennui ? `?oidc=${ennui}` : "?oidc=ok"}` },
    });

    if (chemin === "/api/oidc/depart" && req.method === "GET") {
      const etat = etatOidc();
      if (!etat.pret) {
        console.error("OIDC mal configuré :", etat.detail);
        const r = versEcran("indisponible");
        rep.writeHead(r.statut, r.entetes); return rep.end();
      }

      const d = oidcCommencer({ base: adressePublique(req) });
      const transit = signerTransit(SECRET,
        { e: d.etat, n: d.nonce, v: d.verifieur }, 600);

      rep.writeHead(302, {
        Location: d.url,
        "Set-Cookie": `${COOKIE_TRANSIT}=${transit}; HttpOnly;${COOKIE_SECURE}`
                    + ` SameSite=Lax; Path=/; Max-Age=600`,
      });
      return rep.end();
    }

    if (chemin === "/api/oidc/retour" && req.method === "GET") {
      const fini = (ennui) => {
        const r = versEcran(ennui);
        rep.writeHead(r.statut, { ...r.entetes, "Set-Cookie": effacerTransit });
        return rep.end();
      };

      const transit = verifierTransit(SECRET, lireCookie(req, COOKIE_TRANSIT));
      const code = url.searchParams.get("code");
      const etatRecu = url.searchParams.get("state");

      /* Google renvoie « error=access_denied » quand la personne referme sa
         fenêtre. Ce n'est pas une panne : c'est un renoncement, et le dire
         autrement serait inquiéter pour rien. */
      if (url.searchParams.get("error")) return fini("renonce");

      /* Le state prouve que ce retour répond à un départ que NOUS avons
         provoqué. Sans lui, n'importe qui peut faire aboutir une connexion
         dans le navigateur de quelqu'un d'autre. */
      if (!transit || !code || !etatRecu || etatRecu !== transit.e) {
        console.warn("retour OIDC sans transit valide");
        return fini("expire");
      }

      let identite;
      try {
        identite = await oidcTerminer({ code, verifieur: transit.v,
                                        nonceAttendu: transit.n,
                                        base: adressePublique(req) });
      } catch (e) {
        /* Le détail va au journal, jamais à l'écran : il nomme parfois notre
           identifiant client, et il n'apprendrait rien à la personne. */
        console.error("OIDC refusé :", e.message);
        return fini("refuse");
      }

      /* LE DRAPEAU PASSE PAR ICI AUSSI — corrigé le 24/08/2026. Il ne le
         faisait pas, et Google créait donc des bibliothèques pendant que le
         lien magique refusait les inconnus. Constaté en production, pas en
         relecture : c'est un compte réellement créé qui l'a montré. */
      let issue;
      try {
        issue = await avecVisiteur(bd, (c) =>
          connexionParOidc(c, identite, { inscriptionOuverte: INSCRIPTION_OUVERTE }));
      } catch (e) {
        if (!e.inscriptionFermee) throw e;
        console.warn("OIDC : inscription refusée, les inscriptions sont fermées");
        return fini("fermee");
      }

      /* L'ADRESSE NON VÉRIFIÉE EST REFUSÉE FRANCHEMENT — décidé le 22/08.
         Un repli silencieux sur le lien magique ferait croire à une panne, et
         la personne chercherait le défaut là où il n'est pas. */
      if (issue.rattachementRefuse) {
        console.warn("OIDC : adresse non vérifiée par Google, refus");
        return fini("non-verifiee");
      }

      const signe = signer({
        c: issue.compte_id, t: issue.tenant_id,
        expire: Date.now() + DUREE_SESSION,
      });
      console.log(`connexion Google (${issue.nouveau ? "inscription" : issue.rattache ? "rattachement" : "retour"})`);

      rep.writeHead(302, {
        Location: `/ma-bibliotheque.html?oidc=${issue.nouveau ? "bienvenue" : "ok"}`,
        "Set-Cookie": [
          `${COOKIE_SESSION}=${signe}; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION / 1000}`,
          effacerTransit,
        ],
      });
      return rep.end();
    }

    if (chemin === "/api/deconnexion" && req.method === "POST") {
      return json(rep, { ok: true }, 200, { "Set-Cookie": COOKIES_ACCEPTES
          .map(n => `${n}=; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=0`) });
    }

    /* Une session sans locataire n'en est pas une.
       Les jetons émis avant la bascule n'en portent pas ; ils sont de toute
       façon invalidés par le changement de secret, mais on ne s'appuie pas
       sur cet effet de bord — on refuse explicitement. */
    const brut = verifier(lireSession(req));
    const session = brut && typeof brut.t === "string" ? brut : null;

    /* =====================================================================
       LE SEUL ENDROIT DE L'APPLICATION QUI POSE UN LOCATAIRE.

       Toute lecture et toute écriture passe par « dans ». Une route qui
       oublierait de s'en servir ne verrait pas trop de choses : elle
       n'en verrait aucune, puisque sans app.tenant_id la politique de
       cloisonnement ne laisse rien passer.

       C'est la propriété qui rend la bascule sûre — l'oubli est visible
       immédiatement, au lieu de fuir en silence.
       ===================================================================== */
    const dans = (travail) => session
      ? avecContexte(bd, session.t, travail)
      : avecVisiteur(bd, travail);

    /* La langue des résumés. Résolue UNE fois par requête, à l'intérieur
       d'un contexte — la lecture de « tenants » n'est pas cloisonnée, mais
       la faire ici garde toutes les décisions au même endroit. */
    const langue = await dans((c) => langueDemandee(c, url, session));

    /* LES DEUX ROUTES QUI COÛTENT, QUAND PERSONNE N'EST CONNECTÉ.
       Un utilisateur authentifié n'est pas limité ici : il est identifié,
       borné par son quota sur ce qui se paie, et c'est sa propre
       bibliothèque qu'il ralentirait. */
    if (!session && (chemin === "/api/livres" || chemin === "/api/statistiques")
        && tropDeLectures(ip)) {
      return json(rep, { error: "Trop de requêtes. Réessayez dans une minute." },
                  429, { "Retry-After": "60" });
    }

    /* --- Routes ouvertes : ce que le locataire a rendu public --- */
    if (chemin === "/api/session") {
      return json(rep, {
        connecte: !!session, ia_publique: IA_PUBLIQUE, langue,
        environnement: ENVIRONNEMENT,
        // Une recette sans clef ne peut pas produire de résumé. Le dire
        // évite d'attendre une réponse qui ne viendra pas.
        ia_disponible: Boolean(CLE_ANTHROPIC),
        /* La page a besoin de savoir si le bouton Google mène quelque part.
           Un bouton qui redirige vers un message d'indisponibilité est pire
           que pas de bouton : on clique, on attend, on ne comprend pas. */
        google: etatOidc().pret,
      });
    }

    if (chemin === "/api/livres" && req.method === "GET") {
      return json(rep, await dans((c) => listerLivres(c, langue)));
    }

    if (chemin === "/api/statistiques" && req.method === "GET") {
      return json(rep, await dans((c) => statistiques(c, session, langue)));
    }

    // Lecture ouverte : la liste des rayons n'est pas une donnee sensible,
    // et la page publique en a besoin pour nommer ce qu'elle affiche.
    if (chemin === "/api/rayons" && req.method === "GET") {
      return json(rep, await dans((c) => rayonsDisponibles(c)));
    }

    /* LA COUVERTURE DE SECOURS — ouverte, parce que la page publique en a
       besoin, et BORNÉE pour la même raison.
       Elle ne touche ni la base ni le modèle : elle demande une adresse
       d'image à Google Books avec notre clef, que le navigateur ne peut pas
       porter. Un visiteur anonyme peut donc la solliciter, et le quota de
       lecture qui protège déjà /api/livres la protège aussi — sans quoi on
       offrirait un moyen d'épuiser notre quota Google depuis l'extérieur. */
    if (chemin === "/api/couverture" && req.method === "GET") {
      if (!session && tropDeLectures(ip)) {
        return json(rep, { error: "Trop de requêtes. Réessayez dans une minute." }, 429);
      }
      return json(rep, { url: await couvertureDeSecours(url.searchParams.get("isbn")) });
    }

    /* --- Les traitements qui coûtent de l'argent --- */
    const routesIA = ["/api/resume", "/api/recommandation", "/api/recherche-livre"];
    if (routesIA.includes(chemin) && !session && !IA_PUBLIQUE) {
      return json(rep, {
        error: "Connectez-vous pour utiliser les résumés et les recommandations.",
      }, 401);
    }

    /* --- Toutes les routes suivantes exigent une session --- */
    if (!session && !routesIA.includes(chemin)) {
      return json(rep, { error: "Non authentifié" }, 401);
    }

    /* LA RECHERCHE LIBRE DANS LE CATALOGUE — gratuite, sans modèle.
     *
     * Elle sert quand aucun catalogue ne connaît l'ISBN : tirage de luxe,
     * micro-éditeur, parution trop récente. La personne qui tient le livre
     * lit deux mots sur la couverture — ce qu'aucune machine ne sait faire à
     * partir de treize chiffres que personne ne connaît.
     *
     * PLACÉE APRÈS LE CONTRÔLE DE SESSION, et pas avant.
     *
     * Je l'avais d'abord écrite à côté de /api/couverture, en commentant
     * qu'elle exigeait une session — alors que cet endroit du routeur est
     * AVANT le garde. Le commentaire aurait décrit une protection que le
     * code n'appliquait pas, ce qui est pire que pas de commentaire : on
     * relit, on est rassuré, on passe.
     *
     * Elle n'a rien à faire en accès libre : contrairement à /api/couverture,
     * dont la page publique a besoin, celle-ci ne sert qu'au formulaire
     * d'ajout. Et elle appelle un service extérieur en notre nom. */
    if (chemin === "/api/catalogue" && req.method === "GET") {
      return json(rep, { notices: await chercherParTexte(url.searchParams.get("q")) });
    }

    /* ==================================================================
       LES ARTICLES — IDENTIFIÉS SANS LE MODÈLE

       Crossref rend le titre, les auteurs déjà séparés en nom et prénom, la
       revue, l'année, la pagination, le nombre de citations ET le résumé des
       auteurs. Il n'y a rien à deviner, donc rien à demander au modèle :
       un article coûte ZÉRO à cataloguer, là où un livre coûtait 0,075 €
       avant la cascade et coûte encore 0,002 € pour son seul classement.

       Le rayon, lui, reste un jugement — mais il se demandera au même appel
       de classement que pour un livre, avec la même taxonomie. C'était la
       décision : mêmes rayons, pour voir livres et articles côte à côte sur
       un sujet.

       DOUBLON D'ABORD, comme pour les livres. Un DOI déjà possédé ne repart
       pas chercher : on répond « vous l'avez ».
       ================================================================== */
    if (chemin === "/api/article" && req.method === "GET") {
      const doi = normaliserDoi(url.searchParams.get("doi"));
      if (!doi) return json(rep, { error: "DOI illisible." }, 400);

      const [deja] = await dans((c) => c.query(
        `select p.id, o.titre, o.auteur
           from possessions p
           join ouvrages o on o.id = p.ouvrage_id
          where p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
            and o.doi = $1
          limit 1`, [doi]).then(r => r.rows));
      if (deja) return json(rep, { deja, doi });

      const trouve = await chercherParDoi(doi);
      if (trouve.issue !== "trouvee") return json(rep, trouve);

      /* ON CLASSE ICI, pas côté navigateur.
       *
       * Crossref donne tout SAUF le rayon — et le rayon est un jugement sur
       * VOTRE classification, pas une propriété de l'article. C'est le même
       * appel que pour un livre identifié par un catalogue : sans recherche
       * web, quelques centaines de jetons, environ 0,002 €.
       *
       * La revue est passée en contexte : « Journal of Economic Perspectives »
       * dit bien plus sur le rayon que le nom de l'éditeur. */
      const RAYONS = await dans((c) => rayonsDisponibles(c));
      const a = trouve.article;
      /* Le contexte donné au modèle doit dire CE QU'EST le contenant. Lui
       * annoncer « Revue : Job Satisfaction — A Reader » pour un chapitre de
       * recueil, c'est lui mentir sur la nature de la source avant de lui
       * demander de la classer. */
      const fiche = await classerDepuisCatalogue(
        dans,
        { titre: a.titre, auteur: a.auteur, editeur: a.revue || null, annee: a.annee },
        "crossref", RAYONS,
        a.revue ? `\n${LIBELLES_SUPPORT[a.support] ?? "Publication"} : ${a.revue}` : "");

      /* Les données de Crossref écrasent ce que le modèle aurait pu dire :
         elles ne lui ont pas été demandées, elles ne peuvent pas venir de lui. */
      return json(rep, { ...fiche, ...a, type: "article", source: "crossref",
                         identification: "catalogue" });
    }

    /* La recherche par titre, quand le DOI n'est pas sous la main. Même rôle
       que la recherche libre à la BnF : celui qui a l'article devant lui en
       lit le titre, ce qu'aucune machine ne devine à partir de rien. */
    if (chemin === "/api/articles" && req.method === "GET") {
      return json(rep, { articles: await chercherArticleParTexte(url.searchParams.get("q")) });
    }

    if (chemin === "/api/livres" && req.method === "PUT") {
      const corps = await lireCorps(req);
      const livres = Array.isArray(corps) ? corps : [corps];
      /* Une borne au lot. Le corps est déjà limité à 8 Mo, ce qui laisse
         passer plusieurs dizaines de milliers de fiches dans UNE transaction :
         de quoi immobiliser une connexion du pool — il y en a huit — et
         rendre le service muet pour tout le monde, y compris la page
         publique. Mille tient largement pour un import de bibliothèque. */
      if (livres.length > 1000) {
        return json(rep, { error: "Lot trop volumineux : 1000 ouvrages au maximum." }, 413);
      }
      return json(rep, { enregistres: await dans((c) => enregistrerLivres(c, livres)) });
    }

    // Mise à jour partielle : uniquement les couvertures résolues par le navigateur.
    if (chemin === "/api/couvertures" && req.method === "POST") {
      const lot = await lireCorps(req);
      if (!Array.isArray(lot)) return json(rep, { error: "Tableau attendu" }, 400);
      /* Un SEUL contexte pour tout le lot : cinq cents transactions
         successives, c'est cinq cents allers-retours et autant d'occasions
         de laisser le lot à moitié appliqué. */
      /* La couverture est une propriété du LIVRE, pas de votre exemplaire :
         elle s'écrit donc dans le catalogue partagé, et profite à tous ceux
         qui possèdent la même édition. La politique ouvrages_correction
         limite l'écriture aux ouvrages qu'on possède — d'où la jointure par
         possessions, qui est aussi ce qui traduit VOTRE identifiant en
         identifiant d'ouvrage. */
      await dans(async (client) => {
        for (const c of lot.slice(0, 500)) {
          await client.query(
            `update ouvrages o set cover_url = $2, cover_statut = $3, maj_le = now()
               from possessions p
              where p.ouvrage_id = o.id and p.id = $1
                and p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`,
            [c.id, c.cover_url ?? null, c.cover_statut ?? "inconnu"]);
        }
      });
      return json(rep, { enregistrees: Math.min(lot.length, 500) });
    }

    if (chemin.startsWith("/api/livres/") && req.method === "DELETE") {
      const id = decodeURIComponent(chemin.slice("/api/livres/".length));
      /* On retire la POSSESSION. L'ouvrage reste au catalogue : il peut
         appartenir à quelqu'un d'autre, et sa fiche bibliographique n'est
         pas la vôtre à supprimer. « on delete restrict » sur la clé
         étrangère garantit d'ailleurs qu'on ne peut pas l'effacer tant
         qu'une bibliothèque le référence. */
      await dans((c) => c.query("delete from possessions where id = $1", [id]));
      return json(rep, { ok: true });
    }

    if (chemin === "/api/resume" && req.method === "POST") {
      return json(rep, await resumerLivre(dans, langue, await lireCorps(req)));
    }

    if (chemin === "/api/recommandation" && req.method === "POST") {
      return json(rep, await recommander(dans, langue, await lireCorps(req)));
    }

    if (chemin === "/api/rayons" && req.method === "POST") {
      const corpsRayon = await lireCorps(req);
      return json(rep, await dans((c) => ajouterRayon(c, corpsRayon)));
    }

    /* --- Réglages ---
       Chacune de ces routes REND l'état complet après écriture, plutôt qu'un
       « ok ». L'écran affiche donc toujours ce que la base applique, et non
       ce qu'il a demandé — la différence entre les deux est précisément ce
       qu'on veut voir quand un réglage ne prend pas. */
    /* =====================================================================
       LA PORTE DE SORTIE — ARTICLE 17

       Il n'existait aucune sortie avant le 24/08/2026 : la seule façon de
       partir était de m'écrire, et de me faire confiance. Ce n'est pas un
       droit, c'est une faveur.

       LA CONFIRMATION EST L'ADRESSE RECOPIÉE, pas une case à cocher. Une
       case se coche par réflexe ; recopier son adresse oblige à savoir ce
       qu'on fait. C'est aussi ce qui distingue un geste voulu d'un clic
       provoqué depuis ailleurs — le cookie est en « SameSite=Strict », mais
       on ne s'appuie pas sur un seul rempart.

       LA FONCTION EN BASE NE PREND AUCUN PARAMÈTRE : elle lit le locataire
       dans « app.tenant_id », que « dans() » vient de poser depuis la
       session signée. Aucune valeur calculée ici ne peut désigner la
       bibliothèque de quelqu'un d'autre.
       ===================================================================== */
    if (chemin === "/api/compte" && req.method === "DELETE") {
      const { confirmation } = await lireCorps(req);

      const bilan = await dans(async (c) => {
        /* « where tenant_id = … » N'EST PAS UNE PRÉCAUTION, C'EST LA SEULE
           BORNE — corrigé le 25/08/2026, après un essai réel.

           « comptes » est la seule table métier SANS politique de
           cloisonnement, et c'est voulu : se connecter exige de chercher une
           adresse à travers TOUS les comptes, avant de savoir de qui il
           s'agit. La connexion cloisonnée ne restreint donc RIEN ici.

           Écrite « select courriel from comptes limit 1 », la requête rendait
           l'adresse d'un compte quelconque — en production, celui créé le
           premier. La confirmation comparait la saisie à l'adresse d'un
           AUTRE : impossible de supprimer son propre compte, et une
           « confirmation » qui ne confirmait rien.

           Toute lecture de « comptes » depuis une connexion de locataire doit
           porter ce filtre. « test-http-cloisonnement.mjs » le vérifie
           désormais avec deux locataires. */
        const { rows } = await c.query(
          `select courriel from comptes
            where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`);
        const attendue = rows[0]?.courriel ?? null;

        /* Sans adresse au dossier — cas théorique — on refuse plutôt que de
           laisser passer une confirmation vide qui vaudrait accord. */
        if (!attendue
            || normaliserCourriel(confirmation) !== normaliserCourriel(attendue)) {
          refuser("Pour supprimer, recopiez exactement l'adresse de votre compte.", 400);
        }

        const { rows: [t] } =
          await c.query("select * from public.supprimer_locataire()");
        console.warn(`suppression de compte : ${t.ouvrages_effaces} ouvrage(s)`);
        return { ouvrages: Number(t.ouvrages_effaces),
                 comptes: Number(t.comptes_effaces) };
      });

      /* La session ne survit pas à la bibliothèque qu'elle désignait : sans
         cela, l'onglet resté ouvert continuerait d'interroger un locataire
         disparu, et l'écran parlerait d'erreurs plutôt que d'un départ. */
      return json(rep, { supprime: true, ...bilan }, 200, {
        "Set-Cookie": COOKIES_ACCEPTES.map(n =>
          `${n}=; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=0`),
      });
    }

    if (chemin === "/api/reglages" && req.method === "GET") {
      return json(rep, await dans((c) => lireReglages(c)));
    }
    if (chemin === "/api/reglages" && req.method === "PUT") {
      const corpsR = await lireCorps(req);
      return json(rep, await dans((c) => reglerBibliotheque(c, corpsR)));
    }
    if (chemin === "/api/reglages/rayon" && req.method === "PUT") {
      const corpsR = await lireCorps(req);
      return json(rep, await dans((c) => reglerRayon(c, corpsR)));
    }
    if (chemin === "/api/reglages/livre" && req.method === "PUT") {
      const corpsR = await lireCorps(req);
      return json(rep, await dans((c) => reglerLivre(c, corpsR)));
    }

    if (chemin === "/api/recherche-livre" && req.method === "POST") {
      return json(rep, await chercherLivre(dans, await lireCorps(req)));
    }

    return json(rep, { error: "Route inconnue" }, 404);
  } catch (e) {
    console.error(chemin, e.stack ?? e.message);
    /* CE QUI SORT N'EST PAS CE QU'ON JOURNALISE.
       Une erreur inattendue vient presque toujours de PostgreSQL, et son
       message nomme la table, la colonne, la contrainte — parfois la valeur
       qui l'a violée. Renvoyé au client, il dessine la structure de la base
       à qui sait lire, et peut recopier une donnée d'autrui dans la réponse.
       Les erreurs DÉLIBÉRÉES, elles, portent un statut : celles-là sont
       écrites pour être lues, on les laisse passer telles quelles. */
    if (e.statut) return json(rep, { error: e.message }, e.statut);
    return json(rep, { error: "Erreur interne." }, 500);
  }
});

/* ------------------------------------------------------------ Démarrage */

async function attendreLaBase(essais = 30) {
  for (let i = 1; i <= essais; i++) {
    try { await bd.query("select 1"); return; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error("Base de données injoignable");
}

await attendreLaBase();

/* CE QUE VAUT LA CONFIGURATION DU COURRIEL, DIT AU DÉMARRAGE.
   Une clef absente ou un expéditeur mal écrit ne doivent pas se découvrir
   quand quelqu'un attend son lien. On ne refuse pas de démarrer : la
   connexion par mot de passe, elle, fonctionne toujours. Mais on le dit
   assez fort pour que ça se voie dans le journal d'un déploiement. */
{
  const etat = etatCourriel();
  if (etat.mode === "journal" && ENVIRONNEMENT === "production") {
    console.warn("COURRIEL : aucun expéditeur configuré. La connexion par lien "
      + "refusera poliment. (COURRIEL_SERVICE, COURRIEL_CLEF, COURRIEL_EXPEDITEUR)");
  } else if (!etat.pret) {
    console.error(`COURRIEL MAL CONFIGURÉ (${etat.mode}) : ${etat.detail}`);
  } else {
    console.log(`Courriel : ${etat.mode} — ${etat.detail}`);
  }
  if (DERRIERE_PROXY && !/^https?:\/\/[^\s/]+$/.test(process.env.ADRESSE_PUBLIQUE ?? "")) {
    console.warn("ADRESSE_PUBLIQUE absente : les liens de connexion seront refusés. "
      + "Posez-la dans le fichier d'environnement (ex. https://lisia.y-factor.fr).");
  }

  /* L'ÉTAT DES CATALOGUES, DIT UNE FOIS PLUTÔT QU'À CHAQUE SCAN.
   *
   * « etatCatalogues » était exportée, importée… et jamais appelée. L'intention
   * — dire au démarrage ce sur quoi on peut compter — n'existait que dans le
   * nom de la fonction. Une fonction morte qui décrit une garantie est pire
   * qu'aucune : elle rassure à la relecture.
   *
   * On ne refuse pas de démarrer sans clef Google : la BnF couvre le corpus
   * français, qui est celui de la bibliothèque. Mais il faut que la troisième
   * source manquante se voie dans le journal d'un déploiement, plutôt que de
   * se découvrir sur un livre étranger introuvable six mois plus tard. */
  const cat = etatCatalogues();
  console.log(`Catalogues : bnf (${cat.bnf}), openlibrary (${cat.openlibrary}), `
            + `googlebooks (${cat.googlebooks})`);

  /* Dit au démarrage, parce que c'est le premier endroit où regarder si les
     résumés se mettent à échouer en 502 après une livraison. */
  console.log(`Recherche web : ${OUTIL_RECHERCHE}`
    + (OUTIL_RECHERCHE === "web_search_20250305"
       ? " (sans filtrage dynamique — les résultats entrent entiers dans le contexte)"
       : " (filtrage dynamique)"));
  if (!process.env.CLE_GOOGLE_BOOKS && ENVIRONNEMENT === "production") {
    console.warn("CLE_GOOGLE_BOOKS absente : Google Books est ignoré. La BnF et "
      + "Open Library suffisent au corpus français ; un ouvrage étranger absent "
      + "des deux partira au modèle, donc coûtera.");
  }
}

/* Les liens périmés n'ont aucune raison de s'accumuler. Au démarrage suffit :
   une livraison par jour au pire, et rien ne dépend de cette purge. */
avecVisiteur(bd, purgerLiens).catch(e => console.error("purge des liens :", e.message));

/* Le locataire par défaut, résolu UNE fois au démarrage.
 *
 * Cette lecture porte sur « tenants », qui n'est pas cloisonnée : c'est la
 * table qui DÉFINIT les locataires, elle ne peut pas dépendre de l'un d'eux.
 * Sans elle, la connexion par mot de passe ne saurait pas quelle
 * bibliothèque ouvrir. */
{
  const { rows } = await bd.query(
    "select id from tenants where identifiant = $1", [TENANT_DEFAUT]);
  if (!rows.length) {
    console.error(`Locataire « ${TENANT_DEFAUT} » absent de la base.\n` +
      "Le schéma db/02-multi-locataire.sql n a probablement pas été appliqué.");
    process.exit(1);
  }
  ID_TENANT_DEFAUT = rows[0].id;
  console.log(`Locataire par défaut : ${TENANT_DEFAUT} (${ID_TENANT_DEFAUT}).`);
}

/* L'amorçage écrit des ouvrages : il lui faut donc un locataire, comme à
   toute écriture. Hors contexte, le compte rendrait zéro et l'insertion
   serait refusée — on ré-amorcerait à chaque démarrage, dans le vide. */
await avecContexte(bd, ID_TENANT_DEFAUT, (c) => amorcerSiVide(c));
serveur.listen(PORT, '127.0.0.1', () => console.log(`API prête sur le port ${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    serveur.close(() => bd.end().then(() => process.exit(0)));
  });
}
