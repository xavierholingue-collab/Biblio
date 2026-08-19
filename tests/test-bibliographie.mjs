/* =========================================================================
   LES CATALOGUES RÉPONDENT-ILS AVANT LE MODÈLE ? — cascade, coût, et doute

   Le 18/08/2026, identifier un ouvrage coûtait 0,075 €, mesurés sur dix-huit
   scans réels. Deux tiers de cette somme étaient des résultats de recherche
   web relus par le modèle à chaque tour. Et sur les deux ISBN qui avaient
   résisté ce soir-là, la BnF a répondu juste là où le modèle proposait une
   édition erronée « sans pouvoir confirmer ».

   Ce contrôle éprouve la conséquence : le catalogue d'abord, le modèle pour
   le seul rayon, et la recherche web en dernier recours.

   ---------------------------------------------------------------------------
   CE QU'IL CHERCHE, ET POURQUOI CHACUN PEUT COÛTER QUELQUE CHOSE

   1. LA CASCADE S'ARRÊTE-T-ELLE ? Si elle interroge Open Library après que la
      BnF a répondu, on paie trois appels réseau pour un résultat.

   2. LE MODÈLE REÇOIT-IL LA RECHERCHE WEB QUAND IL NE DOIT PAS ? C'est là
      qu'est l'argent. Un « tools » oublié annulerait tout le gain sans rien
      casser de visible.

   3. LES DONNÉES DU CATALOGUE SURVIVENT-ELLES AU MODÈLE ? Elles ne lui sont
      pas soumises ; il ne doit pas pouvoir les remplacer.

   4. UN NOM INVENTÉ EST-IL REFUSÉ ? On demande une permutation. Un nom
      fabriqué serait indétectable à l'œil sur une fiche qu'on ne relit pas.

   5. « ABSENTE » ET « INJOIGNABLE » SONT-ELLES DISTINGUÉES ? Confondre les
      deux ferait payer le modèle pour un livre que la BnF connaît, au premier
      hoquet réseau.

   6. LES DEUX ROUTES SONT-ELLES SÉPARÉES AU JOURNAL ? Sans cela on ne peut
      pas prouver le gain, et une optimisation qu'on ne mesure pas est une
      opinion.

   USAGE
     node tests/test-bibliographie.mjs
     PGURL=... PGURL_OEIL=... node tests/test-bibliographie.mjs           (CI)
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
const PORT = 3467, MODELE_PORT = 3468, CATA_PORT = 3469;
const BASE = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55497 });
const { q, locataire } = banc;
const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
/* BOB EST PUBLIC, ET C'EST LE POINT.
 *
 * Une première version le créait privé. La RLS cachait alors ses possessions
 * à Xavier, et le contrôle « le livre d'un autre n'est pas un doublon »
 * passait au vert SANS RIEN PROUVER : retirer le filtre de locataire dans la
 * requête ne le faisait pas tomber. Vu en mutant.
 *
 * Public, sa possession devient lisible par tout le monde — c'est ce qui fait
 * vivre les pages publiques. Sans filtre explicite, Xavier scannant un livre
 * que Bob possède s'entendrait donc dire « vous l'avez déjà », avec un
 * identifiant qu'il ne peut pas ouvrir. */
const bob = await locataire("bob-biblio", "publique", "fr", 50);
await q("update tenants set quota_ia_mois = 200 where id = $1", [xavier.id]);

/* ------------------------------------------------------- Les faux catalogues

   La vraie réponse de la BnF au 18/08/2026 pour 9782072958083, recopiée telle
   quelle. Un gabarit inventé prouverait que le code sait lire ce que j'ai
   imaginé — pas ce que la BnF envoie. Les espaces de noms, la mention de
   responsabilité après « / » et la fonction « Auteur du texte » sont
   exactement ceux du service. */
const REPONSE_BNF = (isbn) => `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
<srw:version>1.2</srw:version>
<srw:numberOfRecords>1</srw:numberOfRecords>
<srw:records><srw:record><srw:recordData>
<oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Le vin : par ceux qui le font pour ceux qui le boivent / Sylvie Augereau ; photographies, Louis-Laurent Grandadam</dc:title>
<dc:creator>Augereau, Sylvie. Auteur du texte</dc:creator>
<dc:publisher>Ho&#235;beke (Paris)</dc:publisher>
<dc:date>2021</dc:date>
<dc:identifier>ISBN ${isbn}</dc:identifier>
<dc:format>1 vol. (223 p.) : ill. en coul. ; 29 cm</dc:format>
</oai_dc:dc>
</srw:recordData></srw:record></srw:records>
</srw:searchRetrieveResponse>`;

const BNF_VIDE = `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
<srw:version>1.2</srw:version><srw:numberOfRecords>0</srw:numberOfRecords>
</srw:searchRetrieveResponse>`;

/* Chaque contrôle décide de ce que chaque source répond. « muet » ferme la
   connexion sans répondre : c'est ainsi qu'on éprouve « injoignable ». */
let plan = { bnf: "trouve", openlibrary: "absent", googlebooks: "absent" };
const appelsCatalogue = [];

const catalogues = createServer(async (req, rep) => {
  const nom = new URL(req.url, "http://x").pathname.replace(/^\//, "").split("?")[0];
  /* La recherche par TITRE est enregistrée sous un autre nom que la recherche
     par ISBN. Sans cette distinction, « aucun repli par titre n'a eu lieu »
     serait une assertion qui ne peut pas échouer : les deux appels portent le
     même chemin. Vu en relisant, pas en mutant. */
  appelsCatalogue.push(nom === "bnf" && /bib\.title/.test(req.url) ? "bnf-titre" : nom);
  const cas = plan[nom] ?? "absent";

  if (cas === "muet") { req.socket.destroy(); return; }
  if (cas === "erreur") { rep.writeHead(500); return rep.end("non"); }

  if (nom === "bnf") {
    rep.writeHead(200, { "content-type": "application/xml" });
    /* La recherche par TITRE est un second appel à la même source. On la
       reconnaît à sa requête, pas à son chemin — c'est ainsi que le code
       réel la distingue aussi. */
    const parTitre = /bib\.title/.test(req.url);
    if (parTitre) return rep.end(plan.bnfTitre === "trouve" ? REPONSE_BNF("x") : BNF_VIDE);
    return rep.end(cas === "trouve" ? REPONSE_BNF("9782072958083") : BNF_VIDE);
  }
  if (nom === "openlibrary") {
    /* LA CLEF EST CELLE QU'ON A DEMANDÉE, pas une constante.
     *
     * Le gabarit répondait toujours « ISBN:9782072958083 ». Le code réel lit
     * « j[`ISBN:${isbn}`] » : dès qu'un contrôle utilisait un autre ISBN,
     * Open Library passait pour ne rien connaître, et la cascade s'arrêtait
     * avant elle. Un faux serveur trop simple invente une réalité où le code
     * ne peut pas échouer — ou, ici, où il échoue pour la mauvaise raison. */
    const demande = new URL(req.url, "http://x").searchParams.get("bibkeys") ?? "";
    rep.writeHead(200, { "content-type": "application/json" });
    return rep.end(JSON.stringify(cas === "trouve"
      ? { [demande]: { title: "Titre Open Library",
            authors: [{ name: "Sylvie Augereau" }], publishers: [{ name: "OL" }],
            publish_date: "2021", number_of_pages: 223 } }
      : {}));
  }
  rep.writeHead(200, { "content-type": "application/json" });
  if (cas === "couverture") {
    /* « http: » en dur : de vieilles notices Google le rendent encore, et la
       page étant servie en HTTPS l'image serait bloquée. On vérifie que la
       réécriture a lieu côté serveur. */
    return rep.end(JSON.stringify({ items: [{ volumeInfo: {
      title: "T", imageLinks: { thumbnail: "http://exemple.test/couv.jpg" } } }] }));
  }
  rep.end(JSON.stringify(cas === "trouve"
    ? { items: [{ volumeInfo: { title: "Titre Google", authors: ["Sylvie Augereau"],
                                publisher: "GB", publishedDate: "2021", pageCount: 223 } }] }
    : { totalItems: 0 }));
});
await new Promise(r => catalogues.listen(CATA_PORT, "127.0.0.1", r));

/* ---------------------------------------------------------- Le faux modèle */
const recus = [];
let reponseModele = null;

const faussaire = createServer(async (req, rep) => {
  let brut = "";
  for await (const m of req) brut += m;
  let j = null;
  try { j = JSON.parse(brut); } catch { /* corps illisible */ }
  recus.push({ texte: j?.messages?.[0]?.content ?? "",
               outils: (j?.tools ?? []).map(t => t.name ?? t.type),
               /* Le TYPE et pas seulement le nom : les deux versions de
                  l'outil s'appellent « web_search », et c'est le type qui
                  décide du filtrage dynamique — donc du coût. */
               types: (j?.tools ?? []).map(t => t.type) });

  const charge = reponseModele ?? { auteur: "Augereau Sylvie", categorie: "Académique",
                                    sousCategorie: "Philosophie", rayonSuggere: "", motif: "" };
  rep.writeHead(200, { "content-type": "application/json" });
  rep.end(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(charge) }],
    usage: { input_tokens: 900, output_tokens: 120,
             server_tool_use: { web_search_requests: 0 } },
  }));
});
await new Promise(r => faussaire.listen(MODELE_PORT, "127.0.0.1", r));

/* ------------------------------------------------------------ Lancer l'API */
const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT), MOT_DE_PASSE: "mot-de-passe-de-controle", SECRET_SESSION: SECRET,
    MODELE: "claude-sonnet-5",
    ANTHROPIC_API_KEY: "clef-de-controle-sans-valeur",
    ANTHROPIC_URL: `http://127.0.0.1:${MODELE_PORT}/v1/messages`,
    CATALOGUES_URL: `http://127.0.0.1:${CATA_PORT}/`,
    CLE_GOOGLE_BOOKS: "clef-google-de-controle",
    /* Une valeur DIFFÉRENTE du défaut : c'est la seule façon de prouver que
       la couture est branchée. Régler la variable sur ce que le code met déjà
       en dur ne vérifierait rien. */
    OUTIL_RECHERCHE: "web_search_20250305",
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
  await new Promise(r => catalogues.close(r));
  await banc.fermer();
};
if (!debout) { console.error("  ECHEC l API n a pas démarré\n" + journal); await fermer(); process.exit(1); }

const session = `session=${(() => {
  const c = Buffer.from(JSON.stringify({ t: xavier.id, expire: Date.now() + 3600_000 }))
    .toString("base64url");
  return c + "." + createHmac("sha256", SECRET).update(c).digest("base64url");
})()}`;

const chercher = (requete) => fetch(`${BASE}/api/recherche-livre`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: session },
  body: JSON.stringify({ requete }),
}).then(async r => ({ statut: r.status, corps: await r.json().catch(() => null) }));

const ISBN = "9782072958083";

/* =====================================================================
   1. LA BnF RÉPOND : LA CASCADE S'ARRÊTE
   ===================================================================== */

appelsCatalogue.length = 0; recus.length = 0;
const r1 = await chercher(ISBN);

verifier("la recherche aboutit", r1.statut === 200, JSON.stringify(r1.corps));
verifier("la BnF est interrogée la première",
  appelsCatalogue[0] === "bnf", JSON.stringify(appelsCatalogue));
verifier("… et les autres catalogues ne sont PAS interrogés",
  appelsCatalogue.length === 1, JSON.stringify(appelsCatalogue));

/* =====================================================================
   2. LE MODÈLE N'A PAS DE RECHERCHE WEB — c'est là qu'est l'argent
   ===================================================================== */

verifier("un seul appel au modèle", recus.length === 1, String(recus.length));
verifier("l'appel de classement ne porte AUCUN outil",
  (recus[0]?.outils ?? []).length === 0, JSON.stringify(recus[0]?.outils));
verifier("… et son invite ne demande pas de chercher",
  !/recherche web/i.test(recus[0]?.texte ?? ""));
verifier("l'invite de classement porte les données du catalogue",
  /Augereau, Sylvie/.test(recus[0]?.texte ?? "") && /Hoëbeke/.test(recus[0]?.texte ?? ""),
  (recus[0]?.texte ?? "").slice(0, 200));

/* =====================================================================
   3. LES DONNÉES DU CATALOGUE FONT FOI

   Le XML porte une mention de responsabilité après « / », une fonction de
   catalogage après le nom, une ville après l'éditeur et une entité « &#235; ».
   Les quatre doivent être traitées.
   ===================================================================== */

verifier("le titre est nettoyé de la mention de responsabilité",
  r1.corps?.titre === "Le vin : par ceux qui le font pour ceux qui le boivent",
  r1.corps?.titre);
verifier("l'entité XML est décodée (Hoëbeke, pas Ho&#235;beke)",
  r1.corps?.editeur === "Hoëbeke", r1.corps?.editeur);
verifier("l'année vient du catalogue", r1.corps?.annee === 2021, String(r1.corps?.annee));
verifier("l'ISBN est celui demandé", r1.corps?.isbn === ISBN, r1.corps?.isbn);
verifier("le rayon vient du modèle",
  r1.corps?.sousCategorie === "Philosophie", r1.corps?.sousCategorie);
verifier("la source est tracée", r1.corps?.source === "bnf", String(r1.corps?.source));
verifier("la fiche dit qu'elle vient d'un catalogue",
  r1.corps?.identification === "catalogue", String(r1.corps?.identification));

/* =====================================================================
   4. LE MODÈLE PEUT RÉORDONNER UN NOM, PAS L'INVENTER
   ===================================================================== */

reponseModele = { auteur: "Augereau Sylvie", categorie: "Académique",
                  sousCategorie: "Philosophie", rayonSuggere: "", motif: "" };
const rOrdre = await chercher(ISBN);
verifier("une permutation légitime du nom est acceptée",
  rOrdre.corps?.auteur === "Augereau Sylvie", rOrdre.corps?.auteur);

reponseModele = { auteur: "Kahneman Daniel", categorie: "Académique",
                  sousCategorie: "Philosophie", rayonSuggere: "", motif: "" };
const rInvente = await chercher(ISBN);
verifier("un nom INVENTÉ est refusé, et celui du catalogue conservé",
  rInvente.corps?.auteur === "Augereau, Sylvie", rInvente.corps?.auteur);

reponseModele = null;

/* =====================================================================
   5. « ABSENTE » ET « INJOIGNABLE » NE SE CONFONDENT PAS
   ===================================================================== */

/* Toutes muettes : on ne SAIT PAS si le livre existe. Le modèle doit être
   appelé AVEC recherche, et le doute ne doit pas se transformer en « absent ». */
plan = { bnf: "muet", openlibrary: "muet", googlebooks: "muet" };
appelsCatalogue.length = 0; recus.length = 0;
reponseModele = { titre: "Trouvé par le modèle", auteur: "Auteur X", editeur: "E",
                  annee: 2020, isbn: ISBN, categorie: "Académique",
                  sousCategorie: "Philosophie", rayonSuggere: "", motif: "" };

const rMuet = await chercher(ISBN);
verifier("les trois sources sont tentées quand chacune se tait",
  appelsCatalogue.length === 3, JSON.stringify(appelsCatalogue));
verifier("… et le modèle prend le relais AVEC recherche web",
  (recus[0]?.outils ?? []).includes("web_search"), JSON.stringify(recus[0]?.outils));
verifier("… en rendant tout de même une fiche",
  rMuet.corps?.titre === "Trouvé par le modèle", rMuet.corps?.titre);

/* LA DISTINCTION DOIT AVOIR UNE CONSÉQUENCE OBSERVABLE.
 *
 * Écrite le 18/08, elle n'en avait aucune : la mutation qui confondait
 * « absente » et « injoignable » ne faisait tomber aucun contrôle, parce que
 * les deux cas menaient au même appel. Une distinction sans effet est un
 * commentaire. Ces deux lignes sont ce qui la rend réelle. */
verifier("des catalogues MUETS sont signalés comme tels dans la fiche",
  rMuet.corps?.identification === "modele-catalogues-muets",
  String(rMuet.corps?.identification));

/* Toutes répondent « je ne connais pas » : même issue applicative — le modèle
   cherche — mais pour une raison différente, et le journal doit le dire. */
plan = { bnf: "absent", openlibrary: "absent", googlebooks: "absent" };
appelsCatalogue.length = 0; recus.length = 0;
const rAbsent = await chercher(ISBN);
verifier("un ISBN qu'aucun catalogue ne connaît part au modèle avec recherche",
  (recus[0]?.outils ?? []).includes("web_search") && rAbsent.statut === 200);
verifier("… et la fiche dit « sans notice », pas « muets »",
  rAbsent.corps?.identification === "modele-catalogues-sans-notice",
  String(rAbsent.corps?.identification));

/* Une source en panne ne doit pas empêcher les suivantes de répondre. */
plan = { bnf: "erreur", openlibrary: "trouve", googlebooks: "absent" };
appelsCatalogue.length = 0; recus.length = 0;
reponseModele = null;
const rRepli = await chercher(ISBN);
verifier("la BnF en panne, Open Library prend le relais",
  rRepli.corps?.titre === "Titre Open Library", rRepli.corps?.titre);
verifier("… sans que Google Books soit interrogé",
  !appelsCatalogue.includes("googlebooks"), JSON.stringify(appelsCatalogue));
verifier("… et le modèle reste sans recherche web",
  (recus[0]?.outils ?? []).length === 0, JSON.stringify(recus[0]?.outils));

/* Un nom au format « Prénom Nom » : Open Library ne donne pas l'ordre, et le
   modèle est autorisé à le permuter puisque les mots correspondent. */
verifier("un nom Open Library reste permutable par le modèle",
  rRepli.corps?.auteur === "Augereau Sylvie", rRepli.corps?.auteur);

/* =====================================================================
   6. UNE DEMANDE QUI N'EST PAS UN ISBN NE PASSE PAS PAR LES CATALOGUES
   ===================================================================== */

plan = { bnf: "trouve", openlibrary: "absent", googlebooks: "absent" };
appelsCatalogue.length = 0; recus.length = 0;
reponseModele = { titre: "Par le titre", auteur: "A", editeur: "E", annee: 2020,
                  isbn: "", categorie: "Académique", sousCategorie: "Philosophie",
                  rayonSuggere: "", motif: "" };
const rTitre = await chercher("Système 1 système 2");
verifier("une recherche par titre n'interroge aucun catalogue",
  appelsCatalogue.length === 0, JSON.stringify(appelsCatalogue));
verifier("… et garde la recherche web",
  (recus[0]?.outils ?? []).includes("web_search"), JSON.stringify(recus[0]?.outils));
verifier("… et rend une fiche", rTitre.corps?.titre === "Par le titre", rTitre.corps?.titre);

/* LA VERSION DE L'OUTIL EST CELLE QUE L'ENVIRONNEMENT DIT.
 *
 * Les deux versions s'appellent « web_search » : seul le TYPE distingue celle
 * qui filtre les résultats avant le contexte de celle qui les y déverse. Un
 * contrôle qui ne regarde que le nom ne verrait pas la différence — et c'est
 * pourtant elle qui décide de 95 % du coût d'un livre.
 *
 * On règle la variable sur l'ANCIENNE version, différente du défaut : si la
 * couture n'était pas branchée, le serveur enverrait la nouvelle et ce
 * contrôle tomberait. */
verifier("la version de l'outil de recherche vient de l'environnement",
  (recus[0]?.types ?? []).includes("web_search_20250305"),
  JSON.stringify(recus[0]?.types));

/* Un ISBN mal formé ne doit pas partir au catalogue non plus. */
appelsCatalogue.length = 0;
await chercher("978207295808");            // douze chiffres
verifier("un ISBN incomplet n'est pas envoyé aux catalogues",
  appelsCatalogue.length === 0, JSON.stringify(appelsCatalogue));

/* =====================================================================
   5 bis. UNE NOTICE PAUVRE NE DOIT PAS ARRÊTER LA CASCADE

   Défaut du 18/08, trouvé en production : « trouvé » valait « porte un
   titre ». Google Books a rendu titre et année sans éditeur, la cascade s'est
   arrêtée là, et Open Library — qui l'avait peut-être — n'a jamais été
   interrogée. J'avais construit une hiérarchie de qualité puis écrit un
   critère d'arrêt qui l'ignore.
   ===================================================================== */

/* La BnF rend une notice AMPUTÉE de son éditeur ; Open Library l'a. */
const BNF_SANS_EDITEUR = REPONSE_BNF("9782072958083")
  .replace(/<dc:publisher>[^<]*<\/dc:publisher>\n?/, "");

const cataloguesOrigine = catalogues.listeners("request")[0];
catalogues.removeAllListeners("request");
catalogues.on("request", async (req, rep) => {
  const nom = new URL(req.url, "http://x").pathname.replace(/^\//, "").split("?")[0];
  if (nom === "bnf" && plan.bnf === "sans-editeur" && !/bib\.title/.test(req.url)) {
    appelsCatalogue.push(nom);
    rep.writeHead(200, { "content-type": "application/xml" });
    return rep.end(BNF_SANS_EDITEUR);
  }
  return cataloguesOrigine(req, rep);
});

plan = { bnf: "sans-editeur", openlibrary: "trouve", googlebooks: "absent", bnfTitre: "absent" };
appelsCatalogue.length = 0; recus.length = 0; reponseModele = null;
const rComble = await chercher(ISBN);

verifier("une notice sans éditeur n'arrête pas la cascade",
  appelsCatalogue.filter(n => n === "openlibrary").length === 1,
  JSON.stringify(appelsCatalogue));
verifier("… le trou est comblé par la source suivante",
  rComble.corps?.editeur === "OL", rComble.corps?.editeur);
verifier("… sans écraser ce que la première avait de mieux",
  rComble.corps?.titre === "Le vin : par ceux qui le font pour ceux qui le boivent",
  rComble.corps?.titre);

/* Complète dès la première : on n'interroge personne d'autre. Sans ce
   contrôle, « combler » pourrait dégénérer en « toujours tout demander ». */
plan = { bnf: "trouve", openlibrary: "trouve", googlebooks: "trouve", bnfTitre: "absent" };
appelsCatalogue.length = 0;
await chercher(ISBN);
verifier("une notice complète arrête la cascade au premier appel",
  appelsCatalogue.length === 1, JSON.stringify(appelsCatalogue));

/* =====================================================================
   5 ter. L'ÉDITEUR D'UNE ÉDITION SŒUR — borné, et dit

   Un ISBN désigne une édition, pas une œuvre. La BnF connaissait
   « Pourquoi j'ai toujours raison » sous l'ISBN de 2016 et ignorait la
   réédition de 2025. On récupère l'éditeur, jamais la pagination.
   ===================================================================== */

plan = { bnf: "sans-editeur", openlibrary: "absent", googlebooks: "absent",
         bnfTitre: "trouve" };
appelsCatalogue.length = 0;
const rVoisine = await chercher(ISBN);

verifier("l'éditeur est repris d'une édition sœur quand il manque partout",
  rVoisine.corps?.editeur === "Hoëbeke", rVoisine.corps?.editeur);
verifier("… et la fiche dit que cet éditeur est déduit",
  rVoisine.corps?.editeurAutreEdition === true,
  String(rVoisine.corps?.editeurAutreEdition));
verifier("… tandis qu'un éditeur venu de la bonne notice n'est PAS marqué",
  rComble.corps?.editeurAutreEdition === false,
  String(rComble.corps?.editeurAutreEdition));

plan = { bnf: "trouve", openlibrary: "absent", googlebooks: "absent", bnfTitre: "trouve" };
appelsCatalogue.length = 0;
await chercher(ISBN);
verifier("aucun repli par titre quand l'éditeur est déjà connu",
  !appelsCatalogue.includes("bnf-titre"), JSON.stringify(appelsCatalogue));

/* =====================================================================
   6 bis. LA COUVERTURE DE SECOURS PASSE PAR L'API

   Le navigateur appelait Google Books sans clef. Depuis 2026 c'est 429, et
   l'échec est invisible : une couverture introuvable et une requête refusée
   donnent le même écran. La clef ne peut pas descendre dans la page.
   ===================================================================== */

const couverture = (isbn) =>
  fetch(`${BASE}/api/couverture?isbn=${encodeURIComponent(isbn)}`)
    .then(async r => ({ statut: r.status, corps: await r.json().catch(() => null) }));

plan = { bnf: "absent", openlibrary: "absent", googlebooks: "couverture" };
const rCouv = await couverture(ISBN);
verifier("la couverture de secours est rendue par l'API",
  rCouv.corps?.url === "https://exemple.test/couv.jpg", JSON.stringify(rCouv.corps));

/* La route est OUVERTE — la page publique en a besoin — donc elle ne doit
   rien exiger d'autre qu'un ISBN valide, et ne rien rendre pour le reste. */
verifier("un ISBN invalide ne déclenche aucun appel et rend null",
  (await couverture("pas-un-isbn")).corps?.url === null);

plan = { bnf: "absent", openlibrary: "absent", googlebooks: "absent" };
verifier("sans couverture connue, l'API rend null plutôt qu'une erreur",
  (await couverture(ISBN)).corps?.url === null);

/* =====================================================================
   6 ter. LE LIVRE QU'ON POSSÈDE DÉJÀ

   Constaté en production le 18/08 : scanner un ouvrage déjà possédé menait
   au bout du chemin — catalogues, modèle, formulaire — pour être refusé à la
   dernière ligne par « unique (tenant_id, ouvrage_id) », sans message
   visible. La bonne réponse arrive avant qu'on ait dépensé quoi que ce soit.
   ===================================================================== */

plan = { bnf: "trouve", openlibrary: "absent", googlebooks: "absent", bnfTitre: "absent" };
await banc.semer({ tenant: xavier.id, id: "u-deja", isbn: ISBN,
                   titre: "Un livre déjà là", auteur: "Auteur Connu" });

appelsCatalogue.length = 0; recus.length = 0;
const rDeja = await chercher(ISBN);

verifier("un ISBN déjà possédé est reconnu",
  rDeja.corps?.deja?.id === "u-deja", JSON.stringify(rDeja.corps));
verifier("… avec de quoi ouvrir la fiche existante",
  rDeja.corps?.deja?.titre === "Un livre déjà là"
  && rDeja.corps?.deja?.auteur === "Auteur Connu", JSON.stringify(rDeja.corps?.deja));
verifier("… sans interroger le moindre catalogue",
  appelsCatalogue.length === 0, JSON.stringify(appelsCatalogue));
verifier("… ni appeler le modèle", recus.length === 0, String(recus.length));

/* C'EST LA DÉPENSE QUI COMPTE, pas seulement l'ergonomie : avant ce
   contrôle, chaque re-scan payait une identification. */
const [apresDeja] = await q(
  "select count(*)::int n from appels_ia where route like '/api/recherche-livre%'");
const rDeja2 = await chercher(ISBN);
const [encore] = await q(
  "select count(*)::int n from appels_ia where route like '/api/recherche-livre%'");
verifier("un doublon ne consomme aucun appel au modèle",
  apresDeja.n === encore.n, `${apresDeja.n} puis ${encore.n}`);

/* Le livre d'un AUTRE locataire ne doit pas passer pour le sien : la
   possession est cloisonnée, la reconnaissance doit l'être aussi. */
await banc.semer({ tenant: bob, id: "b-deja", isbn: "9782072958084",
                   titre: "Le livre de Bob", auteur: "Auteur B",
                   visibilite: "publique" });
plan = { bnf: "absent", openlibrary: "absent", googlebooks: "absent", bnfTitre: "absent" };
reponseModele = { titre: "Cherché", auteur: "A", editeur: "E", annee: 2020,
                  isbn: "9782072958084", categorie: "Académique",
                  sousCategorie: "Philosophie", rayonSuggere: "", motif: "" };
const rAutrui = await chercher("9782072958084");
verifier("le livre d'un autre locataire n'est pas un doublon",
  !rAutrui.corps?.deja, JSON.stringify(rAutrui.corps?.deja));
reponseModele = null;

/* Et la base reste le dernier mot : l'écriture directe d'un second
   exemplaire est refusée en 409, avec un message qui dit quoi faire. */
const conflit = await fetch(`${BASE}/api/livres`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie: session },
  body: JSON.stringify([{ id: "u-deja-bis", isbn: ISBN, titre: "Doublon",
                          auteur: "A", categorie: "Académique",
                          sous_categorie: "Philosophie", sphere: "Pro" }]),
}).then(async r => ({ statut: r.status, corps: await r.json().catch(() => null) }));

verifier("écrire un second exemplaire est refusé en 409, pas en 500",
  conflit.statut === 409, String(conflit.statut));
verifier("… et le message dit quoi faire",
  /possédez déjà/i.test(conflit.corps?.error ?? ""), conflit.corps?.error);

/* =====================================================================
   6 quater. LA PROVENANCE SURVIT JUSQU'À LA BASE

   Le 18/08, savoir quelle source avait produit une fiche pauvre a demandé
   une demi-heure d'enquête — pour une information que l'API tenait au moment
   d'écrire la ligne et jetait aussitôt.

   Le chemin est long : cascade → réponse HTTP → formulaire → enregistrement
   → colonne. Un maillon manquant et la provenance meurt en silence, sans
   qu'aucune fonctionnalité ne cesse de marcher. C'est le genre de champ
   qu'on croit avoir et qu'on n'a pas.
   ===================================================================== */

plan = { bnf: "sans-editeur", openlibrary: "trouve", googlebooks: "absent",
         bnfTitre: "absent" };
const rProv = await chercher("9782072958085");
verifier("la réponse porte la composition des sources",
  rProv.corps?.source === "bnf+openlibrary", String(rProv.corps?.source));

const poser = (corps) => fetch(`${BASE}/api/livres`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie: session },
  body: JSON.stringify([corps]),
}).then(r => r.status);

await poser({ id: "u-prov", isbn: "9782072958085", titre: "Avec provenance",
              auteur: "A", categorie: "Académique", sous_categorie: "Philosophie",
              sphere: "Pro", source: rProv.corps.source });
const [enBase] = await q(
  "select source, source_le from ouvrages where isbn = '9782072958085'");
verifier("… et elle arrive jusqu'à la colonne",
  enBase?.source === "bnf+openlibrary", JSON.stringify(enBase));
verifier("… datée", enBase?.source_le !== null && enBase?.source_le !== undefined);

/* Une provenance inventée n'entre pas. Ce champ ne commande rien, mais un
   diagnostic pollué ne vaut pas mieux qu'un diagnostic absent. */
await poser({ id: "u-prov2", isbn: "9782072958086", titre: "Provenance douteuse",
              auteur: "A", categorie: "Académique", sous_categorie: "Philosophie",
              sphere: "Pro", source: "<script>alert(1)</script>" });
const [sale] = await q("select source from ouvrages where isbn = '9782072958086'");
verifier("une provenance hors vocabulaire est ignorée, pas enregistrée",
  sale?.source === null, JSON.stringify(sale));
verifier("… sans faire échouer l'enregistrement du livre",
  (await q("select count(*)::int n from ouvrages where isbn = '9782072958086'"))[0].n === 1);

/* Et une modification ultérieure sans provenance n'efface pas celle qu'on
   avait — même règle que pour l'éditeur. */
await poser({ id: "u-prov", isbn: "9782072958085", titre: "Avec provenance",
              auteur: "A", categorie: "Académique", sous_categorie: "Philosophie",
              sphere: "Pro", note: 4 });
const [garde] = await q("select source from ouvrages where isbn = '9782072958085'");
verifier("une fiche sans provenance n'efface pas celle qui était connue",
  garde?.source === "bnf+openlibrary", JSON.stringify(garde));

/* =====================================================================
   6 quinquies. LA RECHERCHE LIBRE DANS LE CATALOGUE

   Le recours quand aucune base ne connaît l'ISBN — tirage de luxe,
   micro-éditeur, parution trop récente. Deux mots lus sur la couverture,
   aucun appel au modèle.
   ===================================================================== */

const parTexte = (q) => fetch(`${BASE}/api/catalogue?q=${encodeURIComponent(q)}`,
  { headers: { cookie: session } })
  .then(async r => ({ statut: r.status, corps: await r.json().catch(() => null) }));

plan = { bnf: "trouve", openlibrary: "absent", googlebooks: "absent", bnfTitre: "trouve" };
recus.length = 0;
const rTexte = await parTexte("Typex Andy");

verifier("la recherche libre rend des notices",
  Array.isArray(rTexte.corps?.notices) && rTexte.corps.notices.length > 0,
  JSON.stringify(rTexte.corps));
verifier("… nettoyées comme les autres (titre sans mention de responsabilité)",
  rTexte.corps?.notices?.[0]?.titre
    === "Le vin : par ceux qui le font pour ceux qui le boivent",
  rTexte.corps?.notices?.[0]?.titre);
verifier("… avec l'ISBN DE LA NOTICE, qui dit s'il s'agit d'une autre édition",
  rTexte.corps?.notices?.[0]?.isbnNotice === "9782072958083",
  String(rTexte.corps?.notices?.[0]?.isbnNotice));
verifier("… et sans appeler le modèle", recus.length === 0, String(recus.length));

/* Une requête trop courte ne part pas : trois caractères ne cherchent rien
   et rendraient le catalogue entier par pertinence. */
verifier("une requête de moins de trois caractères ne cherche pas",
  (await parTexte("ab")).corps?.notices?.length === 0);

/* ELLE EXIGE UNE SESSION. Contrairement à /api/couverture, dont la page
   publique a besoin, celle-ci ne sert qu'au formulaire d'ajout — et elle
   appelle un service extérieur en notre nom. Placée par erreur avant le
   garde du routeur, elle aurait été ouverte à tous. */
const sansSession = await fetch(`${BASE}/api/catalogue?q=Typex%20Andy`)
  .then(r => r.status);
verifier("la recherche libre est refusée sans session",
  sansSession === 401, String(sansSession));

/* =====================================================================
   7. LES DEUX CHEMINS SONT SÉPARÉS AU JOURNAL

   Sans deux routes distinctes, « cout_ia_par_mois » mélangerait le classement
   à 900 jetons et l'identification à 30 000. On ne pourrait pas prouver le
   gain, et une optimisation qu'on ne mesure pas est une opinion.
   ===================================================================== */

const routes = (await q("select distinct route from appels_ia order by route")).map(r => r.route);
verifier("le classement est journalisé sous sa propre route",
  routes.includes("/api/recherche-livre-classement"), JSON.stringify(routes));
verifier("… distincte de l'identification complète",
  routes.includes("/api/recherche-livre"), JSON.stringify(routes));

const [cout] = await q(
  `select route, sum(jetons_entree)::int e, count(*)::int n from appels_ia
    where route = '/api/recherche-livre-classement' group by route`);
verifier("le classement est bien mesuré (jetons enregistrés)",
  cout?.e > 0 && cout?.n > 0, JSON.stringify(cout));

/* ------------------------------------------------------------- Verdict */
await fermer();

for (const l of ok) console.log("  OK      " + l);
for (const l of ko) console.log("  ECHEC   " + l);
console.log(`\n  ${ok.length} vérifications passées, ${ko.length} échouées`);
if (ko.length) { console.log("\n--- journal du serveur ---\n" + journal); process.exit(1); }
