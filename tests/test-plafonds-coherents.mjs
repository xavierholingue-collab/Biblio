/* =========================================================================
   LES DEUX PLAFONDS NE DOIVENT PLUS SE CONTREDIRE

   ---------------------------------------------------------------------------
   COMMENT LE DÉFAUT EST APPARU

   Deux bornes, posées à quinze jours d'intervalle, chacune raisonnable
   seule :

     quota_ia_mois = 10 appels par mois      (02-multi-locataire.sql, 16/08)
     plafond_usd   = 0,500 $ par mois        (11-plafond-depense.sql,  24/08)

   Et un résumé coûte 0,086 $. Le portefeuille se fermait donc au sixième
   appel, alors que le compteur en annonçait dix.

   Rien ne l'a signalé. Cela s'est vu le 31/08 en écrivant la page d'accueil,
   au moment de dire à un visiteur ce que le gratuit lui donne : la phrase
   « une dizaine de demandes » était fausse dès qu'on demandait la fonction
   la plus utile.

   C'est la faute que ce dépôt traque, sous une forme nouvelle : non pas un
   contrôle qui mesure un substitut, mais DEUX contrôles justes séparément
   dont la conjonction ment.

   ---------------------------------------------------------------------------
   L'INVARIANT

     plafond_usd  >=  quota_ia_mois  ×  coût du plus cher appel mesuré

   Autrement dit : le plafond d'argent ne doit jamais mordre AVANT le quota
   d'appels. Le quota est la borne qu'on annonce et que la jauge affiche ;
   le plafond d'argent est un garde-fou contre l'imprévu — un modèle qui
   renchérit, une boucle, une mesure en panne.

   Le jour où l'un des deux change sans l'autre, la livraison échoue avec le
   calcul en clair. C'est le seul moyen de ne pas redécouvrir la
   contradiction en écrivant une page de vente.

   ---------------------------------------------------------------------------
   POURQUOI LIRE LE SQL PLUTÔT QUE LA BASE

   Ce contrôle porte sur les VALEURS PAR DÉFAUT — ce que reçoit un compte
   neuf, donc ce qu'on annonce publiquement. Elles vivent dans les migrations.
   Un locataire particulier peut être réglé autrement par la porte nommée
   « regler_tarification » ; cela ne regarde pas cette promesse-ci.

   USAGE
     node tests/test-plafonds-coherents.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const DB = [".", "..", path.join("..", "..")]
  .flatMap(c => [path.join(c, "db"), path.join(c, "docker", "db")])
  .find(p => fs.existsSync(path.join(p, "01-schema.sql")));

if (!DB) {
  console.log("  (db/ hors de portée dans cette disposition — non exécuté)");
  console.log("\n  0 vérifications, aucune erreur.");
  process.exit(0);
}

const tout = fs.readdirSync(DB).filter(f => f.endsWith(".sql")).sort()
  .map(f => fs.readFileSync(path.join(DB, f), "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");   /* les commentaires citent les chiffres */

/* --------------------------------------------------------------- Le quota */

const quotas = [...tout.matchAll(/quota_ia_mois\s+integer\s+not null\s+default\s+([\d.]+)/g)]
  .map(m => Number(m[1]));
verifier("le quota d'appels d'un compte neuf est déclaré une seule fois",
  quotas.length === 1, `${quotas.length} déclaration(s) : ${quotas.join(", ")}`);

/* --------------------------------------------------- Le plafond d'argent

   Le DERNIER « set default » gagne : les migrations se rejouent dans
   l'ordre, et 11 peut relever ce que 11 avait posé plus haut. Lire le
   premier donnerait la valeur périmée — et un contrôle vert sur un chiffre
   qui n'est plus appliqué. */
const plafonds = [...tout.matchAll(/plafond_usd[\s\S]{0,80}?default\s+([\d.]+)/g)]
  .map(m => Number(m[1]));
verifier("le plafond de dépense d'un compte neuf est déclaré",
  plafonds.length >= 1, JSON.stringify(plafonds));

const quota   = quotas[0];
const plafond = plafonds[plafonds.length - 1];

/* ------------------------------------------------ Le plus cher appel mesuré

   Relevé en production le 19/08/2026 sur /api/recherche-livre : 1,4677 $
   pour 17 appels. Ce n'est pas une constante du monde — si le tarif du
   modèle change, ce chiffre change, et l'inégalité doit être refaite. */
const PLUS_CHER = 0.086;

verifier("les deux valeurs ont été lues",
  Number.isFinite(quota) && Number.isFinite(plafond),
  `quota=${quota} plafond=${plafond}`);

const requis = quota * PLUS_CHER;
verifier("le plafond d'argent ne mord pas AVANT le quota d'appels",
  plafond >= requis,
  `${plafond} $ pour ${quota} appels à ${PLUS_CHER} $ — il en faudrait `
  + `${requis.toFixed(3)} $. Le portefeuille fermerait au `
  + `${Math.floor(plafond / PLUS_CHER) + 1}e appel, pas au ${quota}e : `
  + `la page d'accueil annoncerait un nombre qu'on n'atteint pas.`);

/* Et l'inverse : un plafond démesuré ferait du quota la seule borne, ce qui
   est voulu — mais au-delà d'un facteur trois, ce n'est plus un garde-fou,
   c'est un chiffre qu'on a oublié de baisser. */
verifier("… et il reste un garde-fou, pas un chiffre oublié",
  plafond <= requis * 3,
  `${plafond} $ pour ${requis.toFixed(3)} $ nécessaires — plus de trois fois trop`);

/* ------------------------------------------- Ce que la page d'accueil dit */

const WEB = [".", "..", path.join("..", "..")]
  .flatMap(c => [path.join(c, "web"), path.join(c, "docker", "web")])
  .find(p => fs.existsSync(path.join(p, "index.html")));

if (WEB) {
  const page = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  /* La page dit « une dizaine ». Si le quota descendait à trois, la phrase
     deviendrait fausse sans que personne ne touche à la page. */
  const ditDizaine = /dizaine de demandes/.test(page);
  verifier("« une dizaine de demandes » correspond au quota réel",
    !ditDizaine || (quota >= 8 && quota <= 12),
    `la page annonce une dizaine, le quota vaut ${quota}`);
}

/* ===================================================================== */

for (const n of ok) console.log("  ok   " + n);
for (const n of ko) console.log("  KO   " + n);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length} erreur(s).`);
process.exit(ko.length ? 1 : 0);
