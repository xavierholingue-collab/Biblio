/* =========================================================================
   LA LECTURE APPARTIENT À CELUI QUI LIT

   CE QUE LA 15 A CASSÉ SANS LE DIRE. Elle a permis à plusieurs personnes de
   partager une bibliothèque. Mais « statut » et « note » vivaient sur la
   POSSESSION, c'est-à-dire sur la bibliothèque : dans un cabinet, le jour où
   l'un marque un ouvrage « Lu », il le devient pour tout le monde. Et la
   note — qui est un jugement sur cinq, pas une annotation — devient celle du
   dernier qui a cliqué.

   Rien n'aurait échoué. Les données seraient simplement fausses, et fausses
   d'une façon qu'on ne remarque qu'en se demandant « qui a lu ça ? ». C'est
   pourquoi ce lot ne peut pas être livré après le 15 : il doit partir AVEC.

   ---------------------------------------------------------------------------
   UNE SEULE SOURCE DE VÉRITÉ, ET LES COLONNES D'ORIGINE S'EN VONT

   La tentation était de garder « possessions.statut » comme « valeur par
   défaut de la bibliothèque » et de ne mettre dans « lectures » que les
   écarts. Elle a été écartée : deux endroits où vit le même fait finissent
   toujours par diverger, et l'on ne s'en aperçoit que lorsque les deux se
   contredisent devant quelqu'un. Ce dépôt a déjà payé cela avec les deux
   plafonds — l'un en appels, l'autre en euros, chacun juste et leur
   conjonction fausse.

   Les colonnes sont donc SUPPRIMÉES, et leur contenu déménage.

   ---------------------------------------------------------------------------
   CE QUE VOIT QUELQU'UN QUI N'EST PAS IDENTIFIÉ

   Un visiteur sur une bibliothèque publique n'a plus de statut de lecture à
   voir. C'est un CHANGEMENT DE PRODUIT, et il va dans le bon sens : jusqu'ici
   la page publique annonçait à n'importe qui combien d'ouvrages le
   propriétaire avait lus, et sa note moyenne. Une progression de lecture est
   une donnée personnelle ; l'étagère est ce qu'on a choisi de montrer.

   La conséquence est traitée côté API : les chiffres de lecture ne sont pas
   rendus à zéro — ils ne sont pas rendus du tout. « 0 lu » serait une
   affirmation fausse ; l'absence est une absence.
   ========================================================================= */

/* --------------------------------------------------------------------------
   LA TABLE

   DEUX CLEFS ÉTRANGÈRES, ET LA SECONDE N'EST PAS REDONDANTE.

   « (tenant_id, possession) » vers « possessions » est celle qui porte le
   sens : une lecture se rattache à un ouvrage possédé.

   « tenant_id » vers « tenants » ne sert qu'à la suppression — et c'est
   exactement ce que test-suppression.mjs interroge : il demande au catalogue
   de PostgreSQL si CHAQUE table portant « tenant_id » casse en cascade vers
   « tenants ». Sans cette seconde clef, la cascade passerait bien par
   « possessions », mais la promesse « tout ce qui vous appartient part »
   reposerait sur un chemin qu'aucun contrôle ne vérifie.
   -------------------------------------------------------------------------- */
create table if not exists public.lectures (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  possession text not null,
  compte_id  uuid not null references public.comptes(id) on delete cascade,

  statut     text not null default 'A lire'
             check (statut in ('Lu', 'En cours', 'A lire')),
  /* Même forme que la colonne qu'elle remplace : numeric(2,1) de 0 à 5. La
     changer ici obligerait à convertir la reprise, et une conversion de type
     dans une migration de reprise est une occasion de perdre des décimales. */
  note       numeric(2,1) check (note >= 0 and note <= 5),
  maj_le     timestamptz not null default now(),

  primary key (tenant_id, possession, compte_id),
  foreign key (tenant_id, possession)
    references public.possessions(tenant_id, id) on delete cascade
);

create index if not exists lectures_compte on public.lectures (compte_id);

/* --------------------------------------------------------------------------
   QUI LIT, QUAND LA SESSION NE LE DIT PAS

   « app.compte_id » est posé par les connexions qui nomment quelqu'un : lien
   magique, Google. La session par MOT DE PASSE, elle, ouvre la bibliothèque
   par défaut sans nommer personne — et c'est le chemin de l'installation
   personnelle, celle de 348 ouvrages.

   Sans cette fonction, cette session verrait toute sa bibliothèque « À lire »
   et ne pourrait plus rien marquer. Une régression sur l'usage d'origine, au
   profit d'une fonctionnalité que cet usage n'emploie pas.

   ELLE NE CHOISIT JAMAIS PARMI PLUSIEURS. C'est le point, et il faut être
   précis : refuser de « prendre le premier propriétaire » était la bonne
   décision pour la suppression, parce qu'il y avait un choix à faire. Ici il
   n'y en a pas — quand une bibliothèque n'a QU'UN membre, la bibliothèque et
   la personne sont le même sujet, et il n'y a rien à départager.

   Dès qu'ils sont deux, la fonction rend NULL. Fermé par défaut : la session
   anonyme ne devient jamais quelqu'un.
   -------------------------------------------------------------------------- */
create or replace function public.compte_effectif()
returns uuid
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(current_setting('app.compte_id', true), '')::uuid,

    /* LA RÈGLE EST ÉCRITE TELLE QU'ELLE SE LIT : s'il y a exactement un
       membre, c'est lui.

       Deux rédactions plus courtes ont été essayées et écartées. « limit 1 »
       sans « order by » désigne arbitrairement quelqu'un parmi plusieurs —
       c'est la faute qui a coûté deux défauts à ce dépôt, dont un trouvé en
       production. Et « min(compte_id) … having count(*) = 1 » serait juste,
       mais se lit comme « prends le plus petit » ; il se trouve en outre que
       PostgreSQL n'agrège pas les uuid, ce qui a tranché.

       Deux sous-requêtes plutôt qu'une : le coût est un parcours d'index de
       plus, la contrepartie est qu'on ne peut pas se tromper en la relisant. */
    case when (select count(*) from public.membres m
                where m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
              ) = 1
         then (select m.compte_id from public.membres m
                where m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    end
  );
$$;

/* --------------------------------------------------------------------------
   CLOISONNEMENT — votre progression n'est vue que par vous

   Y COMPRIS DE VOS COÉQUIPIERS, et c'est un choix qu'on assume. « Qui de
   l'équipe a lu ce livre ? » est une question utile, et on pourra vouloir y
   répondre un jour. Mais l'ouvrir par défaut publierait à des collègues ce
   que personne n'a accepté de publier — et refermer plus tard est bien plus
   difficile qu'ouvrir plus tard.

   « compte_effectif() » et non « app.compte_id » : sans quoi l'installation
   personnelle par mot de passe ne pourrait ni lire ni écrire ses propres
   lectures.

   NULL ferme : une comparaison avec NULL n'est jamais vraie.
   -------------------------------------------------------------------------- */
alter table public.lectures enable row level security;
alter table public.lectures force  row level security;

drop policy if exists lectures_lecture on public.lectures;
create policy lectures_lecture on public.lectures for select
  using (compte_id = public.compte_effectif());

drop policy if exists lectures_ecriture on public.lectures;
create policy lectures_ecriture on public.lectures for insert
  with check (compte_id = public.compte_effectif()
              and tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists lectures_maj on public.lectures;
create policy lectures_maj on public.lectures for update
  using      (compte_id = public.compte_effectif())
  with check (compte_id = public.compte_effectif());

drop policy if exists lectures_retrait on public.lectures;
create policy lectures_retrait on public.lectures for delete
  using (compte_id = public.compte_effectif());

/* --------------------------------------------------------------------------
   LA REPRISE — chaque membre garde ce qu'il voyait

   ON RECOPIE VERS TOUS LES MEMBRES, PAS VERS « LE PROPRIÉTAIRE ».

   Aujourd'hui le statut est commun : tous les membres d'une bibliothèque
   partagée voient la même valeur. Préserver ce que chacun voit, c'est donc
   la lui donner — à chacun. C'est aussi ce qui évite d'avoir à désigner
   quelqu'un, c'est-à-dire à écrire le « limit 1 » sans « order by » qui a
   déjà coûté deux défauts à ce dépôt.

   Au moment où cette migration s'exécute pour la première fois, presque
   toutes les bibliothèques n'ont qu'un membre : la règle et le cas simple
   coïncident. Elle reste juste si ce n'est pas le cas.

   LA LEVÉE PORTE SUR LES TROIS TABLES, ET C'EST LA MOITIÉ QUE J'AVAIS
   OUBLIÉE — 05/09/2026.

   « force row level security » soumet même le propriétaire des tables. J'ai
   d'abord levé les politiques sur « lectures » seule — la table où l'on
   ÉCRIT — en oubliant « possessions » et « membres », les tables qu'on LIT.
   La migration s'exécutait alors comme un visiteur anonyme : « app.tenant_id »
   n'est pas posé, les politiques de lecture ne montraient rien, et
   l'insertion reprenait ZÉRO ligne. Sans erreur, sans avertissement.

   En production, cela signifiait 348 ouvrages repassés « à lire », leurs
   notes perdues, et personne pour le voir avant de regarder.

   AUCUNE DES VINGT-QUATRE SUITES NE L'A ATTRAPÉ : elles montent une base
   vide, où une reprise qui ne reprend rien est indiscernable d'une reprise
   réussie. C'est « test-reprise-lectures.mjs » qui l'a dit, écrit exactement
   pour cela — la base à l'état d'avant, des données semées, la suite
   appliquée.

   C'est le même piège que le matin même — « security definer » qui ne
   franchit pas « force », le déclencheur qui comptait ce qu'on lui montrait,
   « on conflict » qui ne voyait pas le conflit. Quatrième fois en un jour :
   voir la règle 7 de METHODE.md.

   Le motif correct est celui de 03 : lever sur TOUT CE QUE LA REQUÊTE
   TOUCHE, pas seulement sur ce qu'elle écrit.
   -------------------------------------------------------------------------- */
do $$
declare t text;
begin
  foreach t in array array['lectures', 'possessions', 'membres'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I no force row level security', t);
    end if;
  end loop;
end $$;

do $$
declare
  a_reprendre bigint;
  reprises    bigint;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'possessions'
                and column_name = 'statut') then

    /* ===================================================================
       ON VÉRIFIE LA PRÉCONDITION, PAS LE RÉSULTAT — et la distinction est
       tout le sujet.

       La première rédaction comptait « combien y a-t-il à reprendre »
       AVANT, puis comparait avec ce qui avait été repris. Élégant, et
       inutile : ce décompte lit « possessions » et « membres » à travers les
       MÊMES politiques que l'insertion. Politiques oubliées, il rendait zéro
       lui aussi — zéro attendu, zéro repris, tout allait bien, et les
       colonnes étaient supprimées.

       C'est mot pour mot ce que 03-catalogue.sql écrit depuis le 15/08 :
       « un contrôle qui partage l'aveuglement de ce qu'il contrôle ne
       contrôle rien ». Je l'ai réécrit sans le reconnaître.

       « pg_class », lui, n'est pas soumis à la RLS. On demande donc
       directement si la levée a eu lieu — c'est un fait sur le schéma, que
       rien ne peut masquer. Le décompte ci-dessous reste utile pour les
       autres façons de se tromper (jointure fausse, table vide), mais ce
       n'est plus lui qui garde la porte.
       =================================================================== */
    if exists (select 1 from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public'
                 and c.relname in ('lectures', 'possessions', 'membres')
                 and c.relforcerowsecurity) then
      raise exception
        'Les politiques n''ont pas été levées sur les trois tables : la '
        'reprise lirait à travers le cloisonnement et ne reprendrait rien.'
        using errcode = '55000';
    end if;

    /* Combien y avait-il à reprendre — maintenant que l'on SAIT voir. */
    select count(*) into a_reprendre
      from public.possessions p
      join public.membres m on m.tenant_id = p.tenant_id;

    insert into public.lectures (tenant_id, possession, compte_id, statut, note, maj_le)
      select p.tenant_id, p.id, m.compte_id, p.statut, p.note, p.maj_le
        from public.possessions p
        join public.membres m on m.tenant_id = p.tenant_id
    on conflict (tenant_id, possession, compte_id) do nothing;

    get diagnostics reprises = row_count;

    /* ===================================================================
       LA MIGRATION SE CONTRÔLE ELLE-MÊME, ET C'EST LE PIRE CAS DU PROJET

       Si la reprise ne reprend rien — politiques oubliées, jointure fausse,
       table vide par accident — et que la suppression des colonnes s'exécute
       quand même, LES DONNÉES SONT PERDUES POUR DE BON. Pas dégradées : le
       statut et la note de chaque ouvrage, effacés, sans une erreur.

       C'est arrivé pendant l'écriture, le 05/09/2026 : les politiques
       n'étaient levées que sur la table de destination, la lecture des deux
       tables sources ne rendait rien, et zéro ligne a été reprise. Vingt-
       quatre suites de contrôle sont restées vertes.

       Un contrôle en dehors de la migration ne suffit pas : il peut être
       retiré, ou ne pas tourner. La migration porte donc son propre garde-fou
       — et « raise exception » annule la transaction, donc la suppression des
       colonnes avec elle. Le déploiement échoue bruyamment, la base reste
       intacte, et l'on va voir pourquoi.
       =================================================================== */
    if a_reprendre > 0 and reprises = 0 then
      raise exception
        'Reprise des lectures VIDE : % attendues, 0 reprise. Les colonnes ne '
        'seront pas supprimées.', a_reprendre
        using errcode = '55000';
    end if;

    raise notice 'lectures reprises : % sur % attendues', reprises, a_reprendre;

    /* LA VUE S'EFFACE D'ABORD, sans quoi PostgreSQL refuse : « cannot drop
       column statut … because other objects depend on it ». Elle est
       redéfinie plus bas, dans la même migration — et le DDL étant
       transactionnel ici, aucune session ne la voit disparaître. */
    execute 'drop view if exists public.livres';

    alter table public.possessions drop column statut;
    alter table public.possessions drop column note;
  end if;
end $$;

/* Et l'on remet, sur les trois. Une table laissée « no force » resterait
   ouverte à son propriétaire — c'est-à-dire au compte applicatif,
   c'est-à-dire à tout le monde. */
do $$
declare t text;
begin
  foreach t in array array['lectures', 'possessions', 'membres'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;

/* --------------------------------------------------------------------------
   LA VUE — elle recolle maintenant TROIS choses

   Le catalogue partagé, la possession, et LA LECTURE DE CELUI QUI REGARDE.

   « left join » et non « join » : un ouvrage qu'on n'a jamais ouvert n'a pas
   de ligne dans « lectures », et doit quand même figurer sur l'étagère.
   « coalesce(l.statut, 'A lire') » rend alors le point de départ.

   LA JOINTURE EST BORNÉE PAR « compte_effectif() » ET C'EST SUFFISANT. On
   pourrait croire qu'il faut en plus s'appuyer sur la politique de
   « lectures » ; c'est vrai, elle s'applique aussi — « security_invoker »
   fait porter les politiques sur celui qui interroge. Les deux disent la
   même chose, et c'est voulu : la vue reste juste même si l'on venait à
   relâcher la politique, et la politique reste juste même si l'on venait à
   modifier la vue.

   POUR QUI N'EST PERSONNE — visiteur, ou session par mot de passe sur une
   bibliothèque à plusieurs — « compte_effectif() » vaut NULL, la jointure ne
   rend rien, et l'on lit « A lire » partout avec une note nulle. L'API ne
   présente PAS ces valeurs comme des faits : voir « statistiques » dans
   server.js, qui rend « null » plutôt que « 0 lu ».
   -------------------------------------------------------------------------- */
begin;
drop view if exists public.livres;
create view public.livres
with (security_invoker = true) as
select p.tenant_id,
       p.id,
       o.id as ouvrage_id,
       o.isbn, o.titre, o.auteur, o.editeur, o.annee, o.pages,
       o.cover_url, o.cover_statut,
       coalesce(l.statut, 'A lire') as statut,
       l.note,
       p.categorie, p.sous_categorie, p.sphere, p.visibilite,
       p.ajoute_le, p.maj_le,
       o.avec_sources,
       o.type, o.doi, o.revue, o.volume, o.numero,
       o.citations, o.citations_le, o.resume_editeur,
       o.support, o.pagination
  from public.possessions p
  join public.ouvrages o on o.id = p.ouvrage_id
  left join public.lectures l
         on l.tenant_id = p.tenant_id
        and l.possession = p.id
        and l.compte_id = public.compte_effectif()
 where case
         when nullif(current_setting('app.tenant_id', true), '') is null
           then public.possession_publique(p)
         else p.tenant_id = current_setting('app.tenant_id', true)::uuid
       end;
commit;

comment on view public.livres is
  'Assemblage lecture seule : catalogue partagé, possessions du locataire, et
   lecture de la personne connectée. Les écritures passent par possessions,
   ouvrages, resumes_ouvrages et lectures.';

/* --------------------------------------------------------------------------
   LA PORTE NOMMÉE — enregistrer sa lecture

   ELLE EXISTE POUR QUE L'API N'AIT PAS À CONNAÎTRE « compte_effectif() ».
   Sans elle, chaque écriture de statut dupliquerait la règle « qui suis-je »
   côté JavaScript, et c'est ainsi qu'une condition finit par manquer d'un
   côté. Ici la question est posée une fois, en base, à l'endroit où la
   réponse fait aussi la politique.

   ELLE LÈVE PLUTÔT QUE DE NE RIEN FAIRE quand personne n'est identifié. Une
   écriture qui ne s'écrit pas et rend un succès est le défaut le plus cher
   de ce dépôt — la suppression qui n'effaçait rien, la reprise qui ne
   reprenait rien. Un « update » silencieusement vide n'est pas une option.

   « note = null » EST UNE VALEUR, pas une absence de demande : c'est ainsi
   qu'on retire une note. L'appelant qui ne veut pas y toucher n'appelle pas
   cette porte.
   -------------------------------------------------------------------------- */
create or replace function public.enregistrer_lecture(
  la_possession text, le_statut text, la_note numeric)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  moi  uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  lect uuid := public.compte_effectif();
begin
  if moi is null then
    raise exception 'Aucun locataire posé : impossible d''enregistrer une lecture.'
      using errcode = '42501';
  end if;
  if lect is null then
    raise exception 'Cette session n''identifie personne : la lecture ne peut '
                    'pas être attribuée.'
      using errcode = '42501';
  end if;

  insert into public.lectures (tenant_id, possession, compte_id, statut, note, maj_le)
    values (moi, la_possession, lect, coalesce(le_statut, 'A lire'), la_note, now())
  on conflict (tenant_id, possession, compte_id) do update
     set statut = excluded.statut, note = excluded.note, maj_le = now();

  return true;
end $$;

revoke all on function public.enregistrer_lecture(text, text, numeric) from public;
