/* =========================================================================
   LES RÉGLAGES TIENNENT-ILS ? — langue, visibilité aux trois niveaux, quota

   Ce contrôle parle à la vraie API en HTTP, sur un vrai PostgreSQL, avec
   deux locataires. Il ne vérifie pas que le code fait ce qu'il dit : il
   vérifie ce que la base laisse sortir.

   ---------------------------------------------------------------------------
   CE QU'IL CHERCHE, ET POURQUOI CHACUN A DÉJÀ COÛTÉ QUELQUE CHOSE

   1. LE QUOTA REFUSE-T-IL VRAIMENT ? Il existait depuis le 14/08 dans le
      schéma, sans être ni compté ni appliqué. Un plafond qu'on croit actif
      est pire qu'un plafond absent.

   2. ÉCHOUE-T-IL FERMÉ ? Sans locataire posé, « select count(*) » rend zéro,
      c'est-à-dire un quota infini. Le défaut serait parfaitement silencieux :
      pas d'erreur, pas de refus, juste une facture.

   3. TIENT-IL EN CONCURRENCE ? Deux résumés lancés ensemble à 9 sur 10 lisent
      tous les deux « 9 » et passent tous les deux, si rien ne les sérialise.

   4. UN RÉGLAGE CHEZ UN AUTRE EST-IL REFUSÉ ? Et — le piège — REFUSÉ
      VISIBLEMENT. Sous RLS, écrire chez autrui ne lève pas d'erreur : la
      ligne sort du périmètre et PostgreSQL rapporte zéro ligne touchée. Une
      route qui ne regarde pas ce compte répond « enregistré » à une écriture
      qui n'a rien écrit.

   5. LE PROPRE RÉGLAGE MARCHE-T-IL ? La vérification qu'on oublie toujours.
      Le 15/08, une mutation qui sortait l'effacement de son contexte n'a
      fait tomber AUCUN contrôle : tous regardaient ce qui était interdit,
      aucun ce qui devait marcher.

   6. ENREGISTRER UN LIVRE EFFACE-T-IL SON RÉGLAGE ? C'est le défaut que
      j'avais laissé en note dans server.js le 15/08 : la mise à jour écrasait
      la visibilité sans condition. Le menu de réglages aurait défait ses
      propres réglages à la première note modifiée.

   USAGE
     node tests/test-reglages.mjs
     PGURL=... PGURL_OEIL=... node tests/test-reglages.mjs             (CI)
   ========================================================================= */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import pg from "pg";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const SECRET = "un-secret-de-controle-suffisamment-long-pour-passer";
const PORT = 3459;
const BASE = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55493 });
const { q, semer, locataire } = banc;

/* ------------------------------------------------- Deux bibliothèques */

const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
await q("update tenants set visibilite = 'publique', quota_ia_mois = 3 where id = $1",
        [xavier.id]);
const bob = await locataire("bob", "publique", "fr", 5);

/* UN COMPTE DANS LA BIBLIOTHÈQUE PAR DÉFAUT — 05/09/2026.

   Depuis la migration 17, le statut de lecture et la note appartiennent à
   une PERSONNE. La session par mot de passe, elle, ouvre la bibliothèque
   sans en nommer aucune : elle ne peut donc rien attribuer, sauf quand la
   bibliothèque n'a qu'un membre — auquel cas il n'y a rien à départager.

   Ce banc éprouvait jusqu'ici une bibliothèque SANS aucun compte, ce qui
   n'existe pas en production : « creer_locataire » pose toujours un
   propriétaire. On répare le décor plutôt que d'affaiblir la règle. */
const compteX = await banc.compte(xavier.id, "xavier@controle.fr");

/* Le jeu d'essai est construit pour que CHAQUE niveau de la cascade soit
   distinguable. Un rayon entier hérité, un rayon réglé, et deux exceptions
   par livre qui contredisent leur rayon — sans quoi on ne saurait pas si
   c'est le rayon ou le livre qui décide. */
await semer({ tenant: xavier.id, id: "x-philo-1", isbn: "9780000000101",
              categorie: "Savoirs", sous_categorie: "Philosophie" });
await semer({ tenant: xavier.id, id: "x-philo-2", isbn: "9780000000102",
              categorie: "Savoirs", sous_categorie: "Philosophie" });
await semer({ tenant: xavier.id, id: "x-eco-1", isbn: "9780000000103",
              categorie: "Savoirs", sous_categorie: "Économie" });
await semer({ tenant: bob, id: "b-philo-1", isbn: "9780000000201",
              categorie: "Savoirs", sous_categorie: "Philosophie" });

/* ---------------------------------------------------- Un modèle factice

   POURQUOI IL FAUT UN FAUX MODÈLE PLUTÔT QU'UNE CLEF ABSENTE.

   Première version de ce contrôle : ANTHROPIC_API_KEY vide, en se disant
   qu'un appel refusé serait décompté quand même. Les quatre appels ont rendu
   503 et le quota consommé valait ZÉRO — le contrôle croyait éprouver le
   plafond alors qu'il n'atteignait jamais le décompte.

   Et c'était le SERVEUR qui avait raison : sans clef, aucun appel ne part,
   donc rien n'est dépensé, donc rien ne doit être décompté. C'est la recette
   qui vit dans cet état toute l'année.

   Il fallait donc un modèle qui existe, réponde, et ne coûte rien. Celui-ci
   compte les appels reçus et répond une erreur : cela suffit à traverser le
   décompte, et cela vérifie en prime qu'un appel décompté a bien QUITTÉ
   l'API — un plafond qui refuserait sans rien envoyer serait invisible ici. */
let appelsAuModele = 0;
const MODELE_PORT = 3460;
const faussaire = createServer((req, rep) => {
  appelsAuModele++;
  rep.writeHead(529, { "content-type": "application/json" });
  rep.end(JSON.stringify({ error: "modèle de contrôle : indisponible" }));
});
await new Promise(r => faussaire.listen(MODELE_PORT, "127.0.0.1", r));

/* ------------------------------------------------------- Lancer l'API */

const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT),
    MOT_DE_PASSE: "mot-de-passe-de-controle",
    SECRET_SESSION: SECRET,
    // Une clef quelconque : elle ne sert qu'à franchir le contrôle de
    // présence. Elle part vers le faussaire, sur la machine locale, et
    // l'API refuse toute autre destination.
    ANTHROPIC_API_KEY: "clef-de-controle-sans-valeur",
    ANTHROPIC_URL: `http://127.0.0.1:${MODELE_PORT}/v1/messages`,
    FICHIER_AMORCE: "/inexistant",
    TENANT_DEFAUT: "xavier",
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
const fermer = async () => {
  serveur.kill();
  await new Promise(r => faussaire.close(r));
  await banc.fermer();
};
if (!debout) {
  console.error("  ECHEC l API n a pas démarré\n" + journal);
  await fermer(); process.exit(1);
}

/* Une session signée pour chacun. On la fabrique comme le serveur, avec
   createHmac — et surtout PAS par substitution dans un jeton existant : ce
   raccourci-là ne produit pas une session expirée, il produit une signature
   invalide, et le contrôle mesure alors la mauvaise chose (leçon du 14/08). */
const jeton = (tenantId) => {
  const charge = Buffer.from(JSON.stringify({
    t: tenantId, expire: Date.now() + 3600_000 })).toString("base64url");
  return `session=${charge}.${createHmac("sha256", SECRET).update(charge).digest("base64url")}`;
};
const sessionX = jeton(xavier.id);
const sessionB = jeton(bob);

const appel = async (chemin, { cookie, methode = "GET", corps } = {}) => {
  const r = await fetch(BASE + chemin, {
    method: methode,
    headers: { ...(cookie ? { cookie } : {}),
               ...(corps ? { "content-type": "application/json" } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { statut: r.status, corps: await r.json().catch(() => null) };
};

/* =====================================================================
   LA LECTURE DES RÉGLAGES
   ===================================================================== */

const r0 = await appel("/api/reglages", { cookie: sessionX });
verifier("les réglages se lisent", r0.statut === 200, `statut ${r0.statut}`);
verifier("ils portent la langue et la visibilité de la bibliothèque",
  r0.corps?.langue === "fr" && r0.corps?.visibilite === "publique",
  JSON.stringify(r0.corps));
verifier("un visiteur ne lit pas les réglages",
  (await appel("/api/reglages")).statut === 401);
verifier("les rayons sont listés avec ce qu'ils contiennent",
  r0.corps?.rayons?.length === 2 && r0.corps?.livres === 3,
  JSON.stringify(r0.corps?.rayons));
verifier("aucun ouvrage n'est publié sans décision",
  r0.corps?.publies === 0, `${r0.corps?.publies} publiés`);

/* Le compte des rayons ne doit voir QUE les siens. Bob a lui aussi de la
   Philosophie : si la vue oubliait le locataire, on lirait 3 livres au lieu
   de 2 dans ce rayon, et personne ne le remarquerait. */
const philoX = r0.corps?.rayons?.find(r => r.sous_categorie === "Philosophie");
verifier("un rayon ne compte pas les ouvrages d'un autre",
  philoX?.livres === 2, JSON.stringify(philoX));

/* =====================================================================
   LA CASCADE : bibliothèque → rayon → livre
   ===================================================================== */

const publieDuVisiteur = async () =>
  (await appel("/api/livres")).corps?.map(l => l.id).sort() ?? [];

verifier("au départ, la page publique est vide",
  JSON.stringify(await publieDuVisiteur()) === "[]");

const r1 = await appel("/api/reglages/rayon", { cookie: sessionX, methode: "PUT",
  corps: { categorie: "Savoirs", sousCategorie: "Philosophie", visibilite: "publique" } });
verifier("publier un rayon publie ses ouvrages",
  JSON.stringify(await publieDuVisiteur()) === JSON.stringify(["x-philo-1", "x-philo-2"]),
  JSON.stringify(await publieDuVisiteur()));
verifier("la réponse annonce le nombre réellement publié",
  r1.corps?.publies === 2, JSON.stringify(r1.corps?.publies));

await appel("/api/reglages/livre", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-philo-2", visibilite: "privee" } });
verifier("un livre privé l'emporte sur son rayon public",
  JSON.stringify(await publieDuVisiteur()) === JSON.stringify(["x-philo-1"]),
  JSON.stringify(await publieDuVisiteur()));

await appel("/api/reglages/livre", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-eco-1", visibilite: "publique" } });
verifier("un livre public l'emporte sur son rayon hérité",
  JSON.stringify(await publieDuVisiteur()) === JSON.stringify(["x-eco-1", "x-philo-1"]),
  JSON.stringify(await publieDuVisiteur()));

/* LE VERROU MAÎTRE. Fermer la bibliothèque doit tout retirer, y compris ce
   qui est explicitement marqué public en dessous. Sans cette priorité, un
   utilisateur qui « ferme tout » en urgence laisserait sortir ses exceptions
   — c'est-à-dire précisément ce qu'il croyait avoir caché. */
await appel("/api/reglages", { cookie: sessionX, methode: "PUT",
  corps: { visibilite: "privee" } });
verifier("fermer la bibliothèque retire TOUT, exceptions comprises",
  JSON.stringify(await publieDuVisiteur()) === "[]",
  JSON.stringify(await publieDuVisiteur()));

await appel("/api/reglages", { cookie: sessionX, methode: "PUT",
  corps: { visibilite: "publique" } });
verifier("rouvrir la bibliothèque rend exactement ce qui était réglé",
  JSON.stringify(await publieDuVisiteur()) === JSON.stringify(["x-eco-1", "x-philo-1"]),
  JSON.stringify(await publieDuVisiteur()));

const r2 = await appel("/api/reglages/rayon", { cookie: sessionX, methode: "PUT",
  corps: { categorie: "Savoirs", sousCategorie: "Philosophie", visibilite: "heritee" } });
verifier("revenir à « hérité » efface le réglage plutôt que de le stocker",
  (await q("select count(*)::int n from rayons_reglages where tenant_id = $1",
           [xavier.id]))[0].n === 0,
  JSON.stringify(r2.corps?.rayons));

/* =====================================================================
   LA LANGUE
   ===================================================================== */

await appel("/api/reglages", { cookie: sessionX, methode: "PUT", corps: { langue: "en" } });
verifier("changer la langue change ce que renvoie la session",
  (await appel("/api/session", { cookie: sessionX })).corps?.langue === "en");
verifier("une langue inconnue est refusée",
  (await appel("/api/reglages", { cookie: sessionX, methode: "PUT",
     corps: { langue: "klingon" } })).statut === 400);
await appel("/api/reglages", { cookie: sessionX, methode: "PUT", corps: { langue: "fr" } });

verifier("une bibliothèque ne peut pas être « héritée » — elle n'a rien au-dessus",
  (await appel("/api/reglages", { cookie: sessionX, methode: "PUT",
     corps: { visibilite: "heritee" } })).statut === 400);

/* =====================================================================
   LE RÉGLAGE D'UN AUTRE
   ===================================================================== */

verifier("on ne règle pas un ouvrage qui n'est pas à soi",
  (await appel("/api/reglages/livre", { cookie: sessionB, methode: "PUT",
     corps: { id: "x-philo-1", visibilite: "publique" } })).statut === 404);

verifier("… et l'ouvrage visé n'a pas bougé",
  (await q("select visibilite from possessions where tenant_id = $1 and id = 'x-philo-1'",
           [xavier.id]))[0].visibilite === "heritee");

/* CE QUI DOIT MARCHER. Un contrôle qui n'énonce que des interdits reste vert
   quand tout est cassé : refuser tout le monde vérifie chaque interdiction. */
verifier("mais on règle bien les siens",
  (await appel("/api/reglages/livre", { cookie: sessionB, methode: "PUT",
     corps: { id: "b-philo-1", visibilite: "publique" } })).statut === 200);
verifier("… et cela a réellement changé la base",
  (await q("select visibilite from possessions where tenant_id = $1 and id = 'b-philo-1'",
           [bob]))[0].visibilite === "publique");

verifier("Bob ne voit pas les rayons de Xavier dans SES réglages",
  (await appel("/api/reglages", { cookie: sessionB })).corps?.livres === 1,
  JSON.stringify((await appel("/api/reglages", { cookie: sessionB })).corps?.rayons));

/* =====================================================================
   LE QUOTA

   Le faussaire répond une erreur : l'API rend donc 502. Ce qui compte n'est
   pas ce code, c'est que le décompte ait eu lieu AVANT — un appel parti,
   même mal terminé, est un appel facturé.
   ===================================================================== */

const consommer = () => appel("/api/resume", { cookie: sessionX, methode: "POST",
  corps: { bookId: "x-philo-1", forcer: true } });

const statuts = [];
for (let i = 0; i < 4; i++) statuts.push((await consommer()).statut);
verifier("les trois premiers appels franchissent le quota et partent vraiment",
  statuts.slice(0, 3).every(s => s === 502) && appelsAuModele === 3,
  `${JSON.stringify(statuts)}, ${appelsAuModele} appels reçus par le modèle`);
verifier("le quatrième est refusé pour quota, pas pour panne",
  statuts[3] === 429, JSON.stringify(statuts));
verifier("… et le quatrième n'est JAMAIS parti — c'est là qu'est l'économie",
  appelsAuModele === 3, `${appelsAuModele} appels reçus`);

const rq = await appel("/api/reglages", { cookie: sessionX });
verifier("la jauge affiche le même compte que celui qui refuse",
  rq.corps?.quota?.consomme === 3 && rq.corps?.quota?.plafond === 3,
  JSON.stringify(rq.corps?.quota));

verifier("le quota de Bob n'a pas bougé",
  (await appel("/api/reglages", { cookie: sessionB })).corps?.quota?.consomme === 0);

verifier("le journal dit d'où viennent les appels",
  (await q("select distinct route from appels_ia where tenant_id = $1", [xavier.id]))
    .every(r => r.route === "/api/resume"));

/* UN RÉSUMÉ EN CACHE NE COÛTE RIEN, donc ne doit rien décompter. Sans cette
   propriété, relire une fiche déjà résumée viderait le quota — et la jauge
   accuserait l'utilisateur d'une dépense qui n'a pas eu lieu. */
await q(`update tenants set quota_ia_mois = 10 where id = $1`, [xavier.id]);
const [ouvrage] = await q(
  "select ouvrage_id from possessions where tenant_id = $1 and id = 'x-philo-1'", [xavier.id]);
await banc.resumer(ouvrage.ouvrage_id, "fr", "Un résumé déjà écrit.");
const avantCache = (await appel("/api/reglages", { cookie: sessionX })).corps?.quota?.consomme;
await appel("/api/resume", { cookie: sessionX, methode: "POST", corps: { bookId: "x-philo-1" } });
const apresCache = (await appel("/api/reglages", { cookie: sessionX })).corps?.quota?.consomme;
verifier("un résumé servi depuis le cache ne consomme pas de quota",
  avantCache === apresCache, `${avantCache} puis ${apresCache}`);

/* ÉCHOUER FERMÉ. Sans locataire, le décompte doit LEVER, pas rendre zéro.
   On le demande à la base directement : c'est la propriété du dispositif,
   pas celle d'une route. */
let ferme = false;
await banc.dans(null, "select appels_ia_du_mois()").catch(() => { ferme = true; });
verifier("sans locataire, le décompte échoue au lieu de rendre zéro", ferme);

let fermeAussi = false;
await banc.dans(null, "select * from consommer_appel_ia('/api/resume')")
  .catch(() => { fermeAussi = true; });
verifier("sans locataire, on ne peut pas consommer d'appel", fermeAussi);

/* LA CONCURRENCE. Le banc partage une connexion ; il faut donc les siennes
   pour que les transactions soient réellement simultanées. */
await q("delete from appels_ia");
await q("update tenants set quota_ia_mois = 3 where id = $1", [xavier.id]);
const enParallele = await Promise.allSettled(Array.from({ length: 8 }, async () => {
  const c = new pg.Client(banc.url);
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.tenant_id', $1, true)", [xavier.id]);
    const r = await c.query("select * from consommer_appel_ia('/simultane')");
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { await c.end(); }
}));
const acceptes = enParallele.filter(r => r.status === "fulfilled").length;
const ecrits = (await q("select count(*)::int n from appels_ia"))[0].n;
verifier("huit appels simultanés, plafond 3 : exactement 3 passent",
  acceptes === 3, `${acceptes} acceptés`);
verifier("… et exactement 3 lignes sont écrites",
  ecrits === 3, `${ecrits} lignes`);

/* =====================================================================
   ENREGISTRER UN LIVRE NE DOIT PAS EFFACER SON RÉGLAGE

   Le défaut signalé le 15/08 en écrivant enregistrerLivres, réparé le 16.
   Sans cette vérification, le menu de réglages défait ses propres réglages
   dès qu'on touche à une note — et le livre redevient PUBLIC en silence.
   ===================================================================== */

/* MÊME FAMILLE, TROUVÉE EN PRODUCTION LE 18/08 : UN CHAMP VIDE N'EST PAS
   UNE CORRECTION.
   Le titre, l'auteur, l'éditeur et l'année du CATALOGUE étaient écrasés sans
   condition, alors que les pages et la couverture étaient protégées. Une
   fiche issue de Google Books — qui rend rarement l'éditeur — venait donc
   vider un éditeur que la BnF avait correctement renseigné.
   ET LE CATALOGUE EST PARTAGÉ : l'effacement vaut pour tous les possesseurs
   de la même édition. C'est le seul défaut de la série qui détruit. */
await appel("/api/livres", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-philo-1", isbn: "9780000000101", titre: "Titre x-philo-1",
           auteur: "Auteur", editeur: "Éditions de Contrôle", annee: 2011,
           categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro" } });
await appel("/api/livres", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-philo-1", isbn: "9780000000101", titre: "Titre x-philo-1",
           auteur: "Auteur", editeur: "", annee: null,
           categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro" } });
const [notice] = await q(
  `select o.editeur, o.annee from possessions p join ouvrages o on o.id = p.ouvrage_id
    where p.id = 'x-philo-1' and p.tenant_id = $1`, [xavier.id]);
verifier("un éditeur vide n'efface pas l'éditeur du catalogue",
  notice?.editeur === "Éditions de Contrôle", JSON.stringify(notice));
verifier("… ni une année absente l'année déjà connue",
  notice?.annee === 2011, JSON.stringify(notice));

/* Mais une VRAIE correction passe toujours : on n'a pas gelé le catalogue,
   on a seulement refusé que le vide fasse autorité. */
await appel("/api/livres", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-philo-1", isbn: "9780000000101", titre: "Titre x-philo-1",
           auteur: "Auteur", editeur: "Éditions Corrigées", annee: 2012,
           categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro" } });
const [corrigee] = await q(
  `select o.editeur, o.annee from possessions p join ouvrages o on o.id = p.ouvrage_id
    where p.id = 'x-philo-1' and p.tenant_id = $1`, [xavier.id]);
verifier("une correction réelle du catalogue reste possible",
  corrigee?.editeur === "Éditions Corrigées" && corrigee?.annee === 2012,
  JSON.stringify(corrigee));

await appel("/api/reglages/livre", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-philo-1", visibilite: "privee" } });
await appel("/api/livres", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-philo-1", isbn: "9780000000101", titre: "Titre x-philo-1",
           auteur: "Auteur", categorie: "Savoirs",
           sous_categorie: "Philosophie", sphere: "Pro", note: 5 } });
verifier("modifier une note n'efface pas la visibilité choisie",
  (await q("select visibilite from possessions where tenant_id = $1 and id = 'x-philo-1'",
           [xavier.id]))[0].visibilite === "privee",
  (await q("select visibilite from possessions where tenant_id = $1 and id = 'x-philo-1'",
           [xavier.id]))[0].visibilite);

/* LA NOTE A CHANGÉ DE TABLE, PAS DE SENS. Elle vit dans « lectures »,
   attachée au compte qui la porte — ici l'unique membre de la bibliothèque,
   que la session par mot de passe désigne sans ambiguïté. */
verifier("… mais la note a bien été enregistrée (sinon on ne prouve rien)",
  Number((await q(`select note from lectures
                    where tenant_id = $1 and possession = 'x-philo-1'
                      and compte_id = $2`, [xavier.id, compteX]))[0]?.note) === 5,
  JSON.stringify(await q("select * from lectures where tenant_id = $1", [xavier.id])));

/* Un ouvrage NEUF, lui, doit recevoir le point de départ historique :
   Pro public, Perso privé. Sans quoi tout ce qu'on ajoute après la bascule
   disparaît de la page publique sans explication. */
await appel("/api/livres", { cookie: sessionX, methode: "PUT",
  corps: { id: "x-neuf", isbn: "9780000000999", titre: "Neuf", auteur: "A",
           categorie: "Savoirs", sous_categorie: "Économie", sphere: "Pro" } });
verifier("un ouvrage neuf reçoit le point de départ, pas « hérité »",
  (await q("select visibilite from possessions where tenant_id = $1 and id = 'x-neuf'",
           [xavier.id]))[0].visibilite === "publique");

/* =====================================================================
   LE CLOISONNEMENT DE LA TABLE « tenants » ELLE-MÊME
   ===================================================================== */

const bougees = await banc.dans(xavier.id, "update tenants set langue = 'en'")
  .then(() => q("select identifiant, langue from tenants order by identifiant"));
verifier("une écriture sans « where » ne touche QUE son propre locataire",
  bougees.find(t => t.identifiant === "bob")?.langue === "fr",
  JSON.stringify(bougees));

let creationRefusee = false;
await banc.dans(xavier.id,
  "insert into tenants (identifiant, nom) values ('pirate', 'P')")
  .catch(() => { creationRefusee = true; });
verifier("l'application ne peut pas créer de locataire", creationRefusee);

const forcees = await q(
  `select count(*)::int n from pg_class
    where relname in ('tenants', 'appels_ia')
      and relrowsecurity and relforcerowsecurity`);
verifier("« tenants » et « appels_ia » sont sous « force row level security »",
  forcees[0].n === 2, `${forcees[0].n} sur 2`);

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Réglages : langue, visibilité, quota ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
