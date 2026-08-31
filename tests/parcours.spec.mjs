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
    await page.goto("/bibliotheque-publique.html", { waitUntil: "networkidle" });

    // Si le script est bloqué, ce bandeau ne disparaît jamais. C'est
    // exactement le symptôme observé le 04/08/2026.
    await expect(page.locator("#chargement")).toBeHidden();
    await expect(page.locator("#contenu")).toBeVisible();

    expect(plaintes, "le navigateur s'est plaint :\n  " + plaintes.join("\n  ")).toEqual([]);
  });

  test("les chiffres sont réellement affichés", async ({ page }) => {
    await page.goto("/bibliotheque-publique.html", { waitUntil: "networkidle" });
    /* On vérifie que les mesures ATTENDUES sont là, pas qu'il y en ait un
       certain nombre.

       Ce contrôle exigeait exactement six vignettes. L'ajout d'une septième —
       le volume de pages — l'a fait échouer le 14/08/2026, sans rien révéler
       du système : la page allait parfaitement bien. Un test qui tombe à
       chaque enrichissement finit par être assoupli sans qu'on y pense, et
       c'est alors la disparition d'une mesure qui passera inaperçue.

       Nommer ce qu'on attend attrape le vrai risque — une mesure qui
       disparaît — sans punir l'ajout. */
    const vignettes = page.locator("#chiffres .chiffre");
    await expect(vignettes.first()).toBeVisible();

    const etiquettes = (await page.locator("#chiffres .quoi").allTextContents())
      .join(" | ").toLowerCase();
    for (const attendue of ["ouvrages", "lus", "sur la pile", "résumés", "auteurs", "note"]) {
      expect(etiquettes, `mesure disparue : ${attendue}`).toContain(attendue);
    }

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

    await page.goto("/bibliotheque-publique.html", { waitUntil: "networkidle" });
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
    await page.goto("/bibliotheque-publique.html", { waitUntil: "networkidle" });
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
    await page.goto("/bibliotheque-publique.html", { waitUntil: "networkidle" });

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

test.describe("Ajout d'un ouvrage", () => {

  /* Ce contrôle existe à cause d'un défaut précis, constaté le 12/08/2026 sur
     iPhone : le bouton « Scanner » était hors de l'écran, poussé à droite par
     un champ de saisie qui refusait de rétrécir — min-width: auto, la valeur
     par défaut d'un élément flex. Le bouton existait dans le HTML, tous les
     contrôles passaient, et il était invisible.

     Vérifier la présence d'un élément ne prouve donc rien. On mesure ici sa
     position RÉELLE dans la fenêtre. */
  test("sur téléphone, le bouton Scanner est entièrement visible", async ({ page }, infos) => {
    test.skip(infos.project.name !== "mobile", "ne concerne que l'affichage téléphone");
    const motDePasse = process.env.MOT_DE_PASSE;
    test.skip(!motDePasse, "sans mot de passe, le formulaire d'ajout reste fermé");

    const plaintes = surveiller(page);
    await page.goto("/ma-bibliotheque.html", { waitUntil: "networkidle" });

    await page.locator("#btnConnecter").click();
    await page.locator("#cMdp").fill(motDePasse);
    await page.locator("#btnConnexion").click();
    await expect(page.locator("#ajouter")).toBeVisible();

    await page.locator("#ajouter").click();
    const bouton = page.locator("#btnScanner");
    await expect(bouton, "le bouton Scanner n'apparaît pas").toBeVisible();

    const cadre = await bouton.boundingBox();
    const ecran = page.viewportSize();
    expect(cadre.x, "le bouton déborde à gauche").toBeGreaterThanOrEqual(-1);
    expect(cadre.x + cadre.width, `le bouton déborde de ${Math.round(cadre.x + cadre.width - ecran.width)} px à droite`)
      .toBeLessThanOrEqual(ecran.width + 1);
    expect(cadre.y + cadre.height, "le bouton est sous la ligne de flottaison")
      .toBeLessThanOrEqual(ecran.height + 1);

    // Une cible tactile confortable fait au moins 44 points de côté.
    expect(cadre.height, "cible tactile trop petite").toBeGreaterThanOrEqual(40);

    // La page elle-même ne doit pas défiler latéralement.
    const l = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth, vue: window.innerWidth }));
    expect(l.doc, "le formulaire déborde horizontalement").toBeLessThanOrEqual(l.vue + 1);

    expect(plaintes, "le navigateur s'est plaint :\n  " + plaintes.join("\n  ")).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */

test.describe("Ce qui doit rester fermé", () => {

  /* ======================================================================
     ON VÉRIFIE LA VISIBILITÉ, PLUS LA SPHÈRE.

     Ce contrôle exigeait « aucun ouvrage de sphère Perso n'est servi à un
     visiteur ». C'était juste tant que « Pro = public, Perso = privé » était
     une règle écrite dans le code.

     Le menu de réglages, livré le 16/08/2026, l'a remplacée par une décision
     de l'utilisateur. Le soir même, deux romans personnels — les tomes 1 et 4
     du « Guide du voyageur galactique » — ont été publiés volontairement, et
     ce contrôle a annoncé « des ouvrages personnels sont exposés
     publiquement ». Il disait vrai, et il avait tort : c'était une
     publication, pas une fuite.

     Septième occurrence de la même famille en une semaine, et la seconde
     fois que je répare celui qui crie sans chercher les autres. D'où la
     recherche systématique qui a suivi : « sphere » est un CLASSEMENT — Pro,
     Perso — et n'a plus aucun rapport avec ce qui se montre.

     La propriété, elle, ne dépend d'aucun réglage et ne périmera pas :
     RIEN DE CE QUI EST MARQUÉ PRIVÉ NE DOIT SORTIR.
     ====================================================================== */
  test("aucun ouvrage marqué privé n'est servi à un visiteur", async ({ page, request }) => {
    const livres = await (await request.get("/api/livres")).json();
    const liste = Array.isArray(livres) ? livres
      : Object.values(livres).find(v => Array.isArray(v)) ?? [];
    expect(liste.length, "aucun ouvrage retourné").toBeGreaterThan(0);
    expect(liste.filter(l => l.visibilite === "privee").map(l => l.titre),
      "des ouvrages marqués privés sont exposés publiquement").toEqual([]);

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
    const charges = await page.evaluate(() => {
      if (typeof livres === "undefined" || !Array.isArray(livres)) return null;
      return {
        combien: livres.length,
        prives: livres.filter(l => l.visibilite === "privee").map(l => l.titre),
        // Le champ est-il seulement là ? Sans lui, le filtre ci-dessus ne
        // trouve jamais rien et ce contrôle devient une formalité.
        renseignes: livres.filter(l => typeof l.visibilite === "string").length,
      };
    });
    expect(charges, "impossible de lire les ouvrages chargés").not.toBeNull();

    /* LE CONTRÔLE DU CONTRÔLE.
       « visibilite » ne traversait pas versApp() jusqu'au 16/08/2026 : la
       vérification ci-dessous cherchait un champ absent, ne trouvait rien, et
       passait au vert quoi qu'il arrive. On vérifie donc d'abord qu'il y a
       quelque chose à regarder. */
    expect(charges.renseignes,
      "la page ne connaît la visibilité d'aucun ouvrage : le contrôle suivant serait vide")
      .toBe(charges.combien);
    expect(charges.combien, "la page n'a chargé aucun ouvrage").toBeGreaterThan(0);
    expect(charges.prives,
      "la page détient en mémoire des ouvrages marqués privés").toEqual([]);

    /* LA PAGE NE DOIT PAS EN DÉTENIR PLUS QUE L'API N'EN SERT.
       Comparer les deux ensembles attrape ce qu'aucune règle sur les champs
       ne verrait — un cache, un jeu d'amorce oublié, une seconde requête
       faite dans un autre contexte. */
    expect(charges.combien,
      "la page détient plus d'ouvrages que l'API n'en sert à un visiteur")
      .toBe(liste.length);
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

    /* Rappel de dette, s'il en reste une.
       CORRIGÉ le 14/08/2026 : la condition cherchait 'unsafe-inline' dans la
       politique ENTIÈRE. Or elle y figure encore légitimement — dans
       style-src, que les empreintes ne peuvent pas couvrir puisque le script
       pose des attributs style=. Le message s'affichait donc alors même que
       script-src était devenu propre : un rapport qui annonce une dette
       soldée est une désinformation, plus nuisible qu'un silence. */
    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? "";
    if (scriptSrc.includes("'unsafe-inline'")) {
      console.log("\n  DETTE : script-src autorise encore 'unsafe-inline'."
        + " La correction est une empreinte sha256 calculée à la livraison.\n");
    }
  });

  /* Le lecteur de codes-barres tient en deux fichiers servis par Caddy et en
     un mot-clef de la politique de contenu. Si l'un des trois manque, le
     bouton « Scanner » ouvre la caméra puis échoue — et l'échec ne se voit
     que sur un téléphone, devant une étagère. C'est le genre de panne qu'on
     découvre au pire moment. */
  test("le lecteur de codes-barres est réellement livré", async ({ request }) => {
    const mjs = await request.get("/scanner/zbar-wasm.mjs");
    expect(mjs.status(), "le module du scanner n'est pas servi").toBe(200);
    expect(mjs.headers()["content-type"] ?? "", "servi avec un type qui empêche l'import")
      .toMatch(/javascript/);

    const wasm = await request.get("/scanner/zbar.wasm");
    expect(wasm.status(), "le WebAssembly du scanner n'est pas servi").toBe(200);
    const octets = (await wasm.body()).length;
    expect(octets, "fichier WebAssembly suspect : " + octets + " octets")
      .toBeGreaterThan(100_000);

    const csp = (await request.get("/")).headers()["content-security-policy"] ?? "";
    expect(csp, "sans 'wasm-unsafe-eval', le navigateur refusera d'instancier zbar")
      .toContain("'wasm-unsafe-eval'");
  });

  /* La dette du 04/08/2026 : script-src autorisait 'unsafe-inline', c'est-à-
     dire n'importe quel script injecté dans la page. Elle est remplacée par
     des empreintes sha256 calculées à la livraison.

     Ce contrôle ne se contente pas de constater l'absence du mot-clef : il
     vérifie que des empreintes ont bien pris sa place. Une politique sans
     'unsafe-inline' ET sans empreinte bloquerait tous les scripts — la page
     serait servie, muette, exactement comme lors de la panne d'origine.
     C'est le test « la page s'exécute » qui attraperait ce cas, mais autant
     dire ici ce qu'on attend. */
  test("les scripts sont autorisés par empreinte, pas par 'unsafe-inline'", async ({ request }) => {
    const csp = (await request.get("/")).headers()["content-security-policy"] ?? "";
    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? "";

    const empreintes = scriptSrc.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? [];
    expect(empreintes.length, "aucune empreinte dans script-src : " + scriptSrc.trim())
      .toBeGreaterThan(0);
    expect(scriptSrc, "'unsafe-inline' est encore là — les empreintes ne servent alors à rien")
      .not.toContain("'unsafe-inline'");
  });

  test("les tests et les dépendances ne sont pas servis", async ({ request }) => {
    for (const chemin of ["/test/test-fumee.js", "/node_modules/", "/test/"]) {
      const r = await request.get(chemin, { maxRedirects: 0 });
      expect(r.status(), chemin + " est accessible").toBe(404);
    }
  });
});
