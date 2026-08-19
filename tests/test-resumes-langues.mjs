/* =========================================================================
   UN RÉSUMÉ PAR LANGUE, ET LES DEUX COEXISTENT

   Le résumé a quitté la fiche de l'ouvrage pour une table à part, dont la
   clé est (locataire, ouvrage, langue). Trois choses peuvent mal tourner, et
   aucune ne se voit sans regarder :

     — écrire l'anglais ÉCRASE le français. La perte est silencieuse : la
       fiche affiche un texte, il est simplement dans la mauvaise langue.
     — demander l'anglais REND le français. Rien ne signale l'erreur ; il
       faut lire le texte pour s'en apercevoir.
     — la jointure DUPLIQUE l'ouvrage, une ligne par traduction. La
       bibliothèque compte soudain deux fois plus de livres.

   Le contrôle tourne contre le vrai serveur, sur un vrai PostgreSQL, avec
   un observateur privilégié distinct — pour les mêmes raisons que
   test-http-cloisonnement.mjs, dont il reprend le montage.

   Les résumés sont posés DIRECTEMENT en base : la route qui en fabrique
   appelle le modèle, ce qui coûte de l'argent et rend le contrôle
   dépendant d'un service extérieur. Ce qu'on éprouve ici, c'est la lecture
   et le cloisonnement, pas la génération.

   USAGE
     node tests/test-resumes-langues.mjs
     PGURL=... PGURL_OEIL=... node tests/test-resumes-langues.mjs      (CI)
   ========================================================================= */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const MDP = "mot-de-passe-de-controle";
const PORT = 3461;
const BASE = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55493 });
const { q, semer, resumer, locataire } = banc;

/* --------------------------------------------- Une bibliothèque garnie */

const [xavier] = await q("select id from tenants where identifiant = 'xavier'");

const deuxLangues = await semer({
  tenant: xavier.id, id: "deux-langues", isbn: "9781000000001",
  titre: "Titre deux-langues", visibilite: "publique" });
const frSeul = await semer({
  tenant: xavier.id, id: "fr-seul", isbn: "9781000000002", visibilite: "publique" });
const priveResume = await semer({
  tenant: xavier.id, id: "prive-resume", isbn: "9781000000003", visibilite: "privee" });

await resumer(deuxLangues, "fr", "Résumé en français.");
await resumer(deuxLangues, "en", "Summary in English.");
await resumer(frSeul, "fr", "Uniquement en français.");
await resumer(priveResume, "fr", "Résumé d'un ouvrage privé.");

/* UNE SECONDE BIBLIOTHÈQUE, AVEC LE MÊME IDENTIFIANT DE POSSESSION.
 *
 * Ajouté le 15/08/2026 : sans locataire dans la jointure, le résumé de
 * l'une s'attachait au livre de l'autre. Les identifiants de possession
 * sont du texte choisi par chaque bibliothèque — deux amis qui importent
 * le même fichier d'export ont exactement les mêmes.
 *
 * L'ISBN, lui, est DIFFÉRENT : ce sont deux livres distincts qui portent
 * par hasard le même identifiant local. C'est le cas qui piège. */
const amie = await locataire("amie", "publique");
const livreDeLAmie = await semer({
  tenant: amie, id: "deux-langues", isbn: "9789999999999",
  titre: "Le livre de l amie", auteur: "Autre",
  categorie: "Roman", sous_categorie: "Classique", visibilite: "publique" });
await resumer(livreDeLAmie, "fr", "RÉSUMÉ DE L AMIE, PAS LE VOTRE");

/* ------------------------------------------------------- Lancer l'API */

const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT), MOT_DE_PASSE: MDP,
    SECRET_SESSION: "un-secret-de-controle-suffisamment-long-pour-passer",
    ANTHROPIC_API_KEY: "", FICHIER_AMORCE: "/inexistant", TENANT_DEFAUT: "xavier",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
serveur.stdout.on("data", d => { journal += d; });
serveur.stderr.on("data", d => { journal += d; });

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
let debout = false;
for (let i = 0; i < 40 && !debout; i++) {
  try { debout = (await fetch(`${BASE}/api/sante`)).ok; } catch { await dormir(500); }
}
const fermer = async () => { serveur.kill(); await banc.fermer(); };
if (!debout) { console.error("  ECHEC l API n a pas démarré\n" + journal); await fermer(); process.exit(1); }

const appel = async (chemin, { cookie, methode = "GET", corps } = {}) => {
  const r = await fetch(BASE + chemin, {
    method: methode,
    headers: { ...(cookie ? { cookie } : {}), ...(corps ? { "content-type": "application/json" } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { statut: r.status, cookie: r.headers.get("set-cookie"), corps: await r.json().catch(() => null) };
};
const parId = (liste) => Object.fromEntries((liste ?? []).map(l => [l.id, l]));

const connexion = await appel("/api/connexion", { methode: "POST", corps: { motDePasse: MDP } });
const cookie = (connexion.cookie ?? "").split(";")[0];

/* ------------------------------------------------ La jointure ne duplique pas */

const fr = await appel("/api/livres?langue=fr", { cookie });
verifier("un ouvrage à deux résumés reste UN ouvrage",
  Array.isArray(fr.corps) && fr.corps.length === 3, JSON.stringify(fr.corps?.length));

verifier("le résumé d'un homonyme chez quelqu'un d'autre n'est pas repris",
  parId(fr.corps)["deux-langues"]?.resume === "Résumé en français.",
  JSON.stringify(parId(fr.corps)["deux-langues"]?.resume));

/* ------------------------------------------------------ Chaque langue rend la sienne */

const livresFr = parId(fr.corps);
verifier("en français, le résumé français",
  livresFr["deux-langues"]?.resume === "Résumé en français.",
  JSON.stringify(livresFr["deux-langues"]?.resume));

const en = await appel("/api/livres?langue=en", { cookie });
const livresEn = parId(en.corps);
verifier("en anglais, le résumé anglais",
  livresEn["deux-langues"]?.resume === "Summary in English.",
  JSON.stringify(livresEn["deux-langues"]?.resume));

verifier("les points suivent la langue demandée",
  JSON.stringify(livresEn["deux-langues"]?.resume_points) === JSON.stringify(["point en"]),
  JSON.stringify(livresEn["deux-langues"]?.resume_points));

/* Le cas qui pardonne le moins : une traduction ABSENTE. Rendre le
   français à la place serait pire que ne rien rendre — le lecteur croirait
   la traduction faite. */
verifier("une traduction absente rend un résumé vide, pas l'autre langue",
  livresEn["fr-seul"]?.resume === null,
  JSON.stringify(livresEn["fr-seul"]?.resume));

verifier("l'ouvrage sans traduction reste présent dans la liste anglaise",
  Boolean(livresEn["fr-seul"]), JSON.stringify(Object.keys(livresEn)));

/* ------------------------------------------------------ La langue par défaut */

const [{ langue: langueTenant }] = await q("select langue from tenants where id = $1", [xavier.id]);
const defaut = await appel("/api/livres", { cookie });
verifier("sans paramètre, la langue du locataire s'applique",
  parId(defaut.corps)["deux-langues"]?.resume_langue === langueTenant,
  `${parId(defaut.corps)["deux-langues"]?.resume_langue} au lieu de ${langueTenant}`);

await q("update tenants set langue = 'en' where id = $1", [xavier.id]);
const apresBascule = await appel("/api/livres", { cookie });
verifier("changer la langue du locataire change ce qui est servi",
  parId(apresBascule.corps)["deux-langues"]?.resume === "Summary in English.",
  JSON.stringify(parId(apresBascule.corps)["deux-langues"]?.resume));
await q("update tenants set langue = 'fr' where id = $1", [xavier.id]);

/* Une langue inventée ne doit pas produire une bibliothèque sans résumés :
   on retombe sur le français, et on le DIT dans la réponse. */
const inventee = await appel("/api/livres?langue=klingon", { cookie });
verifier("une langue inconnue retombe sur le français",
  parId(inventee.corps)["deux-langues"]?.resume === "Résumé en français.",
  JSON.stringify(parId(inventee.corps)["deux-langues"]?.resume));

const session = await appel("/api/session?langue=en", { cookie });
verifier("la réponse dit dans quelle langue elle est servie",
  session.corps?.langue === "en", JSON.stringify(session.corps));

/* --------------------------------------------------------- Les comptes */

const statsFr = await appel("/api/statistiques?langue=fr", { cookie });
verifier("le compte des résumés porte sur la langue demandée (fr : 3)",
  statsFr.corps?.avec_resume === 3, JSON.stringify(statsFr.corps?.avec_resume));

const statsEn = await appel("/api/statistiques?langue=en", { cookie });
verifier("le compte des résumés porte sur la langue demandée (en : 1)",
  statsEn.corps?.avec_resume === 1, JSON.stringify(statsEn.corps?.avec_resume));

/* ------------------------------------------------------ Et le visiteur ? */

/* Le visiteur voit DEUX bibliothèques publiques, dont deux ouvrages
   partageant le même identifiant. C'est là que l'absence du locataire dans
   la jointure se paie : chaque ouvrage recevrait les deux résumés, et
   apparaîtrait donc deux fois. */
const visiteur = await appel("/api/livres");
const vus = parId(visiteur.corps);
verifier("chez le visiteur non plus, deux bibliothèques ne se mélangent pas",
  (visiteur.corps ?? []).length === 3, JSON.stringify((visiteur.corps ?? []).length));

/* Ce qu'il faut vérifier n'est PAS que le résumé de l'amie est absent — sa
   bibliothèque est publique, il a toute sa place. C'est qu'il est attaché au
   BON livre. Une première version de ce contrôle exigeait son absence : elle
   aurait échoué sur un comportement correct, ce qui aurait conduit à
   « corriger » du code qui n'avait rien.

   Les deux ouvrages portent le même identifiant : on les distingue donc par
   leur titre, seule chose qui les sépare vraiment. */
const parTitre = Object.fromEntries((visiteur.corps ?? []).map(l => [l.titre, l]));
verifier("le résumé de l'amie est sur le livre de l'amie",
  parTitre["Le livre de l amie"]?.resume === "RÉSUMÉ DE L AMIE, PAS LE VOTRE",
  JSON.stringify(parTitre["Le livre de l amie"]?.resume));

verifier("et celui de xavier reste sur le sien, malgré l'identifiant commun",
  parTitre["Titre deux-langues"]?.resume === "Résumé en français.",
  JSON.stringify(parTitre["Titre deux-langues"]?.resume));

verifier("le visiteur ne voit pas l'ouvrage privé, donc pas son résumé",
  !vus["prive-resume"], JSON.stringify(Object.keys(vus)));

/* Le résumé d'un ouvrage privé ne doit pas fuir par la table des résumés,
   qui a sa propre politique — un ouvrage caché dont le résumé sort
   raconterait le livre sans le montrer. */
verifier("aucun résumé privé n'apparaît chez le visiteur",
  !(visiteur.corps ?? []).some(l => String(l.resume ?? "").includes("privé")),
  JSON.stringify((visiteur.corps ?? []).map(l => l.resume)));

/* ------------------------------------------- Rien n'est écrit dans books */

await appel("/api/livres", {
  cookie, methode: "PUT",
  corps: { id: "deux-langues", titre: "Titre deux-langues", auteur: "Auteur",
           categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro",
           resume: "TENTATIVE D ECRITURE PAR LA FICHE" },
});
const [ligne] = await q(
  `select r.resume from resumes_ouvrages r where r.ouvrage_id = $1 and r.langue = 'fr'`,
  [deuxLangues]);
verifier("un résumé envoyé dans la fiche ne réécrit pas la table des résumés",
  ligne?.resume === "Résumé en français.", JSON.stringify(ligne));

const apresEcriture = await appel("/api/livres?langue=fr", { cookie });
/* CE CONTRÔLE PORTE UN NOM TROP MODESTE POUR CE QU'IL A TROUVÉ.
 *
 * La fiche envoyée ci-dessus ne porte PAS d'ISBN. Le 15/08/2026, cela
 * suffisait à détacher le livre du catalogue partagé : clé locale, ouvrage
 * neuf, et le résumé — payé au modèle — disparaissait sur une sauvegarde
 * parfaitement anodine.
 *
 * Règle depuis : on ne change l'ouvrage rattaché que si la fiche porte un
 * ISBN valide. Une information ABSENTE n'est pas une décision. */
verifier("enregistrer sans ISBN ne détache pas le livre de son résumé",
  parId(apresEcriture.corps)["deux-langues"]?.resume === "Résumé en français.",
  JSON.stringify(parId(apresEcriture.corps)["deux-langues"]?.resume));

const [rattachement] = await q(
  "select ouvrage_id from possessions where id = 'deux-langues' and tenant_id = $1",
  [xavier.id]);
verifier("et il reste rattaché au MÊME ouvrage du catalogue",
  rattachement?.ouvrage_id === deuxLangues,
  `${rattachement?.ouvrage_id} au lieu de ${deuxLangues}`);

const orphelins = await q(
  `select cle from ouvrages o
    where not exists (select 1 from possessions p where p.ouvrage_id = o.id)`);
verifier("aucun ouvrage orphelin n'a été créé dans le catalogue partagé",
  orphelins.length === 0, JSON.stringify(orphelins.map(o => o.cle)));

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Résumés, une langue par ligne ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
