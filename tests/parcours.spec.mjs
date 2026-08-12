/* =========================================================================
   PARCOURS EN NAVIGATEUR RÉEL

   Ce que les autres contrôles ne peuvent pas voir, et pourquoi cet étage
   existe.

   jsdom, qui sert aux tests de fumée, n'applique ni feuille de style, ni
   mise en page, ni politique de sécurité du contenu. Il exécute le script
   quoi qu'il arrive. Le 04/08/2026, la page publique s'est retrouvée en
   ligne avec « Chargement des statistiques… » figé pendant des heures : la
   CSP servie par Caddy portait « script-src 'self' », qui interdit les
   scripts en ligne, et l'application tient en un seul fichier HTML, script
   compris. Aucun test ne pouvait le voir — celui qui aurait dû, tournait
   dans un DOM sans politique de sécurité. Le défaut a été trouvé à l'œil.

   Ces vérifications-ci tournent contre l'INSTANCE DÉPLOYÉE, dans un vrai
   navigateur, après la livraison. Elles couvrent trois familles :

     1. la page s'exécute — aucune erreur de console, aucun script refusé ;
     2. la figure suit les données — les aires RENDUES, mesurées en pixels
        à l'écran, correspondent aux effectifs renvoyés par l'API ;
     3. la frontière Pro / Perso tient — rien de personnel dans le HTML
        servi à un visiteur.

   Usage :  npx playwright test --config tests/playwright.config.mjs
   ========================================================================= */

import { test, expect } from "@playwright/test";

/* Recueille toute plainte du navigateur. Une violation de CSP se manifeste
   ici, sous la forme d'un message « Refused to execute inline script… ».   */
function surveiller(page) {
  const plaintes = [];
  page.on("console", m => { if (m.type() === "error") plaintes.push("console : " + m.text()); });
  page.on("pageerror", e => plaintes.push("exception : " + String(e)));
  page.on("requestfailed", r => {
    // Les couvertures distantes peuvent légitimement manquer, et l'absence
    // de favicon n'a jamais empêché personne de lire une page.
    const u = r.url();
    if (!/covers\.openlibrary\.org|books\.google\.com|googleusercontent|favicon/.test(u)) {
      plaintes.push("requête échouée : " + u + " (" + (r.failure()?.errorText ?? "?") + ")");
    }
  });
  return plaintes;
}

/* ------------------------------------------------------------------------ */

test.describe("Page d'accueil publique", () => {

  test("la page s'exécute sans être bridée par la politique de contenu", async ({ page }) => {
    const plaintes = surveiller(page);
    await page.goto("/", { waitUntil: "networkidle" });

    // Si le script est bloqué, ce bandeau ne disparaît jamais. C'est
    // exactement le symptôme observé le 04/08/2026.
    await expect(page.locator("#chargement")).toBeHidden();
    await expect(page.locator("#contenu")).toBeVisible();

    expect(plaintes, "le navigateur s'est plaint :\n  " + plaintes.join("\n  ")).toEqual([]);
  });

  test("les chiffres sont réellement affichés", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const vignettes = page.locator("#chiffres .chiffre");
    await expect(vignettes).toHaveCount(6);

    // Aucun « — » ni case vide : une vignette sans valeur signale que la
    // donnée n'est pas arrivée jusqu'à la page.
    const valeurs = await page.locator("#chiffres .chiffre .n").allTextContents();
    for (const v of valeurs) expect(v.trim().length, "vignette vide").toBeGreaterThan(0);

    // La note moyenne doit dire sur combien d'ouvrages elle porte.
    await expect(page.locator("#chiffres")).toContainText(/not[ée]s\)/);
  });

  test("l'aire rendue de chaque tuile correspond à l'effectif du rayon", async ({ page, request }) => {
    const stats = await (await request.get("/api/statistiques")).json();
    const total = stats.total;

    await page.goto("/", { waitUntil: "networkidle" });
    const tuiles = page.locator("#mosaique .tuile");
    await expect(tuiles).toHaveCount(stats.sous_categories.length);

    // On mesure ce que le NAVIGATEUR a posé à l'écran, pas ce que le script
    // a calculé : c'est la seule mesure qui prouve que la figure est juste
    // une fois la feuille de style appliquée.
    const mesures = await tuiles.evaluateAll(els => els.map(e => {
      const r = e.getBoundingClientRect();
      return { nom: e.querySelector(".nom")?.textContent?.trim() ?? "", w: r.width, h: r.height };
    }));

    const cadre = await page.locator("#mosaique").boundingBox();
    const surface = cadre.width * cadre.height;
    expect(surface, "la mosaïque n'occupe aucune surface").toBeGreaterThan(10_000);

    for (const m of mesures) {
      const rayon = stats.sous_categories.find(s => s.sous_categorie === m.nom);
      if (!rayon) continue;                       // tuile trop petite pour son nom
      const part = (m.w * m.h) / surface;
      // Une tolérance d'un point de pourcentage absorbe les bordures et
      // l'arrondi au pixel, sans laisser passer une erreur d'encodage.
      expect(Math.abs(part - rayon.n / total),
        `« ${m.nom} » occupe ${(part * 100).toFixed(1)} % pour ${rayon.n}/${total} ouvrages`)
        .toBeLessThan(0.01);
    }

    // Toutes les tuiles doivent être visibles et cliquables.
    for (const m of mesures) {
      expect(m.w, `tuile « ${m.nom} » sans largeur`).toBeGreaterThan(1);
      expect(m.h, `tuile « ${m.nom} » sans hauteur`).toBeGreaterThan(1);
    }
  });

  test("la mosaïque ne déborde pas et la page ne défile pas latéralement", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const cadre = await page.locator("#mosaique").boundingBox();

    const debordent = await page.locator("#mosaique .tuile").evaluateAll((els, c) =>
      els.filter(e => {
        const r = e.getBoundingClientRect();
        return r.left < c.x - 1 || r.top < c.y - 1
            || r.right > c.x + c.width + 1 || r.bottom > c.y + c.height + 1;
      }).map(e => e.querySelector(".nom")?.textContent ?? "?"), cadre);
    expect(debordent, "tuiles hors cadre").toEqual([]);

    const largeurs = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      fenetre: window.innerWidth,
    }));
    expect(largeurs.document, "la page défile latéralement")
      .toBeLessThanOrEqual(largeurs.fenetre + 1);
  });

  test("cliquer un rayon ouvre l'application filtrée sur ce rayon", async ({ page }) => {
    const plaintes = surveiller(page);
    await page.goto("/", { waitUntil: "networkidle" });

    const tuile = page.locator("#mosaique .tuile").first();
    const nom = (await tuile.locator(".nom").textContent()).trim();
    await tuile.click();

    await page.waitForURL(/ma-bibliotheque\.html\?rayon=/);
    await expect(page.locator("#mosaique .tuile[aria-pressed='true']")).toHaveCount(1);

    // La liste doit être restreinte à ce rayon, et le dire.
    const fiches = page.locator("#liste .fiche");
    await expect(fiches).not.toHaveCount(0);
    await expect(page.locator("#compteTexte")).toContainText("/");

    expect(plaintes, "le navigateur s'est plaint :\n  " + plaintes.join("\n  ")).toEqual([]);
    expect(decodeURIComponent(new URL(page.url()).searchParams.get("rayon"))).toBe(nom);
  });
});

/* ------------------------------------------------------------------------ */

test.describe("Ce qui doit rester fermé", () => {

  test("aucun ouvrage personnel dans la page servie à un visiteur", async ({ page, request }) => {
    const livres = await (await request.get("/api/livres")).json();
    const liste = Array.isArray(livres) ? livres
      : Object.values(livres).find(v => Array.isArray(v)) ?? [];
    expect(liste.length, "aucun ouvrage retourné").toBeGreaterThan(0);
    expect(liste.filter(l => l.sphere === "Perso"),
      "des ouvrages personnels sont exposés publiquement").toEqual([]);

    await page.goto("/ma-bibliotheque.html", { waitUntil: "networkidle" });

    // On interroge les données que l'application détient réellement en
    // mémoire, et non le texte de la page.
    //
    // Une première version cherchait la chaîne « Perso » dans le HTML. Elle
    // aurait échoué à tous les coups : l'interface contient le mot dans son
    // propre code — le sélecteur « Perso et Pro », le bouton « Espace
    // personnel ». Un contrôle qui échoue toujours ne vaut pas mieux qu'un
    // contrôle qui réussit toujours : dans les deux cas il n'apprend rien.
    // « let livres = [] » au sommet d'un script classique crée une liaison
    // LEXICALE : elle est visible sous le nom « livres », mais n'apparaît
    // pas sur globalThis. Passer par globalThis.livres rendrait undefined
    // et ferait échouer ce contrôle sans qu'aucun ouvrage soit exposé.
    const spheres = await page.evaluate(() => {
      if (typeof livres === "undefined" || !Array.isArray(livres)) return null;
      return [...new Set(livres.map(l => l.sphere))];
    });
    expect(spheres, "impossible de lire les ouvrages chargés").not.toBeNull();
    expect(spheres, "un visiteur voit des ouvrages hors du périmètre Pro").toEqual(["Pro"]);
  });

  test("les en-têtes de sécurité sont bien servis", async ({ request }) => {
    const r = await request.get("/");
    const h = r.headers();

    expect(h["content-security-policy"], "aucune politique de contenu servie").toBeTruthy();
    const csp = h["content-security-policy"];
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
      expect(csp, "directive manquante : " + directive).toContain(directive);
    }
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["strict-transport-security"]).toContain("max-age=");

    // Un rappel volontaire : tant que 'unsafe-inline' est là, la protection
    // contre l'injection de script est affaiblie. Ce contrôle ne fait pas
    // échouer la chaîne — il inscrit la dette dans le journal de livraison,
    // pour qu'elle ne s'oublie pas.
    if (csp.includes("'unsafe-inline'") && csp.includes("script-src")) {
      console.log("\n  DETTE : script-src autorise encore 'unsafe-inline'."
        + " La correction est une empreinte sha256 calculée à la livraison.\n");
    }
  });

  test("les tests et les dépendances ne sont pas servis", async ({ request }) => {
    for (const chemin of ["/test/test-fumee.js", "/node_modules/", "/test/"]) {
      const r = await request.get(chemin, { maxRedirects: 0 });
      expect(r.status(), chemin + " est accessible").toBe(404);
    }
  });
});
