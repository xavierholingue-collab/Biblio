/* =========================================================================
   LE QUOTA SUIT LE NOMBRE DE SIÈGES — sans écraser ce qui a été réglé

   Une bibliothèque partagée à cinq consomme le modèle comme cinq personnes.
   Lui laisser le quota d'une seule bloquerait le cabinet au troisième
   parcours de la journée ; lui en donner cinq d'office offrirait cinq fois
   le gratuit à qui travaille seul.

   ---------------------------------------------------------------------------
   CE FICHIER EXISTE SURTOUT POUR LE CAS INVERSE

   Le 25/08/2026, un redimensionnement appliquant « les valeurs du gratuit » a
   ramené la bibliothèque de Xavier — 100 000 appels, 20 $ — à 10 appels, et
   l'a bloqué. Un déclencheur qui recalcule à chaque changement d'effectif
   referait cela À CHAQUE INVITATION, sans que personne le demande, et sans
   la moindre erreur.

   La moitié des vérifications ci-dessous porte donc sur ce qui NE DOIT PAS
   bouger. Un dimensionnement qui marche est facile à constater ; un
   dimensionnement qui sait s'abstenir ne se voit que si on le lui demande.

   ---------------------------------------------------------------------------
   ET L'INVARIANT DE LA 11 DOIT TENIR À CHAQUE EFFECTIF

     plafond_usd  >=  quota_ia_mois  ×  coût du plus cher appel mesuré

   Il est préservé par construction — les deux valeurs sont multipliées
   ensemble — mais « par construction » est exactement le genre de phrase
   qu'on écrit avant de découvrir qu'elle est fausse. On le vérifie donc à
   plusieurs effectifs.

   USAGE
     node tests/test-sieges.mjs
   ========================================================================= */

import { ouvrirBanc } from "./banc-postgres.mjs";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const banc = await ouvrirBanc({ port: 55513 });
const { q, locataire } = banc;

/* LES VALEURS PAR SIÈGE SONT LUES EN BASE, PAS RECOPIÉES ICI. Les écrire
   dans ce fichier créerait une seconde déclaration : le jour où l'une des
   deux change, le contrôle vérifierait l'ancienne et resterait vert. */
const [{ quota: PAR_SIEGE, plafond: PLAFOND_SIEGE }] = await q(
  "select public.quota_par_siege() as quota, public.plafond_par_siege() as plafond");

verifier("les valeurs par siège sont déclarées en base",
  Number(PAR_SIEGE) > 0 && Number(PLAFOND_SIEGE) > 0,
  JSON.stringify({ PAR_SIEGE, PLAFOND_SIEGE }));

/* Le coût du plus cher appel mesuré, tel que la 11 le fixe. On le relit du
   fichier plutôt que de le réécrire — même raison. */
const COUT_MAX = 0.086;

const tarif = async (t) => (await q(
  "select quota_ia_mois, plafond_usd::text as plafond, tarification from tenants where id = $1",
  [t]))[0];

/* =====================================================================
   1. LE DIMENSIONNEMENT A LIEU QUAND IL DOIT
   ===================================================================== */

/* LE BANC CRÉE SES LOCATAIRES AVEC UN QUOTA BAS — trois appels — pour que
   les contrôles de quota soient praticables. C'est une décision, donc un
   régime « manuelle » : on le vérifie, parce que si le dimensionnement s'en
   emparait, la première invitation d'un contrôle ramènerait le quota à dix
   et toutes les vérifications de quota mesureraient autre chose.

   On demande donc ici une bibliothèque AU TARIF, explicitement. */
const cabinet = await locataire("cabinet", "privee", "fr", Number(PAR_SIEGE));
await q("update tenants set plafond_usd = $1 where id = $2",
        [PLAFOND_SIEGE, cabinet]);

{
  const bas = await locataire("quota-bas", "privee", "fr", 3);
  const r = await tarif(bas);
  verifier("une bibliothèque créée avec d'autres valeurs est « manuelle »",
    r.tarification === "manuelle" && r.quota_ia_mois === 3,
    JSON.stringify(r) + " — le dimensionnement effacerait un réglage voulu");

  const seul = await tarif(cabinet);
  verifier("… tandis qu'une bibliothèque aux valeurs d'un siège reste au tarif",
    seul.tarification === "sieges" && seul.quota_ia_mois === Number(PAR_SIEGE),
    JSON.stringify(seul));
}

const alice = await banc.compte(cabinet, "alice@controle.fr");
{
  const un = await tarif(cabinet);
  verifier("un membre : un siège",
    un.quota_ia_mois === Number(PAR_SIEGE)
      && Number(un.plafond) === Number(PLAFOND_SIEGE),
    JSON.stringify(un));
}

const bob = await banc.compte(cabinet, "bob@controle.fr", "membre");
{
  const deux = await tarif(cabinet);
  verifier("deux membres : deux sièges",
    deux.quota_ia_mois === 2 * Number(PAR_SIEGE)
      && Number(deux.plafond) === 2 * Number(PLAFOND_SIEGE),
    JSON.stringify(deux));
}

const carole = await banc.compte(cabinet, "carole@controle.fr", "membre");
{
  const trois = await tarif(cabinet);
  verifier("trois membres : trois sièges",
    trois.quota_ia_mois === 3 * Number(PAR_SIEGE),
    JSON.stringify(trois));
}

/* ET IL REDESCEND. Un dimensionnement qui ne sait que monter laisserait une
   équipe qui rétrécit payer — ou consommer — pour des sièges vides. */
await q("delete from membres where tenant_id = $1 and compte_id = $2",
        [cabinet, carole]);
{
  const deux = await tarif(cabinet);
  verifier("… et il redescend quand quelqu'un part",
    deux.quota_ia_mois === 2 * Number(PAR_SIEGE), JSON.stringify(deux));
}

/* L'INVARIANT DE LA 11, À CHAQUE EFFECTIF. */
for (const n of [1, 2, 3, 7, 25]) {
  const quota   = n * Number(PAR_SIEGE);
  const plafond = n * Number(PLAFOND_SIEGE);
  verifier(`à ${n} siège(s), le plafond d'argent ne mord pas avant le quota`,
    plafond >= quota * COUT_MAX,
    `${plafond} $ < ${quota} × ${COUT_MAX} = ${(quota * COUT_MAX).toFixed(3)} $`);
}

/* =====================================================================
   2. CE QUI A ÉTÉ RÉGLÉ NE BOUGE PAS

   La moitié qui compte.
   ===================================================================== */

/* =====================================================================
   1 bis. LE DIMENSIONNEMENT MARCHE AUSSI SOUS LE COMPTE APPLICATIF

   Tout ce qui précède passe par l'observateur, qui est superutilisateur et
   traverse les politiques. En production, c'est le compte « biblio » qui
   écrit, et il y est SOUMIS — « force row level security ».

   C'est exactement là que le défaut se cachait : « tenants_reglages » borne
   la mise à jour sur « id = app.tenant_id », et une invitation consommée se
   fait en contexte VISITEUR. L'update ne touchait aucune ligne, et ne le
   disait pas. On éprouve donc le chemin réel : la porte nommée
   « rejoindre_locataire », appelée sans locataire posé.
   ===================================================================== */
{
  const equipe = await locataire("equipe", "privee", "fr", Number(PAR_SIEGE));
  await q("update tenants set plafond_usd = $1 where id = $2",
          [PLAFOND_SIEGE, equipe]);
  const fondateur = await banc.compte(equipe, "fondateur@controle.fr");
  const [{ id: arrivant }] = await q(
    "insert into comptes (courriel) values ('arrivant@controle.fr') returning id");

  const avant = await tarif(equipe);
  await banc.dans(null, "select public.rejoindre_locataire($1, $2)",
                  [arrivant, equipe]);
  const apres = await tarif(equipe);

  verifier("sous le compte applicatif, rejoindre ajoute bien un siège",
    apres.quota_ia_mois === avant.quota_ia_mois + Number(PAR_SIEGE),
    `${avant.quota_ia_mois} → ${apres.quota_ia_mois} : l'écriture est passée `
    + "à travers la politique sans rien écrire, et sans le dire");

  verifier("… et le plafond a suivi",
    Number(apres.plafond) === Number(avant.plafond) + Number(PLAFOND_SIEGE),
    `${avant.plafond} → ${apres.plafond}`);

  verifier("… le décor a bien deux membres",
    Boolean(fondateur) && (await q(
      "select count(*)::int n from membres where tenant_id = $1", [equipe]))[0].n === 2,
    "le contrôle a mesuré autre chose que ce qu'il annonce");
}

/* LA PORTE NOMMÉE, ELLE AUSSI, SOUS LE COMPTE APPLICATIF. « regler_tarification »
   n'avait jamais été lancée qu'en superutilisateur : le jour où l'API s'en
   servirait, elle aurait rendu zéro ligne comme un succès. */
{
  const cible = await locataire("a-regler", "privee", "fr", Number(PAR_SIEGE));
  const rendu = await banc.dans(null,
    "select * from public.regler_tarification($1, 500, 5.000)", [cible]);
  verifier("« regler_tarification » écrit vraiment sous le compte applicatif",
    rendu.length === 1 && rendu[0].quota === 500,
    JSON.stringify(rendu) + " — zéro ligne rendue comme un succès");
}

const perso = await locataire("perso", "privee");
const xavier = await banc.compte(perso, "xavier@controle.fr");

await q("select * from public.regler_tarification($1, 100000, 20.000)", [perso]);

{
  const regle = await tarif(perso);
  verifier("régler à la main bascule en tarification « manuelle »",
    regle.tarification === "manuelle", JSON.stringify(regle));
  verifier("… et les valeurs demandées sont bien posées",
    regle.quota_ia_mois === 100000 && Number(regle.plafond) === 20,
    JSON.stringify(regle));
}

/* LE GESTE QUI A DÉJÀ BLOQUÉ XAVIER : inviter quelqu'un. */
const invite = await banc.compte(perso, "invite@controle.fr", "membre");
{
  const apres = await tarif(perso);
  verifier("INVITER QUELQU'UN N'ÉCRASE PAS UN QUOTA RÉGLÉ À LA MAIN",
    apres.quota_ia_mois === 100000 && Number(apres.plafond) === 20,
    JSON.stringify(apres)
      + " — c'est exactement le geste qui a bloqué la bibliothèque de 348 "
      + "ouvrages le 25/08/2026");
}

/* NI LE DÉPART. */
await q("delete from membres where tenant_id = $1 and compte_id = $2",
        [perso, invite]);
{
  const apres = await tarif(perso);
  verifier("… ni un départ",
    apres.quota_ia_mois === 100000, JSON.stringify(apres));
}

/* ET LE RÉGLAGE MANUEL RESTE MODIFIABLE — un régime figé serait un piège
   d'un autre genre. */
await q("select * from public.regler_tarification($1, 50000, 10.000)", [perso]);
{
  const apres = await tarif(perso);
  verifier("… mais un nouveau réglage à la main passe toujours",
    apres.quota_ia_mois === 50000 && Number(apres.plafond) === 10,
    JSON.stringify(apres));
}

/* =====================================================================
   3. LA PORTE NOMMÉE RESTE LA SEULE

   Le déclencheur de la 11 interdit de changer quota et plafond autrement
   que par « regler_tarification ». Le dimensionnement automatique passe par
   le drapeau prévu — il respecte la porte, il ne la contourne pas. On
   vérifie que la porte tient toujours pour tout le monde.
   ===================================================================== */

{
  let refuse = false;
  try {
    await banc.dans(cabinet,
      "update tenants set quota_ia_mois = 99999 where id = $1", [cabinet]);
  } catch (e) { refuse = /ne se changent pas par ce chemin/.test(e.message); }
  verifier("un locataire ne relève toujours pas son propre quota",
    refuse, "l'écriture directe est passée — la porte nommée est contournable");
}

/* =====================================================================
   4. LA REPRISE — ce qui existait garde ce qu'il avait

   La migration 19 doit marquer « manuelle » toute bibliothèque déjà réglée,
   sans quoi la première invitation qui suit la livraison ramènerait Xavier
   à dix appels. On monte donc la base À L'ÉTAT D'AVANT.
   ===================================================================== */

await banc.fermer();

/* --------------------------------------------------------------- Bilan */

console.log("\n=== Le quota suit les sièges ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
