/* =========================================================================
   API de la bibliothèque.
   Serveur HTTP sans framework, une seule dépendance : le client Postgres.
   Tout ce qui touche à la clé Anthropic reste ici, côté serveur.
   ========================================================================= */

import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 3000);
const MOT_DE_PASSE = process.env.MOT_DE_PASSE ?? "";
const CLE_ANTHROPIC = process.env.ANTHROPIC_API_KEY ?? "";
const MODELE = process.env.MODELE ?? "claude-sonnet-5";
const FICHIER_AMORCE = process.env.FICHIER_AMORCE ?? "/seed/bibliotheque.json";
// Faux par défaut : un visiteur anonyme ne doit pas pouvoir dépenser vos crédits.
const IA_PUBLIQUE = process.env.IA_PUBLIQUE === "true";
const DUREE_SESSION = 30 * 24 * 3600 * 1000; // 30 jours

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
const COOKIE_SECURE = DERRIERE_PROXY ? " Secure;" : "";

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

// Secret de signature des sessions, régénéré à chaque démarrage :
// redémarrer le conteneur déconnecte, ce qui est le comportement souhaité.
const SECRET = randomBytes(32);

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
async function rayonsDisponibles() {
  const listes = {};
  for (const c of Object.keys(SOUS_CATEGORIES)) listes[c] = [...SOUS_CATEGORIES[c]];
  try {
    const { rows } = await bd.query(
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

async function ajouterRayon({ categorie, libelle }) {
  const l = String(libelle ?? "").replace(/\s+/g, " ").trim();
  if (!SOUS_CATEGORIES[categorie]) { const e = new Error("Catégorie inconnue."); e.statut = 400; throw e; }
  if (l.length < 2 || l.length > 60) { const e = new Error("Le nom du rayon doit faire 2 à 60 caractères."); e.statut = 400; throw e; }
  if (l === "Non classé") { const e = new Error("« Non classé » existe déjà."); e.statut = 400; throw e; }

  await bd.query(
    "insert into rayons_ajoutes (categorie, libelle) values ($1, $2) on conflict do nothing",
    [categorie, l]);
  return { categorie, libelle: l, rayons: await rayonsDisponibles() };
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

const COLONNES = `id, isbn, titre, auteur, editeur, annee, statut, note, categorie,
  sous_categorie, sphere, cover_url, cover_statut, resume, resume_points,
  resume_themes, resume_modele, resume_fiabilite, resume_genere_le`;

// Un visiteur sans session ne voit que le périmètre professionnel.
async function listerLivres(session) {
  if (session) {
    const { rows } = await bd.query(`select ${COLONNES} from books order by auteur, titre`);
    return rows;
  }
  const { rows } = await bd.query(
    `select ${COLONNES} from books where sphere = 'Pro' order by auteur, titre`);
  return rows;
}

// Statistiques de la page d'accueil, calculées sur le périmètre visible.
async function statistiques(session) {
  const ou = session ? "" : "where sphere = 'Pro'";
  const et = session ? "where" : "and";

  const [general, sousCats, decennies, auteurs, recents] = await Promise.all([
    bd.query(`select
        count(*)::int                                          as total,
        count(*) filter (where statut = 'Lu')::int              as lus,
        count(*) filter (where statut = 'En cours')::int        as en_cours,
        count(*) filter (where statut = 'A lire')::int          as a_lire,
        count(resume)::int                                     as avec_resume,
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
      from books ${ou}`),
    bd.query(`select sous_categorie, categorie, count(*)::int as n,
                     count(*) filter (where statut = 'Lu')::int as lus,
                     coalesce(sum(pages), 0)::bigint as pages_volume,
                     count(pages)::int as pages_connues
              from books ${ou}
              group by sous_categorie, categorie
              order by n desc`),
    bd.query(`select (annee / 10 * 10)::int as decennie, count(*)::int as n
              from books ${ou} ${et} annee is not null
              group by 1 order by 1`),
    bd.query(`select auteur, count(*)::int as n
              from books ${ou}
              group by auteur having count(*) > 1
              order by n desc, auteur limit 10`),
    bd.query(`select id, titre, auteur, annee, sous_categorie
              from books ${ou} ${et} annee is not null
              order by annee desc, titre limit 8`),
  ]);

  return {
    perimetre: session ? "complet" : "professionnel",
    ...general.rows[0],
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
async function enregistrerLivres(livres) {
  if (!livres.length) return 0;
  const champs = ["id", "isbn", "titre", "auteur", "editeur", "annee", "statut", "note",
    "categorie", "sous_categorie", "sphere", "cover_url", "cover_statut", "resume",
    "resume_points", "resume_themes", "resume_modele", "resume_fiabilite", "resume_genere_le"];

  const valeurs = [];
  const lignes = livres.map((l, i) => {
    const base = i * champs.length;
    valeurs.push(
      l.id, l.isbn || null, l.titre, l.auteur, l.editeur || null,
      l.annee ?? null, l.statut ?? "A lire", l.note ?? null,
      l.categorie, l.sous_categorie ?? l.sousCategorie,
      l.sphere ?? (l.categorie === "Académique" ? "Pro" : "Perso"),
      l.cover_url ?? l.coverUrl ?? null,
      l.cover_statut ?? l.coverStatut ?? "inconnu",
      l.resume ?? null,
      l.resume_points ?? l.resumePoints ?? null,
      l.resume_themes ?? l.resumeThemes ?? null,
      l.resume_modele ?? l.resumeModele ?? null,
      l.resume_fiabilite ?? l.resumeFiabilite ?? null,
      l.resume_genere_le ?? l.resumeGenereLe ?? null,
    );
    return "(" + champs.map((_, j) => `$${base + j + 1}`).join(",") + ")";
  });

  const misAJour = champs.slice(1).map(c => `${c} = excluded.${c}`).join(", ");
  await bd.query(
    `insert into books (${champs.join(",")}) values ${lignes.join(",")}
     on conflict (id) do update set ${misAJour}`,
    valeurs,
  );
  return livres.length;
}

// Amorçage au premier démarrage, depuis l'export JSON de l'ancienne application.
async function amorcerSiVide() {
  const { rows } = await bd.query("select count(*)::int as n from books");
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
    await enregistrerLivres(contenu.slice(i, i + lot));
  }
  console.log(`Amorçage : ${contenu.length} ouvrages importés.`);
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

async function appelerAnthropic(corps) {
  if (!CLE_ANTHROPIC) {
    const e = new Error("ANTHROPIC_API_KEY absente du fichier .env");
    e.statut = 503;
    throw e;
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
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

async function resumerLivre({ bookId, forcer }) {
  const { rows } = await bd.query(`select ${COLONNES} from books where id = $1`, [bookId]);
  const l = rows[0];
  if (!l) { const e = new Error("Ouvrage introuvable"); e.statut = 404; throw e; }

  if (l.resume && !forcer) {
    return { resume: l.resume, points: l.resume_points ?? [], themes: l.resume_themes ?? [], cache: true };
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

  const d = await appelerAnthropic({
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

  await bd.query(
    `update books set resume = $2, resume_points = $3, resume_themes = $4,
       resume_modele = $5, resume_fiabilite = $6, resume_genere_le = now()
     where id = $1`,
    [bookId, info.resume ?? null,
     Array.isArray(info.points) ? info.points : null,
     Array.isArray(info.themes) ? info.themes.map(t => String(t).toLowerCase()) : null,
     MODELE, info.fiabilite ?? null],
  );

  return { resume: info.resume ?? "", points: info.points ?? [], themes: info.themes ?? [],
           fiabilite: info.fiabilite ?? null, cache: false };
}

async function recommander({ intention, sphere, inclureExternes }) {
  intention = String(intention ?? "").trim().slice(0, 600);
  if (intention.length < 3) { const e = new Error("Décrivez ce que vous voulez apprendre."); e.statut = 400; throw e; }

  const perimetreValide = sphere === "Perso" || sphere === "Pro" ? sphere : null;
  const { rows: livres } = perimetreValide
    ? await bd.query(`select ${COLONNES} from books where sphere = $1 order by auteur`, [perimetreValide])
    : await bd.query(`select ${COLONNES} from books order by auteur`);

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

  const d = await appelerAnthropic({
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

  await bd.query(
    "insert into reading_quests (intention, reponse, modele) values ($1, $2, $3)",
    [perimetreValide ? `[${perimetreValide}] ${intention}` : intention, info, MODELE],
  );

  return info;
}

async function chercherLivre({ requete }) {
  requete = String(requete ?? "").trim().slice(0, 300);
  if (!requete) { const e = new Error("Indiquez un ISBN ou un titre."); e.statut = 400; throw e; }

  // La liste proposee au modele doit inclure les rayons que vous avez
  // acceptes depuis : sinon il rangerait en « Non classé » un ouvrage dont
  // le rayon existe desormais.
  const RAYONS = await rayonsDisponibles();

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

  const d = await appelerAnthropic({
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
      const jeton = signer({ expire: Date.now() + DUREE_SESSION });
      return json(rep, { ok: true }, 200, {
        "Set-Cookie": `session=${jeton}; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION / 1000}`,
      });
    }

    if (chemin === "/api/deconnexion" && req.method === "POST") {
      return json(rep, { ok: true }, 200, { "Set-Cookie": `session=; HttpOnly;${COOKIE_SECURE} SameSite=Strict; Path=/; Max-Age=0` });
    }

    const session = verifier(lireCookie(req, "session"));

    /* --- Routes ouvertes : consultation du périmètre professionnel --- */
    if (chemin === "/api/session") {
      return json(rep, { connecte: !!session, ia_publique: IA_PUBLIQUE });
    }

    if (chemin === "/api/livres" && req.method === "GET") {
      return json(rep, await listerLivres(session));
    }

    if (chemin === "/api/statistiques" && req.method === "GET") {
      return json(rep, await statistiques(session));
    }

    // Lecture ouverte : la liste des rayons n'est pas une donnee sensible,
    // et la page publique en a besoin pour nommer ce qu'elle affiche.
    if (chemin === "/api/rayons" && req.method === "GET") {
      return json(rep, await rayonsDisponibles());
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
      return json(rep, { enregistres: await enregistrerLivres(livres) });
    }

    // Mise à jour partielle : uniquement les couvertures résolues par le navigateur.
    if (chemin === "/api/couvertures" && req.method === "POST") {
      const lot = await lireCorps(req);
      if (!Array.isArray(lot)) return json(rep, { error: "Tableau attendu" }, 400);
      for (const c of lot.slice(0, 500)) {
        await bd.query(
          "update books set cover_url = $2, cover_statut = $3 where id = $1",
          [c.id, c.cover_url ?? null, c.cover_statut ?? "inconnu"],
        );
      }
      return json(rep, { enregistrees: Math.min(lot.length, 500) });
    }

    if (chemin.startsWith("/api/livres/") && req.method === "DELETE") {
      const id = decodeURIComponent(chemin.slice("/api/livres/".length));
      await bd.query("delete from books where id = $1", [id]);
      return json(rep, { ok: true });
    }

    if (chemin === "/api/resume" && req.method === "POST") {
      return json(rep, await resumerLivre(await lireCorps(req)));
    }

    if (chemin === "/api/recommandation" && req.method === "POST") {
      return json(rep, await recommander(await lireCorps(req)));
    }

    if (chemin === "/api/rayons" && req.method === "POST") {
      return json(rep, await ajouterRayon(await lireCorps(req)));
    }

    if (chemin === "/api/recherche-livre" && req.method === "POST") {
      return json(rep, await chercherLivre(await lireCorps(req)));
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
await amorcerSiVide();
serveur.listen(PORT, () => console.log(`API prête sur le port ${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    serveur.close(() => bd.end().then(() => process.exit(0)));
  });
}
