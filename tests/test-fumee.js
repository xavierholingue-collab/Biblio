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
    categorie: "Académique", sous_categorie: "Décision, biais & rationalité", sphere: "Pro",
    cover_url: null, cover_statut: "inconnu", resume: null, resume_points: null,
    resume_themes: null, resume_modele: null, resume_fiabilite: null, resume_genere_le: null },
  { id: "b002", isbn: "9782266243124", titre: "Ne le dis à personne",
    auteur: "Coben Harlan", editeur: "Pocket", annee: 2004, statut: "Lu", note: 4,
    categorie: "Roman", sous_categorie: "Polar & thriller", sphere: "Perso",
    cover_url: null, cover_statut: "inconnu", resume: null, resume_points: null,
    resume_themes: null, resume_modele: null, resume_fiabilite: null, resume_genere_le: null },
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
    return reponse({ perimetre: connecte ? "complet" : "professionnel",
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
  if (chemin === "/api/recherche-livre") {
    return reponse({ titre: "Nexus", auteur: "Harari Yuval Noah", editeur: "Albin Michel",
                     annee: 2024, isbn: "9782226476494", categorie: "Académique",
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
