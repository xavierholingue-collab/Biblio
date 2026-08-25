/* ===========================================================================
   LA PORTE DE SORTIE — EFFACER SA BIBLIOTHÈQUE, VRAIMENT

   ---------------------------------------------------------------------------
   POURQUOI CE FICHIER EXISTE

   L'article 17 du RGPD donne un droit à l'effacement. Jusqu'au 24/08/2026 il
   n'existait AUCUNE route de suppression : la seule sortie était de me
   l'écrire, et de me faire confiance. Ce n'est pas un droit, c'est une
   faveur.

   ---------------------------------------------------------------------------
   PAS DE PARAMÈTRE. C'EST LA DÉCISION CENTRALE.

   « supprimer_locataire(id) » serait l'écriture naturelle, et ce serait une
   faute : il suffirait alors d'une variable mal calculée, quelque part dans
   server.js, pour effacer la bibliothèque de quelqu'un d'autre. Et rien ne
   la rendrait au propriétaire.

   Le locataire est donc LU dans « app.tenant_id », que la couche HTTP pose
   depuis la session signée. La fonction ne peut effacer QUE l'appelant,
   parce qu'elle n'a aucun moyen de désigner un autre.

   ---------------------------------------------------------------------------
   UNE POLITIQUE, PAS UN « security definer »

   La tentation était d'écrire « security definer » pour contourner les
   politiques. Deux raisons de ne pas le faire.

   D'abord elle ne marcherait pas : « force row level security » soumet même
   le propriétaire des tables, et le compte applicatif est ce propriétaire.
   C'est écrit dans 02-multi-locataire.sql, et cela m'a déjà coûté une
   matinée.

   Ensuite et surtout, une politique de suppression EST la protection, au
   lieu d'être contournée par elle. Même un « delete from tenants » sans
   clause « where » — écrit par erreur, ou par une injection — n'effacerait
   que la ligne de l'appelant. La borne est dans la base, pas dans la
   prudence de celui qui écrit la requête.

   Sans locataire posé, « id = NULL » n'est jamais vrai : rien n'est effacé.
   La fermeture est le comportement par défaut, sans avoir à y penser.

   ---------------------------------------------------------------------------
   AUCUNE LISTE DE TABLES À EFFACER

   Écrire « delete from possessions; delete from appels_ia; … » serait la
   septième liste écrite à la main de ce dépôt, et elle se périmerait à la
   première table ajoutée — en silence, en laissant derrière elle exactement
   les données qu'on promettait d'effacer.

   Les clés étrangères le savent déjà : chaque table portant « tenant_id »
   pointe vers « tenants » en « on delete cascade ». Effacer la ligne du
   locataire suffit. Et « test-suppression.mjs » interroge le CATALOGUE de
   PostgreSQL — pas ce fichier — pour vérifier qu'aucune table n'échappe à la
   cascade. Une table future sans cascade fera échouer le contrôle.

   Les cascades sont exécutées par le système et ne sont PAS soumises aux
   politiques : c'est ce qui permet à une seule suppression de tout emporter.
   Le contrôle le vérifie table par table plutôt que de me croire sur parole.

   ---------------------------------------------------------------------------
   CE QUI SURVIT, ET POURQUOI C'EST JUSTE

   « ouvrages » n'a pas de « tenant_id » : c'est un catalogue COMMUN, et
   « possessions » y pointe en « on delete restrict ». Les fiches — titre,
   auteur, éditeur, ISBN — subsistent donc après la suppression.

   Elles le doivent : elles appartiennent aussi aux autres lecteurs qui
   possèdent le même livre, et les effacer viderait leurs étagères. Elles ne
   désignent personne, et proviennent de catalogues publics. Ce qui vous
   rattachait à elles — la possession, le statut, la note, le résumé — part
   avec le reste.

   La politique de confidentialité le dit en toutes lettres. Une promesse
   d'effacement qui tait une exception est une promesse fausse.
   =========================================================================== */

/* --------------------------------------------------------------------------
   LE DROIT D'EFFACER SA PROPRE LIGNE, ET ELLE SEULE
   -------------------------------------------------------------------------- */
drop policy if exists tenants_suppression on public.tenants;
create policy tenants_suppression on public.tenants for delete
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* --------------------------------------------------------------------------
   COMPTER CE QU'ON DÉTRUIT, PUIS LE DÉTRUIRE

   PAS « security definer » : la fonction reste soumise à la politique
   ci-dessus, qui est sa vraie protection. Même raisonnement que
   « appels_ia_du_mois » et « depense_ia_du_mois ».

   Elle rend le décompte pour que l'écran puisse dire « 349 ouvrages
   effacés » plutôt qu'un « c'est fait » que rien ne confirme — et pour
   qu'un contrôle puisse vérifier qu'elle a bien agi.
   -------------------------------------------------------------------------- */
create or replace function public.supprimer_locataire()
returns table (ouvrages_effaces bigint, comptes_effaces bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  n_o bigint;
  n_c bigint;
  efface integer;
begin
  /* ÉCHOUER FERMÉ. Sans locataire posé, la politique n'effacerait rien et la
     fonction rendrait « 0 effacé » — un succès apparent pour une suppression
     qui n'a pas eu lieu. La personne croirait ses données parties. */
  if moi is null then
    raise exception 'Aucun locataire posé : impossible de supprimer.'
      using errcode = '42501';
  end if;

  select count(*) into n_o from public.possessions where tenant_id = moi;
  select count(*) into n_c from public.comptes      where tenant_id = moi;

  delete from public.tenants where id = moi;
  get diagnostics efface = row_count;

  /* Si la politique a refusé, « efface » vaut 0. Le dire est le seul moyen
     de distinguer « rien à effacer » de « effacement refusé ». */
  if efface = 0 then
    raise exception 'Suppression refusée : la bibliothèque n''a pas été effacée.'
      using errcode = '42501';
  end if;

  return query select n_o, n_c;
end $$;

revoke all on function public.supprimer_locataire() from public;
