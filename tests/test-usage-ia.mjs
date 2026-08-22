/* =========================================================================
   LA MESURE DU COÛT TIENT-ELLE ? — jetons, recherches, et ce qu'on ne sait pas

   Le quota compte des APPELS. Il est juste et il est éprouvé. Mais depuis que
   les appels ne se valent plus — deux recherches web pour un résumé, quatre
   pour un parcours, aucune pour le second appel de la recommandation — il ne
   mesure plus la dépense. 05-usage-ia.sql enregistre les unités réelles.

   CE CONTRÔLE NE VÉRIFIE PAS QUE LE CODE FAIT CE QU'IL DIT. Il vérifie ce que
   la base contient après un vrai appel HTTP à la vraie API, contre un faux
   modèle qui rend un « usage » choisi.

   ---------------------------------------------------------------------------
   CE QU'IL CHERCHE, ET POURQUOI CHACUN PEUT COÛTER QUELQUE CHOSE

   1. LES UNITÉS ARRIVENT-ELLES EN BASE ? C'est le minimum, et c'est le seul
      point qui tomberait si l'appel à « enregistrer_usage_ia » disparaissait.

   2. LE MODÈLE ENREGISTRÉ EST-IL CELUI QUI EST FACTURÉ ? Il vient du corps de
      la requête, pas de la variable d'environnement. Le jour où une passe
      basculera sur un modèle moins cher, lire l'environnement attribuerait la
      dépense au mauvais tarif — sans erreur, sans alerte, avec un chiffre
      plausible.

   3. UN APPEL RATÉ EST-IL DISTINGUÉ D'UNE MESURE PERDUE ? Les deux laissent
      une ligne sans jetons. Sans « issue », on ne saurait pas lequel des deux
      on regarde, donc on ne regarderait ni l'un ni l'autre.

   4. UNE RÉPONSE SANS « usage » SE VOIT-ELLE ? C'est ainsi qu'un changement de
      forme chez le fournisseur se manifesterait : silencieusement, par un
      total qui baisse.

   5. ÉCRIRE CHEZ AUTRUI LÈVE-T-IL ? Sous RLS, une mise à jour hors périmètre
      ne lève PAS : elle touche zéro ligne et PostgreSQL n'en dit rien. C'est
      le défaut du 16/08, dans une fonction neuve.

   6. LE CONTRÔLE SAIT-IL DIRE NON ? « appels_ia_sans_mesure » doit rendre zéro
      ligne. On lui présente d'abord un cas fautif : une vérification qu'on n'a
      pas vue échouer ne prouve rien.

   7. LE QUOTA MARCHE-T-IL TOUJOURS ? La signature de « consommer_appel_ia » a
      changé. Non-régression.

   USAGE
     node tests/test-usage-ia.mjs
     PGURL=... PGURL_OEIL=... node tests/test-usage-ia.mjs                (CI)
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
const MDP = "mot-de-passe-de-controle";
const PORT = 3465, MODELE_PORT = 3466;
const BASE = `http://127.0.0.1:${PORT}`;
const MODELE_ATTENDU = "claude-sonnet-5";

const banc = await ouvrirBanc({ port: 55493 });
const { q, semer, locataire } = banc;

const [xavier] = await q("select id from tenants where identifiant = 'xavier'");
const bob = await locataire("bob-usage", "privee", "fr", 50);
await q("update tenants set quota_ia_mois = 50 where id = $1", [xavier.id]);

for (const n of [1, 2, 3, 4, 5]) {
  await semer({ tenant: xavier.id, id: `u-${n}`, isbn: `978000000041${n}` });
}

/* --------------------------------------------------- Un modèle pilotable

   Chaque contrôle décide de ce que le modèle va rendre. C'est ce qui permet
   d'éprouver le cas « réponse sans usage » et le cas « le modèle refuse »,
   qu'aucun appel réel ne produirait à la demande. */
let prochaine = { statut: 200, usage: { input_tokens: 26000, output_tokens: 900,
                                        server_tool_use: { web_search_requests: 2 } } };
const corpsRecus = [];

const faussaire = createServer(async (req, rep) => {
  let brut = "";
  for await (const m of req) brut += m;
  try { corpsRecus.push(JSON.parse(brut)); } catch { corpsRecus.push(null); }

  if (prochaine.statut !== 200) {
    rep.writeHead(prochaine.statut, { "content-type": "application/json" });
    return rep.end(JSON.stringify({ error: "refus de contrôle" }));
  }
  const charge = { resume: "Un résumé de contrôle.", points: ["un point"],
                   themes: ["un-theme"], fiabilite: "haute" };
  rep.writeHead(200, { "content-type": "application/json" });
  rep.end(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(charge) }],
    ...(prochaine.usage ? { usage: prochaine.usage } : {}),
  }));
});
await new Promise(r => faussaire.listen(MODELE_PORT, "127.0.0.1", r));

/* ------------------------------------------------------------ Lancer l'API */
const serveur = spawn(process.execPath, [path.join(API, "server.js")], {
  env: {
    ...process.env, ...banc.env,
    PORT: String(PORT), MOT_DE_PASSE: MDP, SECRET_SESSION: SECRET,
    MODELE: MODELE_ATTENDU,
    ANTHROPIC_API_KEY: "clef-de-controle-sans-valeur",
    ANTHROPIC_URL: `http://127.0.0.1:${MODELE_PORT}/v1/messages`,
    FICHIER_AMORCE: "/inexistant", TENANT_DEFAUT: "xavier",
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
  serveur.kill();
  await new Promise(r => faussaire.close(r));
  await banc.fermer();
};
if (!debout) {
  console.error("  ECHEC l API n a pas démarré\n" + journal);
  await fermer(); process.exit(1);
}

const session = (tenant) => {
  const charge = Buffer.from(JSON.stringify({
    t: tenant, expire: Date.now() + 3600_000 })).toString("base64url");
  return charge + "." + createHmac("sha256", SECRET).update(charge).digest("base64url");
};
const sessionX = `session=${session(xavier.id)}`;

const resumer = (bookId) => fetch(`${BASE}/api/resume`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: sessionX },
  body: JSON.stringify({ bookId, forcer: true }),
}).then(async r => ({ statut: r.status, corps: await r.json().catch(() => null) }));

const derniereLigne = async () =>
  (await q(`select * from appels_ia order by id desc limit 1`))[0];

/* =====================================================================
   1. LES UNITÉS ARRIVENT-ELLES EN BASE ?
   ===================================================================== */

await q("delete from appels_ia");
const r1 = await resumer("u-1");
verifier("le résumé aboutit", r1.statut === 200, JSON.stringify(r1.corps));

const l1 = await derniereLigne();
verifier("les jetons d'entrée sont enregistrés",
  l1?.jetons_entree === 26000, String(l1?.jetons_entree));
verifier("les jetons de sortie sont enregistrés",
  l1?.jetons_sortie === 900, String(l1?.jetons_sortie));
verifier("les recherches web sont enregistrées",
  l1?.recherches_web === 2, String(l1?.recherches_web));
verifier("l'issue est « ok »", l1?.issue === "ok", String(l1?.issue));
verifier("la route reste enregistrée", l1?.route === "/api/resume", String(l1?.route));

/* =====================================================================
   2. LE MODÈLE ENREGISTRÉ EST CELUI QUI EST FACTURÉ

   On ne compare pas à la variable d'environnement — ce serait comparer le
   code à lui-même. On compare à ce que le FAUX MODÈLE a réellement reçu.
   ===================================================================== */

const modeleRecu = corpsRecus.at(-1)?.model;
verifier("le modèle enregistré est celui que le modèle a reçu",
  l1?.modele === modeleRecu && modeleRecu === MODELE_ATTENDU,
  `base ${l1?.modele} / reçu ${modeleRecu}`);

/* CE QUE LE CONTRÔLE CI-DESSUS NE COUVRE PAS, ET IL FAUT LE DIRE.
 *
 * Aujourd'hui, toutes les routes envoient « model: MODELE ». La valeur du
 * corps et celle de la variable d'environnement sont donc IDENTIQUES, et la
 * comparaison ci-dessus ne distinguerait pas un code qui lit l'environnement
 * d'un code qui lit le corps. Elle attrape une valeur écrite en dur, rien de
 * plus.
 *
 * Le jour où une passe emploiera un modèle moins cher — c'est une piste
 * ouverte d'ADR-L008 — ce contrôle deviendra discriminant tout seul. En
 * attendant, on éprouve au moins que la plomberie TRANSPORTE l'argument
 * jusqu'à la ligne, plutôt que de l'ignorer. */
await banc.dans(xavier.id, "select * from consommer_appel_ia('/controle', 'un-autre-modele')");
const [porte] = await q(
  "select modele from appels_ia where route = '/controle' order by id desc limit 1");
verifier("le modèle passé à la fonction est bien celui qui est écrit",
  porte?.modele === "un-autre-modele", String(porte?.modele));
await q("delete from appels_ia where route = '/controle'");

/* =====================================================================
   3. UN APPEL RATÉ EST DISTINGUÉ D'UNE MESURE PERDUE
   ===================================================================== */

const avantEchec = (await q("select count(*)::int n from appels_ia"))[0].n;
prochaine = { statut: 500 };
const r2 = await resumer("u-2");
prochaine = { statut: 200, usage: { input_tokens: 26000, output_tokens: 900,
                                    server_tool_use: { web_search_requests: 2 } } };

verifier("un modèle qui refuse rend une erreur au client", r2.statut === 502, String(r2.statut));

const apresEchec = (await q("select count(*)::int n from appels_ia"))[0].n;
verifier("un appel raté reste décompté (ce qui coûte est la tentative)",
  apresEchec === avantEchec + 1, `${avantEchec} puis ${apresEchec}`);

const l2 = await derniereLigne();
verifier("un appel raté porte l'issue « echec »", l2?.issue === "echec", String(l2?.issue));
verifier("… et aucun jeton", l2?.jetons_entree === null, String(l2?.jetons_entree));

/* =====================================================================
   4. UNE RÉPONSE SANS « usage » SE VOIT
   ===================================================================== */

prochaine = { statut: 200, usage: null };
const r3 = await resumer("u-3");
prochaine = { statut: 200, usage: { input_tokens: 26000, output_tokens: 900,
                                    server_tool_use: { web_search_requests: 2 } } };

verifier("une réponse sans usage sert quand même l'utilisateur", r3.statut === 200);
const l3 = await derniereLigne();
verifier("une réponse sans usage porte l'issue « sans_mesure »",
  l3?.issue === "sans_mesure", String(l3?.issue));

/* =====================================================================
   5. LE TARIF

   L'arithmétique est vérifiée sur un cas dont le résultat se calcule de
   tête : 1 000 000 de jetons d'entrée à 2 $, 1 000 000 de sortie à 10 $,
   1 000 recherches à 10 $ — soit 22 $ exactement.
   ===================================================================== */

const [tarif] = await q(
  "select cout_ia_dollars('claude-sonnet-5', 1000000, 1000000, 1000)::float8 as d");
verifier("le tarif de Sonnet 5 est exact (2 + 10 + 10 = 22 $)",
  Math.abs(tarif.d - 22) < 1e-9, String(tarif.d));

const [inconnu] = await q(
  "select cout_ia_dollars('un-modele-jamais-vu', 1000000, 1000000, 1000) as d");
verifier("un modèle inconnu rend NULL plutôt qu'un chiffre plausible et faux",
  inconnu.d === null, String(inconnu.d));

const [nuls] = await q(
  "select cout_ia_dollars('claude-sonnet-5', null, null, null)::float8 as d");
verifier("des unités absentes valent zéro, pas NULL",
  nuls.d === 0, String(nuls.d));

/* =====================================================================
   6. ÉCRIRE CHEZ AUTRUI LÈVE — ET NE PASSE PAS EN SILENCE

   Sous « force row level security », une mise à jour hors périmètre touche
   zéro ligne SANS lever. C'est le piège du 16/08 : l'appelant croit avoir
   écrit. On vérifie donc les deux : que ça lève, et que rien n'a bougé.
   ===================================================================== */

/* SE DÉFENDRE CONTRE L'ABSENCE DE SUJET, et ce n'est pas de la coquetterie.
 *
 * Constaté en mutant ce fichier même : en retirant l'enregistrement de
 * l'usage, plus aucune ligne ne porte « ok », « cible » vaut undefined, et le
 * contrôle PLANTE sur « cible.id » au lieu d'échouer. Un contrôle qui plante
 * n'affiche aucune ligne ECHEC — la mutation paraît donc SURVIVRE, et l'on
 * conclut exactement à l'inverse de la vérité.
 *
 * Même défaut que le 16/08 sur la mutation du cookie. On ne suppose jamais
 * qu'une donnée d'entrée existe : on le vérifie, et son absence est un échec
 * nommé. */
const [cible] = await q(
  "select id, jetons_entree from appels_ia where issue = 'ok' order by id desc limit 1");

if (!cible) {
  verifier("un appel abouti a laissé une ligne mesurée à éprouver", false,
    "aucune ligne « ok » en base : les trois contrôles d'écriture croisée "
    + "n'ont rien pu éprouver");
} else {
  let refuse = false;
  await banc.dans(bob, "select enregistrer_usage_ia($1::bigint, 'ok', 1, 1, 1)", [cible.id])
    .catch(() => { refuse = true; });
  verifier("enregistrer l'usage d'un appel qui n'est pas le sien LÈVE",
    refuse, "aucune erreur — l'écriture a été refusée en silence");

  const [intacte] = await q("select jetons_entree from appels_ia where id = $1", [cible.id]);
  verifier("… et la ligne d'origine n'a pas bougé",
    intacte?.jetons_entree === cible.jetons_entree,
    `${cible.jetons_entree} puis ${intacte?.jetons_entree}`);

  let fermeSansLocataire = false;
  await banc.dans(null, "select enregistrer_usage_ia($1::bigint, 'ok', 1, 1, 1)", [cible.id])
    .catch(() => { fermeSansLocataire = true; });
  verifier("sans locataire, on n'enregistre aucun usage", fermeSansLocataire);
}

/* =====================================================================
   7. LA VUE DE COÛT EST CLOISONNÉE

   Une vue est le raccourci le plus facile pour perdre un cloisonnement :
   sans « security_invoker », elle s'exécuterait avec les droits de son
   propriétaire et rendrait les lignes de tout le monde.
   ===================================================================== */

const vuBob = await banc.dans(bob, "select * from cout_ia_par_mois");
verifier("Bob ne voit aucune dépense de Xavier dans la vue de coût",
  vuBob.length === 0, `${vuBob.length} lignes`);

const vuXavier = await banc.dans(xavier.id, "select * from cout_ia_par_mois");
verifier("… et Xavier voit les siennes",
  vuXavier.length > 0 && vuXavier.every(l => l.tenant_id === xavier.id),
  `${vuXavier.length} lignes`);

const totalDollars = vuXavier.reduce((s, l) => s + Number(l.dollars ?? 0), 0);
verifier("le coût cumulé de Xavier est strictement positif",
  totalDollars > 0, String(totalDollars));

/* ON ÉPINGLE LE VRAI GARDIEN, PAS CELUI QU'ON CROYAIT.
 *
 * Trouvé en mutant : retirer « security_invoker = true » de la vue ci-dessus
 * ne casse RIEN. Le propriétaire de la vue est le compte applicatif, qui est
 * aussi celui des tables, et « force row level security » le soumet comme les
 * autres. C'est donc le « force » qui cloisonne cette vue, et lui seul.
 *
 * Sans ce contrôle, quelqu'un pourrait retirer le « force » d'« appels_ia » en
 * se disant que la vue est protégée par son option — et les deux vérifications
 * de cloisonnement ci-dessus tomberaient sans qu'on sache pourquoi. */
const [forceAppels] = await q(
  "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'appels_ia'");
verifier("« appels_ia » est sous « force row level security » — c'est ce qui cloisonne la vue",
  forceAppels?.relrowsecurity === true && forceAppels?.relforcerowsecurity === true,
  JSON.stringify(forceAppels));

/* =====================================================================
   8. LE CONTRÔLE DE LA MESURE SAIT DIRE NON

   On ne fait pas confiance à une vérification qu'on n'a pas vue échouer.
   On fabrique donc une ligne fautive — aboutie, sans jetons, et assez
   vieille pour sortir du délai d'une heure — puis on la répare.
   ===================================================================== */

const propreAvant = await q("select * from appels_ia_sans_mesure");
verifier("aucune anomalie sur un fonctionnement normal",
  propreAvant.length === 0,
  propreAvant.map(l => `${l.id}:${l.anomalie}`).join(", "));

const [fautive] = await q(
  `insert into appels_ia (tenant_id, route, modele, issue, cree_le)
   values ($1, '/api/resume', 'claude-sonnet-5', 'ok', now() - interval '3 hours')
   returning id`, [xavier.id]);
const vuFautive = await q("select * from appels_ia_sans_mesure where id = $1", [fautive.id]);
verifier("une ligne aboutie sans jetons est signalée",
  vuFautive.length === 1 && vuFautive[0].anomalie === "abouti sans jetons",
  JSON.stringify(vuFautive));

const [envol] = await q(
  `insert into appels_ia (tenant_id, route, modele, cree_le)
   values ($1, '/api/resume', 'claude-sonnet-5', now() - interval '3 hours')
   returning id`, [xavier.id]);
const vuEnvol = await q("select * from appels_ia_sans_mesure where id = $1", [envol.id]);
verifier("une ligne restée en vol est signalée",
  vuEnvol.length === 1 && vuEnvol[0].anomalie === "resté en vol",
  JSON.stringify(vuEnvol));

const [sansModele] = await q(
  `insert into appels_ia (tenant_id, route, issue, jetons_entree, jetons_sortie, cree_le)
   values ($1, '/api/resume', 'ok', 10, 10, now() - interval '3 hours')
   returning id`, [xavier.id]);
const vuSansModele = await q("select * from appels_ia_sans_mesure where id = $1", [sansModele.id]);
verifier("une ligne sans modèle est signalée",
  vuSansModele.length === 1 && vuSansModele[0].anomalie === "sans modèle",
  JSON.stringify(vuSansModele));

/* Le délai fait-il son office ? Une ligne fautive mais RÉCENTE ne doit pas
   remonter : sinon toute mesure en cours passerait pour une anomalie et le
   contrôle serait inutilisable. */
const [recente] = await q(
  `insert into appels_ia (tenant_id, route, modele) values ($1, '/api/resume', 'x')
   returning id`, [xavier.id]);
verifier("une ligne encore en vol depuis moins d'une heure n'est pas une anomalie",
  (await q("select * from appels_ia_sans_mesure where id = $1", [recente.id])).length === 0);

await q("delete from appels_ia where id = any($1::bigint[])",
        [[fautive.id, envol.id, sansModele.id, recente.id]]);
verifier("une fois les lignes fautives retirées, le contrôle repasse au vert",
  (await q("select * from appels_ia_sans_mesure")).length === 0);

/* =====================================================================
   8 bis. CE QUI PRÉCÈDE L'INSTRUMENT N'EST PAS UNE ANOMALIE

   Constaté en production le 18/08/2026, une heure après la mise en service :
   la vue signalait une ligne du 15/08 comme « restée en vol ». Elle n'était
   pas en vol, elle était antérieure aux colonnes. Un contrôle qui crie sur
   l'histoire finit désactivé, et le jour où il criera pour une vraie raison,
   personne ne regardera.

   LE PIÈGE À ÉVITER EST DANS LE REMPLISSAGE, PAS DANS LA VUE. Écrire
   « where issue is null » marquerait, à chaque rejeu, les appels EN COURS à
   cet instant — le contrôle perdrait exactement ce qu'il doit attraper. D'où
   une date écrite en dur, et les deux vérifications ci-dessous : celle qui
   dit que ça marque, et celle qui dit que ça ne marque PAS trop.
   ===================================================================== */

const DB = ["db", path.join("..", "db")].find(d => fs.existsSync(path.join(d, "05-usage-ia.sql")));

/* REJOUER 05 SEUL ANNULAIT CE QUI VIENT APRÈS — corrigé le 22/08/2026.

   Ce rejeu sert à vérifier que le remplissage rétroactif de « issue » ne
   marque pas les appels en cours. Il ne rejouait QUE 05-usage-ia.sql.

   Or 11-plafond-depense.sql redéfinit « consommer_appel_ia » pour y ajouter
   le plafond de dépense. Rejouer 05 restaurait donc l'ANCIENNE fonction, sans
   plafond — et deux contrôles tout neufs échouaient en accusant le plafond
   d'être inopérant, alors qu'il avait été effacé quelques lignes plus haut.

   J'ai perdu un moment à chercher le défaut dans la fonction. Il était dans
   l'ordre : une migration rejouée isolément défait celles qui la suivent.

   Sixième liste écrite à la main de la semaine, après le déployeur,
   test-authentification.mjs, l'assembleur, le domaine, et la mienne. On lit
   donc le répertoire, à partir de 05 — les quatre premières ne touchent rien
   de ce que ce rejeu doit rétablir, et les rejouer coûterait du temps sans
   rien prouver. */
const rejouer05 = async () => {
  const apres05 = fs.readdirSync(DB)
    .filter(f => /^\d\d-.*\.sql$/.test(f) && f >= "05")
    .sort();
  for (const f of apres05) {
    await banc.dans(null, fs.readFileSync(path.join(DB, f), "utf8"));
  }
};

const [ancienne] = await q(
  `insert into appels_ia (tenant_id, route, cree_le)
   values ($1, '/api/resume', timestamptz '2026-08-15 10:10:27+02') returning id`,
  [xavier.id]);

verifier("avant remplissage, une ligne d'avant l'instrument passe pour une anomalie",
  (await q("select * from appels_ia_sans_mesure where id = $1", [ancienne.id])).length === 1);

/* Le témoin, et c'est LUI qui compte : postérieur à la date butoir, sans
   issue, assez vieux pour sortir du délai. Il représente un appel réellement
   en vol au moment d'un rejeu. Le remplissage ne doit pas y toucher. */
const [temoin] = await q(
  `insert into appels_ia (tenant_id, route, modele, cree_le)
   values ($1, '/api/resume', 'claude-sonnet-5', now() - interval '3 hours')
   returning id`, [xavier.id]);

await rejouer05();

const [apres] = await q("select issue from appels_ia where id = $1", [ancienne.id]);
verifier("le remplissage marque « avant_mesure » ce qui précède l'instrument",
  apres?.issue === "avant_mesure", String(apres?.issue));
verifier("… et la vue cesse de la signaler",
  (await q("select * from appels_ia_sans_mesure where id = $1", [ancienne.id])).length === 0);

const [intact] = await q("select issue from appels_ia where id = $1", [temoin.id]);
verifier("un appel POSTÉRIEUR à la date butoir n'est PAS marqué par le rejeu",
  intact?.issue === null, String(intact?.issue));
verifier("… et reste signalé comme resté en vol",
  (await q("select anomalie from appels_ia_sans_mesure where id = $1", [temoin.id]))[0]
    ?.anomalie === "resté en vol");

/* Le rejeu remet-il le cloisonnement ? 05 lève désormais les politiques pour
   écrire ; l'oubli de la remise ne se verrait dans aucune donnée. */
const [forceApresRejeu] = await q(
  "select relforcerowsecurity from pg_class where relname = 'appels_ia'");
verifier("après rejeu de 05, « appels_ia » est de nouveau sous « force »",
  forceApresRejeu?.relforcerowsecurity === true, JSON.stringify(forceApresRejeu));

await q("delete from appels_ia where id = any($1::bigint[])", [[ancienne.id, temoin.id]]);

/* =====================================================================
   9. LE QUOTA N'A PAS ÉTÉ CASSÉ PAR LE CHANGEMENT DE SIGNATURE
   ===================================================================== */

await q("delete from appels_ia");
await q("update tenants set quota_ia_mois = 2 where id = $1", [xavier.id]);

const a = await resumer("u-4");
const b = await resumer("u-5");
const c = await resumer("u-1");
verifier("plafond 2 : les deux premiers passent",
  a.statut === 200 && b.statut === 200, `${a.statut} ${b.statut}`);
verifier("… et le troisième est refusé en 429, pas en 500",
  c.statut === 429, String(c.statut));

const restant = (await q("select count(*)::int n from appels_ia"))[0].n;
verifier("exactement 2 lignes écrites", restant === 2, String(restant));

/* Un refus de quota ne doit rien avoir envoyé au modèle : le contrôle du
   coût n'a de sens que si le plafond agit AVANT la dépense. */
const appelsAuModele = corpsRecus.length;
await resumer("u-1");
verifier("un appel refusé pour quota n'atteint pas le modèle",
  corpsRecus.length === appelsAuModele, `${appelsAuModele} puis ${corpsRecus.length}`);

/* =====================================================================
   LE PLAFOND DE DÉPENSE, ET LE GARDE-FOU QUI L'EMPÊCHE DE SE RELEVER

   Le quota comptait les APPELS. Vos mesures du 19/08 : 0,086 $ l'appel sur
   /api/recherche-livre, 0,0025 $ sur le classement — un facteur TRENTE-QUATRE.
   Un compteur d'appels mesure donc l'activité, pas la dépense, alors que
   c'est la dépense qui sort de la poche.

   Les deux plafonds coexistent parce qu'ils protègent de deux pannes que
   l'autre ne voit pas : la boucle folle (beaucoup d'appels dérisoires) et le
   portefeuille (peu d'appels chers).
   ===================================================================== */

const dansT = (t, sql, params) => banc.dans(t, sql, params);

{
  /* --- Le garde-fou : on ne relève pas son propre plafond ------------- */
  let refuse = false;
  try { await dansT(xavier.id, "update tenants set quota_ia_mois = 99999"); }
  catch { refuse = true; }
  verifier("un locataire ne relève pas son propre quota", refuse,
    "l'update a été accepté");

  refuse = false;
  try { await dansT(xavier.id, "update tenants set plafond_usd = 999"); }
  catch { refuse = true; }
  verifier("… ni son propre plafond de dépense", refuse, "l'update a été accepté");

  /* CE QUI DOIT RESTER POSSIBLE. Un garde-fou qui bloque tout est un garde-fou
     qu'on retire. La langue et la visibilité sont des réglages ordinaires. */
  let passe = true;
  try { await dansT(xavier.id, "update tenants set langue = 'en'"); }
  catch { passe = false; }
  verifier("… mais la langue reste modifiable", passe,
    "le garde-fou bloque aussi ce qu'il ne devrait pas");

  /* --- La porte nommée --------------------------------------------- */
  const regle = await dansT(xavier.id,
    "select * from regler_tarification($1, 40, 0.200)", [xavier.id]);
  verifier("la porte nommée relève le plafond",
    regle[0]?.quota === 40 && Number(regle[0]?.plafond) === 0.2,
    JSON.stringify(regle[0]));

  refuse = false;
  try { await dansT(xavier.id, "select * from regler_tarification($1, 40, 5000)", [xavier.id]); }
  catch { refuse = true; }
  verifier("… et refuse un plafond absurde", refuse, "5000 $ a été accepté");
}

{
  /* --- Le plafond mord sur l'ARGENT, pas sur le nombre ---------------- */
  await q("delete from appels_ia where tenant_id = $1", [xavier.id]);

  /* Un seul appel, cent mille jetons de sortie : 1,00 $. Le quota d'appels
     (40) est loin d'être atteint — c'est bien la dépense qui doit arrêter. */
  await q(`insert into appels_ia (tenant_id, route, modele, issue,
                                  jetons_entree, jetons_sortie, recherches_web)
           values ($1, '/api/essai', 'claude-sonnet-5', 'ok', 0, 100000, 0)`,
          [xavier.id]);

  const [d] = await dansT(xavier.id, "select round(depense_ia_du_mois(), 3) d");
  verifier("la dépense du mois est comptée en argent",
    Number(d.d) === 1, `${d.d} $`);

  let refuse = false, message = "";
  try { await dansT(xavier.id,
    "select * from consommer_appel_ia('/api/essai','claude-sonnet-5')"); }
  catch (e) { refuse = true; message = e.message; }
  verifier("un appel est refusé sur la DÉPENSE, quota d'appels non atteint",
    refuse, "l'appel est passé malgré 1,00 $ sur un plafond de 0,20 $");
  verifier("… et le refus dit des dollars, pas des appels",
    /\$/.test(message) && /plafond de dépense/i.test(message), message.slice(0, 80));
}

{
  /* --- UN APPEL NON MESURÉ EST PRÉSUMÉ CHER ---------------------------
     Sans cette présomption, une instrumentation en panne OUVRIRAIT le
     plafond : plus la mesure tombe, plus on peut dépenser. La pression doit
     être dans l'autre sens. */
  await q("delete from appels_ia where tenant_id = $1", [xavier.id]);
  await q(`insert into appels_ia (tenant_id, route, modele, issue)
           values ($1, '/api/x', null, 'sans_mesure')`, [xavier.id]);
  const [d] = await dansT(xavier.id, "select round(depense_ia_du_mois(), 3) d");
  verifier("un appel non mesuré est présumé cher, pas gratuit",
    Number(d.d) === 0.1, `${d.d} $ — une instrumentation en panne ouvrirait le plafond`);

  /* Et les lignes d'AVANT l'instrument ne comptent pas : elles ne portent
     aucun jeton, et les présumer chères ferait sauter le plafond pour des
     appels vieux d'une semaine. */
  await q("delete from appels_ia where tenant_id = $1", [xavier.id]);
  await q(`insert into appels_ia (tenant_id, route, modele, issue)
           values ($1, '/api/x', null, 'avant_mesure')`, [xavier.id]);
  const [d2] = await dansT(xavier.id, "select round(depense_ia_du_mois(), 3) d");
  verifier("… mais les lignes d'avant l'instrument valent zéro",
    Number(d2.d) === 0, `${d2.d} $`);
}

{
  /* --- ÉCHOUER FERMÉ ------------------------------------------------- */
  let refuse = false;
  try { await dansT(null, "select depense_ia_du_mois()"); }
  catch { refuse = true; }
  verifier("sans locataire posé, la dépense refuse au lieu de rendre zéro",
    refuse, "zéro rendu — c'est-à-dire un plafond jamais atteint");
}

{
  /* --- LA VUE DE COÛT VOIT-ELLE QUELQUE CHOSE ? ----------------------
     Livrée sans « security_invoker », elle rendait ZÉRO LIGNE même en
     superutilisateur : une vue s'exécute par défaut avec les droits de son
     PROPRIÉTAIRE — le compte applicatif, que « force row level security »
     soumet aux politiques. Sans locataire posé, rien.

     Le symptôme est le pire qui soit : pas d'erreur, un tableau vide qui
     ressemble à « aucun appel ce mois-ci ». On conclut sur l'usage au lieu de
     la configuration.

     L'explication était déjà écrite dans 05-usage-ia.sql, à propos de la vue
     voisine. Connaître un piège ne suffit pas. */
  await q("delete from appels_ia where tenant_id = $1", [xavier.id]);
  await q(`insert into appels_ia (tenant_id, route, modele, issue,
                                  jetons_entree, jetons_sortie, recherches_web)
           values ($1, '/api/essai', 'claude-sonnet-5', 'ok', 1000, 500, 0)`,
          [xavier.id]);

  const vue = await q("select * from cout_ia_par_locataire");
  verifier("l'œil privilégié voit ce que chaque locataire a coûté",
    vue.length > 0 && Number(vue[0].dollars) > 0,
    `${vue.length} ligne(s) — sans security_invoker, la vue est muette`);

  /* ET LE CLOISONNEMENT TIENT TOUJOURS. « security_invoker » pourrait passer
     pour une ouverture ; il n'en est pas une. La vue s'exécute avec les
     droits de CELUI QUI INTERROGE — donc l'application reste soumise aux
     politiques, et ne voit que ce qui la regarde. */
  const parLApplication = await banc.dans(null, "select * from cout_ia_par_locataire");
  verifier("… et l'application, elle, n'y voit rien",
    parLApplication.length === 0,
    `${parLApplication.length} ligne(s) visibles sans locataire posé`);
}

/* ------------------------------------------------------------- Verdict */
await fermer();

for (const l of ok) console.log("  OK      " + l);
for (const l of ko) console.log("  ECHEC   " + l);
console.log(`\n  ${ok.length} vérifications passées, ${ko.length} échouées`);
if (ko.length) { console.log("\n--- journal du serveur ---\n" + journal); process.exit(1); }
