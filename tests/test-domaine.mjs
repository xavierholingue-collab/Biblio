/* =========================================================================
   UN SEUL DOMAINE, DÉCLARÉ UNE SEULE FOIS

   ---------------------------------------------------------------------------
   POURQUOI CE CONTRÔLE EXISTE — 21/08/2026

   « biblio.xavier-holingue.eu » était écrit en toutes lettres dans DOUZE
   fichiers : la configuration Caddy, la chaîne de livraison, l'installateur
   de recette, la configuration Playwright, les trois pages, plusieurs
   commentaires. Vingt occurrences.

   C'était la cinquième liste manuelle de la semaine, après celle du
   déployeur, celle de test-authentification.mjs, celle de l'assembleur et la
   mienne. Le motif est toujours le même : une chose vraie répétée à N
   endroits devient N occasions d'oublier, et rien ne signale l'oubli.

   Le déménagement vers « lisia.y-factor.fr » a rendu le coût visible. Sans ce
   contrôle, le prochain se paierait de la même façon — et le vingtième oubli
   serait celui qui casse les liens magiques, parce qu'ADRESSE_PUBLIQUE aurait
   gardé l'ancien nom.

   ---------------------------------------------------------------------------
   LA SOURCE DE VÉRITÉ EST CE QUI DÉCIDE

   Pas un fichier de configuration inventé pour l'occasion : le script Caddy.
   C'est lui qui dit au serveur quels noms servir — le reste ne fait que s'y
   conformer. Un « DOMAINE.txt » à la racine aurait pu diverger de Caddy sans
   que personne ne le voie ; Caddy, lui, ne peut pas diverger de lui-même.

   ---------------------------------------------------------------------------
   CE QU'IL VÉRIFIE

   1. L'ancien nom n'apparaît QUE dans sa déclaration et le commentaire qui
      l'explique. Partout ailleurs, c'est un oubli.
   2. Le nouveau nom apparaît là où il doit décider : la chaîne de livraison,
      la configuration Playwright, les pages.
   3. La redirection de l'ancien vers le nouveau existe, et en 308.

   Ce qu'il ne vérifie pas : que le DNS pointe quelque part, ni que le
   certificat est émis. Cela se constate sur le serveur, pas dans un dépôt.

   USAGE
     node tests/test-domaine.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

/* Les trois dispositions habituelles : dépôt assemblé, source OneDrive, et le
   banc d'essai qui ne recopie que docker/. On cherche au lieu de calculer. */
const RACINE = [".", "..", path.join("..", "..")]
  .find(c => fs.existsSync(path.join(c, "deploiement", "vps-caddy-xavier-holingue.sh")));

if (!RACINE) {
  console.log("  (configuration Caddy hors de portée dans cette disposition — non exécuté)");
  console.log("\n  0 vérifications, aucune erreur.");
  process.exit(0);
}

const caddy = fs.readFileSync(
  path.join(RACINE, "deploiement", "vps-caddy-xavier-holingue.sh"), "utf8");

const SITE   = caddy.match(/^SITE=\$\{SITE:-([a-z0-9.-]+)\}$/m)?.[1];
const ANCIEN = caddy.match(/^ANCIEN=\$\{ANCIEN:-([a-z0-9.-]+)\}$/m)?.[1];

verifier("le domaine est déclaré dans la configuration Caddy",
  !!SITE && !!ANCIEN, `SITE=${SITE} ANCIEN=${ANCIEN}`);
if (!SITE || !ANCIEN) {
  for (const l of ko) console.log("  KO   " + l);
  console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length} échec(s).`);
  process.exit(1);
}

verifier("l'ancien nom redirige vers le nouveau",
  caddy.includes("@@ANCIEN@@ {") && /redir https:\/\/@@SITE@@\{uri\} 308/.test(caddy),
  "aucune redirection 308 de l'ancien vers le nouveau");

/* « permanent » vaut 301 dans Caddy, ce qui transforme un POST en GET.
   /api/lien et /api/connexion-lien sont des POST : une requête arrivée sur
   l'ancien nom deviendrait un GET sans corps, donc un échec sans cause
   visible. Le contrôle est écrit parce que je m'y suis trompé en écrivant le
   bloc, et qu'un commentaire annonçait 308 là où le code faisait 301. */
verifier("… en 308, jamais en « permanent »",
  !/redir https:\/\/@@SITE@@\{uri\} permanent/.test(caddy),
  "« permanent » vaut 301 : le POST deviendrait un GET sans corps");

/* ------------------------------------------------- Le balayage du dépôt */

const EXTENSIONS = new Set([".sh", ".mjs", ".js", ".html", ".yml", ".sql", ".cmd", ".conf"]);
const IGNORES = new Set(["node_modules", ".git", "sauvegardes", "seed", "docs"]);

function fichiers(dir) {
  const sortie = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORES.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sortie.push(...fichiers(p));
    else if (EXTENSIONS.has(path.extname(e.name))) sortie.push(p);
  }
  return sortie;
}

/* « docs/ » est écarté : ce sont des documents d'architecture qui RACONTENT
   l'histoire du service, y compris ses anciennes adresses. Y interdire
   l'ancien nom reviendrait à interdire de dire d'où l'on vient. */
const tous = fichiers(RACINE);
const CADDY = path.join(RACINE, "deploiement", "vps-caddy-xavier-holingue.sh");

/* CE FICHIER-CI EST ÉCARTÉ, et il faut dire pourquoi plutôt que de laisser
   croire à une commodité. Il DOIT nommer l'ancien domaine : sans lui, ses
   commentaires ne pourraient pas expliquer de quoi il protège, et un contrôle
   dont on ignore la raison finit par être supprimé au premier agacement.

   Il s'est dénoncé lui-même au premier lancement — ce qui est le meilleur
   signe qu'il fonctionne. */
const MOI = new URL(import.meta.url).pathname;

const restes = tous
  .filter(f => path.resolve(f) !== path.resolve(CADDY))
  .filter(f => path.resolve(f) !== path.resolve(MOI))
  .filter(f => fs.readFileSync(f, "utf8").includes(ANCIEN))
  .map(f => path.relative(RACINE, f));

verifier("l'ancien domaine ne subsiste nulle part ailleurs",
  restes.length === 0, `encore présent dans : ${restes.join(", ")}`);

/* Dans Caddy lui-même, l'ancien nom n'a le droit d'apparaître que dans un
   COMMENTAIRE ou dans sa déclaration. Toute autre ligne l'utilise pour de
   bon — un bloc de site, une vérification, une liste de certificats.

   J'avais d'abord écrit « pas plus de trois occurrences ». Un seuil est un
   substitut : la mutation qui remettait l'ancien nom en tête du bloc de site
   restait à trois et passait au vert. C'est le défaut que ce dépôt traque
   depuis le début, commis dans le contrôle censé le traquer.

   On regarde donc ce que chaque ligne FAIT, et non combien il y en a. */
const actives = caddy.split("\n")
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => l.includes(ANCIEN))
  .filter(([, l]) => !/^\s*#/.test(l) && !/^ANCIEN=/.test(l));

verifier("… et dans Caddy, seulement en commentaire ou en déclaration",
  actives.length === 0,
  actives.map(([n, l]) => `ligne ${n} : ${l.trim().slice(0, 50)}`).join(" | "));

/* Le nouveau nom doit être arrivé là où il DÉCIDE — pas seulement là où il
   se lit. Un déménagement à moitié fait laisse la chaîne de livraison
   interroger un site qui n'existe plus, et le rapport reste vert parce que
   personne ne regarde ce que « curl » a répondu. */
for (const [chemin, quoi] of [
  [path.join(".github", "workflows", "livraison.yml"), "la chaîne de livraison"],
  [path.join("tests", "playwright.config.mjs"),        "le parcours en navigateur"],
  [path.join("web", "ma-bibliotheque.html"),           "la page principale"],
]) {
  const f = [path.join(RACINE, chemin),
             path.join(RACINE, chemin.replace(/^tests|^web/, m => "docker/" + m))]
    .find(x => fs.existsSync(x));
  if (!f) continue;
  verifier(`${quoi} nomme le domaine courant`,
    fs.readFileSync(f, "utf8").includes(SITE), `${SITE} absent de ${chemin}`);
}

for (const l of ok) console.log("  ok   " + l);
for (const l of ko) console.log("  KO   " + l);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length ? ko.length + " échec(s)" : "aucune erreur"}.`);
if (ko.length) process.exit(1);
