/* =========================================================================
   UNE COULEUR NE S'ÉCRIT QU'À UN ENDROIT

   ---------------------------------------------------------------------------
   POURQUOI CE CONTRÔLE

   Les trois écrans déclaraient chacun leur palette dans leur propre
   « :root ». Trois copies d'une même vérité — et le dépôt sait déjà ce que
   coûtent les copies : le domaine écrit dans douze fichiers, six listes
   manuelles, un plafond en deux exemplaires.

   Une couleur qui dérive ne casse rien. Elle produit deux écrans presque
   pareils, et personne ne sait lequel a raison.

   ---------------------------------------------------------------------------
   LA RÈGLE EST UNE PROPRIÉTÉ, PAS UNE LISTE

   La migration se fait page par page : au 31/08/2026, seule la landing
   utilise les jetons. Exiger « aucune couleur nulle part » ferait échouer le
   contrôle sur des pages qu'on n'a pas encore touchées, et l'on prendrait
   l'habitude de le voir rouge — ce qui revient à ne plus l'avoir.

   La règle est donc conditionnelle : **une page qui charge jetons.css ne
   définit plus de couleur elle-même**. Les autres sont libres jusqu'au jour
   où elles adoptent le fichier ; ce jour-là, le contrôle les prend en
   charge, tout seul.

   Et pour qu'il ne devienne pas vide à force d'exemptions, il exige qu'au
   moins une page ait migré.

   ---------------------------------------------------------------------------
   LA SEULE EXCEPTION, ET SA RAISON

   Le bandeau de recette garde sa couleur en dur. Ce n'est pas un oubli :
   c'est un avertissement de sécurité — « on efface un jour des données en
   croyant être ailleurs » — et il ne doit dépendre d'AUCUN chargement
   externe. Si jetons.css n'arrive pas, le bandeau doit rester rouge.

   L'exception est nommée par ce qu'elle est, pas par le fichier où elle se
   trouve : c'est le bloc « #bandeau-recette » qui est dispensé, dans
   n'importe quelle page.

   USAGE
     node tests/test-jetons.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const RACINE = [".", "..", path.join("..", "..")]
  .flatMap(c => [path.join(c, "web"), path.join(c, "docker", "web")])
  .find(p => fs.existsSync(path.join(p, "index.html")));

if (!RACINE) {
  console.log("  (web/ hors de portée dans cette disposition — non exécuté)");
  console.log("\n  0 vérifications, aucune erreur.");
  process.exit(0);
}

const JETONS = path.join(RACINE, "jetons.css");
verifier("jetons.css existe", fs.existsSync(JETONS));
if (!fs.existsSync(JETONS)) { rapport(); }

const feuille = fs.readFileSync(JETONS, "utf8");
const pages = fs.readdirSync(RACINE).filter(f => f.endsWith(".html")).sort();

/* ===================================================================== */
/* 1. LA FEUILLE DÉFINIT CE QU'ELLE PROMET                                */
/* ===================================================================== */

const declares = new Set(
  [...feuille.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));

verifier("la feuille déclare une palette complète",
  declares.size >= 25, `${declares.size} jetons déclarés`);

for (const attendu of ["--creme", "--encre", "--cobalt", "--titre", "--texte",
                       "--r-carte", "--ombre-carte", "--savoirs", "--roman", "--bd"]) {
  verifier(`« ${attendu} » est défini`, declares.has(attendu));
}

/* LES POLICES SONT CHEZ NOUS. Un « @import » ou une URL vers
   fonts.googleapis.com donnerait à Google l'IP de chaque visiteur — ce que
   la politique de confidentialité affirme expressément ne pas faire. */
verifier("aucune police n'est appelée chez un tiers",
  !/fonts\.(googleapis|gstatic)\.com|@import\s+url\(\s*["']?https?:/i.test(feuille),
  "jetons.css appelle un domaine extérieur");

const fichiersPolice = [...feuille.matchAll(/url\("([^"]+\.woff2)"\)/g)].map(m => m[1]);
verifier("les fichiers de police sont servis depuis /polices/",
  fichiersPolice.length >= 4 && fichiersPolice.every(f => f.startsWith("/polices/")),
  JSON.stringify(fichiersPolice.slice(0, 3)));

const manquants = fichiersPolice
  .filter(f => !fs.existsSync(path.join(RACINE, f.replace(/^\//, ""))));
verifier("… et chacun existe réellement",
  manquants.length === 0,
  `absent(s) : ${[...new Set(manquants)].join(", ")} — la page tombera sur la police de secours`);

/* Sans « unicode-range », le navigateur prend TOUS les fichiers au lieu de
   ceux dont il a besoin. C'est invisible à l'œil et coûte le double.

   LES COMMENTAIRES SONT RETIRÉS D'ABORD. Une première rédaction comptait les
   occurrences du mot dans tout le fichier : le commentaire qui EXPLIQUE
   « unicode-range » en ajoutait une, et le contrôle annonçait 11 plages pour
   10 familles. Compter des occurrences plutôt que des déclarations est le
   travers que test-domaine.mjs a déjà payé. */
const code = feuille.replace(/\/\*[\s\S]*?\*\//g, "");
const familles = (code.match(/@font-face/g) ?? []).length;
const plages   = (code.match(/unicode-range/g) ?? []).length;
verifier("chaque @font-face borne son jeu de caractères",
  familles > 0 && familles === plages, `${familles} @font-face, ${plages} unicode-range`);

/* ===================================================================== */
/* 2. UNE PAGE QUI ADOPTE LES JETONS N'EN DÉFINIT PLUS                    */
/* ===================================================================== */

const contenu = new Map(
  pages.map(p => [p, fs.readFileSync(path.join(RACINE, p), "utf8")]));

const MIGREES = pages.filter(p => /href=["']\/jetons\.css["']/.test(contenu.get(p)));

verifier("au moins une page utilise les jetons",
  MIGREES.length >= 1,
  "aucune page ne charge jetons.css — le contrôle ne regarderait rien");

/* Le bloc du bandeau est retiré AVANT l'examen : sa couleur en dur est
   voulue, et documentée dans chaque page qui le porte. */
const sansBandeau = (html) =>
  html.replace(/#bandeau-recette\s*\{[\s\S]*?\}/g, "")
      .replace(/#bandeau-recette\[hidden\][^}]*\}/g, "");

for (const p of MIGREES) {
  const corps = sansBandeau(contenu.get(p));

  const couleurs = [...corps.matchAll(/#[0-9a-fA-F]{3,8}\b(?![^<]*-->)/g)].map(m => m[0]);
  verifier(`« ${p} » n'écrit aucune couleur en dur`,
    couleurs.length === 0,
    `${[...new Set(couleurs)].join(", ")} — ces valeurs devraient être des jetons`);

  const rgba = [...corps.matchAll(/rgba?\(/g)];
  verifier(`« ${p} » n'écrit aucun rgba() en dur`,
    rgba.length === 0, `${rgba.length} occurrence(s)`);

  /* Une page migrée doit VRAIMENT s'en servir, sinon elle charge un fichier
     pour rien et l'on croirait la migration faite. */
  verifier(`« ${p} » se sert effectivement des jetons`,
    (corps.match(/var\(--/g) ?? []).length >= 10,
    "elle charge jetons.css sans l'utiliser");
}

/* L'INVERSE COMPTE AUSSI : une page qui emploie « var(--… ) » sans charger
   la feuille s'affiche sans couleurs, et le défaut ne se voit qu'à l'œil. */
for (const p of pages.filter(p => !MIGREES.includes(p))) {
  const utilise = (contenu.get(p).match(/var\(--(creme|encre|cobalt|sable|trait)\b/g) ?? []).length;
  verifier(`« ${p} » n'utilise pas des jetons qu'elle ne charge pas`,
    utilise === 0,
    `${utilise} référence(s) à la palette Lisia sans <link> vers jetons.css`);
}

/* ===================================================================== */

rapport();

function rapport() {
  for (const n of ok) console.log("  ok   " + n);
  for (const n of ko) console.log("  KO   " + n);
  console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length} erreur(s).`);
  process.exit(ko.length ? 1 : 0);
}
