/* ===========================================================================
   UNE BIBLIOTHÈQUE PEUT AVOIR PLUSIEURS MEMBRES

   ---------------------------------------------------------------------------
   CE QUI CHANGE, ET SURTOUT CE QUI NE CHANGE PAS

   Le cloisonnement ne bouge pas d'une ligne. Toutes les politiques disent
   encore « = app.tenant_id », et les trente-cinq contrôles qui les éprouvent
   restent valides sans retouche.

   Ce qui change, c'est COMMENT on choisit le locataire courant — pas comment
   il est appliqué. C'est la raison pour laquelle cette architecture a été
   retenue le 04/09/2026 contre celle qui aurait fait des politiques
   « visible parce que membre du même collectif » : une jointure dans chaque
   règle de sécurité, dans un dépôt dont l'argument de sûreté tient à ce que
   ces règles se lisent d'un coup d'œil.

   ---------------------------------------------------------------------------
   IL N'Y A PAS DEUX PRODUITS

   Un locataire sans colocataire, c'est exactement l'application d'avant. Pas
   de « mode perso » et de « mode équipe » à maintenir en parallèle : un
   produit, et un nombre de membres. L'écran des membres n'apparaît que s'il
   y en a plus d'un.

   ---------------------------------------------------------------------------
   « comptes.tenant_id » DISPARAÎT

   Le garder à côté de « membres » ferait deux endroits où lire la même
   vérité — et ce dépôt sait ce que coûtent les doublons : le domaine écrit
   dans douze fichiers, sept listes manuelles, deux plafonds qui avaient
   dérivé l'un de l'autre.

   La reprise est CONDITIONNELLE à l'existence de la colonne : les migrations
   sont rejouées à chaque livraison, et trois fois par test-rejeu. Un
   « insert … select tenant_id from comptes » inconditionnel échouerait au
   deuxième passage, quand la colonne n'existe plus.

   ET LA 02 A DÛ ÊTRE TOUCHÉE, ce que ce dépôt n'avait jamais fait. Elle
   créait « create index comptes_tenant on comptes(tenant_id) » : au second
   passage, l'index visait une colonne disparue et la livraison tombait.
   Cette ligne y est désormais conditionnelle, avec la même explication.
   Le renvoi va dans les deux sens pour que la paire se trouve depuis l'un
   ou l'autre bout — sans quoi, dans six mois, l'un des deux paraîtrait
   arbitraire.

   ---------------------------------------------------------------------------
   « app.compte_id », UNE SECONDE IDENTITÉ DANS LA TRANSACTION

   Jusqu'ici le contexte ne portait que le locataire, parce qu'un locataire
   valait une personne. Ce n'est plus vrai : supprimer la bibliothèque
   demande de savoir QUI le demande, et pas seulement OÙ.

   Elle est posée transaction-locale comme « app.tenant_id », par le même
   chemin, avec la même règle : absente, elle vaut NULL, et tout ce qui en
   dépend ÉCHOUE FERMÉ. Une comparaison avec NULL n'est jamais vraie ; c'est
   ce qui fait qu'un oubli ferme au lieu d'ouvrir.

   ---------------------------------------------------------------------------
   LE QUOTA RESTE SUR LE LOCATAIRE

   Facturer par siège n'oblige pas à compter par siège. Cinq sièges donnent
   une enveloppe commune de 5 × 10 appels, portée par le locataire — ce qui
   laisse « consommer_appel_ia » intacte, avec son verrou et sa forme de
   résultat que deux contrôles lisent par position.

   Et la mise en commun est ce qu'une équipe veut : dans un cabinet, une
   personne alimente la bibliographie et les autres la lisent. Un quota par
   siège non transférable gênerait précisément ce cas-là.

   L'invariant du 31/08 se conserve à l'échelle : 10n × 0,086 = 0,86n, qui
   reste sous 0,900n. Multiplier les deux bornes par le nombre de sièges ne
   peut pas les faire diverger.
   =========================================================================== */

/* --------------------------------------------------------------------------
   L'APPARTENANCE
   -------------------------------------------------------------------------- */
create table if not exists public.membres (
  compte_id  uuid not null references public.comptes(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  /* « invite » n'est pas utilisé aujourd'hui. Il est prévu ici parce que la
     question reviendra le jour où une bibliothèque sera partagée hors du
     cabinet — un client, un intervenant. « Tout est copiable » est juste
     entre collègues ; c'en est une autre entre un cabinet et son client.
     Une valeur de plus dans une colonne qu'on crée de toute façon. */
  role       text not null default 'membre'
             check (role in ('proprietaire', 'membre', 'invite')),

  rejoint_le timestamptz not null default now(),

  /* La dernière fois que ce compte a OUVERT cette bibliothèque. C'est elle
     qui décide laquelle s'ouvre à la connexion suivante — plutôt qu'une
     colonne « dernier_locataire » sur comptes, qui serait un second endroit
     où lire le même fait. */
  vu_le      timestamptz,

  primary key (compte_id, tenant_id)
);

create index if not exists membres_par_locataire on public.membres (tenant_id);

/* --------------------------------------------------------------------------
   LA REPRISE, ET LA FIN DE « UNE BIBLIOTHÈQUE, UNE PERSONNE »

   Chaque compte existant devient PROPRIÉTAIRE de sa bibliothèque : c'est ce
   qu'il était déjà, sans que le schéma sût le dire.
   -------------------------------------------------------------------------- */
/* LA LEVÉE DES POLITIQUES EST OBLIGATOIRE POUR ÉCRIRE — et je l'avais oubliée.

   « force row level security » soumet même le propriétaire des tables. Une
   migration qui insère sans lever ne provoque aucune erreur : elle touche
   zéro ligne, EN SILENCE. La reprise ci-dessous aurait donc pu ne rien
   reprendre, et la première connexion d'un compte existant aurait échoué sur
   « n'appartient à aucune bibliothèque » — trois semaines plus tard, sur le
   serveur.

   C'est test-rejeu.mjs qui l'a dit, et c'est exactement ce pour quoi il
   existe : il compare ce qu'un fichier ÉCRIT à ce qu'il LÈVE. Le motif est
   celui de 02, 03, 05 et 07. */
do $$
declare t text;
begin
  foreach t in array array['membres'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I no force row level security', t);
    end if;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'comptes'
                and column_name = 'tenant_id') then

    insert into public.membres (compte_id, tenant_id, role, rejoint_le)
      select c.id, c.tenant_id, 'proprietaire', c.cree_le
        from public.comptes c
    on conflict (compte_id, tenant_id) do nothing;

    /* L'index qui interdisait le second compte. Son commentaire disait
       « une bibliothèque, une personne » — c'était vrai, ce ne l'est plus. */
    drop index if exists public.comptes_un_par_locataire;

    alter table public.comptes drop column tenant_id;
  end if;
end $$;

/* Et l'on remet, sans quoi la table resterait ouverte à son propriétaire —
   c'est-à-dire au compte applicatif, c'est-à-dire à tout le monde. */
do $$
declare t text;
begin
  foreach t in array array['membres'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;

/* --------------------------------------------------------------------------
   CLOISONNEMENT DE « membres »

   Deux façons légitimes de voir une ligne :
     — c'est la vôtre, où que ce soit (pour bâtir le sélecteur de
       bibliothèque, AVANT qu'un locataire ne soit choisi) ;
     — c'est celle d'un membre de la bibliothèque où vous êtes (pour afficher
       la liste des membres).

   Sans locataire ni compte posés, les deux comparaisons valent NULL : un
   visiteur ne voit rien.
   -------------------------------------------------------------------------- */
alter table public.membres enable row level security;
alter table public.membres force  row level security;

drop policy if exists membres_lecture on public.membres;
create policy membres_lecture on public.membres for select
  using (compte_id = nullif(current_setting('app.compte_id', true), '')::uuid
         or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* L'ÉCRITURE PASSE PAR LES PORTES NOMMÉES, jamais en direct. Inviter, partir
   et créer un locataire sont des gestes dont chacun a ses conditions ; les
   laisser s'écrire à la main reviendrait à les réécrire à chaque appel, et
   c'est ainsi qu'une condition finit par manquer quelque part. */
drop policy if exists membres_ecriture on public.membres;
create policy membres_ecriture on public.membres for insert
  with check (coalesce(nullif(current_setting('app.membres', true), ''), '') = 'en cours');

drop policy if exists membres_depart on public.membres;
create policy membres_depart on public.membres for delete
  using (coalesce(nullif(current_setting('app.membres', true), ''), '') = 'en cours');

drop policy if exists membres_maj on public.membres;
create policy membres_maj on public.membres for update
  using      (coalesce(nullif(current_setting('app.membres', true), ''), '') = 'en cours')
  with check (coalesce(nullif(current_setting('app.membres', true), ''), '') = 'en cours');

/* --------------------------------------------------------------------------
   LA PORTE DE LA CONNEXION — et pourquoi « security definer » ne suffisait pas

   J'AVAIS ÉCRIT L'INVERSE, ET C'ÉTAIT FAUX. Les deux fonctions ci-dessous
   portaient ce commentaire : « security definer, parce que les politiques de
   membres ne montreraient rien à un visiteur ». « security definer » fait
   exécuter le corps avec les droits du PROPRIÉTAIRE des tables — et
   « force row level security » soumet précisément le propriétaire aux
   politiques. La fonction ne voyait donc rien, et rendait zéro ligne SANS LA
   MOINDRE ERREUR. C'est le même piège que la reprise de la ligne 110, à
   quinze lignes d'intervalle, et je ne l'ai pas reconnu.

   Constaté le 05/09/2026 : « Le compte … n'appartient à aucune bibliothèque »
   sur tout le parcours de connexion, alors que la ligne « membres » existait.

   CE QUI OUVRE MAINTENANT, et ce que cela coûte. Un réglage transactionnel
   « app.connexion » portant L'IDENTIFIANT DU COMPTE — pas un drapeau « en
   cours ». La différence est tout : un drapeau ouvrirait « membres » en
   entier le temps de la transaction, tandis qu'ici la politique ne montre que
   les lignes de CE compte-là. Ce qui est révélé est exactement ce que la
   fonction rend de toute façon.

   Qui peut le poser : les deux fonctions ci-dessous, et elles seules — le
   réglage est remis à vide avant qu'elles ne rendent la main. L'identité a
   déjà été prouvée quand on y arrive : un jeton de lien magique consommé, ou
   un « sub » Google vérifié.
   -------------------------------------------------------------------------- */
drop policy if exists membres_connexion on public.membres;
create policy membres_connexion on public.membres for select
  using (compte_id = nullif(current_setting('app.connexion', true), '')::uuid);

drop policy if exists membres_connexion_marque on public.membres;
create policy membres_connexion_marque on public.membres for update
  using      (compte_id = nullif(current_setting('app.connexion', true), '')::uuid)
  with check (compte_id = nullif(current_setting('app.connexion', true), '')::uuid);

/* --------------------------------------------------------------------------
   UNE BIBLIOTHÈQUE A TOUJOURS UN PROPRIÉTAIRE

   Sans cette garde, le dernier propriétaire peut partir et laisser derrière
   lui une bibliothèque que plus personne ne peut ni régler ni supprimer.
   Elle continuerait de coûter, et personne n'aurait le droit d'y toucher.
   -------------------------------------------------------------------------- */
create or replace function public.membres_garde_proprietaire()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  restants integer;
  vise uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  /* LA BIBLIOTHÈQUE ELLE-MÊME PEUT S'EN ALLER, et alors il n'y a plus de
     propriétaire à garder.

     Sans cette sortie, « supprimer_locataire » devenait impossible : la
     suppression du locataire casse en cascade sur « membres », le déclencheur
     y voyait le départ du dernier propriétaire, et refusait. La bibliothèque
     était indestructible — y compris par son propriétaire, y compris par la
     porte de sortie de l'article 17.

     Constaté le 05/09/2026 par test-suppression.mjs, qui a dit exactement
     cela : « la suppression s'exécute sans lever — a LEVÉ ». Un garde-fou qui
     protège si bien qu'il empêche le geste légitime n'est pas un garde-fou,
     c'est une serrure sans clef. */
  if tg_op = 'DELETE'
     and not exists (select 1 from public.tenants where id = vise) then
    return old;
  end if;

  /* CE QUI NE TOUCHE PAS À LA PROPRIÉTÉ N'A RIEN À GARDER — 05/09/2026.

     La garde comptait les propriétaires restants à CHAQUE mise à jour, y
     compris celle de « vu_le » que pose « marquer_ouverture » à chaque
     ouverture de bibliothèque. Et ce décompte lit « membres » À TRAVERS LES
     POLITIQUES : dans le contexte de connexion, seules les lignes du compte
     concerné sont visibles. Pour un membre simple, la requête ne voyait
     AUCUN propriétaire — non parce qu'il n'y en avait pas, mais parce
     qu'ils ne lui étaient pas montrés. La garde concluait au départ du
     dernier propriétaire et refusait.

     Effet : un membre non propriétaire ne pouvait pas ouvrir la bibliothèque
     de son équipe. Statut 500, « Erreur interne » — sur le geste le plus
     ordinaire de toute la fonctionnalité.

     C'est la MÊME FAMILLE que le « security definer » du même jour :
     prendre l'invisibilité pour une absence. Un décompte fait sous RLS ne
     répond pas « combien y en a-t-il » mais « combien m'en montre-t-on », et
     les deux ne coïncident que si l'on a le droit de tout voir.

     Le remède ne consiste pas à élargir la vue — ce serait rouvrir la table
     pour satisfaire un garde-fou. Il consiste à ne poser la question que
     lorsqu'elle se pose : l'invariant porte sur la PROPRIÉTÉ, donc une mise
     à jour qui laisse le rôle intact ne peut pas le rompre.

     Reste vrai pour ce qui compte : la rétrogradation d'un propriétaire et
     le départ d'une ligne passent tous deux par le décompte ci-dessous, et
     les portes nommées qui les portent posent « app.tenant_id » — sous quoi
     TOUTES les lignes de la bibliothèque sont visibles. La question est donc
     posée là où la réponse est juste. */
  if tg_op = 'UPDATE'
     and new.role = old.role
     and new.compte_id = old.compte_id
     and new.tenant_id = old.tenant_id then
    return new;
  end if;

  select count(*) into restants
    from public.membres m
   where m.tenant_id = vise
     and m.role = 'proprietaire'
     and not (m.compte_id = old.compte_id and tg_op in ('DELETE', 'UPDATE'));

  if restants = 0 and (tg_op = 'DELETE' or new.role <> 'proprietaire') then
    raise exception
      'Une bibliothèque doit garder au moins un propriétaire.'
      using errcode = '23514';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end $$;

drop trigger if exists membres_garde_proprietaire on public.membres;
create trigger membres_garde_proprietaire
  before delete or update on public.membres
  for each row execute function public.membres_garde_proprietaire();

/* --------------------------------------------------------------------------
   LES BIBLIOTHÈQUES D'UN COMPTE — ce que le sélecteur affiche

   « security definer » ASSUMÉ : la fonction est appelée AVANT qu'un
   locataire ne soit choisi, donc dans un contexte où « app.tenant_id » est
   vide et où la politique de « tenants » ne montrerait rien. Elle est bornée
   au compte posé dans « app.compte_id » et ne peut rendre les bibliothèques
   de personne d'autre — c'est la clause « where » qui fait la sûreté, pas le
   contexte.
   -------------------------------------------------------------------------- */
create or replace function public.mes_bibliotheques()
returns table (locataire uuid, identifiant text, nom text, role text,
               membres integer, vu_le timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select t.id, t.identifiant, t.nom, m.role,
         (select count(*)::integer from public.membres x where x.tenant_id = t.id),
         m.vu_le
    from public.membres m
    join public.tenants t on t.id = m.tenant_id
   where m.compte_id = nullif(current_setting('app.compte_id', true), '')::uuid
   order by m.vu_le desc nulls last, m.rejoint_le;
$$;

revoke all on function public.mes_bibliotheques() from public;

/* --------------------------------------------------------------------------
   QUELLE BIBLIOTHÈQUE S'OUVRE À LA CONNEXION

   Elle prend le compte EN PARAMÈTRE, et non dans « app.compte_id ». Ce n'est
   pas une commodité : au moment où l'on se connecte, on est encore en
   contexte VISITEUR — ni locataire ni compte posés, puisque c'est justement
   ce qu'on cherche à établir. Une fonction qui lirait le contexte ne rendrait
   rien, et la connexion échouerait sans dire pourquoi.

   ELLE POSE « app.connexion » ELLE-MÊME, et le retire avant de rendre la
   main. « security definer » seul ne suffisait pas — voir la note de la
   politique « membres_connexion » plus haut. La sûreté ne vient pas du
   contexte mais de la clause « where », de la politique qui borne au même
   compte, et de qui peut appeler : l'identité a déjà été prouvée, par un lien
   magique consommé ou un « sub » Google vérifié.

   LA DERNIÈRE OUVERTE, pas la première créée. Quelqu'un qui travaille dans
   la bibliothèque de son cabinet la retrouve en se reconnectant, sans avoir
   à la rechoisir chaque matin. « nulls last » place celles jamais ouvertes
   après, et « rejoint_le » départage — l'ordre est donc total, jamais
   arbitraire.
   -------------------------------------------------------------------------- */
drop function if exists public.bibliotheque_a_ouvrir(uuid);
create function public.bibliotheque_a_ouvrir(le_compte uuid)
returns table (locataire uuid, langue text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  /* Le réglage vaut l'identifiant du compte, et non un drapeau : la politique
     « membres_connexion » n'ouvre alors que les lignes de ce compte-là. */
  perform set_config('app.connexion', le_compte::text, true);

  return query
    select m.tenant_id, t.langue
      from public.membres m
      join public.tenants t on t.id = m.tenant_id
     where m.compte_id = le_compte
     order by m.vu_le desc nulls last, m.rejoint_le
     limit 1;

  perform set_config('app.connexion', '', true);
end $$;

revoke all on function public.bibliotheque_a_ouvrir(uuid) from public;

/* --------------------------------------------------------------------------
   MARQUER QU'ON VIENT D'OUVRIR CETTE BIBLIOTHÈQUE

   Sans cela, « vu_le » resterait à sa valeur de création et « la dernière
   ouverte » ne changerait jamais — un tri stable sur une colonne morte, qui
   aurait l'air de fonctionner tant qu'on n'a qu'une bibliothèque.

   Bornée au couple exact : elle ne peut marquer que l'appartenance qu'on lui
   nomme, et seulement si elle existe. Elle pose « app.connexion » comme sa
   voisine, pour la même raison — et le retire aussitôt.
   -------------------------------------------------------------------------- */
drop function if exists public.marquer_ouverture(uuid, uuid);
create function public.marquer_ouverture(le_compte uuid, le_locataire uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare marque boolean;
begin
  perform set_config('app.connexion', le_compte::text, true);

  update public.membres set vu_le = now()
   where compte_id = le_compte and tenant_id = le_locataire
  returning true into marque;

  perform set_config('app.connexion', '', true);
  return coalesce(marque, false);
end $$;

revoke all on function public.marquer_ouverture(uuid, uuid) from public;

/* --------------------------------------------------------------------------
   CRÉER UN LOCATAIRE — la porte du 10, refaite sans « comptes.tenant_id »

   « create or replace » ici plutôt qu'un correctif dans 10 : les migrations
   se rejouent dans l'ordre, 15 arrive après 10, et c'est cette version-ci
   qui gagne. C'est le même dispositif que 11 refaisant « consommer_appel_ia »
   de 05 — et le même piège s'il fallait un jour rejouer 10 SEULE.
   -------------------------------------------------------------------------- */
/* LA FORME DU RÉSULTAT NE CHANGE PAS — trois colonnes, comme 10 les a
   déclarées. « adresse » n'est que le courriel réémis, et aucun appelant ne
   le lit : « authentification.mjs » ne prend que « compte, locataire ».

   J'ai d'abord écrit deux colonnes, ayant lu le SITE D'APPEL au lieu de la
   DÉCLARATION. PostgreSQL a refusé — « cannot change return type of existing
   function » — et il a eu raison deux fois : la forme était fausse, et la
   changer aurait demandé de supprimer la fonction d'abord. Une pièce mobile
   de plus dans un lot qui en compte déjà beaucoup, pour retirer une colonne
   morte. Elle partira seule, un jour, avec son propre contrôle. */
create or replace function public.creer_locataire(
  le_courriel text, le_quota integer default 10)
returns table (compte uuid, locataire uuid, adresse text)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  nouveau_tenant uuid;
  nouveau_compte uuid;
  ident text;
  essais integer := 0;
begin
  perform set_config('app.inscription', 'en cours', true);
  perform set_config('app.membres',     'en cours', true);

  loop
    /* L'EXPRESSION DE LA 10, À L'IDENTIQUE. J'avais écrit
       « encode(gen_random_bytes(5), 'hex') » — même résultat en apparence,
       dix caractères hexadécimaux, mais « gen_random_bytes » appartient à
       pgcrypto, qui n'est installé nulle part ici. Cela aurait échoué en
       production aussi. Réécrire de mémoire ce qu'une ligne FAIT au lieu de
       lire ce qu'elle EST : troisième fois de la journée. */
    ident := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    begin
      insert into public.tenants (identifiant, nom, visibilite, quota_ia_mois)
        values (ident, ident, 'privee', le_quota)
        returning id into nouveau_tenant;
      exit;
    exception when unique_violation then
      essais := essais + 1;
      if essais > 5 then raise; end if;
    end;
  end loop;

  insert into public.comptes (courriel) values (le_courriel)
    returning id into nouveau_compte;

  /* PROPRIÉTAIRE, et c'est ce qui lui donnera le droit de supprimer. */
  insert into public.membres (compte_id, tenant_id, role, vu_le)
    values (nouveau_compte, nouveau_tenant, 'proprietaire', now());

  perform set_config('app.inscription', '', true);
  perform set_config('app.membres',     '', true);

  return query select nouveau_compte, nouveau_tenant, le_courriel;
end $$;

revoke all on function public.creer_locataire(text, integer) from public;

/* --------------------------------------------------------------------------
   SUPPRIMER LA BIBLIOTHÈQUE — désormais réservé au propriétaire

   Avant ce lot, un locataire valait une personne : demander la suppression
   depuis la session, c'était forcément être chez soi. Ce n'est plus vrai —
   un membre pourrait effacer le fonds de tout le cabinet.

   La forme du résultat NE CHANGE PAS : « ouvrages_effaces, comptes_effaces »
   dans cet ordre, comme 13 l'a posée et comme test-suppression.mjs et
   test-http-cloisonnement.mjs la lisent.
   -------------------------------------------------------------------------- */
create or replace function public.supprimer_locataire()
returns table (ouvrages_effaces bigint, comptes_effaces bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  moi   uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  qui   uuid := nullif(current_setting('app.compte_id', true), '')::uuid;
  n_o   bigint;
  n_c   bigint;
  efface integer;
begin
  if moi is null then
    raise exception 'Aucun locataire posé : impossible de supprimer.'
      using errcode = '42501';
  end if;

  /* « ELLE N'EXISTE PLUS » SE DIT AVANT « VOUS N'Y AVEZ PAS DROIT » — et
     l'ordre n'est pas cosmétique.

     Le cas est réel : double clic sur le bouton, ou onglet resté ouvert. Le
     cookie est valide et signé, mais la bibliothèque est déjà partie — et
     avec elle, en cascade, la ligne « membres » qui prouvait la propriété.
     Le contrôle de propriété placé en premier répondait alors « seul un
     propriétaire peut supprimer cette bibliothèque » à celui qui EN ÉTAIT le
     propriétaire une seconde plus tôt. Refus juste, motif faux.

     Aucune fuite : la politique de « tenants » borne sur « id =
     app.tenant_id », et la session signée interdit de poser le locataire
     d'un autre. On ne peut donc apprendre ici que l'existence de sa propre
     bibliothèque.

     Le message reste celui de la migration 13 — « Suppression refusée » —
     parce que c'est la même vérité dite au bon endroit : rien n'a été
     effacé, et l'on ne rend pas un succès. */
  if not exists (select 1 from public.tenants where id = moi) then
    raise exception 'Suppression refusée : cette bibliothèque n''existe plus.'
      using errcode = '42501';
  end if;

  /* ÉCHOUER FERMÉ SUR LE COMPTE AUSSI. Sans identité posée, « qui » vaut
     NULL, la vérification ci-dessous ne trouve rien, et l'on refuse. Un
     oubli de contexte ferme la porte au lieu de l'ouvrir. */
  if not exists (select 1 from public.membres m
                  where m.tenant_id = moi and m.compte_id = qui
                    and m.role = 'proprietaire') then
    raise exception
      'Seul un propriétaire peut supprimer cette bibliothèque.'
      using errcode = '42501';
  end if;

  select count(*) into n_o from public.possessions where tenant_id = moi;
  select count(*) into n_c from public.membres     where tenant_id = moi;

  delete from public.tenants where id = moi;
  get diagnostics efface = row_count;

  /* CE GARDE-FOU N'EST PLUS CELUI QUE test-suppression.mjs ÉPROUVE, et il
     faut le dire plutôt que de le laisser croire.

     Il est né en 13 pour attraper la session qui survit à sa bibliothèque.
     Ce cas est désormais pris plus haut, sur l'existence. Il ne reste ici
     qu'un filet : le locataire est visible, donc supprimable par la même
     politique — et pourtant la ligne n'est pas partie. Aucun scénario connu
     n'y mène ; c'est précisément pour l'inconnu qu'on le garde.

     Le contrôle qui a désormais une prise réelle est celui du membre non
     propriétaire, ajouté le 05/09/2026 dans test-suppression.mjs. */
  if efface = 0 then
    raise exception 'Suppression refusée : la bibliothèque n''a pas été effacée.'
      using errcode = '42501';
  end if;

  return query select n_o, n_c;
end $$;

revoke all on function public.supprimer_locataire() from public;
