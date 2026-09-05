/* =========================================================================
   PARTIR AVEC SES LIVRES

   La demande, telle que Xavier l'a posée le 05/09/2026 : « si une personne
   fait partie d'une équipe et veut se retirer, que pourrions-nous faire pour
   qu'elle puisse exporter ses livres pour les réimporter dans une nouvelle
   équipe où elle serait seule ». Et la réponse convenue au message suivant :
   « oui. on peut emporter un ouvrage que l'on a pas apporté ».

   ---------------------------------------------------------------------------
   ON EMPORTE UNE COPIE, ON NE REPREND PAS

   La distinction est tout le sujet. Reprendre — retirer du fonds commun ce
   qu'on y avait mis — ferait de chaque départ une amputation pour ceux qui
   restent, et obligerait à savoir QUI a apporté QUOI, une information que le
   schéma ne porte pas et qu'il aurait fallu inventer.

   Copier ne retire rien à personne. Et le partage a déjà tranché la question
   du coût : « resumes_ouvrages » n'a pas de « tenant_id » — le travail du
   modèle est mis en commun depuis le premier jour. Un ouvrage emporté arrive
   donc avec son résumé, sans un appel de plus.

   ---------------------------------------------------------------------------
   TROIS CHOSES NE SUIVENT PAS, ET CHACUNE POUR SA RAISON

   1. LA VISIBILITÉ REPART À « heritee ». Les exceptions par ouvrage ont été
      posées par l'équipe, pas par vous : un livre explicitement « publique »
      chez le cabinet deviendrait publiable sous votre nom, dans une
      bibliothèque dont vous seul choisissez la visibilité. « heritee » suit
      vos propres rayons, et un rayon sans décision explicite est privé.
      Sans décision, on ne publie pas — c'est la règle depuis 02.

   2. LES LECTURES DES AUTRES. Vous emportez LA VÔTRE, celle que vous avez
      enregistrée. Celle de vos collègues ne vous appartient pas, et la
      politique de « lectures » ne vous la montre pas de toute façon.

   3. L'HISTORIQUE D'APPELS AU MODÈLE. Il mesure une dépense faite par la
      bibliothèque d'origine ; la recopier fausserait deux quotas d'un coup.
   ========================================================================= */

/* --------------------------------------------------------------------------
   CRÉER UNE BIBLIOTHÈQUE POUR UN COMPTE QUI EXISTE DÉJÀ

   « creer_locataire » crée un compte ET une bibliothèque : c'est la porte de
   l'inscription. Ici le compte existe — on n'inscrit personne, on ouvre une
   étagère de plus à quelqu'un qui est déjà là.

   ELLE N'EST PAS SOUMISE À « INSCRIPTION_OUVERTE », et c'est délibéré. Ce
   drapeau décide si l'on accepte de NOUVEAUX venus ; il n'a pas à décider si
   quelqu'un qui est déjà client peut quitter une équipe avec ses livres. Une
   porte de sortie qui dépend de l'état du guichet d'entrée n'est pas une
   porte de sortie.

   ELLE RESTE SOUMISE AU PLAFOND JOURNALIER, sans qu'il faille l'écrire : ce
   plafond est un déclencheur « before insert on tenants » posé par la 14. Il
   compte donc TOUTE création de bibliothèque, quel que soit le chemin — y
   compris celui-ci. C'est ce qui borne l'abus évident, créer des étagères en
   série pour cumuler des quotas gratuits.
   -------------------------------------------------------------------------- */
create or replace function public.creer_bibliotheque(
  le_nom text, le_quota integer default 10)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  qui    uuid := nullif(current_setting('app.compte_id', true), '')::uuid;
  neuve  uuid;
  ident  text;
  essais integer := 0;
begin
  /* ÉCHOUER FERMÉ. Sans identité posée, on ne crée rien : une bibliothèque
     sans propriétaire coûterait sans que personne ait le droit d'y toucher. */
  if qui is null then
    raise exception 'Cette session n''identifie aucun compte : impossible de '
                    'créer une bibliothèque.'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.comptes where id = qui) then
    raise exception 'Compte inconnu.' using errcode = '42501';
  end if;

  perform set_config('app.inscription', 'en cours', true);
  perform set_config('app.membres',     'en cours', true);

  loop
    /* Même expression que « creer_locataire », et pour la même raison :
       « gen_random_bytes » appartient à pgcrypto, absent partout ici. */
    ident := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    begin
      insert into public.tenants (identifiant, nom, visibilite, quota_ia_mois)
        values (ident, coalesce(nullif(btrim(le_nom), ''), ident), 'privee', le_quota)
        returning id into neuve;
      exit;
    exception when unique_violation then
      essais := essais + 1;
      if essais > 5 then raise; end if;
    end;
  end loop;

  insert into public.membres (compte_id, tenant_id, role, vu_le)
    values (qui, neuve, 'proprietaire', now());

  perform set_config('app.inscription', '', true);
  perform set_config('app.membres',     '', true);

  return neuve;
end $$;

revoke all on function public.creer_bibliotheque(text, integer) from public;

/* --------------------------------------------------------------------------
   LA PORTE DE LA COPIE — et pourquoi il faut ouvrir la destination

   LE CONTEXTE NE DÉSIGNE QU'UNE BIBLIOTHÈQUE À LA FOIS. « app.tenant_id »
   vaut la source ; toutes les politiques de « possessions » et de
   « lectures » y sont bornées. La destination est donc INVISIBLE, et une
   copie écrite naïvement échouerait de la pire façon :

     — « le livre y est-il déjà ? » rendrait toujours « non », puisqu'on ne
       voit rien de la destination. On insérerait des doublons, ou l'on
       heurterait « unique (tenant_id, ouvrage_id) » ;
     — « cet identifiant est-il libre ? » rendrait toujours « oui », et la
       clef primaire sauterait.

   C'est la cinquième fois en un jour qu'une vue restreinte serait prise pour
   la réalité (règle 7 de METHODE.md). On la nomme donc au lieu de la
   subir : « app.copie » porte L'IDENTIFIANT DE LA DESTINATION — pas un
   drapeau « en cours ». La différence est la même que pour « app.connexion » :
   un drapeau ouvrirait tout, un identifiant n'ouvre qu'un endroit, et
   exactement celui que la fonction a déjà vérifié être le vôtre.
   -------------------------------------------------------------------------- */
drop policy if exists possessions_copie on public.possessions;
create policy possessions_copie on public.possessions for select
  using (tenant_id = nullif(current_setting('app.copie', true), '')::uuid);

drop policy if exists possessions_copie_ajout on public.possessions;
create policy possessions_copie_ajout on public.possessions for insert
  with check (tenant_id = nullif(current_setting('app.copie', true), '')::uuid);

drop policy if exists lectures_copie on public.lectures;
create policy lectures_copie on public.lectures for insert
  with check (tenant_id = nullif(current_setting('app.copie', true), '')::uuid
              and compte_id = public.compte_effectif());

/* --------------------------------------------------------------------------
   EMPORTER

   Rend deux nombres, et les deux comptent : ce qui a été copié, et ce qui ne
   l'a pas été parce que la destination le possédait déjà. Un seul chiffre
   laisserait croire à une perte là où il n'y a qu'un doublon évité.
   -------------------------------------------------------------------------- */
create or replace function public.copier_dans(la_cible uuid)
returns table (copies bigint, ignores bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source  uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  qui     uuid := nullif(current_setting('app.compte_id', true), '')::uuid;
  n_copie bigint;
  n_total bigint;
begin
  if source is null or qui is null then
    raise exception 'Contexte incomplet : impossible de copier.'
      using errcode = '42501';
  end if;
  if la_cible is null or la_cible = source then
    raise exception 'La destination doit être une AUTRE de vos bibliothèques.'
      using errcode = '22004';
  end if;

  /* MEMBRE DES DEUX CÔTÉS, ET C'EST LA SEULE BORNE.

     « membres_lecture » montre vos propres appartenances où qu'elles soient
     — c'est ce qui permet de poser la question sur la destination alors
     qu'on est dans la source. Une valeur inventée par le navigateur ne peut
     donc pas passer : elle ne figurerait dans aucune de vos lignes.

     Le MÊME message pour « pas la vôtre » et « n'existe pas » : les
     distinguer ferait de cette porte un annuaire des bibliothèques. */
  if not exists (select 1 from public.membres m
                  where m.compte_id = qui and m.tenant_id = la_cible) then
    raise exception 'Cette bibliothèque n''est pas la vôtre.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.membres m
                  where m.compte_id = qui and m.tenant_id = source) then
    raise exception 'Vous n''êtes pas membre de la bibliothèque à copier.'
      using errcode = '42501';
  end if;

  select count(*) into n_total from public.possessions p where p.tenant_id = source;

  /* La destination s'ouvre ICI, et pas avant les vérifications. */
  perform set_config('app.copie', la_cible::text, true);

  with a_copier as (
    select p.id, p.ouvrage_id, p.categorie, p.sous_categorie, p.sphere,
           /* L'IDENTIFIANT EST GARDÉ S'IL EST LIBRE, dérivé sinon. On ne
              perd donc pas les repères d'un import précédent, et deux
              ouvrages différents ne se heurtent pas. Le suffixe vient de
              l'ouvrage : deux exécutions donnent le même, ce qui rend la
              copie rejouable. */
           case when exists (select 1 from public.possessions q
                              where q.tenant_id = la_cible and q.id = p.id)
                then p.id || '-' || left(md5(p.ouvrage_id::text), 6)
                else p.id end as id_cible
      from public.possessions p
     where p.tenant_id = source
       and not exists (select 1 from public.possessions q
                        where q.tenant_id = la_cible
                          and q.ouvrage_id = p.ouvrage_id)
  ),
  posees as (
    insert into public.possessions (tenant_id, id, ouvrage_id, categorie,
                                    sous_categorie, sphere, visibilite)
      select la_cible, c.id_cible, c.ouvrage_id, c.categorie,
             c.sous_categorie, c.sphere,
             /* « heritee » — voir la note en tête de fichier : les
                exceptions de visibilité étaient celles de l'équipe. */
             'heritee'
        from a_copier c
    returning id, ouvrage_id
  )
  select count(*) into n_copie from posees;

  /* VOS LECTURES SUIVENT VOS LIVRES. Sans cela, on emporterait une étagère
     sans mémoire : tout « à lire », y compris ce qu'on a lu la semaine
     passée. La jointure passe par l'ouvrage, parce que l'identifiant a pu
     être dérivé au passage. */
  insert into public.lectures (tenant_id, possession, compte_id, statut, note, maj_le)
    select la_cible, q.id, qui, l.statut, l.note, l.maj_le
      from public.lectures l
      join public.possessions p on p.tenant_id = source and p.id = l.possession
      join public.possessions q on q.tenant_id = la_cible
                               and q.ouvrage_id = p.ouvrage_id
     where l.tenant_id = source and l.compte_id = qui
  on conflict (tenant_id, possession, compte_id) do nothing;

  perform set_config('app.copie', '', true);

  return query select n_copie, n_total - n_copie;
end $$;

revoke all on function public.copier_dans(uuid) from public;
