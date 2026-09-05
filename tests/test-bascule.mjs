/* =========================================================================
   CHANGER DE BIBLIOTHÈQUE — ET NE PAS ENTRER CHEZ LES AUTRES

   La bascule est la première route du produit qui prend, en entrée, un
   identifiant DE BIBLIOTHÈQUE fourni par le navigateur. Toutes les autres
   lisent le locataire dans la session signée, où rien de calculé côté client
   ne peut le désigner. Celle-ci renverse la charge : c'est la seule route
   dont le paramètre, s'il n'était pas borné, ouvrirait n'importe quel fonds.

   D'où ce fichier, et d'où sa forme : la vérification qui compte n'est pas
   « la bascule fonctionne » — elle fonctionnerait aussi en ouvrant tout.
   C'est « elle refuse ce qui n'est pas à moi, ET le cookie ne bouge pas ».

   ---------------------------------------------------------------------------
   TROIS PIÈGES QUE CE FICHIER SURVEILLE NOMMÉMENT

   1. UN REFUS QUI LAISSE QUAND MÊME LE COOKIE. Une route peut répondre 403
      après avoir posé l'en-tête. On vérifie donc le CORPS SUIVANT, en
      redemandant les livres : c'est le seul témoin qui ne ment pas.

   2. UN MESSAGE QUI DISTINGUE « n'existe pas » DE « pas la vôtre ». La
      différence transforme la route en annuaire : on essaie des
      identifiants jusqu'à apprendre lesquels désignent une vraie
      bibliothèque.

   3. « vu_le » NON MARQUÉ. La bascule marcherait, et la reconnexion
      rouvrirait toujours la même bibliothèque. Rien ne casserait ; ce serait
      simplement faux, et invisible tant qu'on n'en a qu'une.

   USAGE
     node tests/test-bascule.mjs
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
const PORT   = 3462;
const BASE   = `http://127.0.0.1:${PORT}`;

const banc = await ouvrirBanc({ port: 55497 });
const { q, semer, locataire } = banc;

/* --------------------------------------------------------- Le décor ---

   TROIS BIBLIOTHÈQUES ET DEUX PERSONNES, et cette dissymétrie est le sujet.

     cabinet   — Camille (propriétaire) et Dominique (membre)
     perso     — Camille seule
     etranger  — Dominique seul, et Camille n'y a rien à faire

   Sans « etranger », la seule chose éprouvable serait « je bascule vers ce
   à quoi j'ai droit ». C'est la moitié rassurante. */

const cabinet  = await locataire("cabinet",  "privee");
const perso    = await locataire("perso",    "privee");
const etranger = await locataire("etranger", "privee");

await semer({ tenant: cabinet,  id: "cab-1", titre: "Le fonds du cabinet" });
await semer({ tenant: cabinet,  id: "cab-2", titre: "Un second du cabinet" });
await semer({ tenant: perso,    id: "per-1", titre: "Un livre à moi" });
await semer({ tenant: etranger, id: "etr-1", titre: "Chez quelqu'un d'autre" });

const camille   = await banc.compte(cabinet, "camille@controle.fr");
const dominique = await banc.compte(etranger, "dominique@controle.fr");

/* Camille appartient aussi à « perso », et Dominique au cabinet — insérés
   par l'observateur, comme le fera l'invitation. « vu_le » reste NULL :
   c'est ce qui permet, plus bas, de constater que la bascule le marque. */
await q(`insert into membres (compte_id, tenant_id, role) values
           ($1, $2, 'proprietaire'), ($3, $4, 'membre')`,
        [camille, perso, dominique, cabinet]);

/* UN NOM QUI CONTIENT DU BALISAGE, ET C'EST LE SEUL MOYEN D'ÉPROUVER.

   La première rédaction vérifiait « aucune option ne contient d'élément
   enfant » sur des noms tels que « cabinet » et « perso ». Avec de tels
   noms, « innerHTML » et « textContent » donnent EXACTEMENT le même
   résultat : le contrôle serait passé au vert des deux façons, en ne
   prouvant rien. C'est la quatrième fois dans ce dépôt qu'un contrôle
   mesure un cas où le défaut ne peut pas se manifester.

   Le nom d'une bibliothèque est écrit par une personne. S'il était posé en
   « innerHTML », celui-ci s'exécuterait dans le navigateur de TOUS les
   membres de l'équipe — c'est-à-dire précisément là où le partage introduit
   quelqu'un d'autre que soi. */
const NOM_PIEGE = 'Cabinet <img src=x onerror="window.__injecte=1">';
await q("update tenants set nom = $1 where id = $2", [NOM_PIEGE, cabinet]);

/* ------------------------------------------------------- Lancer l'API */

const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT),
    MOT_DE_PASSE: MDP,
    SECRET_SESSION: SECRET,
    ANTHROPIC_API_KEY: "",
    FICHIER_AMORCE: "/inexistant",
    TENANT_DEFAUT: "cabinet",
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

/* Le contrôle connaît le secret : il fabrique la session que produit une
   vraie connexion. Un attaquant, lui, ne saurait pas signer — c'est ce qui
   rend cette fabrication légitime ici et impossible ailleurs. */
const signerJeton = (charge) => {
  const brut = Buffer.from(JSON.stringify(charge)).toString("base64url");
  return "session=" + brut + "." +
    createHmac("sha256", SECRET).update(brut).digest("base64url");
};
const sessionDe = (compte, tenant) =>
  signerJeton({ c: compte, t: tenant, expire: Date.now() + 1e9 });

const titres = (corps) => Array.isArray(corps)
  ? corps.map(l => l.titre).sort() : corps;

/* =====================================================================
   1. CE QUE « /api/session » ANNONCE
   ===================================================================== */

const cookieCamille = sessionDe(camille, cabinet);
const vue = await appel("/api/session", { cookie: cookieCamille });

verifier("la session annonce les DEUX bibliothèques de camille",
  (vue.corps?.bibliotheques ?? []).map(b => b.identifiant).sort()
    .join(",") === "cabinet,perso",
  JSON.stringify(vue.corps?.bibliotheques));

verifier("… et AUCUNE de celles où elle n'est pas",
  !(vue.corps?.bibliotheques ?? []).some(b => b.identifiant === "etranger"),
  JSON.stringify(vue.corps?.bibliotheques));

verifier("… elle dit laquelle est ouverte",
  vue.corps?.bibliotheque === cabinet, JSON.stringify(vue.corps?.bibliotheque));

verifier("… et le rôle, car il commande ce que l'écran propose",
  (vue.corps?.bibliotheques ?? []).find(b => b.identifiant === "cabinet")
    ?.role === "proprietaire",
  JSON.stringify(vue.corps?.bibliotheques));

/* LA SESSION PAR MOT DE PASSE N'A PAS DE « MES BIBLIOTHÈQUES ». Elle ouvre
   la bibliothèque par défaut sans nommer personne. Une liste vide, et non un
   sélecteur vide : l'écran doit pouvoir distinguer « rien à choisir » de
   « votre liste a disparu ». */
{
  const parMotDePasse = await appel("/api/connexion",
    { methode: "POST", corps: { motDePasse: MDP } });
  const anonyme = (parMotDePasse.cookie ?? "").split(";")[0];
  const vueAnonyme = await appel("/api/session", { cookie: anonyme });
  verifier("une session par mot de passe reçoit une liste VIDE",
    Array.isArray(vueAnonyme.corps?.bibliotheques)
      && vueAnonyme.corps.bibliotheques.length === 0,
    JSON.stringify(vueAnonyme.corps?.bibliotheques));

  const refus = await appel("/api/session/bibliotheque",
    { cookie: anonyme, methode: "POST", corps: { locataire: cabinet } });
  verifier("… et ne peut pas basculer",
    refus.statut === 403, `statut ${refus.statut} — ${JSON.stringify(refus.corps)}`);
}

/* =====================================================================
   2. LA BASCULE LÉGITIME
   ===================================================================== */

const avant = await appel("/api/livres", { cookie: cookieCamille });
verifier("camille voit d'abord le fonds du cabinet",
  JSON.stringify(titres(avant.corps))
    === JSON.stringify(["Le fonds du cabinet", "Un second du cabinet"]),
  JSON.stringify(titres(avant.corps)));

const bascule = await appel("/api/session/bibliotheque",
  { cookie: cookieCamille, methode: "POST", corps: { locataire: perso } });
verifier("basculer vers sa propre bibliothèque est accepté",
  bascule.statut === 200 && bascule.corps?.ok === true,
  `statut ${bascule.statut} — ${JSON.stringify(bascule.corps)}`);

const cookieApres = (bascule.cookie ?? "").split(";")[0];
verifier("… et un nouveau cookie de session est émis",
  cookieApres.startsWith("session=") && cookieApres !== cookieCamille,
  bascule.cookie);

/* LA PREUVE N'EST PAS LE COOKIE, C'EST CE QU'IL DONNE À VOIR. Un jeton
   réémis mais portant le même locataire aurait exactement la même allure. */
const apres = await appel("/api/livres", { cookie: cookieApres });
verifier("… et le fonds affiché est celui de l'autre bibliothèque",
  JSON.stringify(titres(apres.corps)) === JSON.stringify(["Un livre à moi"]),
  JSON.stringify(titres(apres.corps)));

/* « vu_le » MARQUÉ — sinon « la dernière ouverte » ne changerait jamais. */
const [marque] = await q(
  "select vu_le from membres where compte_id = $1 and tenant_id = $2",
  [camille, perso]);
verifier("… et l'ouverture est datée, pour que la reconnexion y revienne",
  marque?.vu_le !== null && marque?.vu_le !== undefined,
  JSON.stringify(marque));

/* =====================================================================
   3. CE QUI DOIT ÊTRE REFUSÉ

   Et l'on vérifie CHAQUE FOIS que le cookie n'a pas bougé. Un 403 rendu
   après avoir posé l'en-tête serait un refus de façade.
   ===================================================================== */

const inchange = async (nom, reponse, cookieAvant, fondsAttendu) => {
  verifier(nom, reponse.statut === 403,
    `statut ${reponse.statut} — ${JSON.stringify(reponse.corps)}`);
  verifier(`… ${nom} : aucun cookie n'est posé`,
    !reponse.cookie, reponse.cookie);
  const encore = await appel("/api/livres", { cookie: cookieAvant });
  verifier(`… ${nom} : la session ouvre toujours la même bibliothèque`,
    JSON.stringify(titres(encore.corps)) === JSON.stringify(fondsAttendu),
    JSON.stringify(titres(encore.corps)));
};

await inchange("la bibliothèque d'un tiers est refusée",
  await appel("/api/session/bibliotheque",
    { cookie: cookieApres, methode: "POST", corps: { locataire: etranger } }),
  cookieApres, ["Un livre à moi"]);

await inchange("un identifiant inventé est refusé",
  await appel("/api/session/bibliotheque",
    { cookie: cookieApres, methode: "POST",
      corps: { locataire: "00000000-0000-0000-0000-000000000000" } }),
  cookieApres, ["Un livre à moi"]);

await inchange("une valeur qui n'est pas un identifiant est refusée",
  await appel("/api/session/bibliotheque",
    { cookie: cookieApres, methode: "POST", corps: { locataire: "' or 1=1 --" } }),
  cookieApres, ["Un livre à moi"]);

await inchange("l'absence de valeur est refusée",
  await appel("/api/session/bibliotheque",
    { cookie: cookieApres, methode: "POST", corps: {} }),
  cookieApres, ["Un livre à moi"]);

/* LE MÊME MESSAGE POUR « n'existe pas » ET « pas la vôtre ». Les distinguer
   ferait de cette route un annuaire des bibliothèques du service. */
{
  const tiers = await appel("/api/session/bibliotheque",
    { cookie: cookieApres, methode: "POST", corps: { locataire: etranger } });
  const nulle = await appel("/api/session/bibliotheque",
    { cookie: cookieApres, methode: "POST",
      corps: { locataire: "00000000-0000-0000-0000-000000000000" } });
  verifier("le refus ne dit pas si la bibliothèque existe",
    tiers.corps?.error === nulle.corps?.error,
    `« ${tiers.corps?.error} » contre « ${nulle.corps?.error} »`);
}

/* =====================================================================
   4. UN MEMBRE SIMPLE BASCULE AUSSI

   Dominique est membre du cabinet sans en être propriétaire. Le rôle
   commande ce qu'on peut FAIRE dans une bibliothèque, pas le droit d'y
   entrer — sans quoi l'invitation ne servirait à rien.
   ===================================================================== */

const cookieDominique = sessionDe(dominique, etranger);
const entree = await appel("/api/session/bibliotheque",
  { cookie: cookieDominique, methode: "POST", corps: { locataire: cabinet } });
verifier("un membre non propriétaire peut ouvrir la bibliothèque partagée",
  entree.statut === 200,
  `statut ${entree.statut} — ${JSON.stringify(entree.corps)}`);

const vuDominique = await appel("/api/livres",
  { cookie: (entree.cookie ?? "").split(";")[0] });
verifier("… et il y voit le fonds commun",
  JSON.stringify(titres(vuDominique.corps))
    === JSON.stringify(["Le fonds du cabinet", "Un second du cabinet"]),
  JSON.stringify(titres(vuDominique.corps)));

/* =====================================================================
   5. L'ÉCRAN — le sélecteur n'apparaît QUE s'il y a un choix

   POURQUOI CETTE PARTIE EXISTE. La route peut être parfaite et l'écran
   inutilisable : un sélecteur qui ne s'affiche jamais rend la
   fonctionnalité inaccessible, un sélecteur affiché à qui n'a qu'une
   bibliothèque pose une question sans objet. Ni l'un ni l'autre ne casse
   quoi que ce soit — ils se contentent d'être faux.

   ON EXÉCUTE LA VRAIE PAGE, contre la vraie API, avec jsdom. Une
   vérification par expression régulière sur le HTML dirait que le bloc
   existe ; elle ne dirait pas s'il finit visible. C'est la leçon du
   bandeau de recette, même fichier, même méthode.
   ===================================================================== */
{
  const { JSDOM } = await import("jsdom");
  const WEB = ["web", path.join("..", "web")]
    .find(c => fs.existsSync(path.join(c, "ma-bibliotheque.html")));

  if (!WEB) {
    verifier("web/ma-bibliotheque.html est lisible", false, "dossier introuvable");
  } else {
    const html = fs.readFileSync(path.join(WEB, "ma-bibliotheque.html"), "utf8");

    /* Une page qui lève ne doit pas emporter le bilan. Même enveloppe que
       test-environnement.mjs, et pour la même raison. */
    const incidents = [];
    const garde = (e) => incidents.push(e.message);
    process.on("uncaughtException", garde);

    const rendre = async (cookie) => {
      const dom = new JSDOM(html, {
        runScripts: "dangerously",
        url: BASE + "/",
        beforeParse(w) {
          /* Le cookie voyage à la main : jsdom ne gère pas le magasin de
             cookies pour « fetch ». C'est la session qui décide de tout ce
             qu'on éprouve ici, elle ne peut pas être omise. */
          w.fetch = (u, o = {}) => fetch(new URL(u, BASE),
            { ...o, headers: { ...(o.headers ?? {}), cookie } });
          w.requestAnimationFrame = (fn) => setTimeout(fn, 0);
          w.cancelAnimationFrame = (id) => clearTimeout(id);
        },
      });
      await dormir(900);
      return dom;
    };

    /* a) Deux bibliothèques : le sélecteur est là, avec les deux, et il
          désigne celle qui est ouverte. */
    {
      const dom = await rendre(sessionDe(camille, cabinet));
      const d = dom.window.document;
      const bloc = d.getElementById("choixBibliotheque");
      const sel  = d.getElementById("selBibliotheque");

      verifier("avec deux bibliothèques, le sélecteur est VISIBLE",
        Boolean(bloc) && bloc.hidden === false,
        bloc ? `hidden=${bloc.hidden}` : "élément absent");

      const options = sel ? [...sel.options].map(o => o.value) : [];
      verifier("… il propose exactement les deux",
        options.length === 2 && options.includes(cabinet) && options.includes(perso),
        JSON.stringify(options));

      verifier("… et celle qui est ouverte est celle qui est sélectionnée",
        sel?.value === cabinet, `${sel?.value} au lieu de ${cabinet}`);

      /* Le nom vient de la base, donc d'une personne, et celui du cabinet
         porte du balisage exprès. Trois façons de le dire, parce qu'aucune
         seule ne suffit :
           — aucun élément n'a été construit à partir du nom ;
           — le texte affiché contient les chevrons, donc il n'a pas été
             interprété ;
           — et rien ne s'est exécuté dans la page. */
      const optionCabinet = [...(sel?.options ?? [])]
        .find(o => o.value === cabinet);
      verifier("… le nom d'une bibliothèque ne construit aucun élément",
        optionCabinet?.children.length === 0,
        `${optionCabinet?.children.length} enfant(s) — le nom a été interprété`);
      verifier("… il s'affiche tel qu'il est écrit, chevrons compris",
        (optionCabinet?.textContent ?? "").includes(NOM_PIEGE),
        JSON.stringify(optionCabinet?.textContent));
      verifier("… et rien ne s'est exécuté au passage",
        dom.window.__injecte === undefined,
        "le balisage d'un nom de bibliothèque s'exécute chez les autres membres");

      dom.window.close();
    }

    /* b) Une seule : rien à choisir, donc rien à montrer. C'est ce qui fait
          que l'application reste personnelle sans deuxième écran. */
    {
      const dom = await rendre(sessionDe(dominique, etranger));
      const bloc = dom.window.document.getElementById("choixBibliotheque");
      /* Dominique appartient à DEUX bibliothèques depuis le décor ; on
         éprouve donc le cas « une seule » sur un compte fait pour cela. */
      dom.window.close();
      verifier("le sélecteur existe dans la page pour tout le monde",
        Boolean(bloc), "le bloc est absent du HTML");
    }

    {
      const seul = await banc.compte(perso, "seul@controle.fr", "membre");
      const dom = await rendre(sessionDe(seul, perso));
      const bloc = dom.window.document.getElementById("choixBibliotheque");
      verifier("avec UNE seule bibliothèque, le sélecteur reste caché",
        Boolean(bloc) && bloc.hidden === true,
        bloc ? `hidden=${bloc.hidden}` : "élément absent");
      dom.window.close();
    }

    /* c) La session par mot de passe : liste vide, donc rien non plus. */
    {
      const parMotDePasse = await appel("/api/connexion",
        { methode: "POST", corps: { motDePasse: MDP } });
      const dom = await rendre((parMotDePasse.cookie ?? "").split(";")[0]);
      const bloc = dom.window.document.getElementById("choixBibliotheque");
      verifier("avec une session par mot de passe, le sélecteur reste caché",
        Boolean(bloc) && bloc.hidden === true,
        bloc ? `hidden=${bloc.hidden}` : "élément absent");
      dom.window.close();
    }

    process.off("uncaughtException", garde);
    verifier("la page ne lève rien pendant ces rendus",
      incidents.length === 0, incidents.join(" | "));
  }
}

/* --------------------------------------------------------------- Bilan */

await fermer();

console.log("\n=== Bascule entre bibliothèques ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
