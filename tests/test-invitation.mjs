/* =========================================================================
   INVITER, REJOINDRE, PARTIR — la chaîne complète, à travers HTTP

   L'INVITATION EST LA SEULE FONCTION DU PRODUIT QUI FASSE ENTRER QUELQU'UN
   CHEZ SOI. Tout le reste du cloisonnement dit qui ne peut PAS voir quoi ;
   celle-ci dit l'inverse, et une erreur y a donc l'effet opposé de partout
   ailleurs : elle ne ferme pas trop, elle ouvre trop.

   ---------------------------------------------------------------------------
   LES CINQ CHOSES QUI PEUVENT ÊTRE FAUSSES SANS QUE RIEN NE CASSE

   1. L'INVITÉ SANS COMPTE REÇOIT SA PROPRE BIBLIOTHÈQUE VIDE. Le lien
      marche, la personne entre, tout a l'air normal — sauf qu'elle est
      seule devant rien, et que le cabinet qui l'attendait ne la voit pas
      arriver. C'est le défaut que la colonne « rejoint » existe pour
      empêcher, et il ne produit AUCUNE erreur.

   2. L'INVITÉ ARRIVE PROPRIÉTAIRE. Rien ne casse non plus — jusqu'au jour
      où il supprime la bibliothèque, ce qu'il a alors parfaitement le droit
      de faire.

   3. N'IMPORTE QUEL MEMBRE PEUT INVITER. La bibliothèque s'ouvre de proche
      en proche, et personne ne s'en aperçoit avant que ce soit fait.

   4. L'INVITATION TOMBE SOUS LE PLAFOND D'INSCRIPTION. Le lien reçu ne
      marche pas, sans qu'on puisse dire pourquoi — ni celui qui invite, ni
      celui qui est invité.

   5. LE DERNIER PROPRIÉTAIRE PART. La bibliothèque continue de coûter et
      plus personne n'a le droit d'y toucher.

   USAGE
     node tests/test-invitation.mjs
   ========================================================================= */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { ouvrirBanc } from "./banc-postgres.mjs";

const API = ["api", path.join("..", "api")].find(c => fs.existsSync(path.join(c, "server.js")));
if (!API) { console.error("  ECHEC api/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const SECRET = "un-secret-de-controle-suffisamment-long-pour-passer";
const PORT   = 3466;
const PORT_COURRIEL = 3467;
const BASE   = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55499 });
const { q, semer, locataire } = banc;

/* ------------------------------------------------- Le faux service d'envoi

   ON LIT LE COURRIEL PLUTÔT QUE DE DEVINER LE JETON. Fabriquer le lien à
   partir de la base reviendrait à éprouver la base ; ici on veut savoir ce
   que la PERSONNE INVITÉE reçoit — c'est-à-dire si le service tient sa
   promesse de bout en bout. */
const recus = [];
const faussaire = createServer(async (req, rep) => {
  let brut = "";
  for await (const m of req) brut += m;
  recus.push({ corps: (() => { try { return JSON.parse(brut); } catch { return null; } })() });
  rep.writeHead(200, { "content-type": "application/json" });
  rep.end('{"id":"controle"}');
});
await new Promise(r => faussaire.listen(PORT_COURRIEL, "127.0.0.1", r));

/* Le jeton se lit dans le corps du message, comme le ferait la personne en
   cliquant. */
const dernierJeton = () => {
  const m = /[?&]jeton=([\w.~-]+)/.exec(
    JSON.stringify(recus[recus.length - 1]?.corps ?? {}));
  return m ? decodeURIComponent(m[1]) : null;
};

/* --------------------------------------------------------- Le décor --- */

const cabinet = await locataire("cabinet", "privee");
const ailleurs = await locataire("ailleurs", "privee");

await semer({ tenant: cabinet,  id: "cab-1", titre: "Le fonds du cabinet" });
await semer({ tenant: ailleurs, id: "ail-1", titre: "Ailleurs" });

const proprio  = await banc.compte(cabinet, "proprio@controle.fr");
const employe  = await banc.compte(cabinet, "employe@controle.fr", "membre");
await banc.compte(ailleurs, "ailleurs@controle.fr");

await q("update tenants set nom = $1 where id = $2",
        ["Cabinet Y-Factor", cabinet]);

/* COMBIEN DE BIBLIOTHÈQUES AVANT, LU EN BASE PLUTÔT QUE COMPTÉ DE TÊTE.

   Une première rédaction affirmait « 2 » — le cabinet et ailleurs. Il y en
   avait 3 : la migration 02 pose le locataire par défaut « xavier », et je
   l'avais oublié. Le contrôle était rouge alors que le code était juste,
   ce qui est la version bénigne d'une faute dont la version grave est
   l'inverse : un chiffre deviné qui se trouve juste par accident, et une
   régression qui passe.

   La règle vaut dans les deux sens : on lit l'état de départ, on ne le
   suppose pas. */
const bibliothequesAuDepart = Number(
  (await q("select count(*) as n from tenants"))[0].n);

/* ------------------------------------------------------- Lancer l'API ---

   « INSCRIPTION_OUVERTE » RESTE À ZÉRO POUR TOUT CE FICHIER, et c'est
   volontaire : une invitation n'est pas une inscription. Si elle passait
   sous ce drapeau, tout ce qui suit tomberait — ce qui est exactement le
   contrôle qu'on veut. */
const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT),
    MOT_DE_PASSE: "mot-de-passe-de-controle",
    SECRET_SESSION: SECRET,
    ANTHROPIC_API_KEY: "",
    FICHIER_AMORCE: "/inexistant",
    TENANT_DEFAUT: "cabinet",
    INSCRIPTION_OUVERTE: "0",
    COURRIEL_SERVICE: "resend",
    COURRIEL_CLEF: "cle-de-controle",
    COURRIEL_EXPEDITEUR: "biblio@exemple.fr",
    COURRIEL_URL: `http://127.0.0.1:${PORT_COURRIEL}/envoi`,
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

const fermer = async () => {
  serveur.kill(); faussaire.close(); await banc.fermer();
};

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
  return { statut: r.status, cookie: r.headers.get("set-cookie"),
           corps: await r.json().catch(() => null) };
};

const signerJeton = (charge) => {
  const brut = Buffer.from(JSON.stringify(charge)).toString("base64url");
  return "session=" + brut + "." +
    createHmac("sha256", SECRET).update(brut).digest("base64url");
};
const sessionDe = (compte, tenant) =>
  signerJeton({ c: compte, t: tenant, expire: Date.now() + 1e9 });

/* UN CONTRÔLE QUI PLANTE N'EST PAS UN CONTRÔLE QUI ÉCHOUE — 5e occurrence.

   Éprouvé le 05/09/2026 : en court-circuitant la branche « invitation » de
   « consommerLien », l'invitation retombe dans l'inscription ordinaire,
   celle-ci est refusée puisque les inscriptions sont fermées, le compte
   attendu n'existe donc pas — et « rows[0].id » a fait mourir le processus.
   LE FICHIER N'A RIEN IMPRIMÉ DU TOUT : trente vérifications déjà passées,
   perdues, et le vrai défaut invisible.

   Ce n'est pas la première fois ; c'est le motif que test-suppression.mjs
   décrit depuis le 24/08. Toute lecture qui SUPPOSE qu'une étape précédente
   a réussi doit donc échouer par un nom, jamais par une pile d'appels. */
const idDuCompte = async (courriel, pourquoi) => {
  const r = await q("select id from comptes where courriel = $1", [courriel]);
  if (!r.length) {
    verifier(pourquoi, false,
      `aucun compte « ${courriel} » — une étape précédente n'a pas abouti`);
    return null;
  }
  return r[0].id;
};

const sessionProprio = sessionDe(proprio, cabinet);
const sessionEmploye = sessionDe(employe, cabinet);

/* =====================================================================
   1. QUI PEUT INVITER
   ===================================================================== */

{
  recus.length = 0;
  const parEmploye = await appel("/api/membres",
    { cookie: sessionEmploye, methode: "POST",
      corps: { courriel: "intrus@controle.fr" } });
  verifier("un membre non propriétaire ne peut PAS inviter",
    parEmploye.statut === 403,
    `statut ${parEmploye.statut} — ${JSON.stringify(parEmploye.corps)}`);
  verifier("… et aucun courriel n'est parti",
    recus.length === 0, `${recus.length} envoi(s)`);
  const liens = await q("select count(*)::int n from liens_connexion");
  verifier("… et aucun lien n'a été posé en base",
    liens[0].n === 0, JSON.stringify(liens[0]));
}

{
  /* La session par mot de passe n'identifie personne : elle ne peut pas
     inviter, pour la même raison qu'elle ne peut pas supprimer. */
  const cx = await appel("/api/connexion",
    { methode: "POST", corps: { motDePasse: "mot-de-passe-de-controle" } });
  const anonyme = (cx.cookie ?? "").split(";")[0];
  const essai = await appel("/api/membres",
    { cookie: anonyme, methode: "POST", corps: { courriel: "x@controle.fr" } });
  verifier("une session par mot de passe ne peut pas inviter",
    essai.statut === 403, `statut ${essai.statut}`);
}

/* =====================================================================
   2. INVITER QUELQU'UN QUI N'A PAS DE COMPTE

   LE CAS CENTRAL. Les inscriptions sont FERMÉES pour ce serveur : si
   l'invitation empruntait la porte de l'inscription, rien de ce qui suit
   ne fonctionnerait.
   ===================================================================== */

recus.length = 0;
const invitation = await appel("/api/membres",
  { cookie: sessionProprio, methode: "POST",
    corps: { courriel: "Nouvelle@Controle.FR" } });

verifier("un propriétaire peut inviter, inscriptions FERMÉES",
  invitation.statut === 200 && invitation.corps?.invite === true,
  `statut ${invitation.statut} — ${JSON.stringify(invitation.corps)}`);

verifier("… un courriel part",
  recus.length === 1, `${recus.length} envoi(s)`);

const texteInvitation = JSON.stringify(recus[0]?.corps ?? {});
verifier("… il nomme la bibliothèque, pour qu'on sache où mène le lien",
  texteInvitation.includes("Cabinet Y-Factor"), texteInvitation.slice(0, 200));

verifier("… et il ne nomme pas qui invite",
  !texteInvitation.includes("proprio@controle.fr"), texteInvitation.slice(0, 200));

/* AUCUNE BIBLIOTHÈQUE N'EST CRÉÉE PAR L'ENVOI — rien n'existe avant que le
   lien soit ouvert, comme pour l'inscription. */
{
  const t = await q("select count(*)::int n from tenants");
  verifier("… et rien n'est créé tant que le lien n'est pas ouvert",
    t[0].n === bibliothequesAuDepart,
    `${t[0].n} au lieu de ${bibliothequesAuDepart}`);
}

const jetonInvitation = dernierJeton();
verifier("le lien reçu porte un jeton", Boolean(jetonInvitation),
  texteInvitation.slice(0, 200));

/* --------------------------------------------------- On ouvre le lien */

const arrivee = await appel("/api/connexion-lien",
  { methode: "POST", corps: { jeton: jetonInvitation } });
verifier("le lien d'invitation ouvre une session",
  arrivee.statut === 200, `statut ${arrivee.statut} — ${JSON.stringify(arrivee.corps)}`);

const cookieInvite = (arrivee.cookie ?? "").split(";")[0];

/* LA VÉRIFICATION QUI COMPTE LE PLUS : aucune bibliothèque de plus. */
{
  const t = await q("select identifiant from tenants order by identifiant");
  verifier("REJOINDRE NE CRÉE PAS DE BIBLIOTHÈQUE",
    t.length === bibliothequesAuDepart,
    `${t.length} au lieu de ${bibliothequesAuDepart} : `
    + `${t.map(x => x.identifiant).join(", ")} — l'invité a reçu la sienne, `
    + "vide, au lieu de rejoindre celle qui l'attendait");
}

{
  const m = await q(
    `select c.courriel, m.role from membres m join comptes c on c.id = m.compte_id
      where m.tenant_id = $1 order by c.courriel`, [cabinet]);
  verifier("… l'invité est bien membre du cabinet",
    m.some(x => x.courriel === "nouvelle@controle.fr"), JSON.stringify(m));
  verifier("… avec le rôle « membre », JAMAIS « proprietaire »",
    m.find(x => x.courriel === "nouvelle@controle.fr")?.role === "membre",
    JSON.stringify(m));
}

/* L'ADRESSE EST NORMALISÉE. Invitée en « Nouvelle@Controle.FR », la
   personne se connectera plus tard en minuscules — deux comptes pour une
   personne serait le genre de défaut qu'on ne voit qu'au support. */
{
  const c = await q("select courriel from comptes where courriel ilike $1",
    ["nouvelle@controle.fr"]);
  verifier("… et son adresse est enregistrée en minuscules",
    c.length === 1 && c[0].courriel === "nouvelle@controle.fr",
    JSON.stringify(c));
}

/* CE QUE L'INVITÉ VOIT EN ARRIVANT : le fonds du cabinet, et pas un écran
   vide. C'est la promesse du courriel, éprouvée par le résultat. */
{
  const vue = await appel("/api/livres", { cookie: cookieInvite });
  verifier("… et en arrivant, il voit le fonds du cabinet",
    Array.isArray(vue.corps) && vue.corps.some(l => l.titre === "Le fonds du cabinet"),
    JSON.stringify(vue.corps));
}

/* LE LIEN NE SERT QU'UNE FOIS. */
{
  const rejoue = await appel("/api/connexion-lien",
    { methode: "POST", corps: { jeton: jetonInvitation } });
  verifier("le lien d'invitation ne sert pas deux fois",
    rejoue.statut === 401, `statut ${rejoue.statut}`);
}

/* =====================================================================
   3. INVITER QUELQU'UN QUI A DÉJÀ UN COMPTE

   Il ne doit pas perdre la sienne : rejoindre AJOUTE une appartenance.
   ===================================================================== */

recus.length = 0;
await appel("/api/membres",
  { cookie: sessionProprio, methode: "POST",
    corps: { courriel: "ailleurs@controle.fr" } });
const arrivee2 = await appel("/api/connexion-lien",
  { methode: "POST", corps: { jeton: dernierJeton() } });
verifier("quelqu'un qui a déjà un compte peut rejoindre",
  arrivee2.statut === 200, `statut ${arrivee2.statut}`);

{
  const m = await q(
    `select t.identifiant, m.role from membres m
       join tenants t on t.id = m.tenant_id
       join comptes c on c.id = m.compte_id
      where c.courriel = 'ailleurs@controle.fr' order by t.identifiant`);
  verifier("… et il appartient DÉSORMAIS AUX DEUX",
    m.length === 2, JSON.stringify(m));
  verifier("… en gardant son rôle de propriétaire chez lui",
    m.find(x => x.identifiant === "ailleurs")?.role === "proprietaire",
    JSON.stringify(m));
}

{
  const vue = await appel("/api/session",
    { cookie: (arrivee2.cookie ?? "").split(";")[0] });
  verifier("… la bibliothèque OUVERTE est celle où on l'a invité",
    vue.corps?.bibliotheque === cabinet,
    JSON.stringify(vue.corps?.bibliotheque));
}

/* =====================================================================
   4. LA LISTE DES MEMBRES
   ===================================================================== */

{
  const liste = await appel("/api/membres", { cookie: sessionProprio });
  const adresses = (liste.corps ?? []).map(m => m.courriel).sort();
  verifier("la liste des membres est celle de la bibliothèque ouverte",
    JSON.stringify(adresses) === JSON.stringify(
      ["ailleurs@controle.fr", "employe@controle.fr",
       "nouvelle@controle.fr", "proprio@controle.fr"]),
    JSON.stringify(adresses));

  verifier("… et elle dit qui l'on est dans cette liste",
    (liste.corps ?? []).filter(m => m.moi).length === 1
      && liste.corps.find(m => m.moi)?.courriel === "proprio@controle.fr",
    JSON.stringify(liste.corps?.map(m => [m.courriel, m.moi])));

  const visiteur = await appel("/api/membres");
  verifier("… et un visiteur ne l'obtient pas",
    visiteur.statut === 401, `statut ${visiteur.statut}`);
}

/* =====================================================================
   5. PARTIR
   ===================================================================== */

{
  const id = await idDuCompte("nouvelle@controle.fr",
    "le compte de l'invité existe pour éprouver le départ");
  const invite = id && sessionDe(id, cabinet);

  const depart = await appel("/api/membres", { cookie: invite, methode: "DELETE" });
  verifier("un membre peut quitter la bibliothèque",
    depart.statut === 200 && depart.corps?.parti === true,
    `statut ${depart.statut} — ${JSON.stringify(depart.corps)}`);

  verifier("… et sa session est retirée, puisqu'elle désignait cet endroit",
    /=;|Max-Age=0/.test(depart.cookie ?? ""), depart.cookie);

  const m = await q(
    `select 1 from membres m join comptes c on c.id = m.compte_id
      where c.courriel = 'nouvelle@controle.fr' and m.tenant_id = $1`, [cabinet]);
  verifier("… l'appartenance a disparu", m.length === 0, JSON.stringify(m));

  /* PARTIR N'EFFACE RIEN. C'est ce qui distingue cette porte de
     « /api/compte », et la distinction doit rester nette. */
  const fonds = await q(
    "select count(*)::int n from possessions where tenant_id = $1", [cabinet]);
  verifier("… et le fonds du cabinet est intact",
    fonds[0].n === 1, JSON.stringify(fonds[0]));

  const compte = await q(
    "select count(*)::int n from comptes where courriel = 'nouvelle@controle.fr'");
  verifier("… le compte de la personne existe toujours",
    compte[0].n === 1, JSON.stringify(compte[0]));

  const encore = await appel("/api/membres", { cookie: invite, methode: "DELETE" });
  verifier("… et repartir une seconde fois est refusé, pas rendu comme un succès",
    encore.statut === 403, `statut ${encore.statut} — ${JSON.stringify(encore.corps)}`);
}

/* LE DERNIER PROPRIÉTAIRE NE PEUT PAS PARTIR. */
{
  const id = await idDuCompte("ailleurs@controle.fr",
    "le compte du propriétaire d'ailleurs existe");
  const seul = id && sessionDe(id, ailleurs);
  const depart = await appel("/api/membres", { cookie: seul, methode: "DELETE" });
  verifier("le dernier propriétaire ne peut PAS quitter sa bibliothèque",
    depart.statut === 403,
    `statut ${depart.statut} — ${JSON.stringify(depart.corps)}`);

  const t = await q("select 1 from tenants where id = $1", [ailleurs]);
  verifier("… et la bibliothèque est toujours là",
    t.length === 1, "elle a disparu sur un départ refusé");
}

/* =====================================================================
   6. L'ÉCRAN DES RÉGLAGES — ce qui est offert doit être possible

   TROIS FAÇONS D'AVOIR TORT SANS RIEN CASSER :
     — un bouton « inviter » montré à un membre simple : refusé à chaque
       clic, et la personne croit s'y prendre mal ;
     — un bouton « quitter » montré au dernier propriétaire : idem, la base
       refuse toujours ;
     — la section cachée à un propriétaire seul : aucune équipe ne pourrait
       jamais commencer, puisque le seul endroit d'où l'on invite serait
       invisible à tous ceux qui n'ont encore invité personne.

   ---------------------------------------------------------------------------
   POURQUOI ON N'EXÉCUTE PAS LA PAGE ICI, ALORS QU'ON LE FAIT AILLEURS

   test-bascule.mjs monte ma-bibliotheque.html dans jsdom et regarde le
   résultat. La même méthode a été essayée pour reglages.html, et elle a
   donné six faux rouges : JSDOM N'EXÉCUTE PAS LES SCRIPTS « type=module »,
   et cette page en est un. Le contrôle a lu « Lecture des réglages… » et
   conclu que la section était cachée — elle ne l'était pas, elle n'avait
   jamais été peinte.

   La limite est écrite depuis le 21/08 dans test-environnement.mjs. Ne pas
   l'avoir relue a coûté une demi-heure et failli coûter une « correction »
   d'un défaut inexistant, ce qui aurait été bien pire.

   ON ÉPROUVE DONC LA RÈGLE, PAS LE DESSIN. « visibiliteEquipe » est pure :
   elle prend la liste des membres et rend ce qui doit être visible. Le
   contrôle EXTRAIT SON TEXTE DE LA PAGE et l'évalue — ce n'est pas une copie
   qui dériverait, c'est la source elle-même.
   ===================================================================== */
{
  const WEB = ["web", path.join("..", "web")]
    .find(c => fs.existsSync(path.join(c, "reglages.html")));
  const html = WEB ? fs.readFileSync(path.join(WEB, "reglages.html"), "utf8") : "";

  const texte = /function visibiliteEquipe\(membres\) \{[\s\S]*?\n\}/.exec(html);
  verifier("la règle d'affichage de l'équipe est trouvée dans la page",
    Boolean(texte), "« visibiliteEquipe » introuvable — renommée ?");

  if (texte) {
    const visibilite = new Function(`${texte[0]}; return visibiliteEquipe;`)();

    const P = (moi = false) => ({ role: "proprietaire", moi });
    const M = (moi = false) => ({ role: "membre", moi });

    /* « emporter » N'A DE SENS QUE DEPUIS UNE BIBLIOTHÈQUE PARTAGÉE — chez
       soi, copier vers soi-même est refusé par la base, et proposer le
       bouton donnerait un geste qui échoue toujours. Il est en revanche
       offert au dernier propriétaire, qui ne peut pas partir : emporter et
       partir sont deux gestes distincts, et prendre une copie de travail
       est légitime quand on reste. */
    const cas = [
      ["un propriétaire SEUL chez lui",
       [P(true)],           { section: true,  invitation: true,  depart: false, emporter: false }],
      ["un propriétaire avec une équipe",
       [P(true), M(), M()], { section: true,  invitation: true,  depart: false, emporter: true  }],
      ["un propriétaire parmi DEUX propriétaires",
       [P(true), P(), M()], { section: true,  invitation: true,  depart: true,  emporter: true  }],
      ["un membre simple dans une équipe",
       [P(), M(true)],      { section: true,  invitation: false, depart: true,  emporter: true  }],
      ["un membre simple seul — cas qui ne devrait pas exister",
       [M(true)],           { section: false, invitation: false, depart: false, emporter: false }],
    ];

    for (const [nom, membres, attendu] of cas) {
      const vu = visibilite(membres);
      for (const clef of ["section", "invitation", "depart", "emporter"]) {
        verifier(`${nom} : ${clef} ${attendu[clef] ? "offert" : "caché"}`,
          vu[clef] === attendu[clef],
          `« ${clef} » vaut ${vu[clef]} au lieu de ${attendu[clef]}`);
      }
    }
  }

  /* LES ÉLÉMENTS EXISTENT ET PARTENT CACHÉS. La règle peut être juste et
     n'avoir rien à commander. */
  for (const id of ["sectionEquipe", "blocInvitation", "blocDepart",
                    "blocEmporter"]) {
    verifier(`« ${id} » existe dans la page et part caché`,
      new RegExp(`id="${id}"[^>]*\\shidden`).test(html)
      || new RegExp(`id="${id}"[\\s\\S]{0,80}?hidden`).test(html),
      `${id} manquant, ou visible avant d'avoir été peint`);
  }

  /* L'ADRESSE D'UN MEMBRE EST POSÉE EN TEXTE. Elle est écrite par une AUTRE
     personne — c'est la première liste de l'application dans ce cas. */
  verifier("l'adresse d'un membre est posée en texte, jamais en balisage",
    /qui\.textContent = m\.courriel/.test(html)
    && !/innerHTML\s*=\s*[^;]*m\.courriel/.test(html),
    "une adresse de courriel serait interprétée chez les autres membres");
}

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Invitation, arrivée, départ ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
