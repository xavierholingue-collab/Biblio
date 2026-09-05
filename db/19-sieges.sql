/* =========================================================================
   LE QUOTA SUIT LE NOMBRE DE SIÈGES

   « par siège pour l'instant, on verra plus tard dans une version Pro ou
   Team pour intégrer des quotas d'équipe plus élevés » — Xavier, 05/09/2026.

   Une bibliothèque partagée à cinq consomme le modèle comme cinq personnes.
   Lui laisser le quota d'une seule serait tenir une promesse fausse : à la
   troisième recommandation de la journée, le cabinet entier se retrouverait
   bloqué par un compteur dimensionné pour un individu. Et l'inverse — un
   quota fixe assez large pour cinq — offrirait cinq fois le gratuit à qui
   travaille seul.

   ---------------------------------------------------------------------------
   L'INVARIANT DE LA 11 EST PRÉSERVÉ PAR CONSTRUCTION

     plafond_usd  >=  quota_ia_mois  ×  coût du plus cher appel mesuré

   Multiplier LES DEUX par le nombre de sièges laisse l'inégalité vraie :
   10n × 0,086 = 0,86n  <=  0,900n. C'est ce qui permet de dimensionner sans
   rouvrir la question — et c'est aussi pourquoi les deux valeurs par siège
   sont déclarées ICI, ensemble, dans deux fonctions plutôt que dans deux
   constantes recopiées. Deux bornes posées séparément ont déjà dérivé une
   fois dans ce dépôt ; on ne recommence pas.

   ---------------------------------------------------------------------------
   CE QUI A ÉTÉ RÉGLÉ À LA MAIN NE SE FAIT PAS ÉCRASER

   C'est la partie qui compte, et elle vient d'une faute réelle : le
   25/08/2026, un redimensionnement appliquant « les valeurs du gratuit » a
   ramené la bibliothèque de Xavier — 100 000 appels, 20 $ — à 10 appels, et
   l'a bloqué. Un déclencheur qui recalcule à chaque changement d'effectif
   referait exactement cela, à chaque invitation, sans que personne le
   demande.

   Une colonne « tarification » distingue donc les deux régimes :

     « sieges »   — dimensionné automatiquement. C'est le cas par défaut,
                    celui de toutes les bibliothèques du gratuit.
     « manuelle » — quelqu'un a décidé. Le déclencheur n'y touche plus.

   « regler_tarification » bascule en « manuelle » : régler à la main EST la
   décision. Et la reprise ci-dessous marque « manuelle » toute bibliothèque
   dont les valeurs actuelles ne correspondent PAS au calcul par siège —
   c'est-à-dire tout ce qui a déjà été réglé. Personne ne perd ce qu'il a.
   ========================================================================= */

/* --------------------------------------------------------------------------
   CE QUE VAUT UN SIÈGE

   Deux fonctions plutôt que deux nombres écrits en plusieurs endroits. Elles
   sont « immutable » : PostgreSQL peut les replier dans un index ou une
   contrainte, et surtout elles se lisent depuis les contrôles, qui
   comparent ces valeurs à celles annoncées sur la page d'accueil.
   -------------------------------------------------------------------------- */
create or replace function public.quota_par_siege()
returns integer language sql immutable as $$ select 10 $$;

create or replace function public.plafond_par_siege()
returns numeric language sql immutable as $$ select 0.900::numeric $$;

/* --------------------------------------------------------------------------
   LE RÉGIME DE TARIFICATION

   « sieges » par défaut : une bibliothèque neuve est dimensionnée
   automatiquement, et le restera tant que personne n'aura décidé autrement.
   -------------------------------------------------------------------------- */
alter table public.tenants add column if not exists tarification text
  not null default 'sieges';

alter table public.tenants drop constraint if exists tenants_tarification_connue;
alter table public.tenants add constraint tenants_tarification_connue
  check (tarification in ('sieges', 'manuelle'));

/* --------------------------------------------------------------------------
   LA POLITIQUE QUI MANQUAIT DEPUIS LA 11 — trouvée le 05/09/2026

   « tenants_reglages » borne la mise à jour sur « id = app.tenant_id ».
   C'est juste pour l'application : on ne règle que chez soi. Mais deux
   chemins légitimes n'ont PAS de locataire posé :

     — « regler_tarification », qu'on appelle en exploitation pour relever le
       quota de quelqu'un. Elle n'a jamais échoué parce qu'on l'a toujours
       lancée en superutilisateur, qui traverse les politiques. Appelée par
       le compte applicatif, elle aurait touché ZÉRO ligne et rendu zéro
       ligne — un succès silencieux. Le défaut dormait depuis la 11.

     — le dimensionnement ci-dessous, qui s'exécute pendant une invitation :
       « app.tenant_id » vaut alors la bibliothèque de celui qui invite, ce
       qui coïncide par hasard ; mais pendant une consommation de lien
       d'invitation, le contexte est VISITEUR, et l'update ne touchait rien.

   C'est la cinquième fois en un jour qu'une écriture passe à travers une
   politique et n'écrit rien sans le dire (règle 7 de METHODE.md). On ajoute
   donc la politique qui correspond à la porte nommée déjà existante :
   « app.tarification = 'en cours' » est le drapeau que le déclencheur de la
   11 exige DÉJÀ pour laisser passer l'écriture. La politique et le
   déclencheur disent maintenant la même chose — l'un décide ce qui est
   visible, l'autre ce qui est permis.
   -------------------------------------------------------------------------- */
drop policy if exists tenants_tarification on public.tenants;
create policy tenants_tarification on public.tenants for update
  using      (coalesce(nullif(current_setting('app.tarification', true), ''), '')
              = 'en cours')
  with check (coalesce(nullif(current_setting('app.tarification', true), ''), '')
              = 'en cours');

/* --------------------------------------------------------------------------
   LE RÉGIME EST DÉCIDÉ À LA CRÉATION

   Une bibliothèque créée avec les valeurs d'UN SIÈGE est au tarif : elle
   suivra son effectif. Créée avec autre chose, quelqu'un a décidé — et le
   dimensionnement automatique n'a pas à revenir sur cette décision.

   POURQUOI CE N'EST PAS UN CAS PARTICULIER POUR LES CONTRÔLES. Le banc
   d'essai crée ses locataires avec un quota volontairement bas — trois
   appels — pour que les contrôles de quota soient praticables. Sans cette
   règle, la première invitation d'un contrôle ramènerait le quota à dix et
   la vérification suivante mesurerait autre chose que ce qu'elle annonce.
   La règle n'est pas écrite POUR eux : elle dit ce qui est vrai, et il se
   trouve qu'elle règle aussi leur cas. « creer_locataire » passe dix, qui
   est exactement la valeur d'un siège, et reste donc au tarif.
   -------------------------------------------------------------------------- */
create or replace function public.tenants_regime_initial()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.tarification = 'sieges'
     and (new.quota_ia_mois is distinct from public.quota_par_siege()
          or new.plafond_usd is distinct from public.plafond_par_siege())
  then
    new.tarification := 'manuelle';
  end if;
  return new;
end $$;

drop trigger if exists tenants_regime_initial on public.tenants;
create trigger tenants_regime_initial
  before insert on public.tenants
  for each row execute function public.tenants_regime_initial();

/* --------------------------------------------------------------------------
   LA REPRISE — ce qui a été réglé reste réglé

   ON COMPARE AUX VALEURS QU'AURAIT LE CALCUL, pas à un seuil arbitraire.
   Une bibliothèque à un membre avec 10 appels et 0,900 $ est exactement ce
   que le calcul produirait : elle reste « sieges ». Celle de Xavier, à
   100 000 et 20 $, ne l'est pas : elle passe « manuelle » et ne bougera
   plus.

   « coalesce(m.n, 0) » : une bibliothèque sans membre — l'artefact du
   locataire par défaut avant toute connexion — compte pour zéro siège. Elle
   ne sera donc pas jugée « manuelle » sur un calcul absurde ; le
   déclencheur, lui, plancher à un siège (voir plus bas).

   LES POLITIQUES SONT LEVÉES SUR LES DEUX TABLES LUES, et pas seulement sur
   celle qu'on écrit. C'est la faute du matin même, sur la 17 : lever
   « lectures » en oubliant « possessions » et « membres » faisait lire zéro
   ligne, en silence. On ne la refait pas.
   -------------------------------------------------------------------------- */
do $$
declare t text;
begin
  foreach t in array array['tenants', 'membres'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I no force row level security', t);
    end if;
  end loop;
end $$;

do $$
begin
  /* La levée a-t-elle eu lieu ? Question posée à « pg_class », que la RLS ne
     masque pas — même garde-fou que la 17, et pour la même raison. */
  if exists (select 1 from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relname in ('tenants', 'membres')
               and c.relforcerowsecurity) then
    raise exception 'Les politiques n''ont pas été levées : la reprise de '
                    'tarification lirait à travers le cloisonnement.'
      using errcode = '55000';
  end if;

  perform set_config('app.tarification', 'en cours', true);

  update public.tenants t
     set tarification = 'manuelle'
    from (select tn.id,
                 greatest(coalesce(count(m.compte_id), 0), 1) as sieges
            from public.tenants tn
            left join public.membres m on m.tenant_id = tn.id
           group by tn.id) s
   where s.id = t.id
     and t.tarification = 'sieges'
     and (t.quota_ia_mois is distinct from public.quota_par_siege() * s.sieges
          or t.plafond_usd is distinct from public.plafond_par_siege() * s.sieges);

  perform set_config('app.tarification', '', true);
end $$;

do $$
declare t text;
begin
  foreach t in array array['tenants', 'membres'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;

/* --------------------------------------------------------------------------
   RÉGLER À LA MAIN, C'EST DÉCIDER

   « create or replace » de la fonction de la 11, avec UNE ligne de plus. La
   forme du résultat ne change pas — « locataire, quota, plafond » — parce
   que test-usage-ia.mjs et les commandes d'exploitation la lisent ainsi.
   -------------------------------------------------------------------------- */
create or replace function public.regler_tarification(
  le_tenant  uuid,
  le_quota   integer,
  le_plafond numeric)
returns table (locataire uuid, quota integer, plafond numeric)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if le_quota is null or le_quota < 0 or le_quota > 100000 then
    raise exception 'Quota hors bornes : %', le_quota using errcode = '22023';
  end if;
  if le_plafond is null or le_plafond < 0 or le_plafond > 1000 then
    raise exception 'Plafond hors bornes : %', le_plafond using errcode = '22023';
  end if;

  perform set_config('app.tarification', 'en cours', true);

  return query
    update public.tenants t
       set quota_ia_mois = le_quota,
           plafond_usd   = le_plafond,
           /* CE QUI DISTINGUE CETTE PORTE DU DÉCLENCHEUR : passer par ici,
              c'est décider. La bibliothèque quitte le dimensionnement
              automatique et n'y revient pas toute seule — sans quoi la
              prochaine invitation effacerait le réglage. */
           tarification  = 'manuelle'
     where t.id = le_tenant
    returning t.id, t.quota_ia_mois, t.plafond_usd;
end $$;

/* --------------------------------------------------------------------------
   LE DIMENSIONNEMENT

   « security definer » N'EST PAS CE QUI LE FAIT MARCHER — il n'échapperait
   pas à « force row level security », leçon du 05/09 au matin. Ce qui lui
   permet d'écrire, c'est « app.tarification », le drapeau que le déclencheur
   de la 11 exige déjà : la porte nommée est respectée, pas contournée.

   PLANCHER À UN SIÈGE. Le déclencheur s'exécute aussi quand la DERNIÈRE
   ligne « membres » disparaît — cascade d'une suppression de bibliothèque,
   ou départ. Un quota de zéro appel serait vrai selon la formule et faux
   selon le produit : une bibliothèque existe toujours pour quelqu'un.

   IL NE TOUCHE PAS AUX BIBLIOTHÈQUES « manuelle ». C'est la protection de
   ce qui a été réglé, et le contrôle l'éprouve dans les deux sens : le
   redimensionnement a lieu quand il doit, et n'a pas lieu quand il ne doit
   pas.
   -------------------------------------------------------------------------- */
drop policy if exists membres_sieges on public.membres;
create policy membres_sieges on public.membres for select
  using (tenant_id = nullif(current_setting('app.sieges', true), '')::uuid);

create or replace function public.dimensionner_sieges()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  vise   uuid := coalesce(new.tenant_id, old.tenant_id);
  sieges integer;
begin
  /* La bibliothèque peut être en train de disparaître — cascade sur
     « membres ». Il n'y a alors plus rien à dimensionner, et l'« update »
     ressusciterait une ligne que la suppression vient d'emporter. */
  if not exists (select 1 from public.tenants where id = vise
                   and tarification = 'sieges') then
    return coalesce(new, old);
  end if;

  /* LE DÉCOMPTE LIT « membres » À TRAVERS LES POLITIQUES — sixième fois du
     05/09/2026, et je ne l'ai pas reconnue plus vite que les cinq autres.

     « security definer » exécute avec les droits du PROPRIÉTAIRE des tables,
     que « force row level security » soumet aux politiques comme tout le
     monde. Pendant une invitation consommée, ni « app.compte_id » ni
     « app.tenant_id » ne sont posés : « membres_lecture » ne montrait AUCUNE
     ligne, le décompte valait zéro, et « greatest(0, 1) » rendait UN. Toute
     équipe, quelle que soit sa taille, était dimensionnée pour une personne.

     Rien n'échouait. Le quota était simplement faux, et faux d'une façon
     qu'on ne remarque qu'en comptant à la main.

     « app.sieges » PORTE L'IDENTIFIANT DU LOCATAIRE, pas un drapeau : la
     politique n'ouvre alors que les lignes de CETTE bibliothèque — celle
     qu'on est déjà en train de modifier. Même dispositif que
     « app.connexion » et « app.copie », et même raison de le préférer à un
     « en cours » qui ouvrirait la table entière. */
  perform set_config('app.sieges', vise::text, true);

  select greatest(count(*), 1) into sieges
    from public.membres m where m.tenant_id = vise;

  perform set_config('app.sieges', '', true);

  perform set_config('app.tarification', 'en cours', true);

  update public.tenants
     set quota_ia_mois = public.quota_par_siege()   * sieges,
         plafond_usd   = public.plafond_par_siege() * sieges
   where id = vise;

  perform set_config('app.tarification', '', true);

  return coalesce(new, old);
end $$;

/* « after », et non « before » : le décompte doit voir la ligne posée ou
   retirée. En « before », on compterait l'effectif d'avant, et le quota
   aurait toujours un siège de retard — ce qui aurait l'air de marcher tant
   qu'on n'invite qu'une personne à la fois. */
drop trigger if exists membres_dimensionne on public.membres;
create trigger membres_dimensionne
  after insert or delete on public.membres
  for each row execute function public.dimensionner_sieges();

revoke all on function public.dimensionner_sieges()  from public;
revoke all on function public.quota_par_siege()      from public;
revoke all on function public.plafond_par_siege()    from public;
