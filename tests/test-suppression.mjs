/* =========================================================================
   LA PORTE DE SORTIE — ÉPROUVÉE SUR CE QU'ELLE PROMET

   Une suppression qui « marche » ne prouve presque rien : elle passe aussi
   quand elle oublie la moitié des tables, quand elle emporte le voisin, ou
   quand elle rend un succès sans avoir rien effacé. Ce sont ces trois cas
   qui sont contrôlés ici.

   ---------------------------------------------------------------------------
   LE CONTRÔLE CENTRAL INTERROGE LE CATALOGUE, PAS UNE LISTE

   « chaque table portant tenant_id casse-t-elle en cascade ? » est demandé à
   PostgreSQL lui-même. Une liste écrite ici se périmerait à la première
   table ajoutée — en silence, et précisément sur les données qu'on promet
   d'effacer. Le dépôt a déjà payé six listes manuelles ; celle-ci coûterait
   une promesse fausse.

   USAGE
     PGURL=… PGURL_OEIL=… node tests/test-suppression.mjs
   ========================================================================= */

import { ouvrirBanc } from "./banc-postgres.mjs";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const banc = await ouvrirBanc();
const { q, dans, semer, locataire } = banc;

/* UN CONTRÔLE QUI PLANTE N'EST PAS UN CONTRÔLE QUI ÉCHOUE — 4e occurrence.
   Éprouvé le 24/08/2026 : en retirant la cascade d'« appels_ia », la
   vérification du catalogue avait BIEN noté l'anomalie… puis la suppression
   a levé une violation de clé étrangère, le processus est mort, et le
   rapport n'a jamais été imprimé. Le défaut était vu, et perdu.
   D'où cette enveloppe : ce qui casse devient un échec NOMMÉ, et tout ce qui
   avait déjà été constaté s'affiche quand même. */
const enChaine = async (nom, faire) => {
  try { await faire(); }
  catch (e) { verifier(nom, false, `a LEVÉ au lieu d'échouer : ${e.message}`); }
};

/* ===================================================================== */
/* 1. AUCUNE TABLE N'ÉCHAPPE À LA CASCADE                                 */
/* ===================================================================== */

/* Toutes les tables du schéma public qui portent une colonne « tenant_id ». */
const portantes = (await q(`
  select c.relname as table
    from pg_attribute a
    join pg_class     c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
   order by 1`)).map(r => r.table);

verifier("des tables portant « tenant_id » ont été trouvées",
  portantes.length >= 8, `${portantes.length} : ${portantes.join(", ")}`);

/* Celles dont le tenant_id pointe vers tenants EN CASCADE. « confdeltype »
   vaut 'c' pour ON DELETE CASCADE — c'est PostgreSQL qui répond, pas moi. */
const cascadantes = new Set((await q(`
  select src.relname as table
    from pg_constraint      k
    join pg_class       src on src.oid = k.conrelid
    join pg_class       dst on dst.oid = k.confrelid
    join pg_namespace     n on n.oid = src.relnamespace
    join pg_attribute     a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
   where k.contype = 'f' and n.nspname = 'public'
     and dst.relname = 'tenants' and a.attname = 'tenant_id'
     and k.confdeltype = 'c'`)).map(r => r.table));

const orphelines = portantes.filter(t => t !== "tenants" && !cascadantes.has(t));
verifier("CHAQUE table portant « tenant_id » casse en cascade",
  orphelines.length === 0,
  `sans cascade : ${orphelines.join(", ")} — ces données SURVIVRAIENT à la suppression`);

/* ===================================================================== */
/* 2. CE QUI PART, ET CE QUI RESTE                                        */
/* ===================================================================== */

const partant = await locataire("qui-part");
const restant = await locataire("qui-reste");

/* LE MÊME LIVRE CHEZ LES DEUX. C'est le cas qui casse une suppression
   naïve : « ouvrages » est un catalogue commun, et « possessions » y pointe
   en « on delete restrict ». Une cascade qui emporterait l'ouvrage
   échouerait ici — ou pire, viderait l'étagère du voisin. */
const partage = await semer({ tenant: partant, id: "p1", isbn: "9782070360024",
                              titre: "Le Mythe de Sisyphe", auteur: "Camus" });
await semer({ tenant: restant, id: "r1", isbn: "9782070360024",
              titre: "Le Mythe de Sisyphe", auteur: "Camus" });
await semer({ tenant: partant, id: "p2", titre: "Un livre à lui seul" });

await q(`insert into comptes (tenant_id, courriel) values ($1, $2)`,
  [partant, "part@exemple.fr"]);
await q(`insert into comptes (tenant_id, courriel) values ($1, $2)`,
  [restant, "reste@exemple.fr"]);
await q(`insert into appels_ia (tenant_id, route, modele, issue)
         values ($1, '/api/x', 'm', 'ok')`, [partant]);

const avant = {
  partant: Number((await q(
    "select count(*) as n from possessions where tenant_id = $1", [partant]))[0].n),
  restant: Number((await q(
    "select count(*) as n from possessions where tenant_id = $1", [restant]))[0].n),
};
verifier("le décor est planté", avant.partant === 2 && avant.restant === 1,
  JSON.stringify(avant));

/* ===================================================================== */
/* 3. ON NE SUPPRIME QUE SOI                                              */
/* ===================================================================== */

/* Il n'y a pas de paramètre à falsifier : la seule attaque possible est de
   se présenter comme un autre, ce que la session signée interdit. On vérifie
   ici la conséquence — poser SON locataire n'efface QUE le sien. */
{
  let leve = false;
  try { await dans(null, "select * from public.supprimer_locataire()"); }
  catch (e) { leve = /Aucun locataire/.test(e.message); }
  verifier("sans locataire posé, la suppression LÈVE au lieu de rendre « 0 »",
    leve, "elle a rendu un succès silencieux");
}

{
  /* Le voisin essaie d'effacer la ligne de « partant » en la nommant
     explicitement. La politique borne sur « id = app.tenant_id » : la clause
     « where » de l'attaquant ne peut pas élargir ce que la politique permet. */
  await dans(restant, "delete from public.tenants where id = $1", [partant]);
  const [cible] = await q("select id from tenants where id = $1", [partant]);
  verifier("un locataire ne peut pas effacer la bibliothèque d'un autre",
    cible !== undefined, "la ligne visée a disparu — la politique ne borne pas");
}

/* ===================================================================== */
/* 4. LA SUPPRESSION ELLE-MÊME                                            */
/* ===================================================================== */

let tally = null;
await enChaine("la suppression s'exécute sans lever", async () => {
  [tally] = await dans(partant, "select * from public.supprimer_locataire()");
});

verifier("elle rend le décompte de ce qu'elle a détruit",
  Number(tally?.ouvrages_effaces) === 2 && Number(tally?.comptes_effaces) === 1,
  JSON.stringify(tally));

/* CHAQUE TABLE, UNE PAR UNE — et la liste vient du catalogue, pas de moi.
   C'est la vérification qui distingue « la ligne du locataire est partie »
   de « tout ce qui lui appartenait est parti ». */
const restes = [];
for (const t of portantes) {
  const col = t === "tenants" ? "id" : "tenant_id";
  const [{ n }] = await q(`select count(*) as n from public.${t} where ${col} = $1`,
    [partant]);
  if (Number(n) > 0) restes.push(`${t}=${n}`);
}
verifier("après suppression, AUCUNE table ne garde une ligne du locataire",
  restes.length === 0, `restes : ${restes.join(", ")}`);

/* UNE SESSION QUI SURVIT À SA BIBLIOTHÈQUE. Le cas arrive pour de vrai :
   double clic sur le bouton, ou onglet resté ouvert. Le cookie est valide et
   signé, mais le locataire n'existe plus. La politique n'efface alors aucune
   ligne — et sans le contrôle de « row_count », la fonction rendrait « 0
   effacé » comme un succès. La personne verrait « c'est fait » deux fois.

   Ce contrôle manquait : une mutation retirant ce garde-fou a survécu. */
{
  let leve = false;
  try { await dans(partant, "select * from public.supprimer_locataire()"); }
  catch (e) { leve = /Suppression refusée/.test(e.message); }
  verifier("une bibliothèque déjà effacée ne rend pas un second faux succès",
    leve, "succès rendu pour une suppression qui n'a rien effacé");
}

/* ===================================================================== */
/* 5. LE VOISIN N'A RIEN PERDU                                            */
/* ===================================================================== */

const apres = Number((await q(
  "select count(*) as n from possessions where tenant_id = $1", [restant]))[0].n);
verifier("le locataire voisin garde exactement ce qu'il avait",
  apres === avant.restant, `${avant.restant} → ${apres}`);

const [survivant] = await q("select id, titre from ouvrages where id = $1", [partage]);
verifier("… et la fiche du livre PARTAGÉ survit",
  survivant !== undefined,
  "l'ouvrage commun a été emporté — l'étagère du voisin pointe dans le vide");

const [compteVoisin] = await q(
  "select courriel from comptes where tenant_id = $1", [restant]);
verifier("… et son compte aussi",
  compteVoisin?.courriel === "reste@exemple.fr", JSON.stringify(compteVoisin));

/* ===================================================================== */

await banc.fermer();
for (const n of ok) console.log("  ok   " + n);
for (const n of ko) console.log("  KO   " + n);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length} erreur(s).`);
process.exit(ko.length ? 1 : 0);
