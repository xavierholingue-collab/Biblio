/* =========================================================================
   LANCER TOUS LES CONTRÔLES, ET LIRE CE QU'ILS RENDENT

   Écrit le 18/09/2026, au terme d'une journée où j'ai annoncé « vert » trois
   fois sur des suites qui ne l'étaient pas.

   ---------------------------------------------------------------------------
   POURQUOI CE FICHIER EXISTE, ET CE QU'IL REMPLACE

   La façon de faire était une boucle shell improvisée, différente à chaque
   fois, qui filtrait la sortie avec un motif écrit de mémoire. Le 05/09, ce
   motif cherchait « echec » en minuscules ; le fichier écrivait « 2 ÉCHECS ».
   J'ai lu « 51 vérifications passées », conclu au vert, et fait pousser. La
   chaîne de livraison a trouvé les deux échecs en trente et une secondes.

   LA RÈGLE QUE CE FICHIER APPLIQUE, ET C'EST SA SEULE RAISON D'ÊTRE : un
   programme dit s'il a échoué par son CODE DE SORTIE. Le texte est pour
   l'humain qui lit ; le code est pour la machine qui décide. Filtrer le
   texte, c'est choisir d'avance ce qu'on accepte de voir.

   Le résumé affiché à côté du code n'est qu'un confort de lecture. Il n'entre
   dans aucune décision — et s'il disparaissait, ce lanceur continuerait de
   dire la vérité.

   ---------------------------------------------------------------------------
   SÉQUENTIEL, ET C'EST VOULU

   Plusieurs suites montent un PostgreSQL et une API sur des ports fixes. Les
   mener de front les ferait se disputer ces ports, et l'on passerait la
   soirée à démêler des échecs qui ne disent rien du code.

   ---------------------------------------------------------------------------
   CE QU'IL NE REMPLACE PAS

   La chaîne de livraison. Elle monte un vrai PostgreSQL du même numéro que la
   production, applique le schéma comme le déployeur, et mène le parcours en
   navigateur. Ce lanceur sert à ne pas partir à l'aveugle — c'est tout, et
   c'est déjà ce qui manquait.

   USAGE
     npm run controles              (depuis la racine du dépôt)
     node tests/lancer-tous.mjs
     node tests/lancer-tous.mjs lectures sieges      (par fragment de nom)
   ========================================================================= */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TESTS = ["tests", "."].find(
  (c) => fs.existsSync(path.join(c, "banc-postgres.mjs")));
if (!TESTS) {
  console.error("  ECHEC tests/ introuvable — lancez depuis la racine du dépôt.");
  process.exit(1);
}

/* Les fichiers d'essai, lus dans le dossier plutôt qu'écrits ici.
 *
 * Une liste à la main se périme au premier ajout, et le contrôle oublié ne
 * signale rien : il est simplement absent. Ce dépôt a déjà payé sept listes
 * manuelles ; celle-ci aurait coûté des suites qu'on croit lancées. */
const motifs = process.argv.slice(2);
const fichiers = fs.readdirSync(TESTS)
  .filter((f) => /^test-.*\.(mjs|js)$/.test(f))
  .filter((f) => !motifs.length || motifs.some((m) => f.includes(m)))
  .sort();

if (!fichiers.length) {
  console.error(`  ECHEC aucun fichier d'essai ne correspond à : ${motifs.join(" ")}`);
  process.exit(1);
}

console.log(`\n=== ${fichiers.length} fichier(s) de contrôle ===\n`);

const rouges = [];
const debut = Date.now();

for (const f of fichiers) {
  process.stdout.write(`  ${f.padEnd(32)}`);

  const sortie = await new Promise((resoudre) => {
    const p = spawn(process.execPath, [path.join(TESTS, f)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let texte = "";
    p.stdout.on("data", (d) => { texte += d; });
    p.stderr.on("data", (d) => { texte += d; });
    p.on("exit", (code) => resoudre({ code, texte }));
    p.on("error", (e) => resoudre({ code: 1, texte: String(e) }));
  });

  /* LE RÉSUMÉ EST UN CONFORT, PAS UNE PREUVE. On l'affiche s'il existe, et
     son absence ne change rien : c'est « code » qui décide. */
  const resume = (sortie.texte.match(/.*vérifications.*/g) ?? []).pop() ?? "";

  if (sortie.code === 0) {
    console.log(`ok    ${resume.trim()}`);
  } else {
    console.log(`ROUGE  code=${sortie.code}  ${resume.trim()}`);
    rouges.push({ f, ...sortie });
  }
}

const secondes = Math.round((Date.now() - debut) / 1000);

/* CE QUI A ÉCHOUÉ EST RÉIMPRIMÉ EN ENTIER, à la fin.
 *
 * Un fichier qui PLANTE ne dit rien dans la colonne de droite — c'est
 * exactement le cas qui s'est produit le 05/09, et il faut alors la pile
 * d'appels, pas un résumé absent. On la garde sous la main plutôt que de
 * relancer le fichier à part pour la voir. */
if (rouges.length) {
  for (const r of rouges) {
    console.log(`\n${"─".repeat(70)}\n  ${r.f} — code de sortie ${r.code}\n`);
    console.log(r.texte.split("\n").slice(-40).join("\n"));
  }
  console.log(`\n${rouges.length} fichier(s) ROUGE(S) sur ${fichiers.length}, `
    + `en ${secondes} s : ${rouges.map((r) => r.f).join(", ")}\n`);
  process.exit(1);
}

console.log(`\n  ${fichiers.length} fichiers, tous à zéro, en ${secondes} s.\n`);
