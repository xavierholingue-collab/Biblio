/* =========================================================================
   LES CATALOGUES — UN SEUL ENDROIT QUI SAIT OÙ L'ON DEMANDE UN LIVRE

   Jusqu'au 18/08/2026, identifier un ouvrage à partir d'un ISBN passait par
   le modèle, avec recherche web. Rien d'autre n'était interrogé : « server.js »
   ne connaissait ni Open Library ni Google Books. Coût mesuré sur dix-huit
   scans réels : 0,075 € par livre, dont les deux tiers en résultats de
   recherche relus par le modèle à chaque tour.

   Ce fichier existe parce qu'une notice de catalogue est GRATUITE, et parce
   qu'elle est MEILLEURE.

   ---------------------------------------------------------------------------
   CE QUE LES ESSAIS DU 18/08 ONT MONTRÉ, ET QUI A INVERSÉ L'ORDRE PRÉVU

   Deux ISBN de la bibliothèque, éprouvés un par un :

     9782072958083   Augereau, « Le vin », Hoëbeke 2021
     9782913838109   « Fondation Hartung-Bergman », Antibes 2022

     Open Library   ne connaît NI l'un NI l'autre. Sa couverture de l'édition
                    française courante est faible. Je la voyais en tête ;
                    c'était faux.
     Google Books   répond 429 sans clef, avec « quota_limit_value: 0 ». La
                    consultation anonyme n'existe plus.
     BnF            trouve LES DEUX, en Dublin Core propre.

   Le second cas mérite d'être retenu : le modèle, avec recherche web, n'avait
   pas su l'identifier — il proposait une édition de 2017 « sans pouvoir
   confirmer ». La BnF répond 2022, avec la pagination. LE CHEMIN GRATUIT N'EST
   PAS UN REPLI DÉGRADÉ : c'est le dépôt légal, donc la notice, quand le modèle
   ne produit qu'une reconstitution.

   D'où l'ordre : BnF, puis Open Library, puis Google Books. Pour une
   bibliothèque française d'abord, la meilleure source passe en premier.

   Affinage possible, non retenu pour l'instant par souci de simplicité :
   n'interroger la BnF en tête que pour les préfixes 978-2 et 979-10 (édition
   de langue française), et commencer par Open Library sinon. Un appel manqué
   coûte quelques dizaines de millisecondes ; la complexité, elle, se paie tous
   les jours.

   ---------------------------------------------------------------------------
   TROIS ISSUES, ET LA TROISIÈME EST LA PLUS IMPORTANTE

   Reprises telles quelles de « vps-couvertures.mjs », où elles avaient déjà
   été pensées :

     trouvee     — la notice existe, on la rend ;
     absente     — la source a répondu « je n'ai pas » ;
     injoignable — le réseau a échoué, ou la source a refusé.

   Confondre « absente » et « injoignable » reviendrait à graver une panne
   passagère dans une décision. Ici la conséquence serait de payer un appel au
   modèle pour un livre que la BnF connaît, simplement parce qu'elle n'a pas
   répondu pendant trois secondes. La cascade rend donc les DEUX : ce qu'elle a
   trouvé, et si quelqu'un s'est tu.

   ---------------------------------------------------------------------------
   CE QUE CE FICHIER NE FAIT PAS : DEVINER L'ORDRE D'UN NOM

   Biblio range les auteurs en « Nom Prénom ». La BnF rend déjà « Augereau,
   Sylvie » — l'ordre est donné. Open Library et Google Books rendent « Sylvie
   Augereau », et retrouver le nom de famille demande un jugement : particules,
   noms composés, auteurs chinois, pseudonymes.

   On ne devine pas. La donnée part telle quelle au modèle, dont l'appel de
   classement — sans recherche web, donc bon marché — remet l'ordre en même
   temps qu'il choisit le rayon. Une heuristique d'inversion serait juste neuf
   fois sur dix, et personne ne verrait jamais la dixième.
   ========================================================================= */

import { XMLParser } from "fast-xml-parser";

/* L'analyse XML n'est pas écrite à la main, et c'est un choix.
 *
 * Le Dublin Core de la BnF est plat : cinq balises à lire. La tentation d'une
 * expression régulière est réelle. Elle bute sur les entités — « &amp; »,
 * « &#233; » — et cette donnée finit dans l'invite du modèle ET dans du HTML.
 * Deux endroits où une erreur d'échappement ne se voit pas et coûte cher.
 *
 * « fast-xml-parser » est la bibliothèque que SupPerf porte déjà : le
 * développeur à venir la connaîtra, et elle entre dans le jeu de conventions
 * repris par ADR-L001 plutôt que d'ouvrir un jeu de plus.
 *
 * « removeNSPrefix » supprime « srw: », « dc: », « oai_dc: » — sans quoi
 * chaque accès porterait un préfixe, et la moindre évolution de l'espace de
 * noms côté BnF casserait la lecture.
 *
 * « htmlEntities » N'EST PAS OPTIONNEL ICI, et l'ironie mérite d'être notée.
 *
 * J'ai écarté l'extraction maison en invoquant les entités : « &amp; »,
 * « &#233; ». Or par défaut la bibliothèque ne les décode pas non plus. Même
 * avec « processEntities », qui est pourtant actif d'origine, la notice de la
 * BnF rendait « Ho&#235;beke » — l'éditeur du premier ouvrage éprouvé. Il faut
 * « htmlEntities: true » pour les références numériques.
 *
 * La leçon n'est pas « la bibliothèque ne sert à rien » : elle décode
 * correctement une fois réglée, et elle traite les cas tordus qu'une
 * expression régulière manquerait. La leçon est que CHOISIR UN OUTIL ÉPROUVÉ
 * NE DISPENSE PAS D'ÉPROUVER SON RÉGLAGE. Seul le contrôle a vu la
 * différence ; à l'œil, « Hoëbeke » et « Ho&#235;beke » se ressemblent assez
 * pour passer une relecture. */
const analyseurXml = new XMLParser({
  ignoreAttributes: true, removeNSPrefix: true,
  processEntities: true, htmlEntities: true,
});

const DELAI = 8_000;

/* Les adresses, surchargeables UNIQUEMENT vers la machine locale.
 *
 * Même raisonnement que ANTHROPIC_URL et COURRIEL_URL : les contrôles ont
 * besoin de catalogues qui répondent sans réseau, mais une destination
 * librement configurable enverrait la clef Google à qui la demande. Toute
 * valeur hors de 127.0.0.1 est ignorée avec un avertissement — jamais refusée
 * en silence, jamais honorée non plus. */
const ADRESSES = {
  bnf: "https://catalogue.bnf.fr/api/SRU",
  openlibrary: "https://openlibrary.org/api/books",
  googlebooks: "https://www.googleapis.com/books/v1/volumes",
};

function adresse(nom) {
  const voulue = process.env.CATALOGUES_URL ?? "";
  if (!voulue) return ADRESSES[nom];
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(voulue)) {
    return voulue.replace(/\/$/, "") + "/" + nom;
  }
  console.warn(`CATALOGUES_URL ignorée : « ${voulue} » n'est pas sur la machine locale.`);
  return ADRESSES[nom];
}

const CLE_GOOGLE = process.env.CLE_GOOGLE_BOOKS ?? "";

/* ------------------------------------------------------------- Outillage */

/** Un ISBN-13 propre, ou null. On ne convertit pas les ISBN-10 : le lecteur
 *  de codes-barres rend de l'EAN-13, et une conversion écrite à la main pour
 *  un cas qui ne se produit pas est du code non éprouvé en production. */
export function isbn13(brut) {
  const chiffres = String(brut ?? "").replace(/[^0-9Xx]/g, "");
  return /^97[89]\d{10}$/.test(chiffres) ? chiffres : null;
}

const texte = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const premier = (v) => (Array.isArray(v) ? v[0] : v);

/** Une année plausible, ou null. « impr. 2021 », « 2021-2022 », « c2021 ». */
function annee(v) {
  const m = texte(v).match(/(1[4-9]\d{2}|20\d{2}|21\d{2})/);
  return m ? Number(m[1]) : null;
}

async function demander(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(DELAI),
                               headers: { "user-agent": "biblio/1.0" } });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.http = r.status; throw e; }
  return r;
}

/* =========================================================================
   LA BnF — SRU, Dublin Core

   Le service est public, sans clef, sans authentification. Il interroge par
   « bib.isbn » et couvre le dépôt légal français.
   ========================================================================= */
async function chezBnf(isbn) {
  const url = `${adresse("bnf")}?version=1.2&operation=searchRetrieve`
            + `&query=${encodeURIComponent(`bib.isbn all "${isbn}"`)}`
            + `&recordSchema=dublincore&maximumRecords=1`;

  const brut = await (await demander(url)).text();
  const doc = analyseurXml.parse(brut);
  const reponse = doc?.searchRetrieveResponse;

  /* Zéro notice n'est PAS une erreur : c'est une réponse, et elle vaut
     « absente ». Confondre les deux ferait payer un appel au modèle chaque
     fois que la BnF dit honnêtement qu'elle ne connaît pas l'ouvrage. */
  if (!reponse || Number(reponse.numberOfRecords ?? 0) === 0) return null;

  const dc = premier(premier(reponse.records?.record)?.recordData?.dc);
  return dc ? { ...noticeBnf(dc), source: "bnf" } : null;
}

/* Le Dublin Core de la BnF, traduit en fiche de lecture. Écrit une fois :
   trois chemins le lisent — par ISBN, par titre pour l'éditeur manquant, et
   la recherche libre — et trois copies de ces nettoyages divergeraient. */
function noticeBnf(dc) {
  /* Le titre BnF porte la mention de responsabilité après « / », selon la
     norme ISBD : « Le vin : … / Sylvie Augereau ; photographies, … ». On la
     retire — elle répète l'auteur et alourdit une fiche de lecture. */
  const titre = texte(premier(dc.title)).split(" / ")[0].trim();

  /* « Augereau, Sylvie. Auteur du texte » — la fonction est un ajout de
     catalogage. La liste des fonctions retirées est CLOSE et explicite :
     un motif large mangerait un nom se terminant par un point. */
  const auteur = texte(premier(dc.creator))
    .replace(/\.\s*(Auteur|Autrice|Éditeur|Editeur|Illustrateur|Illustratrice|Traducteur|Traductrice|Photographe|Directeur|Directrice|Compilateur|Préfacier)[^.]*\.?\s*$/i, "")
    .trim();

  /* « Hoëbeke (Paris) » — la ville est une précision de catalogue. */
  const editeur = texte(premier(dc.publisher)).replace(/\s*\([^)]*\)\s*$/, "").trim();

  /* « 1 vol. (223 p.) : ill. en coul. ; 29 cm » */
  const pagesM = texte(premier(dc.format)).match(/\((\d+)\s*p/);

  /* L'ISBN de LA NOTICE, qui n'est pas forcément celui qu'on a scanné —
     c'est précisément l'information qui permet de dire « cette fiche vient
     d'une autre édition ». */
  const isbnM = []
    .concat(dc.identifier ?? [])
    .map((v) => texte(v).match(/ISBN\s*(97[89]\d{10})/)?.[1])
    .find(Boolean) ?? null;

  return { titre, auteur, editeur, annee: annee(dc.date),
           pages: pagesM ? Number(pagesM[1]) : null, isbnNotice: isbnM };
}

/* =========================================================================
   LA RECHERCHE LIBRE — DEUX MOTS LUS SUR LA COUVERTURE

   Éprouvé le 19/08/2026 sur le cas qui a motivé ce code : un tirage de luxe
   de « Typex's Andy » (Casterman) dont l'ISBN n'est dans aucune base. La
   requête « Typex Andy » — deux mots visibles sur la couverture — rend UNE
   notice, la bonne, complète.

   C'est la leçon de ce cas : pendant qu'on cherche à deviner un livre à
   partir de treize chiffres que personne ne connaît, la personne qui l'a en
   main peut lire son titre. La machine devinait mal ce que l'humain lit
   sans effort.

   GRATUIT ET SANS MODÈLE. La BnF répond en quelques dizaines de
   millisecondes ; l'identification par le modèle coûtait 0,075 € et se
   trompait sur ce livre-là.
   ========================================================================= */
export async function chercherParTexte(brut, maximum = 5) {
  /* Les guillemets délimitent les termes en CQL : un titre qui en contient
     casserait la requête, et la casserait en ressemblant à « aucun
     résultat » plutôt qu'à une erreur. */
  const q = String(brut ?? "").replace(/["\\]/g, " ").trim().slice(0, 150);
  if (q.length < 3) return [];

  const cql = `bib.anywhere all "${q}"`;
  const url = `${adresse("bnf")}?version=1.2&operation=searchRetrieve`
            + `&query=${encodeURIComponent(cql)}`
            + `&recordSchema=dublincore&maximumRecords=${Math.min(10, maximum)}`;

  const doc = analyseurXml.parse(await (await demander(url)).text());
  const reponse = doc?.searchRetrieveResponse;
  if (!reponse || Number(reponse.numberOfRecords ?? 0) === 0) return [];

  const brutes = [].concat(reponse.records?.record ?? []);
  return brutes
    .map((r) => premier(r?.recordData?.dc))
    .filter(Boolean)
    .map(noticeBnf)
    .filter((n) => n.titre);
}

/* =========================================================================
   OPEN LIBRARY — JSON, sans clef
   ========================================================================= */
async function chezOpenLibrary(isbn) {
  const url = `${adresse("openlibrary")}?bibkeys=ISBN:${isbn}&jscmd=data&format=json`;
  const j = await (await demander(url)).json();
  const l = j?.[`ISBN:${isbn}`];
  if (!l) return null;                       // « {} » : la réponse d'un absent

  return {
    titre: texte(l.title),
    auteur: texte(premier(l.authors)?.name),
    editeur: texte(premier(l.publishers)?.name),
    annee: annee(l.publish_date),
    pages: Number.isInteger(l.number_of_pages) ? l.number_of_pages : null,
    source: "openlibrary",
  };
}

/* =========================================================================
   GOOGLE BOOKS — JSON, CLEF OBLIGATOIRE DEPUIS 2026

   Constaté le 18/08/2026 : sans clef, le service rend 429 avec
   « quota_limit_value: 0 ». La consultation anonyme n'existe plus.

   SANS CLEF, LA SOURCE EST DÉCLARÉE INJOIGNABLE, PAS MUETTE. La nuance
   décide de la suite : « absente » clôt la question, « injoignable » laisse
   le doute et autorise le recours au modèle.
   ========================================================================= */
async function chezGoogleBooks(isbn) {
  if (!CLE_GOOGLE) { const e = new Error("CLE_GOOGLE_BOOKS absente"); e.sansClef = true; throw e; }

  const url = `${adresse("googlebooks")}?q=isbn:${isbn}&key=${encodeURIComponent(CLE_GOOGLE)}`;
  const j = await (await demander(url)).json();
  const v = premier(j?.items)?.volumeInfo;
  if (!v) return null;

  return {
    titre: texte(v.title) + (v.subtitle ? ` : ${texte(v.subtitle)}` : ""),
    auteur: texte(premier(v.authors)),
    editeur: texte(v.publisher),
    annee: annee(v.publishedDate),
    pages: Number.isInteger(v.pageCount) ? v.pageCount : null,
    source: "googlebooks",
  };
}

/* =========================================================================
   LA CASCADE

   Rend toujours un objet, jamais une exception : l'appelant doit pouvoir
   décider, pas rattraper.

     { issue: "trouvee",     livre, source }
     { issue: "absente",     muettes: [] }        toutes ont répondu « non »
     { issue: "injoignable", muettes: [...] }     au moins une s'est tue

   POURQUOI « injoignable » N'EST PAS « absente ». Si la BnF ne répond pas et
   qu'Open Library ne connaît pas l'ouvrage, conclure « absent » ferait payer
   un appel au modèle — et, pire, inscrirait une identification approximative
   pour un livre dont la notice existe. Le doute doit remonter.
   ========================================================================= */
const SOURCES = [
  ["bnf", chezBnf],
  ["openlibrary", chezOpenLibrary],
  ["googlebooks", chezGoogleBooks],
];

/* CE QU'UNE NOTICE DOIT PORTER POUR QU'ON CESSE DE CHERCHER.
 *
 * « Trouvé » valait « porte un titre », et c'était le défaut du 18/08 : une
 * notice indigente arrêtait la cascade, et les sources suivantes — qui
 * avaient peut-être l'éditeur — n'étaient jamais interrogées. J'avais
 * construit une hiérarchie de qualité puis écrit un critère d'arrêt qui
 * l'ignore.
 *
 * Les pages n'en font PAS partie : elles manquent presque partout, et les
 * exiger forcerait trois appels à chaque livre pour un champ décoratif. */
const CHAMPS_ATTENDUS = ["titre", "auteur", "editeur", "annee"];

const rempli = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const complete = (l) => CHAMPS_ATTENDUS.every((c) => rempli(l[c]));

/** Comble les trous de « base » avec « autre ». N'écrase JAMAIS un champ
 *  rempli : la première source est la meilleure, les suivantes ne servent
 *  qu'à compléter. Rend true si quelque chose a été comblé. */
function combler(base, autre) {
  let comble = false;
  for (const c of [...CHAMPS_ATTENDUS, "pages"]) {
    if (!rempli(base[c]) && rempli(autre[c])) { base[c] = autre[c]; comble = true; }
  }
  return comble;
}

export async function chercherParIsbn(brut) {
  const isbn = isbn13(brut);
  if (!isbn) return { issue: "absente", muettes: [], detail: "ISBN-13 invalide" };

  const muettes = [];
  const sources = [];
  let livre = null;

  for (const [nom, interroger] of SOURCES) {
    try {
      const trouve = await interroger(isbn);
      if (trouve?.titre) {
        if (!livre) { livre = { ...trouve }; sources.push(nom); }
        else if (combler(livre, trouve)) sources.push(nom);
      }
      // null : la source a répondu, elle ne connaît pas. On continue.
    } catch (e) {
      /* Le détail part au journal, jamais au client : il porte l'adresse
         appelée, et pour Google la clef est dans cette adresse. */
      console.warn(`catalogue ${nom} injoignable — ${e.sansClef ? "clef absente" : e.message}`);
      muettes.push(nom);
    }
    if (livre && complete(livre)) break;   // plus rien ne manque : on s'arrête
  }

  if (livre) {
    /* DERNIER RECOURS POUR L'ÉDITEUR : UNE ÉDITION SŒUR.
     *
     * Un ISBN désigne une ÉDITION, pas une œuvre. Constaté le 18/08 sur
     * « Pourquoi j'ai toujours raison » : la BnF connaît l'édition Flammarion
     * de 2016 (9782081392335) et ignore la réédition de 2025 (9782080494115).
     * Interroger par ISBN seul, c'est ignorer tout ce que la bibliothèque
     * sait de l'ouvrage dès que l'édition change.
     *
     * ON NE REPREND QUE L'ÉDITEUR, et c'est une frontière, pas une prudence
     * excessive. L'éditeur survit à une réédition ; la pagination, l'année et
     * la collection, non. Afficher 415 pages parce qu'une autre édition les
     * avait produirait une fiche FAUSSE — et une fiche fausse est pire qu'une
     * fiche incomplète, parce qu'elle a l'air juste et que personne ne la
     * vérifie.
     *
     * La fiche porte « editeur_autre_edition » pour que ce soit lisible dans
     * six mois : ce qui est déduit doit se distinguer de ce qui est mesuré. */
    if (!rempli(livre.editeur) && rempli(livre.titre) && rempli(livre.auteur)) {
      try {
        const voisine = await chezBnfParTitre(livre.titre, livre.auteur);
        if (voisine?.editeur) {
          livre.editeur = voisine.editeur;
          livre.editeur_autre_edition = true;
          sources.push("bnf:autre-edition");
        }
      } catch (e) {
        console.warn("repli BnF par titre indisponible —", e.message);
      }
    }
    return { issue: "trouvee", livre: { ...livre, isbn },
             source: sources.join("+"), sources };
  }

  return { issue: muettes.length ? "injoignable" : "absente", muettes };
}

/* =========================================================================
   LA BnF PAR TITRE ET AUTEUR

   Appelée seulement quand l'ISBN n'a rien donné et qu'il manque l'éditeur.
   Rend UNIQUEMENT ce qui traverse les rééditions.

   LE TITRE EST NETTOYÉ DE SES GUILLEMETS AVANT D'ENTRER DANS LA REQUÊTE.
   La syntaxe CQL délimite les termes par des guillemets doubles : un titre
   qui en contient casserait la requête, et la casserait d'une manière qui
   ressemble à « aucun résultat » plutôt qu'à une erreur. On les retire, on
   ne les échappe pas — un guillemet dans un titre n'aide pas à le retrouver.
   ========================================================================= */
async function chezBnfParTitre(titre, auteur) {
  const propre = (s) => String(s ?? "").replace(/["\\]/g, " ").trim().slice(0, 120);
  const t = propre(titre), a = propre(auteur);
  if (t.length < 4) return null;

  const cql = `bib.title all "${t}" and bib.author all "${a}"`;
  const url = `${adresse("bnf")}?version=1.2&operation=searchRetrieve`
            + `&query=${encodeURIComponent(cql)}`
            + `&recordSchema=dublincore&maximumRecords=1`;

  const doc = analyseurXml.parse(await (await demander(url)).text());
  const reponse = doc?.searchRetrieveResponse;
  if (!reponse || Number(reponse.numberOfRecords ?? 0) === 0) return null;

  const dc = premier(premier(reponse.records?.record)?.recordData?.dc);
  if (!dc) return null;

  /* On lit la notice entière puis on n'en garde QUE l'éditeur. Le reste est
     jeté délibérément : pagination et année appartiennent à l'édition
     trouvée, pas à celle qu'on tient. Jeter ici plutôt que de ne pas lire,
     pour que le jour où l'on voudra un autre champ stable, la question se
     pose à cet endroit et pas ailleurs. */
  const { editeur } = noticeBnf(dc);
  return editeur ? { editeur } : null;
}

/* =========================================================================
   LA COUVERTURE DE SECOURS

   Le navigateur cherche d'abord chez Open Library, par une URL d'image
   DÉTERMINISTE — pas d'appel d'API, pas de clef, rien à rapatrier. Ce
   chemin-là marche et reste où il est.

   Le secours, lui, était cassé : la page appelait Google Books SANS CLEF, et
   depuis 2026 cela rend 429. La recherche de couverture de secours échouait
   donc en production, silencieusement, pour tout le monde. Personne ne s'en
   plaint jamais — une couverture manquante ressemble à une couverture
   absente, et l'application dessine la sienne.

   La clef ne peut pas descendre dans le navigateur : elle y serait publique.
   C'est donc l'API qui demande, et elle seule.

   ON NE REND QUE L'ADRESSE, pas l'image. Relayer les octets ferait du serveur
   un proxy d'images — bande passante, cache à gérer, et une porte pour faire
   télécharger n'importe quoi par notre adresse IP. Le navigateur charge
   l'image lui-même, comme il le fait déjà pour Open Library.
   ========================================================================= */
export async function couvertureDeSecours(brut) {
  const isbn = isbn13(brut);
  if (!isbn || !CLE_GOOGLE) return null;

  try {
    const url = `${adresse("googlebooks")}?q=isbn:${isbn}&key=${encodeURIComponent(CLE_GOOGLE)}`;
    const j = await (await demander(url)).json();
    const img = premier(j?.items)?.volumeInfo?.imageLinks;
    const u = img?.thumbnail || img?.smallThumbnail;
    /* « http: » en dur chez Google sur de vieilles notices : la page est
       servie en HTTPS, une image en clair y serait bloquée. */
    return u ? String(u).replace(/^http:/, "https:") : null;
  } catch (e) {
    console.warn("couverture de secours indisponible —", e.message);
    return null;
  }
}

/** L'état des catalogues au démarrage, pour le dire une fois plutôt qu'à
 *  chaque scan. Google sans clef n'empêche pas de démarrer — la BnF suffit
 *  au corpus français — mais il faut que ce soit écrit quelque part. */
export function etatCatalogues() {
  return {
    bnf: "public, sans clef",
    openlibrary: "public, sans clef",
    googlebooks: CLE_GOOGLE ? "clef présente" : "CLE_GOOGLE_BOOKS absente — source ignorée",
  };
}
