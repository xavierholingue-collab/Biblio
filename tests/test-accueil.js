/* Test de la page d'accueil publique.
   Charge index.html dans un DOM simulé, avec /api/statistiques simulée, et
   vérifie que la figure DIT ce qu'elle prétend dire.

   POURQUOI CE TEST EXISTE
   La version précédente dessinait un « mur d'étagère » dont la hauteur de
   chaque dos valait 45 + ((i * 37 + n * 13) % 55) — une fonction de l'INDICE
   de boucle. La figure portait role="img" et l'étiquette « Vue d'ensemble de
   la bibliothèque » ; elle n'encodait rien. Aucun test ne pouvait échouer,
   puisqu'aucun ne portait sur cette page.

   Les vérifications ci-dessous sont donc écrites pour tomber si la géométrie
   cesse de suivre les données : les aires doivent rester proportionnelles au
   nombre d'ouvrages, et un rayon deux fois plus fourni doit occuper deux
   fois plus de place.

   Usage :  npm install jsdom  puis  node test-accueil.js                    */

const fs = require("fs");
const chemin = require("path");
const { JSDOM } = require("jsdom");

const CANDIDATS = [
  chemin.join(__dirname, "..", "index.html"),        // web/test/
  chemin.join(__dirname, "..", "web", "index.html"), // tests/ à la racine
  chemin.join(process.cwd(), "web", "index.html"),   // lancé depuis la racine
];
const HTML = CANDIDATS.find(c => fs.existsSync(c));
if (!HTML) {
  console.error("index.html introuvable. Emplacements essayés :");
  CANDIDATS.forEach(c => console.error("  " + c));
  process.exit(1);
}
const html = fs.readFileSync(HTML, "utf8");

const erreurs = [], ok = [];
function verifier(nom, condition, detail) {
  (condition ? ok : erreurs).push(nom + (condition ? "" : " — " + (detail ?? "")));
}

/* --------------------------- Statistiques simulées -------------------------
   Volontairement déséquilibrées : 40, 20, 10, 5, 1. Si les aires suivent les
   effectifs, les rapports 2:1 doivent se retrouver dans la géométrie. Un
   jeu de données uniforme ne prouverait rien.                               */
const RAYONS = [
  { sous_categorie: "Politique, société & géopolitique", categorie: "Académique", n: 40, lus: 40, pages_volume: 12000, pages_connues: 30 },
  { sous_categorie: "Philosophie",                       categorie: "Académique", n: 20, lus: 10 },
  { sous_categorie: "Management & leadership",           categorie: "Académique", n: 10, lus: 5 },
  { sous_categorie: "Économie",                          categorie: "Académique", n: 5,  lus: 0 },
  { sous_categorie: "Classique",                         categorie: "Roman",      n: 1,  lus: 1 },
];
const TOTAL = RAYONS.reduce((s, r) => s + r.n, 0);   // 76

const STATS = {
  perimetre: "public",
  total: TOTAL, lus: 56, en_cours: 0, a_lire: 20,
  avec_resume: 70, auteurs: 60, rayons: RAYONS.length,
  note_moyenne: 4.32,
  notes: 19,
  // 12 000 pages connues sur 30 ouvrages seulement : le taux de couverture
  // doit apparaitre, sinon le chiffre se lirait comme le volume des 76.
  pages_volume: 12000, pages_connues: 30,                       // 19 ouvrages notés sur 76 : c'est le point
  annee_min: 1949, annee_max: 2025,
  sous_categories: RAYONS,
  decennies: [{ decennie: 2010, n: 30 }, { decennie: 2020, n: 46 }],
  auteurs_recurrents: [{ auteur: "Kahneman Daniel", n: 3 }],
  plus_recents: [{ id: "x1", titre: "Un titre", auteur: "Un auteur", annee: 2025, sous_categorie: "Philosophie" }],
};

const LARGEUR = 900, HAUTEUR = 320;

const sansScripts = html.replace(/<script>[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(sansScripts, { runScripts: "dangerously", pretendToBeVisual: true,
                                     url: "http://localhost:8080/" });
const w = dom.window;
w.onerror = m => erreurs.push("erreur JS : " + m);

// jsdom ne fait aucune mise en page : sans dimensions, le pavage n'a pas de
// surface à découper et ne dessinerait rien.
Object.defineProperty(w.HTMLElement.prototype, "clientWidth",
  { configurable: true, get() { return this.id === "mosaique" ? LARGEUR : 0; } });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight",
  { configurable: true, get() { return this.id === "mosaique" ? HAUTEUR : 0; } });

const appels = [];
w.fetch = (url) => {
  appels.push(String(url));
  if (String(url).includes("/api/statistiques")) {
    return Promise.resolve({ ok: true, status: 200, json: async () => STATS });
  }
  return Promise.reject(new Error("réseau coupé"));
};

/* -------------------------------- Exécution ------------------------------- */

/* ON NOMME CE QU'ON ATTEND, ON NE LE COMPTE PAS.
 *
 * Ce contrôle exigeait « un bloc de script ». Le 15/08/2026, l'ajout du
 * bandeau de recette en a fait deux, et la chaîne s'est arrêtée sur une
 * page parfaitement saine — DEUX FOIS, parce que le même défaut existait
 * dans test-fumee.js et que je n'avais réparé que celui qui criait.
 *
 * Un compte de blocs est une propriété de la MISE EN FORME, pas du
 * comportement : il tombe dès qu'on ajoute quelque chose de légitime, et
 * il reste muet le jour où le script qui compte vraiment disparaît.
 *
 * Tous les blocs sont exécutés — la page en a besoin — mais c'est la
 * PRÉSENCE de celui qui dessine la mosaïque qu'on vérifie. */
const blocs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
verifier("le script qui dessine la mosaïque est présent",
  blocs.some(b => /dessinerMosaique|\/api\/statistiques/.test(b)),
  "aucun des " + blocs.length + " blocs ne le contient");

const attendre = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const d = w.document;
  blocs.forEach(b => { const s = d.createElement("script"); s.textContent = b; d.body.appendChild(s); });
  await attendre(120);

  verifier("les statistiques ont été demandées",
    appels.some(u => u.includes("/api/statistiques")));
  verifier("contenu affiché", d.getElementById("contenu").hidden === false);
  verifier("bandeau de chargement retiré", d.getElementById("chargement").hidden === true);

  /* ------------------------- La figure et les données ---------------------- */

  const tuiles = [...d.querySelectorAll("#mosaique .tuile")];
  verifier("une tuile par rayon", tuiles.length === RAYONS.length,
    tuiles.length + " tuile(s) pour " + RAYONS.length + " rayons");

  const aire = t => parseFloat(t.style.width) * parseFloat(t.style.height);
  const surface = LARGEUR * HAUTEUR;

  if (tuiles.length === RAYONS.length) {
    // Chaque tuile occupe-t-elle la part qui lui revient ?
    let ecartMax = 0, coupable = "";
    tuiles.forEach(t => {
      const nom = t.querySelector(".nom").textContent;
      const attendu = RAYONS.find(r => r.sous_categorie === nom);
      const partReelle = aire(t) / surface;
      const partAttendue = attendu ? attendu.n / TOTAL : NaN;
      const ecart = Math.abs(partReelle - partAttendue);
      if (!(ecart <= ecartMax)) { ecartMax = ecart; coupable = nom; }
    });
    verifier("l'aire de chaque tuile suit son effectif",
      ecartMax < 0.005,
      "écart max " + (ecartMax * 100).toFixed(2) + " point de % sur « " + coupable + " »");

    // Le rapport 2:1 entre le premier et le deuxième rayon doit se voir.
    const par = {};
    tuiles.forEach(t => { par[t.querySelector(".nom").textContent] = aire(t); });
    const rapport = par["Politique, société & géopolitique"] / par["Philosophie"];
    verifier("un rayon deux fois plus fourni occupe deux fois plus de place",
      Math.abs(rapport - 2) < 0.05, "rapport observé " + rapport.toFixed(3));

    verifier("la mosaïque couvre son cadre",
      Math.abs(tuiles.reduce((s, t) => s + aire(t), 0) - surface) / surface < 0.01);

    // Aucune tuile ne doit déborder ni se placer hors cadre.
    const dehors = tuiles.filter(t => {
      const x = parseFloat(t.style.left), y = parseFloat(t.style.top);
      const lw = parseFloat(t.style.width), lh = parseFloat(t.style.height);
      return x < -0.5 || y < -0.5 || x + lw > LARGEUR + 0.5 || y + lh > HAUTEUR + 0.5;
    });
    verifier("aucune tuile hors du cadre", dehors.length === 0, dehors.length + " débordement(s)");
  }

  /* ------------------------------ L'interaction ---------------------------- */

  const liens = tuiles.map(t => t.getAttribute("href") || "");
  verifier("chaque tuile mène au rayon correspondant",
    liens.length > 0 && liens.every(h => h.startsWith("/ma-bibliotheque.html?rayon=")),
    liens[0]);
  verifier("le nom du rayon est encodé dans le lien",
    liens.some(h => h.includes(encodeURIComponent("Politique, société & géopolitique"))),
    liens.join(" | ").slice(0, 120));
  verifier("chaque tuile porte une étiquette lisible par un lecteur d'écran",
    tuiles.every(t => (t.getAttribute("aria-label") || "").length > 10));

  /* ------------------------- Ce que la page affirme ------------------------ */

  const chiffres = d.getElementById("chiffres").textContent;
  verifier("la note moyenne dit sur combien d'ouvrages elle porte",
    /19 not/.test(chiffres),
    "étiquettes : " + chiffres.replace(/\s+/g, " ").slice(0, 200));
  verifier("la note moyenne n'est pas présentée comme portant sur tous les ouvrages",
    !/note moyenne(?!\s*\()/.test(chiffres.replace(/\s+/g, " ")));

  verifier("le volume de pages dit sur combien d'ouvrages il porte",
    /12\s*000/.test(chiffres.replace(/\s+/g, " ")) && /30 ouvrages sur 76/.test(chiffres.replace(/\s+/g, " ")),
    chiffres.replace(/\s+/g, " ").slice(0, 240));
  verifier("le volume n'est pas présenté comme celui de la bibliothèque",
    !/12 000\s*pages\s*$/.test(chiffres.trim()));

  const legende = d.getElementById("legendeMosaique").textContent;
  verifier("la légende explique ce que l'aire encode", /[Aa]ire/.test(legende), legende.slice(0, 120));
  verifier("la légende dit que l'aire n'est PAS le volume",
    /pas à leur volume/.test(legende), legende.slice(0, 200));
  verifier("la légende annonce le périmètre", /publié/.test(legende), legende.slice(0, 120));

  /* ------------------ La figure décorative a bien disparu ------------------ */

  verifier("plus de dos d'étagère", d.querySelectorAll(".dos").length === 0);
  verifier("plus de hauteur pseudo-aléatoire dans le source",
    !/%\s*55\b/.test(html) && !/i\s*\*\s*37/.test(html));

  /* --------------------------------- Bilan --------------------------------- */

  console.log("\n=== Page d'accueil ===\n");
  ok.forEach(t => console.log("  ok   " + t));
  if (erreurs.length) {
    console.log("");
    erreurs.forEach(t => console.log("  NON  " + t));
    console.log("\n" + erreurs.length + " vérification(s) en échec sur " + (ok.length + erreurs.length) + ".");
    process.exit(1);
  }
  console.log("\n" + ok.length + " vérifications, aucune erreur.");
})();
