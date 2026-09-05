/* =========================================================================
   LA LECTURE APPARTIENT À CELUI QUI LIT

   CE FICHIER EXISTE POUR UN DÉFAUT QUI NE CASSE RIEN. Avant la migration 17,
   « statut » et « note » vivaient sur la POSSESSION : dans un cabinet, le
   jour où l'un marque un ouvrage « Lu », il l'est pour tout le monde, et la
   note — un jugement sur cinq — devient celle du dernier qui a cliqué.

   Aucune erreur, aucun journal, aucune alerte. Simplement des données
   fausses, et fausses d'une façon qu'on ne remarque qu'en se demandant
   « qui a lu ça ? ». C'est pourquoi ce lot ne pouvait pas être livré après
   le précédent : une équipe aurait été livrée fausse.

   ---------------------------------------------------------------------------
   LES QUATRE PIÈGES SURVEILLÉS NOMMÉMENT

   1. LA LECTURE DE L'UN DEVIENT CELLE DE L'AUTRE. Le défaut d'origine.

   2. UN ENREGISTREMENT QUI NE PARLE PAS DE LECTURE LA REMET À ZÉRO. Corriger
      un rayon, changer une visibilité — et l'ouvrage repasse « à lire ». Le
      piège est réel : la liste d'entrée normalise « statut » à « A lire »
      quand il est absent, ce qui avait un sens sur l'étagère et n'en a plus
      sur la personne.

   3. LE VISITEUR VOIT « 0 LU ». La vue rend « A lire » à qui n'est
      personne ; compter ces lignes produit une affirmation fausse et
      crédible sur la bibliothèque de quelqu'un d'autre.

   4. LA SESSION PAR MOT DE PASSE PERD SES LECTURES. Elle ouvre la
      bibliothèque sans nommer personne. Sur une bibliothèque à UN membre il
      n'y a rien à départager — et c'est l'installation personnelle, celle de
      348 ouvrages. Une régression ici aurait été payée par l'usage d'origine
      au profit d'une fonctionnalité qu'il n'emploie pas.

   USAGE
     node tests/test-lectures.mjs
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
const PORT   = 3472;
const BASE   = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55503 });
const { q, semer, locataire } = banc;

/* --------------------------------------------------------- Le décor ---

   « cabinet » a DEUX membres — c'est là que le défaut d'origine se voit.
   « perso » n'en a qu'UN : c'est l'installation personnelle, celle que la
   session par mot de passe doit continuer de servir sans rien perdre. */

const cabinet = await locataire("cabinet", "publique");
const perso   = await locataire("perso",   "privee");

await semer({ tenant: cabinet, id: "c1", titre: "Le fonds commun" });
await semer({ tenant: cabinet, id: "c2", titre: "Un second commun" });
await semer({ tenant: perso,   id: "p1", titre: "Un livre à moi" });

const alice = await banc.compte(cabinet, "alice@controle.fr");
const bob   = await banc.compte(cabinet, "bob@controle.fr", "membre");
const seul  = await banc.compte(perso,   "seul@controle.fr");

/* Les rayons du cabinet sont publics : sans cela la bibliothèque publique
   n'exposerait rien, et le contrôle du visiteur ne prouverait pas ce qu'il
   annonce — il lirait zéro parce qu'il ne voit rien, pas parce que les
   chiffres de lecture sont tus. */
await q(`insert into rayons_reglages (tenant_id, categorie, sous_categorie, visibilite)
         values ($1, 'Savoirs', 'Philosophie', 'publique')
         on conflict (tenant_id, categorie, sous_categorie)
         do update set visibilite = 'publique'`, [cabinet]);

/* ------------------------------------------------------- Lancer l'API */

const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT), MOT_DE_PASSE: MDP, SECRET_SESSION: SECRET,
    ANTHROPIC_API_KEY: "", FICHIER_AMORCE: "/inexistant",
    TENANT_DEFAUT: "perso",
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

const sAlice = sessionDe(alice, cabinet);
const sBob   = sessionDe(bob,   cabinet);

/* Ce qu'une session voit d'un ouvrage donné, à travers l'API. */
const vu = async (cookie, id) => {
  const r = await appel("/api/livres", { cookie });
  return (Array.isArray(r.corps) ? r.corps : []).find(l => l.id === id) ?? null;
};

/* =====================================================================
   1. LE DÉFAUT D'ORIGINE — la lecture de l'un n'est pas celle de l'autre
   ===================================================================== */

await appel("/api/livres", { cookie: sAlice, methode: "PUT",
  corps: { id: "c1", titre: "Le fonds commun", auteur: "Auteur",
           categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro",
           statut: "Lu", note: 5 } });

{
  const chezAlice = await vu(sAlice, "c1");
  const chezBob   = await vu(sBob,   "c1");

  verifier("alice enregistre sa lecture",
    chezAlice?.statut === "Lu" && Number(chezAlice?.note) === 5,
    JSON.stringify(chezAlice && { statut: chezAlice.statut, note: chezAlice.note }));

  verifier("BOB NE L'HÉRITE PAS — l'ouvrage reste « à lire » pour lui",
    chezBob?.statut === "A lire",
    `${chezBob?.statut} — la lecture d'un membre est devenue celle de tous`);

  verifier("… ni la note d'alice",
    chezBob?.note === null || chezBob?.note === undefined,
    `${chezBob?.note} — le jugement d'un membre est devenu celui de tous`);

  verifier("… et l'ouvrage est bien le MÊME des deux côtés",
    chezAlice?.ouvrage_id === chezBob?.ouvrage_id && Boolean(chezAlice?.ouvrage_id),
    "le contrôle compare deux fiches différentes, il ne prouve rien");
}

/* BOB LIT AUSSI, ET ALICE NE BOUGE PAS. Le sens inverse compte autant : une
   implémentation qui écraserait toujours avec la dernière écriture passerait
   la moitié précédente. */
await appel("/api/livres", { cookie: sBob, methode: "PUT",
  corps: { id: "c1", titre: "Le fonds commun", auteur: "Auteur",
           categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro",
           statut: "En cours", note: 2 } });

{
  const chezAlice = await vu(sAlice, "c1");
  const chezBob   = await vu(sBob,   "c1");
  verifier("bob enregistre la sienne",
    chezBob?.statut === "En cours" && Number(chezBob?.note) === 2,
    JSON.stringify(chezBob && { statut: chezBob.statut, note: chezBob.note }));
  verifier("… et celle d'alice est intacte",
    chezAlice?.statut === "Lu" && Number(chezAlice?.note) === 5,
    JSON.stringify(chezAlice && { statut: chezAlice.statut, note: chezAlice.note }));
}

/* =====================================================================
   2. UN ENREGISTREMENT QUI NE PARLE PAS DE LECTURE N'Y TOUCHE PAS

   Le piège est celui de la valeur par défaut : « A lire » avait un sens sur
   l'étagère — la colonne était NOT NULL — et n'en a plus sur la personne.
   Le confondre remettrait la lecture à zéro à chaque changement de rayon.
   ===================================================================== */

await appel("/api/livres", { cookie: sAlice, methode: "PUT",
  corps: { id: "c1", titre: "Le fonds commun", auteur: "Auteur",
           categorie: "Savoirs", sous_categorie: "Épistémologie", sphere: "Pro" } });

{
  const apres = await vu(sAlice, "c1");
  verifier("changer de rayon N'EFFACE PAS la lecture",
    apres?.statut === "Lu" && Number(apres?.note) === 5,
    `${apres?.statut} / ${apres?.note} — un enregistrement muet a remis la lecture à zéro`);
  verifier("… et le rayon a bien changé (sinon on ne prouve rien)",
    apres?.sous_categorie === "Épistémologie", apres?.sous_categorie);
}

/* =====================================================================
   3. CE QUE VOIT QUI N'EST PERSONNE

   La vue rend « A lire » à qui n'a pas de lecture. Compter ces lignes
   produirait « 0 lu, 2 à lire » sur la bibliothèque d'autrui : une
   affirmation fausse, et crédible. L'API doit TAIRE ces chiffres, pas les
   rendre à zéro.
   ===================================================================== */

{
  const publique = await appel("/api/statistiques");
  verifier("le visiteur voit bien la bibliothèque publique",
    Number(publique.corps?.total) > 0, JSON.stringify(publique.corps?.total));

  verifier("… mais AUCUN chiffre de lecture ne lui est rendu",
    publique.corps?.lus === null && publique.corps?.en_cours === null
      && publique.corps?.a_lire === null,
    JSON.stringify({ lus: publique.corps?.lus, en_cours: publique.corps?.en_cours,
                     a_lire: publique.corps?.a_lire })
      + " — « 0 lu » se lit comme un fait sur la bibliothèque de quelqu'un d'autre");

  verifier("… ni la note moyenne, ni son effectif",
    publique.corps?.note_moyenne === null && publique.corps?.notes === null,
    JSON.stringify({ moyenne: publique.corps?.note_moyenne,
                     notes: publique.corps?.notes }));

  /* ET LES CHIFFRES EXISTENT POUR QUI EST IDENTIFIÉ — sans quoi on aurait
     seulement prouvé qu'ils sont toujours absents. */
  const sienne = await appel("/api/statistiques", { cookie: sAlice });
  verifier("alice, elle, obtient ses propres chiffres de lecture",
    sienne.corps?.lus === 1 && sienne.corps?.en_cours === 0,
    JSON.stringify({ lus: sienne.corps?.lus, en_cours: sienne.corps?.en_cours }));
  verifier("… et bob les siens, qui sont différents",
    (await appel("/api/statistiques", { cookie: sBob })).corps?.en_cours === 1,
    "les deux membres partagent les mêmes compteurs");
}

/* =====================================================================
   3 bis. LA PAGE PUBLIQUE N'ÉCRIT PAS « 0 LUS »

   L'API tait les chiffres ; encore faut-il que la page ne les invente pas.
   « null + null » vaut 0 en JavaScript : sans traitement, la vignette « sur
   la pile » afficherait un zéro parfaitement crédible, et rien nulle part
   n'aurait signalé l'anomalie.

   On exécute la vraie page contre la vraie API, comme test-bascule.mjs le
   fait — c'est un script classique, donc jsdom l'exécute.
   ===================================================================== */
{
  const { JSDOM } = await import("jsdom");
  const WEB = ["web", path.join("..", "web")]
    .find(c => fs.existsSync(path.join(c, "bibliotheque-publique.html")));

  if (!WEB) {
    verifier("web/bibliotheque-publique.html est lisible", false, "introuvable");
  } else {
    const html = fs.readFileSync(
      path.join(WEB, "bibliotheque-publique.html"), "utf8");
    const dom = new JSDOM(html, {
      runScripts: "dangerously", url: BASE + "/",
      beforeParse(w) {
        w.fetch = (u, o) => fetch(new URL(u, BASE), o);
        w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
        w.cancelAnimationFrame = (id) => clearTimeout(id);
      },
    });
    await dormir(1200);
    const chiffres = dom.window.document.getElementById("chiffres");
    const texte = chiffres?.textContent ?? "";

    verifier("la page publique affiche bien ses chiffres",
      /ouvrages/.test(texte), JSON.stringify(texte.slice(0, 120)));
    /* « \blus\b » NE MORD PAS SUR « 0lus » — le texte des vignettes est
       concaténé sans espace, et « 0 » comme « l » sont des caractères de
       mot : il n'y a pas de frontière entre eux. La première rédaction de ce
       contrôle laissait donc passer la mutation qui remet la vignette, et
       c'est celle d'à côté qui l'a attrapée.
       On vise donc l'étiquette telle qu'elle est écrite. */
    verifier("… sans vignette « lus »",
      !/lus\s*\(/i.test(texte),
      JSON.stringify(texte.slice(0, 200))
        + " — un zéro s'y lit comme un fait sur la bibliothèque d'autrui");
    verifier("… ni « sur la pile »",
      !/sur la pile/i.test(texte), JSON.stringify(texte.slice(0, 200)));
    verifier("… et aucun « NaN » n'a été fabriqué en chemin",
      !/NaN/.test(texte), JSON.stringify(texte.slice(0, 200)));

    /* LA MOSAÏQUE — mesurée sur les DONNÉES, faute de pouvoir l'être sur
       le rendu. Ajouté le 05/09/2026, après que la chaîne de livraison ait
       trouvé ce que ce contrôle avait manqué.

       J'avais tu les chiffres de lecture en haut de page et oublié qu'ils
       existent par RAYON : chaque tuile porte une jauge « part lue » et une
       infobulle « x % lus ». Un visiteur voyait treize barres vides et
       treize « 0 % lus » — la même affirmation fausse, répétée, et d'autant
       plus crédible.

       POURQUOI PAS SUR LE DOM. La mosaïque est un pavage calculé à partir de
       la LARGEUR RÉELLE du conteneur ; sous jsdom elle vaut zéro, les tuiles
       font moins d'un pixel et le code les écarte. Le contrôle écrit d'abord
       ainsi n'a trouvé aucune tuile — et une absence constatée sur un écran
       vide ne prouve rien.

       On mesure donc ce que le serveur REND, qui est l'invariant réel, et
       l'on vérifie séparément que la page ne replie pas un « je ne sais
       pas » sur un zéro. */
    const stats = (await appel("/api/statistiques")).corps ?? {};
    verifier("la bibliothèque publique expose bien ses rayons",
      Array.isArray(stats.sous_categories) && stats.sous_categories.length > 0,
      "aucun rayon — l'absence de « lus » ne prouverait rien");

    verifier("… et AUCUN rayon n'annonce de part lue au visiteur",
      (stats.sous_categories ?? []).every(x => x.lus === null),
      JSON.stringify(stats.sous_categories?.slice(0, 2))
      + " — treize jauges à zéro sur la bibliothèque de quelqu'un d'autre");

    /* LES COMMENTAIRES SONT RETIRÉS AVANT DE CHERCHER, et ce n'est pas un
       détail : la première rédaction s'est déclenchée sur SA PROPRE
       explication — le texte qui décrit le piège contient le motif du piège.
       Un contrôle qui lit de la prose comme du code crie au loup, et un
       garde-fou qui crie au loup finit par être désactivé.
       Même précaution que test-plafonds-coherents.mjs, pour la même raison. */
    const codeSeul = html.replace(/\/\*[\s\S]*?\*\//g, "");
    verifier("la page ne replie pas « je ne sais pas » sur zéro",
      !/t\.lus\s*(\?\?|\|\|)\s*0/.test(codeSeul),
      "« t.lus ?? 0 » fabrique un zéro là où le serveur a dit « null »");

    dom.window.close();
  }
}

/* =====================================================================
   4. LA SESSION PAR MOT DE PASSE

   « perso » n'a qu'un membre : il n'y a rien à départager, et l'installation
   personnelle ne doit RIEN perdre. C'est le cas d'usage d'origine.
   ===================================================================== */

const cx = await appel("/api/connexion",
  { methode: "POST", corps: { motDePasse: MDP } });
const parMotDePasse = await (async () => {
  const r = await fetch(BASE + "/api/connexion", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ motDePasse: MDP }) });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
})();

verifier("le mot de passe ouvre bien une session", cx.statut === 200,
  JSON.stringify(cx.corps));

{
  const r = await appel("/api/livres", { cookie: parMotDePasse, methode: "PUT",
    corps: { id: "p1", titre: "Un livre à moi", auteur: "Auteur",
             categorie: "Savoirs", sous_categorie: "Philosophie",
             sphere: "Pro", statut: "Lu", note: 4 } });
  verifier("sur une bibliothèque à UN membre, elle enregistre la lecture",
    r.statut === 200,
    `statut ${r.statut} — ${JSON.stringify(r.corps)} : l'installation personnelle a perdu ses statuts`);

  const l = await vu(parMotDePasse, "p1");
  verifier("… et la relit",
    l?.statut === "Lu" && Number(l?.note) === 4,
    JSON.stringify(l && { statut: l.statut, note: l.note }));

  /* ELLE L'A ATTRIBUÉE AU SEUL MEMBRE, pas à personne. Vérifié en base :
     sinon la ligne pourrait exister sans propriétaire lisible. */
  const enBase = await q(
    `select compte_id, statut from lectures where tenant_id = $1 and possession = 'p1'`,
    [perso]);
  verifier("… au nom de l'unique membre, et de lui seul",
    enBase.length === 1 && enBase[0].compte_id === seul,
    JSON.stringify(enBase));
}

/* DÈS QU'ILS SONT DEUX, ELLE NE PEUT PLUS ATTRIBUER — et elle le DIT.
   Un 500 « Erreur interne » ferait chercher une panne ; le 403 dit ce qu'il
   en est et ce qu'il y a à faire. */
{
  const jeton = signerJeton({ t: cabinet, expire: Date.now() + 1e9 });
  const r = await appel("/api/livres", { cookie: jeton, methode: "PUT",
    corps: { id: "c2", titre: "Un second commun", auteur: "Auteur",
             categorie: "Savoirs", sous_categorie: "Philosophie",
             sphere: "Pro", statut: "Lu" } });
  verifier("sur une bibliothèque à DEUX membres, elle refuse d'attribuer",
    r.statut === 403, `statut ${r.statut} — ${JSON.stringify(r.corps)}`);
  verifier("… et le refus est explicite, pas une « erreur interne »",
    /identifie/i.test(r.corps?.error ?? ""), JSON.stringify(r.corps));

  /* MAIS ELLE PEUT TOUJOURS TENIR L'ÉTAGÈRE. Refuser tout l'enregistrement
     serait excessif : le rayon, le titre et la visibilité n'appartiennent à
     personne en particulier. */
  const sansLecture = await appel("/api/livres", { cookie: jeton, methode: "PUT",
    corps: { id: "c2", titre: "Un second commun, corrigé", auteur: "Auteur",
             categorie: "Savoirs", sous_categorie: "Philosophie", sphere: "Pro" } });
  verifier("… mais elle enregistre toujours ce qui n'est pas une lecture",
    sansLecture.statut === 200,
    `statut ${sansLecture.statut} — ${JSON.stringify(sansLecture.corps)}`);
}

/* =====================================================================
   5. LE CLOISONNEMENT, EN SQL

   L'API pourrait être juste et la base ouverte : une requête écrite ailleurs
   passerait alors entre les mailles. On interroge donc la base directement.
   ===================================================================== */

{
  const vuAlice = await banc.dans({ locataire: cabinet, compte: alice },
    "select compte_id, statut from lectures");
  verifier("en SQL, alice ne voit QUE ses propres lectures",
    vuAlice.length > 0 && vuAlice.every(l => l.compte_id === alice),
    JSON.stringify(vuAlice));

  const vuVisiteur = await banc.dans(null, "select count(*)::int n from lectures");
  verifier("un visiteur n'en voit aucune",
    vuVisiteur[0].n === 0, `${vuVisiteur[0].n} ligne(s)`);

  /* LA VUE SE TIENT TOUTE SEULE — contrôle ajouté après une mutation qui a
     SURVÉCU, le 05/09/2026.

     « livres » borne sa jointure sur « compte_effectif() », et la politique
     « lectures_lecture » dit la même chose. Deux remparts pour un défaut :
     c'est délibéré, la migration 17 l'écrit. Mais la conséquence est qu'aucun
     contrôle ne distinguait l'un de l'autre — retirer la condition de la
     jointure laissait les vingt-six vérifications au vert, parce que la
     politique rattrapait.

     Un rempart que rien ne mesure n'est pas un rempart, c'est une intention.
     On l'isole donc avec le seul instrument qui traverse les politiques :
     L'OBSERVATEUR, qui est superutilisateur. Pour lui, la RLS ne s'applique
     pas — ce qui reste alors est exactement la jointure de la vue.

     Le sens à l'envers vaut aussi : si demain quelqu'un allège la vue en se
     disant « la politique suffit », ce contrôle-ci le dira. */
  await banc.oeil.query("select set_config('app.tenant_id', $1, false)", [cabinet]);
  await banc.oeil.query("select set_config('app.compte_id', $1, false)", [alice]);
  const sansPolitique = (await banc.oeil.query(
    "select id, statut, note from public.livres where id = 'c1'")).rows;
  await banc.oeil.query("select set_config('app.tenant_id', '', false)");
  await banc.oeil.query("select set_config('app.compte_id', '', false)");

  verifier("politiques traversées, la vue ne rend qu'UNE ligne par ouvrage",
    sansPolitique.length === 1,
    `${sansPolitique.length} lignes — la jointure ne borne pas sur le lecteur`);
  verifier("… et c'est bien la lecture d'alice, pas celle de bob",
    sansPolitique[0]?.statut === "Lu" && Number(sansPolitique[0]?.note) === 5,
    JSON.stringify(sansPolitique));

  /* On n'écrit pas la lecture d'un autre, même en nommant son identifiant. */
  let refuse = false;
  try {
    await banc.dans({ locataire: cabinet, compte: bob },
      `insert into lectures (tenant_id, possession, compte_id, statut)
       values ($1, 'c2', $2, 'Lu')`, [cabinet, alice]);
  } catch { refuse = true; }
  verifier("bob ne peut pas écrire une lecture AU NOM d'alice", refuse,
    "l'insertion est passée — la politique ne borne pas sur le compte");
}

/* =====================================================================
   6. LA PORTE DE SORTIE EMPORTE AUSSI LES LECTURES
   ===================================================================== */

{
  const avant = Number((await q(
    "select count(*) as n from lectures where tenant_id = $1", [cabinet]))[0].n);
  verifier("le cabinet a bien des lectures avant sa suppression",
    avant > 0, `${avant}`);

  await banc.dans({ locataire: cabinet, compte: alice },
    "select * from public.supprimer_locataire()");

  const apres = Number((await q(
    "select count(*) as n from lectures where tenant_id = $1", [cabinet]))[0].n);
  verifier("… et il n'en reste aucune après", apres === 0, `${apres} restante(s)`);

  const ailleurs = Number((await q(
    "select count(*) as n from lectures where tenant_id = $1", [perso]))[0].n);
  verifier("… tandis que celles du voisin sont intactes",
    ailleurs === 1, `${ailleurs}`);
}

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== La lecture appartient à celui qui lit ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
