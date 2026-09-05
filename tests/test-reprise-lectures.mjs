/* =========================================================================
   LE DÉMÉNAGEMENT DES LECTURES — éprouvé sur des données qui existaient

   CE QUE LES AUTRES CONTRÔLES NE DISENT PAS. Le banc d'essai applique toutes
   les migrations d'un bloc sur une base VIDE : une reprise qui ne reprend
   rien y passe au vert, puisqu'il n'y avait rien à reprendre. Le rejeu, lui,
   vérifie qu'une migration s'applique deux fois — pas qu'elle déplace
   correctement ce qui était là.

   Or la 17 déplace le statut de lecture et la note de 348 ouvrages réels,
   et elle le fait sous « force row level security », qui soumet même le
   propriétaire des tables. Une insertion qui oublie de lever les politiques
   touche ZÉRO ligne, EN SILENCE. La bibliothèque repartirait entièrement
   « à lire », sans une erreur, et personne ne le verrait avant de regarder.

   Ce fichier monte donc la base À L'ÉTAT D'AVANT, y sème des lectures comme
   elles existaient, applique la suite, et regarde ce qui est arrivé.

   ---------------------------------------------------------------------------
   CE QU'IL SURVEILLE

   1. RIEN NE SE PERD. Chaque statut, chaque note, sur chaque ouvrage.
   2. RIEN NE SE MÉLANGE entre deux bibliothèques.
   3. CHAQUE MEMBRE GARDE CE QU'IL VOYAIT. Le statut était commun : le
      préserver, c'est le donner à chacun — et c'est aussi ce qui évite
      d'avoir à désigner « le » propriétaire parmi plusieurs.
   4. LES COLONNES D'ORIGINE SONT BIEN PARTIES. Sans quoi deux endroits
      porteraient le même fait, et divergeraient.

   USAGE
     node tests/test-reprise-lectures.mjs
   ========================================================================= */

import { ouvrirBanc } from "./banc-postgres.mjs";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

/* On s'arrête AVANT 17 : la base est alors dans l'état où se trouve
   aujourd'hui le serveur de production. */
const banc = await ouvrirBanc({ port: 55507, jusqua: "17-" });
const { q, locataire } = banc;

/* ------------------------------------------------- L'état d'AVANT --- */

verifier("la base est bien à l'état d'avant la 17",
  (await q(`select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'possessions'
               and column_name = 'statut'`)).length === 1,
  "la colonne « statut » est déjà partie : le contrôle n'éprouve rien");

verifier("… et « lectures » n'existe pas encore",
  (await q(`select to_regclass('public.lectures') as t`))[0].t === null,
  "la table est déjà là");

const cabinet = await locataire("cabinet", "privee");
const voisin  = await locataire("voisin",  "privee");

/* Deux membres pour le cabinet — c'est le cas où « à qui appartient ce
   statut ? » n'a pas de réponse évidente, et donc celui qu'il faut éprouver. */
const alice = await banc.compte(cabinet, "alice@controle.fr");
const bob   = await banc.compte(cabinet, "bob@controle.fr", "membre");
const seul  = await banc.compte(voisin,  "seul@controle.fr");

/* On sème EN SQL DIRECT, comme la base l'était avant la migration : le
   « semer » du banc, lui, écrit déjà dans « lectures ». */
const poser = async (tenant, id, titre, statut, note) => {
  const [o] = await q(
    `insert into ouvrages (cle, titre, auteur) values ($1, $2, 'Auteur')
     on conflict (cle) do update set cle = excluded.cle returning id`,
    [`local:${tenant}:${id}`, titre]);
  await q(
    `insert into possessions (tenant_id, id, ouvrage_id, statut, note,
                              categorie, sous_categorie, sphere)
     values ($1,$2,$3,$4,$5,'Savoirs','Philosophie','Pro')`,
    [tenant, id, o.id, statut, note]);
};

const AVANT = [
  [cabinet, "c1", "Lu et noté",        "Lu",       5],
  [cabinet, "c2", "En cours sans note", "En cours", null],
  [cabinet, "c3", "Jamais ouvert",     "A lire",   null],
  [voisin,  "v1", "Chez le voisin",    "Lu",       3],
];
for (const [t, id, titre, statut, note] of AVANT) await poser(t, id, titre, statut, note);

verifier("le décor d'avant est en place",
  Number((await q("select count(*) as n from possessions"))[0].n) === 4,
  JSON.stringify(await q("select tenant_id, id, statut, note from possessions")));

/* ------------------------------------------------- LE DÉMÉNAGEMENT --- */

await banc.appliquerLaSuite();

/* 1. RIEN NE SE PERD — chaque ligne, pour chaque membre. */
{
  const attendu = [];
  for (const [t, id, , statut, note] of AVANT) {
    for (const c of (t === cabinet ? [alice, bob] : [seul])) {
      attendu.push({ tenant_id: t, possession: id, compte_id: c, statut,
                     note: note === null ? null : String(note.toFixed(1)) });
    }
  }
  const trouve = await q(
    `select tenant_id, possession, compte_id, statut, note::text as note
       from lectures order by tenant_id, possession, compte_id`);

  const clef = (l) => `${l.tenant_id}|${l.possession}|${l.compte_id}`;
  const parClef = new Map(trouve.map(l => [clef(l), l]));

  const manquants = attendu.filter(a => !parClef.has(clef(a)));
  verifier("chaque lecture d'avant a été reprise, pour chaque membre",
    manquants.length === 0,
    `${manquants.length} manquante(s) sur ${attendu.length} : `
    + JSON.stringify(manquants.slice(0, 4))
    + " — la reprise a touché zéro ligne, ou presque");

  const faux = attendu.filter(a => {
    const l = parClef.get(clef(a));
    return l && (l.statut !== a.statut || l.note !== a.note);
  });
  verifier("… avec le MÊME statut et la MÊME note",
    faux.length === 0,
    JSON.stringify(faux.slice(0, 3).map(a => ({
      attendu: a, trouve: parClef.get(clef(a)) }))));

  verifier("… et rien de plus n'a été inventé",
    trouve.length === attendu.length,
    `${trouve.length} lignes pour ${attendu.length} attendues`);
}

/* 2. LES DEUX MEMBRES ONT CHACUN LA LEUR, et ce sont deux lignes distinctes.
      C'est ce qui rend le lot utile : à partir de maintenant elles peuvent
      diverger. */
{
  const c1 = await q(
    "select compte_id from lectures where tenant_id = $1 and possession = 'c1'",
    [cabinet]);
  verifier("les deux membres du cabinet ont chacun leur ligne",
    c1.length === 2 && c1.some(l => l.compte_id === alice)
                    && c1.some(l => l.compte_id === bob),
    JSON.stringify(c1));
}

/* 3. RIEN N'A TRAVERSÉ D'UNE BIBLIOTHÈQUE À L'AUTRE. */
{
  const chezVoisin = await q(
    "select compte_id, possession from lectures where tenant_id = $1", [voisin]);
  verifier("aucune lecture du cabinet n'a atterri chez le voisin",
    chezVoisin.length === 1 && chezVoisin[0].compte_id === seul
      && chezVoisin[0].possession === "v1",
    JSON.stringify(chezVoisin));
}

/* 4. LES COLONNES D'ORIGINE SONT PARTIES — sinon deux endroits porteraient
      le même fait, et l'un des deux se périmerait sans le dire. */
{
  const restantes = await q(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'possessions'
        and column_name in ('statut', 'note')`);
  verifier("« statut » et « note » ont quitté « possessions »",
    restantes.length === 0,
    `il reste : ${restantes.map(r => r.column_name).join(", ")}`);
}

/* 5. ET LA VUE REND CE QUE CHACUN VOYAIT — la reprise ne sert à rien si la
      vue ne sait pas la lire. */
{
  const [vuAlice] = await banc.dans({ locataire: cabinet, compte: alice },
    "select statut, note::text as note from livres where id = 'c1'");
  verifier("alice retrouve sa lecture à travers la vue",
    vuAlice?.statut === "Lu" && vuAlice?.note === "5.0",
    JSON.stringify(vuAlice));

  const [vuBob] = await banc.dans({ locataire: cabinet, compte: bob },
    "select statut, note::text as note from livres where id = 'c2'");
  verifier("… et bob la sienne, sur un autre ouvrage",
    vuBob?.statut === "En cours" && vuBob?.note === null,
    JSON.stringify(vuBob));
}

/* --------------------------------------------------------------- Bilan */

await banc.fermer();

console.log("\n=== Reprise des lectures ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
