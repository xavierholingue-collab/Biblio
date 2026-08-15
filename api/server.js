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

const PORT = Number(process.env.PORT ?? 3000);
const MOT_DE_PASSE = process.env.MOT_DE_PASSE ?? "";
const CLE_ANTHROPIC = process.env.ANTHROPIC_API_KEY ?? "";
const MODELE = process.env.MODELE ?? "claude-sonnet-5";
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
  "Académique": [
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

function lireCookie(req, nom) {
  const brut = req.headers.cookie ?? "";
  for (const part of brut.split(";")) {
    const [c, ...v] = part.trim().split("=");
    if (c === nom) return decodeURIComponent(v.join("="));
  }
  return null;
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
  const t = tentatives.get(ip) ?? { debut: Date.now(), nombre: 0 };
  t.nombre += 1;
  tentatives.set(ip, t);
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
  b.cover_url, b.cover_statut, b.visibilite`;

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
    perimetre: session ? "complet" : "professionnel",
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
    const sphere = l.sphere ?? (l.categorie === "Académique" ? "Pro" : "Perso");
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
      categorie: l.categorie,
      sous_categorie: l.sous_categorie ?? l.sousCategorie,
      sphere,

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
  const CLE = `case when e.isbn is not null then 'isbn:' || e.isbn
                    else 'local:' || current_setting('app.tenant_id', true) || ':' || e.id end`;

  const SOURCE = `jsonb_to_recordset($1::jsonb) as e(
      id text, isbn text, titre text, auteur text, editeur text, annee int,
      pages int, cover_url text, cover_statut text, statut text, note numeric,
      categorie text, sous_categorie text, sphere text, visibilite text)`;

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
                           cover_url, cover_statut)
     select distinct on (cle) * from (
       select ${CLE} as cle, e.isbn, e.titre, e.auteur, e.editeur, e.annee,
              e.pages, e.cover_url, coalesce(e.cover_statut, 'inconnu')
         from ${SOURCE}
         left join possessions p on p.tenant_id = ${MOI} and p.id = e.id
        where e.isbn is not null or p.id is null) t
     on conflict (cle) do nothing`, [charge]);

  // 2. La possession. Le locataire vient du réglage de session, celui-là
  //    même que la politique d'écriture vérifie.
  await client.query(
    `insert into possessions (tenant_id, id, ouvrage_id, statut, note,
                              categorie, sous_categorie, sphere, visibilite, maj_le)
     select ${MOI}, e.id,
            case when e.isbn is not null then o.id
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
       visibilite = excluded.visibilite, maj_le = now()`, [charge]);

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
  await client.query(
    `update ouvrages o set
       titre = e.titre, auteur = e.auteur, editeur = e.editeur, annee = e.annee,
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
  try {
    await dans((c) => c.query("select * from consommer_appel_ia($1)", [route]));
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

  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLE_ANTHROPIC,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(corps),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    const e = new Error(`Le modèle a refusé la requête (HTTP ${r.status}) : ${detail}`);
    e.statut = 502;
    throw e;
  }
  return r.json();
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
      { type: "web_search_20250305", name: "web_search", max_uses: 2 },
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
${inclureExternes !== false ? `- Ajoute ensuite 2 à 3 ouvrages ABSENTS de sa bibliothèque qui comblent les lacunes.
  Vérifie leur existence par recherche web (titre, auteur, éditeur, année exacts).` : "- N'ajoute aucune suggestion extérieure."}

Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises Markdown :
{
  "lecture_de_la_demande": "1 à 2 phrases : ce que tu comprends de sa question.",
  "parcours": [ { "id": "x042", "ordre": 1, "pourquoi": "...", "a_chercher": "le chapitre à viser" } ],
  "lacune": "1 à 2 phrases, ou chaîne vide.",
  "suggestions_externes": [ { "titre": "", "auteur": "Nom Prénom", "editeur": "", "annee": 2020, "isbn": "", "pourquoi": "" } ]
}`;

  const d = await appelerAnthropic(dans, "/api/recommandation", {
    model: MODELE,
    max_tokens: 4000,
    messages: [{ role: "user", content: consigne }],
    ...(inclureExternes !== false
      ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }] }
      : {}),
  });

  const info = extraireJson((d.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"));

  const connus = new Set(livres.map(l => l.id));
  info.parcours = (Array.isArray(info.parcours) ? info.parcours : [])
    .filter(p => connus.has(p.id))
    .sort((a, b) => (a.ordre ?? 99) - (b.ordre ?? 99));
  if (inclureExternes === false) info.suggestions_externes = [];

  await dans((c) => c.query(
    `insert into reading_quests (intention, reponse, modele, tenant_id)
     values ($1, $2, $3, nullif(current_setting('app.tenant_id', true), '')::uuid)`,
    [perimetreValide ? `[${perimetreValide}] ${intention}` : intention, info, MODELE]));

  return info;
}

async function chercherLivre(dans, { requete }) {
  requete = String(requete ?? "").trim().slice(0, 300);
  if (!requete) { const e = new Error("Indiquez un ISBN ou un titre."); e.statut = 400; throw e; }

  // La liste proposee au modele doit inclure les rayons que vous avez
  // acceptes depuis : sinon il rangerait en « Non classé » un ouvrage dont
  // le rayon existe desormais.
  const RAYONS = await dans((c) => rayonsDisponibles(c));

  const consigne = `Trouve les informations bibliographiques du livre correspondant à : "${requete}".
Utilise la recherche web pour vérifier. N'invente aucune donnée : si une information
est introuvable, mets une chaîne vide ou null.

Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises Markdown :
{"titre":"","auteur":"Nom Prénom","editeur":"","annee":2020,"isbn":"","categorie":"","sousCategorie":"","rayonSuggere":"","motif":""}

- "auteur" au format « Nom Prénom » (exemple : « Kahneman Daniel »).
- "isbn" au format ISBN-13 sans tirets.
- "categorie" vaut exactement l'une de : "Académique", "Roman", "BD".
- "sousCategorie" vaut exactement l'une des valeurs autorisées pour cette catégorie :
Académique : ${RAYONS["Académique"].join(" | ")}
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
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
  });

  const info = extraireJson((d.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n"));

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
  const propre = (v, n) => String(v ?? "").replace(/[ -]/g, " ").trim().slice(0, n);
  info.rayonSuggere = propre(info.rayonSuggere, 60);
  info.motif = propre(info.motif, 300);
  // Une suggestion n'a de sens que si le livre est effectivement non classe.
  if (info.sousCategorie !== "Non classé") { info.rayonSuggere = ""; info.motif = ""; }

  if (info.isbn) info.isbn = String(info.isbn).replace(/[^0-9Xx]/g, "");
  return info;
}

/* ---------------------------------------------------------------- Routage */

const serveur = createServer(async (req, rep) => {
  const url = new URL(req.url, "http://interne");
  const chemin = url.pathname;
  const ip = adresseClient(req);

  try {
    if (chemin === "/api/sante") return json(rep, { ok: true });

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
        "Set-Cookie": `session=${jeton}; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION / 1000}`,
      });
    }

    if (chemin === "/api/deconnexion" && req.method === "POST") {
      return json(rep, { ok: true }, 200, { "Set-Cookie": `session=; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=0` });
    }

    /* Une session sans locataire n'en est pas une.
       Les jetons émis avant la bascule n'en portent pas ; ils sont de toute
       façon invalidés par le changement de secret, mais on ne s'appuie pas
       sur cet effet de bord — on refuse explicitement. */
    const brut = verifier(lireCookie(req, "session"));
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

    /* --- Routes ouvertes : ce que le locataire a rendu public --- */
    if (chemin === "/api/session") {
      return json(rep, {
        connecte: !!session, ia_publique: IA_PUBLIQUE, langue,
        environnement: ENVIRONNEMENT,
        // Une recette sans clef ne peut pas produire de résumé. Le dire
        // évite d'attendre une réponse qui ne viendra pas.
        ia_disponible: Boolean(CLE_ANTHROPIC),
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

    if (chemin === "/api/livres" && req.method === "PUT") {
      const corps = await lireCorps(req);
      const livres = Array.isArray(corps) ? corps : [corps];
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
    console.error(chemin, e.message);
    return json(rep, { error: e.message }, e.statut ?? 500);
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
serveur.listen(PORT, () => console.log(`API prête sur le port ${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    serveur.close(() => bd.end().then(() => process.exit(0)));
  });
}
