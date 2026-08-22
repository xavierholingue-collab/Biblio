/* =========================================================================
   CALCUL DE LA POLITIQUE DE CONTENU PAR EMPREINTE

   Produit la directive Content-Security-Policy de lisia.y-factor.fr,
   en autorisant chaque script en ligne par son empreinte sha256 plutôt que
   par le mot-clef 'unsafe-inline'.

   POURQUOI
   'unsafe-inline' autorise N'IMPORTE QUEL script en ligne. Si une valeur
   venue de la base — un titre d'ouvrage, un résumé produit par le modèle —
   parvenait un jour à s'insérer dans le HTML, elle s'exécuterait. Une
   empreinte n'autorise qu'un contenu précis : modifier une virgule dans le
   script suffit à le faire refuser.

   C'est pour cela que ce calcul appartient à la chaîne de livraison et non
   à un fichier écrit à la main : une empreinte oubliée casse la page.

   CE QUI PEUT MAL SE PASSER, ET COMMENT ON LE VOIT
   Une empreinte fausse ne produit aucune erreur serveur : la page arrive,
   le script est refusé en silence par le navigateur, et l'application reste
   figée sur « Chargement… ». C'est exactement la panne du 04/08/2026. Le
   contrôle Playwright qui vérifie la disparition du bandeau de chargement
   est donc la garantie, pas ce script.

   USAGE
     node calculer-csp.mjs web/               # affiche la politique
     node calculer-csp.mjs web/ --caddy       # bloc Caddy prêt à importer
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const dossier = process.argv[2] ?? "web";
const pourCaddy = process.argv.includes("--caddy");

/* Extrait le contenu de chaque <script> SANS attribut src.
   L'empreinte porte sur le texte exact situé entre les balises — espaces et
   retours à la ligne compris. Une seule différence d'octet et le navigateur
   refuse. */
function scriptsEnLigne(html) {
  const trouves = [];
  const motif = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = motif.exec(html)) !== null) {
    const attributs = m[1];
    if (/\bsrc\s*=/i.test(attributs)) continue;          // script externe : couvert par 'self'
    // Les blocs de données (application/ld+json) ne sont pas exécutés et ne
    // relèvent donc pas de script-src. Les inclure ne nuirait pas, mais
    // gonflerait la politique sans raison.
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(attributs)?.[1] ?? "";
    if (type && !/javascript|module/i.test(type)) continue;
    trouves.push(m[2]);
  }
  return trouves;
}

const empreinte = (contenu) =>
  "sha256-" + createHash("sha256").update(contenu, "utf8").digest("base64");

/* --------------------------------------------------------------- Marche */

if (!fs.existsSync(dossier)) {
  console.error(`  ECHEC dossier introuvable : ${dossier}`);
  process.exit(1);
}

const pages = fs.readdirSync(dossier).filter(f => f.endsWith(".html")).sort();
if (!pages.length) { console.error(`  ECHEC aucune page dans ${dossier}`); process.exit(1); }

const empreintes = new Set();
const detail = [];
for (const page of pages) {
  const html = fs.readFileSync(path.join(dossier, page), "utf8");
  const scripts = scriptsEnLigne(html);
  for (const s of scripts) {
    const e = empreinte(s);
    empreintes.add(e);
    detail.push(`${page} : ${s.length} octets -> ${e.slice(0, 24)}…`);
  }
}

if (!empreintes.size) {
  // Aucune empreinte signifierait une politique qui n'autorise aucun script
  // en ligne — sur une application qui n'en contient que, la page serait
  // muette. Mieux vaut refuser de produire une politique que d'en produire
  // une qui casse tout.
  console.error("  ECHEC aucun script en ligne trouvé — extraction probablement fautive.");
  process.exit(1);
}

const liste = [...empreintes].map(e => `'${e}'`).join(" ");

const politique = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' reste : zbar, le lecteur de codes-barres, est un
  // module WebAssembly, et son instanciation relève de script-src.
  `script-src 'self' 'wasm-unsafe-eval' ${liste}`,
  // Les styles restent en 'unsafe-inline' : les pages portent des attributs
  // style= posés par le script, qu'aucune empreinte ne peut couvrir. Le
  // risque est sans commune mesure avec celui d'un script.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://covers.openlibrary.org https://books.google.com https://*.googleusercontent.com",
  "connect-src 'self' https://www.googleapis.com",
  "media-src 'self' blob:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

if (pourCaddy) {
  console.log(`# Genere par calculer-csp.mjs le ${new Date().toISOString()}`);
  console.log("# NE PAS MODIFIER A LA MAIN : toute retouche du HTML change les empreintes.");
  detail.forEach(d => console.log(`#   ${d}`));
  console.log(`header Content-Security-Policy "${politique}"`);
} else {
  detail.forEach(d => console.log("  " + d));
  console.log("\n" + politique);
}
