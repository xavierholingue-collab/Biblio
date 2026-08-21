/* Test de fumée du front Docker : charge l'application dans un DOM simulé,
   avec une API simulée, et vérifie le parcours complet sans réseau réel.

   Usage :  npm install jsdom  puis  node test-fumee.js                        */

const fs = require("fs");
const { JSDOM } = require("jsdom");

/* La page a chercher, quelle que soit la profondeur ou vit ce test.
 *
 * Il a longtemps vecu dans web/test/, ou « .. » designait web/. Depuis
 * qu'il est range dans tests/, a la racine du depot, « .. » designe le
 * dossier parent du depot — et le test echouait sur un ENOENT sans rapport
 * avec ce qu'il verifie.
 *
 * Un test ne doit pas se casser parce qu'on l'a deplace. On enumere donc
 * les emplacements plausibles, et l'on dit lesquels ont ete essayes si
 * aucun ne convient. */
const chemin = require("path");
const CANDIDATS = [
  chemin.join(__dirname, "..", "ma-bibliotheque.html"),        // web/test/
  chemin.join(__dirname, "..", "web", "ma-bibliotheque.html"), // tests/ a la racine
  chemin.join(process.cwd(), "web", "ma-bibliotheque.html"),   // lance depuis la racine
];
const HTML = CANDIDATS.find((c) => fs.existsSync(c));
if (!HTML) {
  console.error("ma-bibliotheque.html introuvable. Emplacements essayes :");
  CANDIDATS.forEach((c) => console.error("  " + c));
  process.exit(1);
}
const html = fs.readFileSync(HTML, "utf8");

const erreurs = [], ok = [];
function verifier(nom, condition, detail) {
  (condition ? ok : erreurs).push(nom + (condition ? "" : " — " + (detail ?? "")));
}

const sansScripts = html.replace(/<script>[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(sansScripts, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost:8080/" });
const w = dom.window;
w.onerror = (m) => erreurs.push("erreur JS : " + m);
// jsdom ne sait pas naviguer : on neutralise le rechargement de page.
delete w.location.reload;
w.location.reload = () => {};
w.confirm = () => true;

/* jsdom ne calcule aucune mise en page : clientWidth et clientHeight valent
   toujours 0. La mosaïque, qui pave une surface, ne dessinerait donc rien —
   et le test ne prouverait rien du tout. On donne au DOM simulé des
   dimensions plausibles, celles d'une fenêtre de bureau.

   Ce n'est pas une complaisance : sans mise en page, il n'y a aucune
   question à poser à un algorithme de pavage. Ce que le test vérifie
   ensuite — le nombre de tuiles, la proportionnalité des aires, les liens —
   ne dépend pas de la valeur choisie. */
Object.defineProperty(w.HTMLElement.prototype, "clientWidth",
  { configurable: true, get() { return this.id === "mosaique" ? 880 : 0; } });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight",
  { configurable: true, get() { return this.id === "mosaique" ? 240 : 0; } });

/* ------------------------------- API simulée ------------------------------ */

const MOT_DE_PASSE = "motdepassedetest";
let connecte = false;
const appels = [];

// Deux ouvrages suffisent pour valider le parcours complet.
let table = [
  { id: "b001", isbn: "9782081285750", titre: "C'est (vraiment?) moi qui décide",
    auteur: "Ariely Dan", editeur: "Flammarion", annee: 2011, statut: "Lu", note: 5,
    categorie: "Savoirs", sous_categorie: "Décision, biais & rationalité", sphere: "Pro",
    cover_url: null, cover_statut: "inconnu", resume: null, resume_points: null,
    resume_themes: null, resume_modele: null, resume_fiabilite: null, resume_genere_le: null },
  { id: "b002", isbn: "9782266243124", titre: "Ne le dis à personne",
    auteur: "Coben Harlan", editeur: "Pocket", annee: 2004, statut: "Lu", note: 4,
    categorie: "Roman", sous_categorie: "Polar & thriller", sphere: "Perso",
    cover_url: null, cover_statut: "inconnu", resume: null, resume_points: null,
    resume_themes: null, resume_modele: null, resume_fiabilite: null, resume_genere_le: null },
];

/* Les candidats d'une recherche par titre, NOMMÉS pour que le contrôle
   compte ce que la fausse source a rendu au lieu d'un nombre écrit à la main.

   Trois cas, et le troisième est celui qui a produit le défaut du 21/08/2026 :
   un CHAPITRE dont le contenant est un livre. Sans lui, la liste de choix
   n'aurait jamais eu l'occasion d'appeler un recueil « revue ». */
const CANDIDATS_ARTICLES = [
  { doi: "10.1038/nature14539", titre: "Deep learning",
    auteur: "LeCun Yann ; Bengio Yoshua ; Hinton Geoffrey",
    revue: "Nature", annee: 2015, citations: 12345, support: "revue" },
  { doi: "10.1016/j.neunet.2014.09.003", titre: "Deep learning in neural networks",
    auteur: "Schmidhuber Jürgen", revue: "Neural Networks", annee: 2015,
    citations: 9876, support: "revue" },
  { doi: "10.1007/978-1-349-02701-9_2", titre: "One More Time",
    auteur: "Herzberg Frederick", revue: "Job Satisfaction — A Reader",
    annee: 1976, citations: 92, support: "ouvrage" },
];

function reponse(corps, statut = 200) {
  return Promise.resolve({
    ok: statut < 400, status: statut,
    json: () => Promise.resolve(corps),
    headers: { get: () => null },
  });
}

w.fetch = (url, options = {}) => {
  const chemin = String(url).replace(/^https?:\/\/[^/]+/, "");
  const methode = options.method ?? "GET";
  const corps = options.body ? JSON.parse(options.body) : undefined;
  appels.push([methode, chemin, corps]);

  if (chemin === "/api/session") return reponse({ connecte, ia_publique: false });
  if (chemin === "/api/connexion") {
    if (corps?.motDePasse !== MOT_DE_PASSE) return reponse({ error: "Mot de passe incorrect" }, 401);
    connecte = true;
    return reponse({ ok: true });
  }
  if (chemin === "/api/deconnexion") { connecte = false; return reponse({ ok: true }); }

  // Routes ouvertes : un visiteur ne voit que le perimetre professionnel.
  if (chemin === "/api/livres" && methode === "GET") {
    const vus = connecte ? table : table.filter(l => l.sphere === "Pro");
    return reponse(vus.map(l => ({ ...l })));
  }
  if (chemin === "/api/statistiques") {
    const vus = connecte ? table : table.filter(l => l.sphere === "Pro");
    return reponse({ perimetre: connecte ? "complet" : "public",
                     total: vus.length, lus: vus.length, en_cours: 0, a_lire: 0,
                     avec_resume: 0, auteurs: vus.length, rayons: 1, note_moyenne: 4.5,
                     sous_categories: [], decennies: [], auteurs_recurrents: [],
                     plus_recents: [] });
  }
  if (!connecte) return reponse({ error: "Non authentifié" }, 401);
  if (chemin === "/api/livres" && methode === "PUT") {
    [].concat(corps).forEach(r => {
      const i = table.findIndex(x => x.id === r.id);
      if (i >= 0) Object.assign(table[i], r); else table.push(r);
    });
    return reponse({ enregistres: [].concat(corps).length });
  }
  if (chemin.startsWith("/api/livres/") && methode === "DELETE") {
    const id = decodeURIComponent(chemin.slice("/api/livres/".length));
    table = table.filter(l => l.id !== id);
    return reponse({ ok: true });
  }
  if (chemin === "/api/couvertures") {
    corps.forEach(c => {
      const l = table.find(x => x.id === c.id);
      if (l) { l.cover_url = c.cover_url; l.cover_statut = c.cover_statut; }
    });
    return reponse({ enregistrees: corps.length });
  }
  if (chemin === "/api/resume") {
    return reponse({ resume: "Résumé de test.", points: ["Point A", "Point B"],
                     themes: ["décision", "biais"], fiabilite: "haute" });
  }
  if (chemin === "/api/recommandation") {
    return reponse({
      lecture_de_la_demande: "Vous cherchez à mieux décider.",
      parcours: [{ id: "b001", ordre: 1, pourquoi: "Parce que.", a_chercher: "Chapitre 3" }],
      lacune: "Rien sur la théorie des jeux.",
      suggestions_externes: [{ titre: "Un livre absent", auteur: "Auteur Test",
                               editeur: "Ed", annee: 2020, isbn: "9780000000000",
                               pourquoi: "Comble la lacune." }],
    });
  }
  if (chemin.startsWith("/api/articles")) {
    return reponse({ articles: CANDIDATS_ARTICLES });
  }
  if (chemin.startsWith("/api/article")) {
    /* LA RÉPONSE DÉPEND DU DOI DEMANDÉ, et ce n'est pas un raffinement.
     *
     * Troisième occurrence du même défaut de gabarit. Le 18/08, la fausse
     * Open Library était clefée sur un ISBN constant : tout autre ISBN la
     * faisait passer pour ignorante. Le 19/08, la fausse BnF rendait le même
     * nom pour la recherche par ISBN et par titre, rendant vide l'assertion
     * « aucun repli n'a eu lieu ». Ici, rendre toujours l'article de Nature
     * faisait passer au vert une mutation qui réécrivait l'étiquette du champ
     * en « Revue » sans condition — puisque Nature EST une revue.
     *
     * Une fausse source qui ne distingue pas ses cas invente un monde où le
     * code ne peut pas échouer. */
    const doi = decodeURIComponent(chemin.split("doi=")[1] ?? "");
    if (doi.startsWith("10.1007/")) {
      return reponse({
        issue: "trouvee", type: "article", source: "crossref",
        doi: "10.1007/978-1-349-02701-9_2",
        titre: "One More Time: How Do You Motivate Employees?",
        auteur: "Herzberg Frederick", revue: "Job Satisfaction — A Reader",
        editeur: "Palgrave Macmillan UK", annee: 1976, citations: 92,
        support: "ouvrage", pagination: "17-32",
        /* PAS d'abstract : Crossref n'en a pas pour ce chapitre. C'est ce qui
           a fait retomber l'ajout sur un résumé payant, à 0,060 €. */
        resumeEditeur: null, avecSources: null,
        categorie: "Savoirs", sousCategorie: "Management & leadership",
      });
    }
    return reponse({
      issue: "trouvee", type: "article", source: "crossref",
      doi: "10.1038/nature14539", titre: "Deep learning",
      auteur: "LeCun Yann ; Bengio Yoshua ; Hinton Geoffrey",
      revue: "Nature", annee: 2015, volume: "521", numero: "7553",
      citations: 12345, resumeEditeur: "Deep learning allows…",
      support: "revue", pagination: "436-444",
      avecSources: true, categorie: "Savoirs", sousCategorie: "Numérique, IA & SI",
    });
  }
  if (chemin === "/api/recherche-livre") {
    return reponse({ titre: "Nexus", auteur: "Harari Yuval Noah", editeur: "Albin Michel",
                     annee: 2024, isbn: "9782226476494", categorie: "Savoirs",
                     sousCategorie: "Numérique, IA & SI" });
  }
  // Requête sortante vers Google Books : coupée.
  return Promise.reject(new Error("réseau coupé"));
};

/* ------------------------------- Exécution -------------------------------- */

/* ON NOMME CE QU'ON ATTEND, ON NE LE COMPTE PAS.
 *
 * Ce contrôle exigeait « deux blocs de script ». Le 15/08/2026, l'ajout du
 * bandeau de recette en a fait trois, et la chaîne s'est arrêtée sur une
 * page parfaitement saine.
 *
 * Un compte est une propriété de la MISE EN FORME, pas du comportement :
 * il tombe dès qu'on ajoute quelque chose de légitime, et il ne dit rien
 * quand le script qui compte vraiment disparaît. Même erreur que le
 * contrôle qui exigeait six vignettes et cassait à la septième.
 *
 * On vérifie donc la présence de ce dont la page a BESOIN. */
const blocs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
verifier("au moins un bloc de script", blocs.length >= 1, "trouvé " + blocs.length);

const ATTENDUS = [
  ["le script principal de l'application", /function\s+rafraichir|entrerDansApp/],
  ["le bandeau d'environnement",           /bandeau-recette/],
];
for (const [nom, motif] of ATTENDUS) {
  verifier(nom, blocs.some(b => motif.test(b)),
    "aucun des " + blocs.length + " blocs ne correspond");
}

const attendre = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const d = w.document;
  blocs.forEach(b => { const s = d.createElement("script"); s.textContent = b; d.body.appendChild(s); });
  await attendre(80);
  const lire = expr => w.eval(expr);

  verifier("aucune référence à Supabase", !html.includes("supabase"));
  verifier("aucune donnée embarquée dans le fichier", !html.includes("LIVRES_INITIAUX"));
  verifier("champ e-mail retiré", !d.getElementById("cEmail"));

  /* --- Mode visiteur : aucun mur de connexion --- */
  verifier("application visible sans connexion", !d.getElementById("app").hidden);
  verifier("1 ouvrage professionnel visible", lire("livres.length") === 1, "livres = " + lire("livres.length"));
  verifier("aucun ouvrage perso exposé",
    lire("livres.filter(l => l.sphere === 'Perso').length") === 0);
  verifier("bouton Espace personnel présent", !!d.getElementById("btnConnecter"));
  verifier("bouton Se déconnecter absent", !d.getElementById("btnDeconnexion"));
  verifier("filtre Perso indisponible", d.getElementById("sphere").disabled === true);
  verifier("ajout de livre masqué", d.getElementById("ajouter").hidden === true);
  verifier("import masqué", d.getElementById("importBtn").hidden === true);
  verifier("export JSON masqué", d.getElementById("exportJson").hidden === true);
  verifier("export CSV accessible", d.getElementById("exportCsv").hidden === false);
  verifier("recommandation renvoyée vers la connexion",
    /connecter/i.test(d.getElementById("btnQuete").textContent),
    d.getElementById("btnQuete").textContent);

  /* Un visiteur qui ouvre une fiche ne déclenche aucun appel payant */
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  await lire('ouvrirFiche("b001")');
  await attendre(100);
  verifier("aucun appel à /api/resume pour un visiteur",
    !appels.some(a => a[1] === "/api/resume"));
  verifier("absence de résumé signalée",
    /Aucun résumé/i.test(d.getElementById("etatResume").textContent),
    d.getElementById("etatResume").textContent);
  verifier("régénération masquée pour un visiteur", d.getElementById("btnRegenerer").hidden);
  d.getElementById("btnFermerFiche").dispatchEvent(new w.Event("click"));

  /* --- Connexion via la fenêtre --- */
  d.getElementById("btnConnecter").dispatchEvent(new w.Event("click"));
  await attendre(40);
  verifier("fenêtre de connexion ouverte", d.getElementById("modaleConnexion").open);

  d.getElementById("cMdp").value = "faux";
  d.getElementById("formConnexion").dispatchEvent(new w.Event("submit"));
  await attendre(60);
  verifier("mot de passe refusé signalé",
    /refus/i.test(d.getElementById("etatConnexion").textContent),
    d.getElementById("etatConnexion").textContent);

  d.getElementById("cMdp").value = MOT_DE_PASSE;
  d.getElementById("formConnexion").dispatchEvent(new w.Event("submit"));
  await attendre(200);
  verifier("fenêtre refermée après connexion", !d.getElementById("modaleConnexion").open);
  verifier("2 ouvrages après connexion", lire("livres.length") === 2, "livres = " + lire("livres.length"));
  verifier("filtre Perso disponible", d.getElementById("sphere").disabled === false);
  verifier("ajout de livre accessible", d.getElementById("ajouter").hidden === false);
  verifier("recommandation active",
    /recommander/i.test(d.getElementById("btnQuete").textContent),
    d.getElementById("btnQuete").textContent);

  /* Rendu */
  verifier("liste rendue", d.querySelectorAll("#liste .fiche").length === 2);

  /* Mosaïque des rayons.
     Les deux ouvrages d'essai appartiennent à deux rayons distincts : on
     attend donc deux tuiles, et les aires doivent être égales puisque
     chaque rayon compte un ouvrage. */
  const tuiles = [...d.querySelectorAll("#mosaique .tuile")];
  verifier("mosaïque dessinée", tuiles.length === 2, tuiles.length + " tuile(s)");

  if (tuiles.length === 2) {
    const aire = t => parseFloat(t.style.width) * parseFloat(t.style.height);
    const [a1, a2] = tuiles.map(aire);
    verifier("aires proportionnelles au nombre d'ouvrages",
      Math.abs(a1 - a2) / Math.max(a1, a2) < 0.02,
      "aires " + Math.round(a1) + " et " + Math.round(a2));
    verifier("la mosaïque couvre le cadre",
      Math.abs(a1 + a2 - 880 * 240) / (880 * 240) < 0.02,
      "couverture " + Math.round((a1 + a2) / (880 * 240) * 100) + " %");
    verifier("tuiles nommées d'après les rayons",
      tuiles.every(t => t.textContent.trim().length > 0));
  }

  /* Interaction : cliquer une tuile filtre sur ce rayon, un second clic le
     retire. C'est la seule fonction nouvelle qui n'a pas d'équivalent
     ailleurs dans l'interface — le menu déroulant ne se déclique pas. */
  const cible = tuiles.find(t => /Décision/.test(t.textContent));
  verifier("tuile du rayon Décision présente", !!cible);
  if (cible) {
    cible.dispatchEvent(new w.Event("click"));
    await attendre(30);
    verifier("clic sur une tuile filtre le rayon",
      d.querySelectorAll("#liste .fiche").length === 1,
      d.querySelectorAll("#liste .fiche").length + " fiche(s)");
    verifier("tuile marquée active",
      d.querySelector('#mosaique .tuile[aria-pressed="true"]') !== null);

    const memeTuile = [...d.querySelectorAll("#mosaique .tuile")]
      .find(t => /Décision/.test(t.textContent));
    memeTuile.dispatchEvent(new w.Event("click"));
    await attendre(30);
    verifier("second clic retire le filtre",
      d.querySelectorAll("#liste .fiche").length === 2,
      d.querySelectorAll("#liste .fiche").length + " fiche(s)");
  }

  /* Filtre Perso / Pro */
  d.getElementById("sphere").value = "Perso";
  d.getElementById("sphere").dispatchEvent(new w.Event("change"));
  await attendre(30);
  verifier("filtre Perso", d.querySelectorAll("#liste .fiche").length === 1);
  d.getElementById("sphere").value = "";
  d.getElementById("sphere").dispatchEvent(new w.Event("change"));

  /* ------------------- Tout ce qui est affiché filtre -------------------
     Le principe ramené du dossier Lisia : auteur, éditeur, année, rayon,
     statut ne sont pas des étiquettes mortes, ce sont des chemins.

     LE PIÈGE ÉPROUVÉ ICI EST LE TROISIÈME CONTRÔLE. La ligne entière est
     cliquable depuis toujours ; un jeton posé dedans hérite du clic du
     parent. Sans « stopPropagation », cliquer un auteur filtre ET ouvre la
     fiche du livre — les deux à la fois, ce qui donne l'impression que
     l'application fait n'importe quoi. */
  const clic = () => new w.MouseEvent("click", { bubbles: true, cancelable: true });

  const auteurs = [...d.querySelectorAll("#liste .fiche .meta .filtrable")];
  verifier("les valeurs affichées sont cliquables",
    auteurs.length >= 2, auteurs.length + " jeton(s)");

  if (auteurs.length) {
    const nom = auteurs[0].textContent;
    auteurs[0].dispatchEvent(clic());
    await attendre(30);

    verifier("cliquer un auteur filtre la liste",
      d.querySelectorAll("#liste .fiche").length === 1,
      d.querySelectorAll("#liste .fiche").length + " fiche(s) pour " + nom);

    verifier("… et le clic n'ouvre PAS la fiche du livre",
      !d.getElementById("fiche").open,
      "la modale de fiche s'est ouverte en même temps");

    verifier("… le filtre actif est affiché",
      d.querySelectorAll("#filtresActifs .puce-filtre").length === 1,
      d.getElementById("filtresActifs").hidden ? "barre masquée" : "aucune puce");

    /* Bascule : le même clic retire ce qu'il a posé. Sans elle, on ne sait
       plus revenir en arrière autrement qu'en rechargeant la page. */
    [...d.querySelectorAll("#liste .fiche .meta .filtrable")][0].dispatchEvent(clic());
    await attendre(30);
    verifier("recliquer le même auteur retire le filtre",
      d.querySelectorAll("#liste .fiche").length === 2 &&
      d.getElementById("filtresActifs").hidden);

    /* Et la puce sait retirer, elle aussi. */
    [...d.querySelectorAll("#liste .fiche .meta .filtrable")][0].dispatchEvent(clic());
    await attendre(30);
    const puce = d.querySelector("#filtresActifs .puce-filtre");
    verifier("la puce du filtre porte son libellé",
      puce && /Auteur\s*:/.test(puce.textContent), puce ? puce.textContent : "absente");
    if (puce) {
      puce.dispatchEvent(clic());
      await attendre(30);
      verifier("cliquer la puce retire le filtre",
        d.querySelectorAll("#liste .fiche").length === 2);
    }
  }

  /* ---------------------- La zone Articles ----------------------
     L'article est ajouté PAR LE FORMULAIRE, pas posé dans le jeu d'essai.
     Deux raisons : cela n'écrase aucun compte des contrôles précédents — une
     première version l'avait ajouté au jeu initial et en a cassé sept d'un
     coup — et surtout cela éprouve le chemin réel, du DOI collé jusqu'à la
     ligne affichée. */
  d.getElementById("ajouterArticle").dispatchEvent(clic());
  await attendre(30);
  verifier("le formulaire d'article demande un DOI, pas un ISBN",
    !d.getElementById("blocDoi").hidden && d.getElementById("blocIsbn").hidden);

  /* ---- La recherche par TITRE, celle qu'on utilisera le plus ----
     Le même champ accepte les deux : la forme de ce qu'on tape décide. Un
     DOI se reconnaît sans ambiguïté ; tout le reste est un titre. */
  d.getElementById("rechercheDoi").value = "deep learning";
  d.getElementById("btnChercherDoi").dispatchEvent(clic());
  await attendre(60);
  const propositions = [...d.querySelectorAll("#etatDoi button")];
  /* ON COMPTE CE QUE LA FAUSSE SOURCE A RENDU, pas un nombre écrit à la main.
     Le contrôle exigeait « === 2 ». Ajouter un troisième candidat au gabarit
     — pour éprouver le cas du chapitre d'ouvrage — l'a fait échouer alors que
     rien n'était cassé. Un contrôle qui s'oppose à l'enrichissement du jeu
     d'essai finit par être desserré à la va-vite, et il emporte alors les cas
     où il avait raison. Ce qu'il doit dire est : la page affiche TOUS les
     candidats rendus, sans en perdre ni en inventer. */
  verifier("un titre rend une liste de candidats",
    propositions.length === CANDIDATS_ARTICLES.length,
    propositions.length + " proposition(s) pour "
      + CANDIDATS_ARTICLES.length + " rendue(s)");
  verifier("… avec revue, année et citations pour choisir",
    /Nature/.test(propositions[0]?.textContent ?? "") &&
    /citations/.test(propositions[0]?.textContent ?? ""),
    propositions[0]?.textContent);

  /* Choisir repasse par le DOI : la recherche ne rend qu'un résumé de notice,
     sans abstract ni rayon. */
  /* CE QUE LA LIGNE DIT DU CONTENANT. Le 21/08/2026, la fiche du premier
     article ajouté en production annonçait « Revue : Job Satisfaction — A
     Reader » — un recueil Palgrave présenté comme un périodique. On vérifie
     ici que la ligne de choix distingue les deux : c'est là qu'on décide. */
  const textes = propositions.map(p => p.textContent);
  verifier("un chapitre d'ouvrage s'annonce comme tel dans la liste",
    textes.some(t => /Ouvrage\s*:\s*Job Satisfaction/.test(t)),
    JSON.stringify(textes));
  verifier("… et un article de revue ne porte pas d'étiquette inutile",
    textes.some(t => /Nature/.test(t) && !/Revue\s*:/.test(t)),
    JSON.stringify(textes));

  const avantChoix = appels.filter(a => a[1].startsWith("/api/article?")).length;
  propositions[0]?.dispatchEvent(clic());
  await attendre(60);

  /* CE QUI COMPTE N'EST PAS QUE LE TITRE SOIT REMPLI — une version fautive
     qui recopierait simplement les champs de la liste le remplirait aussi, et
     mon premier contrôle passait au vert sur cette mutation.
     Ce qui compte est que le choix REPASSE PAR LE DOI : la recherche ne rend
     qu'un résumé de notice, sans abstract, sans pagination, sans rayon. */
  verifier("choisir un candidat relance la recherche par DOI",
    appels.filter(a => a[1].startsWith("/api/article?")).length === avantChoix + 1,
    "aucun appel /api/article après le choix");
  verifier("… et la fiche en ressort classée",
    d.getElementById("fTitre").value === "Deep learning" &&
    d.getElementById("fSous").value === "Numérique, IA & SI",
    d.getElementById("fTitre").value + " / " + d.getElementById("fSous").value);

  /* L'étiquette du champ suit le support au lieu d'affirmer « Revue ».

     ÉPROUVÉ SUR LE CHAPITRE, pas sur l'article de Nature. Vérifier « Revue »
     sur une revue ne prouve rien : une version qui écrit « Revue » sans
     condition passe au vert. C'est le cas où le mot doit CHANGER qui a une
     chance d'échouer. */
  verifier("le champ prend le nom du contenant",
    d.querySelector('label[for="fEditeur"]')?.textContent === "Revue",
    d.querySelector('label[for="fEditeur"]')?.textContent);

  d.getElementById("rechercheDoi").value = "10.1007/978-1-349-02701-9_2";
  d.getElementById("btnChercherDoi").dispatchEvent(clic());
  await attendre(60);
  verifier("… et un chapitre d'ouvrage ne s'appelle pas « Revue »",
    d.querySelector('label[for="fEditeur"]')?.textContent === "Ouvrage",
    d.querySelector('label[for="fEditeur"]')?.textContent);
  verifier("… le contenant reste rempli quel que soit son type",
    d.getElementById("fEditeur").value === "Job Satisfaction — A Reader",
    d.getElementById("fEditeur").value);

  /* ON N'ENREGISTRE PAS CE CHAPITRE. Une première version le sauvait pour en
     ouvrir la fiche : quatre contrôles de comptage en aval, qui attendent UN
     article et trois documents, sont tombés. Même leçon que le 20/08, où
     enrichir le jeu d'essai partagé avait cassé sept assertions étrangères.

     Le jeu d'essai d'une page est un état partagé par tout ce qui suit. Ce
     qu'on y ajoute au milieu, tout le reste le subit. */

  d.getElementById("rechercheDoi").value = "https://doi.org/10.1038/nature14539";
  d.getElementById("btnChercherDoi").dispatchEvent(clic());
  await attendre(60);
  verifier("Crossref remplit le formulaire",
    d.getElementById("fTitre").value === "Deep learning" &&
    d.getElementById("fEditeur").value === "Nature",
    d.getElementById("fTitre").value + " / " + d.getElementById("fEditeur").value);
  verifier("… et un article de revue est marqué sourcé sans qu'on le demande",
    d.getElementById("fSources").value === "oui", d.getElementById("fSources").value);

  d.getElementById("btnEnregistrer").dispatchEvent(clic());
  await attendre(80);

  const envoye = appels.filter(a => a[0] === "PUT" && a[1] === "/api/livres").pop();
  const paquet = [].concat(envoye?.[2] ?? [])[0];
  verifier("l'article est enregistré AVEC son type et son DOI",
    paquet?.type === "article" && paquet?.doi === "10.1038/nature14539",
    JSON.stringify({ type: paquet?.type, doi: paquet?.doi }));
  verifier("… et sa revue, pas son éditeur",
    paquet?.revue === "Nature", String(paquet?.revue));
  verifier("… et sa plage de pages, sans quoi on ne peut pas le citer",
    paquet?.pagination === "436-444", String(paquet?.pagination));

  /* ---- CE QUE LA FICHE AFFICHE VRAIMENT ----------------------------------
     La fiche d'un ARTICLE n'était éprouvée nulle part : ni le volume, ni les
     citations, ni le lien DOI, ni la pagination. J'avais ajouté ces quatre
     affichages en les vérifiant à l'œil, ce qui n'est pas les vérifier.

     Constaté en mutant le 21/08 : retirer la pagination de la fiche ne
     faisait tomber aucun contrôle. Un affichage que rien ne regarde disparaît
     sans bruit — et c'est justement ce qui manque pour citer. */
  const art = lire("livres[livres.length - 1]");
  await lire(`ouvrirFiche(${JSON.stringify(art.id)})`);
  await attendre(60);
  const meta = d.getElementById("ficheMeta")?.textContent ?? "";
  verifier("la fiche d'un article montre sa plage de pages",
    /p\. 436-444/.test(meta), meta);
  verifier("… son volume et son numéro",
    /vol\. 521, n° 7553/.test(meta), meta);
  verifier("… son contenant, et non un éditeur",
    /Nature/.test(meta), meta);
  verifier("… et le DOI est un lien qu'on peut suivre",
    d.getElementById("ficheDoi")?.querySelector("a")?.getAttribute("href")
      === "https://doi.org/10.1038/nature14539",
    String(d.getElementById("ficheDoi")?.querySelector("a")?.getAttribute("href")));
  d.getElementById("fermerFiche")?.dispatchEvent(clic());
  await attendre(30);

  verifier("la bibliothèque compte un document de plus",
    d.querySelectorAll("#liste .fiche").length === 3,
    d.querySelectorAll("#liste .fiche").length + " fiche(s)");

  /* La zone filtre. « Articles » n'en montre qu'un, « Livres » les deux
     autres — c'est ce qui fait de la zone un filtre et non un écran. */
  d.getElementById("zoneArticles").dispatchEvent(clic());
  await attendre(30);
  verifier("la zone Articles n'affiche que les articles",
    d.querySelectorAll("#liste .fiche").length === 1,
    d.querySelectorAll("#liste .fiche").length + " fiche(s)");

  /* « ?. » et non « . » : quand la zone ne rend rien — ce qui est précisément
     le défaut qu'on cherche —, querySelector rend null et le contrôle PLANTE
     au lieu d'échouer. Un plantage n'affiche aucune ligne KO : la mutation
     paraît survivre. Troisième fois que je fais l'erreur ; c'est visiblement
     mon angle mort. */
  const ligneArticle = d.querySelector("#liste .fiche .meta")?.textContent ?? "";
  verifier("une ligne d'article montre sa revue et ses citations",
    /Nature/.test(ligneArticle) && /citations/.test(ligneArticle),
    ligneArticle || "aucune ligne affichée");

  /* L'éditeur d'un article n'est PAS sa revue : Crossref rend « American
     Economic Association » et « Journal of Economic Perspectives ». Afficher
     le premier n'aide personne à retrouver un article. */
  verifier("… et pas son éditeur",
    !/American Economic Association/.test(ligneArticle), ligneArticle);

  d.getElementById("zoneLivres").dispatchEvent(clic());
  await attendre(30);
  verifier("la zone Livres écarte les articles",
    d.querySelectorAll("#liste .fiche").length === 2,
    d.querySelectorAll("#liste .fiche").length + " fiche(s)");

  d.getElementById("zoneTout").dispatchEvent(clic());
  await attendre(30);
  verifier("« Tout » remet livres et articles côte à côte",
    d.querySelectorAll("#liste .fiche").length === 3);

  /* Rouvrir le formulaire d'un LIVRE après un article doit refermer le bloc
     DOI. Sans cela, on chercherait un DOI pour un roman — et le champ resté
     ouvert donne l'impression que l'application a gardé un état d'avant. */
  d.getElementById("ajouter").dispatchEvent(clic());
  await attendre(30);
  verifier("le formulaire revient en mode livre après un article",
    d.getElementById("blocDoi").hidden && !d.getElementById("blocIsbn").hidden,
    "bloc DOI encore ouvert");
  d.getElementById("modale").close();

  /* Vue couvertures */
  d.getElementById("vueGrille").dispatchEvent(new w.Event("click"));
  await attendre(60);
  const img = d.querySelector("#grille .couv img");
  verifier("couverture pointée sur Open Library",
    img && /covers\.openlibrary\.org/.test(img.src), img ? img.src : "aucune");
  d.getElementById("vueListe").dispatchEvent(new w.Event("click"));

  /* Fiche et résumé, une fois connecté */
  await lire('ouvrirFiche("b001")');
  await attendre(120);
  verifier("fiche ouverte", d.getElementById("fiche").open);
  verifier("appel POST /api/resume", appels.some(a => a[1] === "/api/resume" && a[0] === "POST"));
  verifier("résumé affiché", /Résumé de test/.test(d.getElementById("ficheResume").textContent));
  verifier("thèmes cliquables", d.querySelectorAll("#ficheThemes .theme").length === 2);
  d.getElementById("btnFermerFiche").dispatchEvent(new w.Event("click"));

  /* Recommandation */
  d.getElementById("qIntention").value = "mieux décider en incertitude";
  d.getElementById("btnQuete").dispatchEvent(new w.Event("click"));
  await attendre(150);
  verifier("appel POST /api/recommandation", appels.some(a => a[1] === "/api/recommandation"));
  verifier("parcours affiché", d.querySelectorAll("#reponseQuete .etape").length === 1);
  verifier("suggestion externe affichée", d.querySelectorAll("#reponseQuete .externe").length === 1);

  /* Ajout depuis une suggestion */
  d.querySelector("#reponseQuete .externe button").dispatchEvent(new w.Event("click"));
  await attendre(30);
  verifier("formulaire prérempli", d.getElementById("fTitre").value === "Un livre absent");

  /* Recherche bibliographique */
  d.getElementById("rechercheIsbn").value = "Nexus Harari";
  d.getElementById("btnChercher").dispatchEvent(new w.Event("click"));
  await attendre(120);
  verifier("appel POST /api/recherche-livre", appels.some(a => a[1] === "/api/recherche-livre"));
  verifier("formulaire rempli", d.getElementById("fTitre").value === "Nexus");
  verifier("sous-catégorie contrainte", d.getElementById("fSous").value === "Numérique, IA & SI");

  /* Enregistrement */
  const avant = table.length;
  await lire("enregistrer()");
  await attendre(80);
  verifier("PUT /api/livres à l'enregistrement", appels.some(a => a[0] === "PUT" && a[1] === "/api/livres"));
  verifier("ouvrage ajouté", table.length === avant + 1, "table = " + table.length);
  const ajoute = table[table.length - 1];
  verifier("payload en snake_case", "sous_categorie" in ajoute, Object.keys(ajoute).join(","));
  verifier("sphere transmise", ["Perso", "Pro"].includes(ajoute.sphere), String(ajoute.sphere));

  /* Export */
  const csv = lire("versCsv()");
  verifier("CSV avec colonne sphere", csv.split("\n")[0].includes("sphere"));

  /* ------------------------------- Scanner --------------------------------
     jsdom n'exécute pas les scripts de type module et n'a ni caméra ni
     WebAssembly. On ne peut donc pas éprouver le scan lui-même ici — c'est
     une limite réelle, pas un oubli. En revanche, la vérification de la clé
     de contrôle EAN-13 est du calcul pur : elle doit être éprouvée, car
     c'est elle qui empêche une lecture erronée de ramener le mauvais livre. */
  verifier("bouton Scanner présent et masqué sans caméra",
    d.getElementById("btnScanner") !== null && d.getElementById("btnScanner").hidden,
    d.getElementById("btnScanner") ? "visible" : "absent");
  verifier("fenêtre de scan présente", d.getElementById("scanner") !== null);
  verifier("la vidéo est jouable en ligne sur iPhone",
    d.getElementById("scanVideo")?.hasAttribute("playsinline") === true);

  const bloc = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  verifier("bloc du scanner trouvé", !!bloc);
  if (bloc) {
    const source = bloc.match(/function estEan13[\s\S]*?\n}/)[0];
    const estEan13 = new Function(source + "; return estEan13;")();

    const valides = ["9782738149466", "9782226240101", "9782021428582", "9791095438663"];
    const refuses = [
      "9782738149467",   // dernier chiffre faux
      "9782738149",      // trop court
      "97827381494660",  // trop long
      "978273814946X",   // caractère non numérique
      "",
    ];
    verifier("clé EAN-13 : les ISBN réels sont acceptés",
      valides.every(estEan13),
      valides.filter(c => !estEan13(c)).join(", "));
    verifier("clé EAN-13 : un chiffre faux est refusé",
      refuses.every(c => !estEan13(c)),
      refuses.filter(estEan13).join(", "));

    /* ------------------------- La porte de sortie -------------------------
       Deux codes sur dix-huit n'ont pas été lus le 18/08/2026 — 11 %, aperçu
       fluide, donc ni WebKit ni la caméra. La saisie manuelle existait déjà
       mais rien ne la proposait à quelqu'un qui tient son téléphone.

       ON N'ATTEND PAS DOUZE SECONDES POUR L'ÉPROUVER. On remplace « setTimeout »
       par un espion : il capture le délai et le rappel, et on déclenche le
       rappel à la main. Ce qui est vérifié est la LOGIQUE, pas la patience. */
    const bornes = bloc.match(
      /const DELAI_SAISIE_MANUELLE[\s\S]*?function armerSaisieManuelle\(\)[\s\S]*?\n}/)?.[0];
    verifier("le repli de saisie manuelle est présent dans le script", !!bornes);

    if (bornes) {
      const bouton = { hidden: false };          // faux : on part visible…
      let rappel = null, delai = null;
      const fabriquer = new Function("$", "setTimeout", "clearTimeout",
        bornes + "; return { armerSaisieManuelle, DELAI_SAISIE_MANUELLE };");
      const outils = fabriquer(() => bouton,
                               (f, d) => { rappel = f; delai = d; return 1; },
                               () => {});

      outils.armerSaisieManuelle();
      verifier("… et l'armement le masque d'abord", bouton.hidden === true);

      /* Trop tôt, on propose d'abandonner à quelqu'un qui vise encore ; trop
         tard, on l'abandonne vraiment. La borne dit l'intention, pas la
         valeur exacte — 12 s aujourd'hui, ajustable sans casser ce contrôle. */
      verifier("le délai laisse le temps de viser sans faire attendre",
        delai >= 8000 && delai <= 20000, String(delai));

      rappel();
      verifier("passé le délai, la saisie manuelle est offerte",
        bouton.hidden === false);
    }

    verifier("le bouton de saisie manuelle part masqué dans le HTML",
      d.getElementById("scanManuel") !== null && d.getElementById("scanManuel").hidden,
      d.getElementById("scanManuel") ? "visible au chargement" : "absent");

    /* ---------------- La page n'appelle plus Google directement -----------
       Depuis 2026, googleapis.com refuse les requêtes sans clef (429,
       « quota_limit_value: 0 »). La clef ne peut pas descendre dans une page
       publique : elle y serait lisible par tout le monde. Le secours passe
       donc par notre API.

       CONTRÔLE DE FORME, et je préfère le dire : jsdom n'exécute pas ce code
       et ne voit donc pas où part une requête. La mutation qui rétablit
       l'appel direct ne fait tomber AUCUNE vérification de comportement —
       essayée le 18/08. Celle-ci lit la source, ce qui est plus faible, mais
       elle attrape exactement la régression qu'on redoute : quelqu'un qui
       « simplifie » en rappelant Google depuis le navigateur.

       PIÈGE ÉVITÉ DE JUSTESSE : la première version de ce contrôle lisait
       « bloc », c'est-à-dire le script du SCANNER. Or les couvertures vivent
       dans le script principal. La mutation passait donc au vert — un
       contrôle qui regarde au mauvais endroit ne dit rien, et le dit avec
       assurance. On lit le fichier entier. */
    verifier("la page n'appelle pas googleapis directement",
      !/fetch\(\s*["'`][^"'`]*googleapis/.test(html),
      "un fetch vers googleapis.com subsiste dans la page");
  }

  /* ------------- « Informations trouvées » ne se dit plus à vide ----------
     Le 18/08, la page affichait ce message SANS CONDITION, y compris quand
     la recherche n'avait rien rapporté : elle affirmait un succès qu'elle
     n'avait pas eu, puis reprochait à l'utilisateur un formulaire vide
     qu'elle avait laissé vide.

     CONTRÔLE DE FORME, et je préfère le dire : jsdom n'exécute pas ce bloc
     — il vit dans un script que la page charge, et le simuler demanderait
     de reconstruire l'API entière. On vérifie donc que le message est
     GARDÉ par un test sur le titre, ce qui attrape la régression exacte :
     quelqu'un qui remettrait l'affirmation inconditionnelle. */
  const bloc2 = html.match(/async function chercherLivre\(\)[\s\S]*?\n}/)?.[0];
  verifier("le bloc de recherche est trouvé", !!bloc2);
  if (bloc2) {
    verifier("un résultat sans titre est annoncé comme introuvable",
      /if\s*\(!info\.titre\)/.test(bloc2)
      && /Aucun catalogue ne conna/.test(bloc2),
      "rien ne distingue le succès de l'échec");
    /* CE QU'IL FAUT VÉRIFIER EST QUE LE GARDE SORT, pas où il se trouve.
     *
     * Première version : comparer les positions du garde et du message de
     * succès dans le texte source. Elle échouait — parce que le COMMENTAIRE
     * qui explique le correctif cite le message, et qu'il est placé avant le
     * garde. L'indexOf tombait sur la documentation.
     *
     * Un contrôle mis en échec par sa propre explication : c'est ce qui
     * arrive quand on mesure la forme du texte plutôt que le comportement.
     * Ici, la propriété est « le garde interrompt la fonction » — un return
     * entre l'accolade ouvrante et sa fermeture. */
    verifier("… et ce garde interrompt la fonction",
      /if\s*\(!info\.titre\)\s*\{[^}]*?\breturn;/s.test(bloc2),
      "le garde n'a pas de return : le message de succès s'affichera quand même");
    verifier("… l'ISBN scanné est reporté pour la saisie manuelle",
      /fIsbn"\)\.value = isbnLu/.test(bloc2),
      "il faudrait recopier treize chiffres à la main");
  }

  /* Déconnexion */
  d.getElementById("btnDeconnexion").dispatchEvent(new w.Event("click"));
  await attendre(60);
  verifier("appel POST /api/deconnexion", appels.some(a => a[1] === "/api/deconnexion"));

  console.log("\n" + ok.length + " vérifications passées");
  ok.forEach(o => console.log("  ok   " + o));
  if (erreurs.length) {
    console.log("\n" + erreurs.length + " ÉCHECS");
    erreurs.forEach(e => console.log("  KO   " + e));
    process.exit(1);
  }
  console.log("\nAucune erreur.");
})();
