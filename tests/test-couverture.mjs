/* =========================================================================
   CHAQUE FICHIER D'ESSAI EST-IL RÉELLEMENT LANCÉ ?

   Le contrôle qui vérifie les contrôles. Il n'éprouve aucune fonctionnalité :
   il vérifie que les autres sont branchés.

   ---------------------------------------------------------------------------
   POURQUOI IL EXISTE — 21/08/2026

   Trois listes écrites à la main dans ce dépôt, et les trois ont mordu :

     16/08  vps-deployer-biblio.sh vérifiait la présence de « 02 » et « 03 ».
            04-reglages.sql est arrivé sans y être ajouté. Corrigé en lisant
            le répertoire.

     21/08  test-authentification.mjs appliquait « 01 » et « 02 ». Six
            migrations plus tard, il bâtissait encore le schéma d'il y a une
            semaine. La chaîne a échoué sur « column courriel does not
            exist » — dans un test qui n'avait rien à voir. Corrigé de même.

     21/08  MOI. J'ai lancé douze suites sur quinze et annoncé « douze suites
            vertes », ce qui était vrai et trompeur. La treizième était celle
            qui échouait.

   Le point commun n'est pas la négligence : c'est qu'une liste manuelle ne
   signale JAMAIS ce qui lui manque. Elle passe au vert sur ce qu'elle
   contient, et le silence sur le reste ressemble à un succès.

   ---------------------------------------------------------------------------
   CE QU'IL VÉRIFIE, ET CE QU'IL NE PEUT PAS

   Il vérifie qu'un fichier « tests/test-*.mjs » ou « tests/test-*.js » est
   NOMMÉ quelque part dans le workflow. Il ne vérifie pas qu'il y est lancé
   correctement, ni avec le bon environnement — un nom cité dans un
   commentaire suffirait à le satisfaire.

   C'est une couverture faible, et c'est assumé : le défaut qu'on a vu trois
   fois n'est pas « mal lancé », c'est « pas lancé du tout ». Un contrôle qui
   attrape le défaut réel vaut mieux qu'un contrôle ambitieux qu'on n'écrit
   pas.

   USAGE
     node tests/test-couverture.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

/* Deux dispositions, comme partout ailleurs : le dépôt assemblé (tests/ et
   .github/ frères) et la source OneDrive (docker/tests/ et .github/ à deux
   crans). On cherche au lieu de calculer. */
const TESTS = ["tests", "."].find(c => fs.existsSync(path.join(c, "test-couverture.mjs")));
const FLUX = [".github/workflows", path.join("..", ".github", "workflows"),
              path.join("..", "..", ".github", "workflows")]
  .map(c => path.join(c, "livraison.yml")).find(f => fs.existsSync(f));

if (!TESTS) {
  console.error("  ECHEC tests/ introuvable"); process.exit(1);
}

if (!FLUX) {
  /* Absent du paquet déployé — c'est normal, le workflow ne part pas sur le
     serveur. On le DIT plutôt que de rendre un vert silencieux : un contrôle
     qui n'a rien pu contrôler et se tait passe pour un contrôle réussi. */
  console.log("  (livraison.yml hors de portée dans cette disposition — non exécuté)");
  console.log("\n  0 vérifications, aucune erreur.");
  process.exit(0);
}

const flux = fs.readFileSync(FLUX, "utf8");
const fichiers = fs.readdirSync(TESTS)
  .filter(f => /^test-.*\.(mjs|js)$/.test(f))
  .sort();

verifier("des fichiers d'essai ont été trouvés", fichiers.length > 0,
  `${fichiers.length} fichier(s) dans ${TESTS}`);

const orphelins = fichiers.filter(f => !flux.includes(f));
verifier("chaque fichier d'essai est nommé dans la chaîne de livraison",
  orphelins.length === 0,
  `jamais lancé(s) : ${orphelins.join(", ")}`);

/* L'inverse compte autant. Un nom cité dans le workflow qui ne correspond à
   aucun fichier fait échouer la chaîne sur un ENOENT — message qui dit
   « fichier introuvable » sans dire lequel manque ni depuis quand. */
const cites = [...flux.matchAll(/\btests\/(test-[\w.-]+\.m?js)\b/g)]
  .map(m => m[1]);
const fantomes = [...new Set(cites)].filter(n => !fichiers.includes(n));
verifier("… et chaque nom cité correspond à un fichier",
  fantomes.length === 0, `cité(s) sans exister : ${fantomes.join(", ")}`);

/* Le parcours en navigateur n'est pas lancé par son nom mais par la
   configuration Playwright. On vérifie donc qu'elle le voit. */
if (fs.existsSync(path.join(TESTS, "parcours.spec.mjs"))) {
  verifier("le parcours en navigateur est atteint par sa configuration",
    /playwright\.config\.mjs/.test(flux),
    "aucune référence à playwright.config.mjs dans le workflow");
}

/* ---------------------------------------------------------------------------
   LE REGISTRE SE SOUMET À SA PROPRE RÈGLE

   METHODE.md nomme les contrôles nés de la règle 4 — « une promesse sans
   contrôle n'est qu'une promesse ». Il cite donc des fichiers, et un fichier
   cité peut être renommé.

   Un registre de fautes qui pointe vers des contrôles disparus serait
   exactement la dérive qu'il dénonce : une affirmation sur l'ensemble du
   dépôt, plus vérifiée par rien, et qui continue de rassurer. */
/* DEUX DISPOSITIONS, ET J'AVAIS OUBLIÉ LA SECONDE. Dans la source, le
   registre est à côté du code ; dans le dépôt assemblé, l'assembleur le
   range sous « docs/ ». Ne chercher qu'à la racine faisait SAUTER le
   contrôle en silence — vert par absence, ce qui est précisément ce que
   METHODE.md reproche aux autres. Trouvé en reproduisant la disposition du
   dépôt, le 24/08 au soir. */
const METHODE = [".", "..", path.join("..", "..")]
  .flatMap(c => [path.join(c, "METHODE.md"), path.join(c, "docs", "METHODE.md")])
  .find(p => fs.existsSync(p));

/* Et s'il reste introuvable, on le DIT : un registre qu'aucun contrôle ne
   voit n'est plus adossé à rien. */
verifier("METHODE.md est trouvé là où il est rangé",
  METHODE !== undefined, "registre introuvable dans cette disposition");

if (METHODE) {
  const cité = [...fs.readFileSync(METHODE, "utf8")
    .matchAll(/\btests\/(test-[\w.-]+\.m?js)\b/g)].map(m => m[1]);
  const perdus = [...new Set(cité)].filter(n => !fichiers.includes(n));
  verifier("METHODE.md ne cite que des contrôles qui existent",
    cité.length > 0 && perdus.length === 0,
    cité.length === 0
      ? "le registre ne cite plus aucun contrôle"
      : `disparu(s) : ${perdus.join(", ")} — le registre promet ce qui n'existe plus`);
}

for (const l of ok) console.log("  ok   " + l);
for (const l of ko) console.log("  KO   " + l);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length ? ko.length + " échec(s)" : "aucune erreur"}.`);
if (ko.length) process.exit(1);
