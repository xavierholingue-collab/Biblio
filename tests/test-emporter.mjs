/* =========================================================================
   PARTIR AVEC SES LIVRES

   « Si une personne fait partie d'une équipe et veut se retirer, que
   pourrions-nous faire pour qu'elle puisse exporter ses livres » — et la
   réponse convenue : on emporte une COPIE, y compris d'un ouvrage qu'on n'a
   pas apporté.

   ---------------------------------------------------------------------------
   CE QUI PEUT ÊTRE FAUX SANS QUE RIEN NE CASSE

   1. LA COPIE NE COPIE RIEN. Le contexte ne désigne qu'une bibliothèque à la
      fois : la destination est invisible depuis la source. Une condition
      « ce livre y est-il déjà ? » posée naïvement répond toujours « non »,
      et une condition « cet identifiant est-il libre ? » toujours « oui ».
      Selon le sens de l'erreur, on obtient des doublons, une clef primaire
      qui saute, ou zéro ligne — et zéro ligne ne lève pas.

   2. ON EMPORTE CHEZ QUELQU'UN D'AUTRE. La destination est un paramètre
      fourni par le navigateur : c'est la deuxième route du produit dans ce
      cas, après la bascule. Une borne qui manque déverse une bibliothèque
      entière chez un tiers.

   3. LA COPIE ARRIVE PUBLIQUE. Les exceptions de visibilité étaient celles
      de l'équipe. Recopiées telles quelles dans une bibliothèque publique,
      elles publient sous votre nom ce que vous n'avez pas choisi de publier.

   4. L'ÉTAGÈRE ARRIVE SANS MÉMOIRE. Tout « à lire », y compris ce qu'on a
      lu la semaine passée. Rien ne casse ; c'est simplement faux.

   USAGE
     node tests/test-emporter.mjs
   ========================================================================= */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const MDP    = "mot-de-passe-de-controle";
const SECRET = "un-secret-de-controle-suffisamment-long-pour-passer";
const PORT   = 3476;
const BASE   = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55511 });
const { q, semer, locataire } = banc;

/* --------------------------------------------------------- Le décor ---

   « cabinet » — le fonds commun, trois ouvrages, deux membres.
   « chezmoi » — la bibliothèque personnelle de Camille, qui possède DÉJÀ
                 l'un des trois : c'est le cas qui distingue « copié » de
                 « ignoré », et celui qui casse une copie naïve.
   « etranger » — là où Camille n'a rien à faire.                        */

const cabinet  = await locataire("cabinet",  "publique");
const chezmoi  = await locataire("chezmoi",  "privee");
const etranger = await locataire("etranger", "privee");

const partage = await semer({ tenant: cabinet, id: "cab-1",
  isbn: "9782070360024", titre: "Le Mythe de Sisyphe", auteur: "Camus" });
await semer({ tenant: cabinet, id: "cab-2", titre: "Un deuxième du cabinet" });
await semer({ tenant: cabinet, id: "cab-3", titre: "Un troisième du cabinet" });

/* LE MÊME OUVRAGE, DÉJÀ CHEZ CAMILLE — et sous le MÊME identifiant de
   possession, ce qui éprouve d'un coup les deux collisions possibles :
   l'ouvrage déjà présent, et l'identifiant déjà pris. */
await semer({ tenant: chezmoi, id: "cab-1", isbn: "9782070360024",
  titre: "Le Mythe de Sisyphe", auteur: "Camus" });
await semer({ tenant: etranger, id: "etr-1", titre: "Chez quelqu'un d'autre" });

const camille   = await banc.compte(cabinet, "camille@controle.fr");
const dominique = await banc.compte(cabinet, "dominique@controle.fr", "membre");
await banc.compte(etranger, "etranger@controle.fr");

/* Camille possède aussi « chezmoi ». */
await q(`insert into membres (compte_id, tenant_id, role)
         values ($1, $2, 'proprietaire')`, [camille, chezmoi]);

/* Une visibilité EXPLICITEMENT PUBLIQUE posée par l'équipe : c'est elle qui
   ne doit pas suivre. Sans cette ligne, le contrôle sur la visibilité
   passerait au vert en ne rencontrant que des « heritee ». */
await q(`update possessions set visibilite = 'publique'
          where tenant_id = $1 and id = 'cab-2'`, [cabinet]);

/* Les lectures de chacun. Celle de Dominique ne doit JAMAIS suivre Camille. */
await banc.lire(cabinet, "cab-2", camille,   "Lu",       5);
await banc.lire(cabinet, "cab-3", dominique, "En cours", 2);

/* ------------------------------------------------------- Lancer l'API */

const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT), MOT_DE_PASSE: MDP, SECRET_SESSION: SECRET,
    ANTHROPIC_API_KEY: "", FICHIER_AMORCE: "/inexistant",
    TENANT_DEFAUT: "cabinet", INSCRIPTION_OUVERTE: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
serveur.stdout.on("data", d => { journal += d; });
serveur.stderr.on("data", d => { journal += d; });

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
let debout = false;
for (let i = 0; i < 40 && !debout; i++) {
  try { debout = (await fetch(`${BASE}/api/sante`)).ok; } catch { await dormir(400); }
}
const fermer = async () => { serveur.kill(); await banc.fermer(); };
if (!debout) {
  console.error("  ECHEC l'API n'a pas démarré\n" + journal);
  await fermer(); process.exit(1);
}

const appel = async (chemin, { cookie, methode = "GET", corps } = {}) => {
  const r = await fetch(BASE + chemin, {
    method: methode,
    headers: { ...(cookie ? { cookie } : {}),
               ...(corps ? { "content-type": "application/json" } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => null) };
};

const signerJeton = (charge) => {
  const brut = Buffer.from(JSON.stringify(charge)).toString("base64url");
  return "session=" + brut + "." +
    createHmac("sha256", SECRET).update(brut).digest("base64url");
};
const sessionDe = (compte, tenant) =>
  signerJeton({ c: compte, t: tenant, expire: Date.now() + 1e9 });

const sCamille   = sessionDe(camille, cabinet);
const sDominique = sessionDe(dominique, cabinet);

/* =====================================================================
   1. CE QUI DOIT ÊTRE REFUSÉ

   D'abord, parce qu'une copie réussie n'apprend rien sur les bornes.
   ===================================================================== */

/* 400 OU 403 — LES DEUX SONT DES REFUS, ET LA DISTINCTION EST VOULUE.
   400 : la valeur n'est pas un identifiant (une faute de forme, qui ne
   révèle rien). 403 : la valeur en est un, mais pas le vôtre. Ce qu'on
   exige de tous, c'est qu'aucune ligne n'atterrisse chez le tiers — et
   qu'aucun 500 ne fasse croire à une panne. */
const inchange = async (nom, reponse) => {
  verifier(nom, reponse.statut === 403 || reponse.statut === 400,
    `statut ${reponse.statut} — ${JSON.stringify(reponse.corps)}`);
  const chez = Number((await q(
    "select count(*) as n from possessions where tenant_id = $1", [etranger]))[0].n);
  verifier(`… ${nom} : rien n'a été déversé chez le tiers`,
    chez === 1, `${chez} ouvrage(s) au lieu de 1`);
};

await inchange("copier vers la bibliothèque d'un tiers est refusé",
  await appel("/api/bibliotheque/copie",
    { cookie: sCamille, methode: "POST", corps: { cible: etranger } }));

await inchange("copier vers un identifiant inventé est refusé",
  await appel("/api/bibliotheque/copie",
    { cookie: sCamille, methode: "POST",
      corps: { cible: "00000000-0000-0000-0000-000000000000" } }));

await inchange("copier vers une valeur qui n'est pas un identifiant est refusé",
  await appel("/api/bibliotheque/copie",
    { cookie: sCamille, methode: "POST", corps: { cible: "' or 1=1 --" } }));

{
  const surPlace = await appel("/api/bibliotheque/copie",
    { cookie: sCamille, methode: "POST", corps: { cible: cabinet } });
  verifier("copier une bibliothèque sur elle-même est refusé",
    surPlace.statut === 403,
    `statut ${surPlace.statut} — ${JSON.stringify(surPlace.corps)}`);
}

{
  const anonyme = await (async () => {
    const r = await fetch(BASE + "/api/connexion", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ motDePasse: MDP }) });
    return (r.headers.get("set-cookie") ?? "").split(";")[0];
  })();
  const r = await appel("/api/bibliotheque/copie",
    { cookie: anonyme, methode: "POST", corps: { cible: chezmoi } });
  verifier("une session par mot de passe ne peut pas emporter",
    r.statut === 403, `statut ${r.statut} — ${JSON.stringify(r.corps)}`);
}

/* =====================================================================
   2. LA COPIE VERS UNE BIBLIOTHÈQUE QUE L'ON A DÉJÀ
   ===================================================================== */

const avantChezMoi = Number((await q(
  "select count(*) as n from possessions where tenant_id = $1", [chezmoi]))[0].n);

const copie = await appel("/api/bibliotheque/copie",
  { cookie: sCamille, methode: "POST", corps: { cible: chezmoi } });

verifier("camille emporte une copie vers sa propre bibliothèque",
  copie.statut === 200, `statut ${copie.statut} — ${JSON.stringify(copie.corps)}`);

verifier("… deux ouvrages copiés, un ignoré parce que déjà présent",
  copie.corps?.copies === 2 && copie.corps?.ignores === 1,
  JSON.stringify(copie.corps));

{
  const apres = await q(
    `select p.id, o.titre, p.visibilite from possessions p
       join ouvrages o on o.id = p.ouvrage_id
      where p.tenant_id = $1 order by o.titre`, [chezmoi]);

  verifier("… l'étagère est passée de 1 à 3",
    avantChezMoi === 1 && apres.length === 3,
    `${avantChezMoi} → ${apres.length}`);

  verifier("… sans doublon de l'ouvrage déjà possédé",
    apres.filter(r => r.titre === "Le Mythe de Sisyphe").length === 1,
    JSON.stringify(apres.map(r => r.titre)));

  /* PIÈGE 3 : la visibilité posée par l'équipe ne suit pas. */
  verifier("… et AUCUNE copie n'arrive avec une visibilité choisie ailleurs",
    apres.filter(r => r.titre !== "Le Mythe de Sisyphe")
         .every(r => r.visibilite === "heritee"),
    JSON.stringify(apres)
      + " — une exception de l'équipe publierait sous votre nom");

  /* L'identifiant est gardé quand il est libre, dérivé quand il est pris. */
  verifier("… l'identifiant est gardé quand il est libre",
    apres.some(r => r.id === "cab-2") && apres.some(r => r.id === "cab-3"),
    JSON.stringify(apres.map(r => r.id)));
}

/* LE FONDS D'ORIGINE N'A RIEN PERDU — on copie, on ne reprend pas. */
{
  const restant = Number((await q(
    "select count(*) as n from possessions where tenant_id = $1", [cabinet]))[0].n);
  verifier("le fonds du cabinet est intact — on copie, on ne reprend pas",
    restant === 3, `${restant} ouvrage(s) au lieu de 3`);
}

/* PIÈGE 4 : les lectures suivent leur propriétaire, et lui seul. */
{
  const chez = await q(
    `select l.statut, l.note::text as note, o.titre
       from lectures l
       join possessions p on p.tenant_id = l.tenant_id and p.id = l.possession
       join ouvrages o on o.id = p.ouvrage_id
      where l.tenant_id = $1 and l.compte_id = $2`, [chezmoi, camille]);

  verifier("la lecture de camille l'a suivie",
    chez.length === 1 && chez[0].titre === "Un deuxième du cabinet"
      && chez[0].statut === "Lu" && chez[0].note === "5.0",
    JSON.stringify(chez));

  const deDominique = await q(
    "select count(*) as n from lectures where tenant_id = $1 and compte_id = $2",
    [chezmoi, dominique]);
  verifier("… et celle de dominique est restée où elle était",
    Number(deDominique[0].n) === 0,
    "la lecture d'un collègue a été emportée avec l'étagère");
}

/* LE FILTRE « mes lectures » SE TIENT TOUT SEUL — contrôle ajouté après une
   mutation qui a SURVÉCU, le 05/09/2026.

   La copie des lectures dit « where l.compte_id = qui », et la politique
   « lectures_lecture » ne montre de toute façon que les vôtres. Deux
   remparts pour un défaut : retirer le filtre laissait les vingt-sept
   vérifications au vert, parce que la politique rattrapait.

   Or ce défaut-là serait grave : l'insertion attribue TOUJOURS la lecture à
   « qui ». Sans filtre, et si la politique venait à s'assouplir, Camille
   emporterait le statut de lecture de Dominique COMME S'IL ÉTAIT LE SIEN.

   On l'isole donc avec le seul instrument qui traverse les politiques :
   l'observateur, superutilisateur. Ce qui reste alors est exactement la
   clause « where ». C'est la règle 8 de METHODE.md, deuxième application. */
{
  const refuge = await locataire("refuge", "privee");
  await q(`insert into membres (compte_id, tenant_id, role)
           values ($1, $2, 'proprietaire')`, [camille, refuge]);

  await banc.oeil.query("select set_config('app.tenant_id', $1, false)", [cabinet]);
  await banc.oeil.query("select set_config('app.compte_id', $1, false)", [camille]);
  await banc.oeil.query("select * from public.copier_dans($1)", [refuge]);
  await banc.oeil.query("select set_config('app.tenant_id', '', false)");
  await banc.oeil.query("select set_config('app.compte_id', '', false)");

  const emportees = await q(
    `select l.compte_id, l.statut, o.titre from lectures l
       join possessions p on p.tenant_id = l.tenant_id and p.id = l.possession
       join ouvrages o on o.id = p.ouvrage_id
      where l.tenant_id = $1 order by o.titre`, [refuge]);

  verifier("politiques traversées, seule MA lecture est emportée",
    emportees.length === 1 && emportees[0].titre === "Un deuxième du cabinet",
    JSON.stringify(emportees)
      + " — la lecture d'un collègue a été emportée sous mon nom");
  verifier("… et elle m'est attribuée, à moi",
    emportees[0]?.compte_id === camille, JSON.stringify(emportees));
}

/* REJOUER LA COPIE NE DOIT RIEN AJOUTER. Quelqu'un qui clique deux fois ne
   doit pas se retrouver avec une étagère en double. */
{
  const encore = await appel("/api/bibliotheque/copie",
    { cookie: sCamille, methode: "POST", corps: { cible: chezmoi } });
  const apres = Number((await q(
    "select count(*) as n from possessions where tenant_id = $1", [chezmoi]))[0].n);
  verifier("copier deux fois n'ajoute rien",
    encore.corps?.copies === 0 && apres === 3,
    `${JSON.stringify(encore.corps)} — ${apres} ouvrage(s)`);
}

/* =====================================================================
   3. QUELQU'UN QUI N'A QUE L'ÉQUIPE

   C'est le cas de Xavier dans sa question. Sans destination, la sortie ne
   serait qu'une phrase.
   ===================================================================== */

{
  const avant = Number((await q("select count(*) as n from tenants"))[0].n);

  const sortie = await appel("/api/bibliotheque/copie",
    { cookie: sDominique, methode: "POST", corps: { nom: "Ma bibliothèque" } });

  verifier("dominique, qui n'a que l'équipe, obtient une bibliothèque neuve",
    sortie.statut === 200 && sortie.corps?.creee === true,
    `statut ${sortie.statut} — ${JSON.stringify(sortie.corps)}`);

  verifier("… inscriptions FERMÉES, car partir n'est pas s'inscrire",
    sortie.corps?.copies === 3, JSON.stringify(sortie.corps));

  const apres = Number((await q("select count(*) as n from tenants"))[0].n);
  verifier("… et une seule bibliothèque a été créée",
    apres === avant + 1, `${avant} → ${apres}`);

  const neuve = sortie.corps?.bibliotheque;
  const role = await q(
    "select role from membres where tenant_id = $1 and compte_id = $2",
    [neuve, dominique]);
  verifier("… dont il est PROPRIÉTAIRE",
    role[0]?.role === "proprietaire", JSON.stringify(role));

  const nom = await q("select nom, visibilite from tenants where id = $1", [neuve]);
  verifier("… elle porte le nom demandé",
    nom[0]?.nom === "Ma bibliothèque", JSON.stringify(nom[0]));
  verifier("… et elle est PRIVÉE, comme toute bibliothèque neuve",
    nom[0]?.visibilite === "privee", JSON.stringify(nom[0]));

  const sienne = await q(
    `select l.statut, o.titre from lectures l
       join possessions p on p.tenant_id = l.tenant_id and p.id = l.possession
       join ouvrages o on o.id = p.ouvrage_id
      where l.tenant_id = $1`, [neuve]);
  verifier("… et sa propre lecture l'a suivi",
    sienne.length === 1 && sienne[0].titre === "Un troisième du cabinet"
      && sienne[0].statut === "En cours",
    JSON.stringify(sienne));

  /* IL PEUT MAINTENANT PARTIR POUR DE BON — c'est la séquence complète que
     la question décrivait : emporter, puis se retirer. */
  const depart = await appel("/api/membres",
    { cookie: sDominique, methode: "DELETE" });
  verifier("… puis quitter l'équipe, ses livres emportés",
    depart.statut === 200, `statut ${depart.statut} — ${JSON.stringify(depart.corps)}`);

  const encoreLa = Number((await q(
    "select count(*) as n from possessions where tenant_id = $1", [neuve]))[0].n);
  verifier("… et ce qu'il a emporté est toujours chez lui",
    encoreLa === 3, `${encoreLa} ouvrage(s)`);
}

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Partir avec ses livres ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
