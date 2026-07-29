/* Test de fumée du front Docker : charge l'application dans un DOM simulé,
   avec une API simulée, et vérifie le parcours complet sans réseau réel.

   Usage :  npm install jsdom  puis  node test-fumee.js                        */

const fs = require("fs");
const { JSDOM } = require("jsdom");

const HTML = require("path").join(__dirname, "..", "ma-bibliotheque.html");
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

const blocs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
verifier("deux blocs de script trouvés", blocs.length === 2, "trouvé " + blocs.length);

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
  verifier("étagère dessinée", d.querySelectorAll("#etagere .dos").length === 2);

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
