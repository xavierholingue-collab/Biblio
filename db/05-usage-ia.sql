/* ===========================================================================
   CE QUE COÛTE RÉELLEMENT UN APPEL — ET POURQUOI LE COMPTER NE SUFFISAIT PAS

   Le quota du 16/08/2026 compte des APPELS. Il est juste, il est éprouvé, il
   échoue fermé — et il est en train de devenir décoratif.

   La raison tient en une phrase : LES APPELS NE SONT PLUS HOMOGÈNES. Un
   résumé lance deux recherches web ; un parcours en lance quatre ; le second
   appel de la recommandation n'en lance aucune. La recherche web est facturée
   10 $ pour mille, et surtout CHAQUE LOT DE RÉSULTATS ENTRE DANS LE CONTEXTE,
   donc il est relu et refacturé à chaque tour du modèle. Ce qui coûte n'est
   pas ce que le modèle écrit, c'est ce qu'il relit.

   Conséquence : deux appels décomptés à l'identique peuvent différer d'un
   facteur trois. « Dix appels par mois » ne veut donc rien dire en argent, et
   le plafond ne protège pas la seule chose qu'il prétend protéger.

   C'est la famille de défaut relevée toute la semaine, dans sa forme la plus
   discrète : UN CONTRÔLE QUI MESURE UN SUBSTITUT. Il n'est pas faux — il
   mesurait bien la dépense le jour où tous les appels se valaient. Il a cessé
   d'être vrai sans que rien ne change dans son code.

   ---------------------------------------------------------------------------
   CE FICHIER NE DÉCIDE RIEN, IL INSTRUMENTE

   Il ne change ni le plafond, ni la façon de le consommer, ni le prix de
   l'abonnement. Il rend seulement mesurable ce qui était supposé. L'arbitrage
   — baisser « max_uses », employer un modèle moins cher pour la première
   passe, refuser de résumer à l'import — vient APRÈS, sur des données.

   Écrire ce fichier avant l'arbitrage est délibéré : un mois d'usage réel
   vaut mieux qu'une estimation, et l'estimation qui a motivé ce chantier
   (0,05 à 0,10 € par résumé) n'est justement qu'une estimation.

   ---------------------------------------------------------------------------
   ON ENREGISTRE DES UNITÉS, JAMAIS UN MONTANT

   Jetons et recherches sont des faits : ils ne changeront pas. Un prix, si.
   Stocker « 0,07 € » dans une ligne, c'est figer le tarif du jour dans une
   donnée qu'on relira dans deux ans en la croyant exacte. Le montant se
   calcule à la lecture, par « cout_ia_dollars », qui est le seul endroit à
   connaître un tarif — et qui rend NULL pour un modèle qu'il ne connaît pas,
   plutôt que d'inventer.

   En dollars, et non en euros : c'est la monnaie de la facture. Convertir
   supposerait un taux de change, c'est-à-dire une seconde donnée périssable
   pour rien.

   ---------------------------------------------------------------------------
   CE FICHIER A COMMENCÉ PAR NE RIEN ÉCRIRE. IL ÉCRIT MAINTENANT.

   La première version portait ici : « DDL seulement, donc pas de levée de
   politiques — si l'on ajoute un jour un remplissage rétroactif, il faudra
   lever et remettre comme le fait 04 ». Ce jour est arrivé le soir même.

   Ce qui l'a provoqué mérite d'être raconté, parce que le défaut était dans le
   contrôle et non dans le code. Mise en production le 18/08, la vue
   « appels_ia_sans_mesure » a immédiatement signalé une ligne du 15/08 comme
   « restée en vol ». Elle n'était pas en vol : elle est ANTÉRIEURE À
   L'INSTRUMENT. La vue ne savait pas distinguer « la mesure a échoué » de
   « la mesure n'existait pas encore ».

   Ce n'est pas anodin. UN CONTRÔLE QUI CRIE SUR L'HISTOIRE FINIT DÉSACTIVÉ,
   et le jour où il criera pour une vraie raison, personne ne regardera. Une
   ligne parasite aujourd'hui, mille après une reprise de données.

   D'où le remplissage ci-dessous, et donc la levée des politiques. Sous
   « force row level security », un « update » lancé sans locataire ne lève
   pas : aucune ligne ne correspond à la politique, PostgreSQL en rapporte
   zéro, et la migration s'achève sans avoir rien fait. En silence.
   =========================================================================== */

/* --------------------------------------------------------------------------
   LEVER LE CLOISONNEMENT AVANT D'ÉCRIRE — même geste que 02, 03 et 04.
   -------------------------------------------------------------------------- */
do $$
begin
  if to_regclass('public.appels_ia') is not null then
    execute 'alter table public.appels_ia no force row level security';
  end if;
end $$;

/* ------------------------------------------------------- Ce qu'on mesure

   « modele » est enregistré ligne à ligne, et ce n'est pas un détail : le
   jour où la première passe basculera sur un modèle moins cher — c'est l'une
   des pistes ouvertes — le prix du jeton changera. Sans cette colonne, on ne
   saurait plus attribuer une dépense passée au bon tarif, et l'historique
   deviendrait illisible rétroactivement.

   « issue » distingue trois situations que rien ne séparait :

     'ok'          l'appel a abouti et son usage est enregistré ;
     'echec'       l'appel a été facturé mais n'a rien rendu — le quota est
                   consommé, c'est voulu, et il faut pouvoir le voir ;
     'sans_mesure' l'appel a abouti mais la réponse ne portait pas d'« usage ».
                   Le fournisseur a changé la forme de sa réponse.
     'avant_mesure' la ligne est antérieure à cette migration. On ne sait rien
                   d'elle et on ne saura jamais rien : c'est un fait, pas une
                   anomalie.

   NULL signifie « en vol ». Une ligne restée NULL une heure après sa création
   raconte un processus mort au milieu d'un appel.

   Sans cette distinction, une ligne sans jetons serait ambiguë : appel échoué
   (normal) ou comptabilité cassée (défaut) ? On ne saurait pas lequel, donc on
   ne regarderait ni l'un ni l'autre. */
alter table public.appels_ia
  add column if not exists modele         text,
  add column if not exists jetons_entree  integer,
  add column if not exists jetons_sortie  integer,
  add column if not exists recherches_web integer,
  add column if not exists issue          text;

alter table public.appels_ia drop constraint if exists appels_ia_issue_connue;
alter table public.appels_ia add constraint appels_ia_issue_connue
  check (issue is null or issue in ('ok', 'echec', 'sans_mesure', 'avant_mesure'));

/* --------------------------------------- Marquer ce qui précède l'instrument

   UNE DATE ÉCRITE EN DUR, ET C'EST TOUT L'INTÉRÊT.

   La tentation est d'écrire « where issue is null » : plus court, et faux de
   la pire façon. Rejouée dans six mois — ce que ce fichier doit supporter —
   cette condition marquerait « avant_mesure » toute ligne EN VOL à cet
   instant, c'est-à-dire un appel réellement en cours. Le contrôle perdrait
   exactement ce qu'il est censé attraper, et il le perdrait en silence.

   Une constante ne peut pas dériver. Le 18/08/2026 est le jour où les
   colonnes sont apparues en production ; tout ce qui précède est, par
   construction, hors de portée de la mesure. Aucune ligne future ne peut
   entrer dans ce filtre, quel que soit le nombre de rejeux.

   C'est la règle « borner toute exception » : une exception datée s'épuise,
   une exception conditionnelle s'étend. */
update public.appels_ia
   set issue = 'avant_mesure'
 where issue is null
   and cree_le < timestamptz '2026-08-18 00:00:00+02';

/* ==========================================================================
   CONSOMMER, EN RENDANT DE QUOI REVENIR ÉCRIRE

   L'ordre reste celui du 16/08 et il ne changera pas : on consomme AVANT
   d'appeler le modèle, parce que ce qui coûte est la tentative. L'usage, lui,
   n'est connu qu'APRÈS. Il faut donc pouvoir retrouver la ligne qu'on vient
   d'écrire, d'où l'identifiant rendu.

   « appel_id » est ajouté EN DERNIÈRE COLONNE, délibérément : deux contrôles
   lisent déjà le résultat de cette fonction, et une colonne insérée en tête
   décalerait leurs lectures sans qu'aucun ne tombe. On ne réordonne pas un
   contrat que d'autres lisent.

   « le_modele » a une valeur par défaut pour que « consommer_appel_ia($1) »
   reste valide. Un appelant qui l'oublie n'échoue pas — il écrit simplement
   une ligne sans modèle, que la vue de contrôle plus bas signalera.
   ========================================================================== */
drop function if exists public.consommer_appel_ia(text);

create or replace function public.consommer_appel_ia(
  la_route text, le_modele text default null)
returns table (consomme integer, plafond integer, appel_id bigint)
language plpgsql as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  n   integer;
  p   integer;
  nouvel_id bigint;
begin
  if moi is null then
    raise exception 'Aucun locataire posé : impossible de décompter un appel.'
      using errcode = '42501';
  end if;

  -- Le verrou et la lecture du plafond, en un seul geste. Sans « for update »,
  -- huit appels simultanés passent un plafond de trois.
  select t.quota_ia_mois into p
    from public.tenants t where t.id = moi for update;

  if p is null then
    raise exception 'Locataire inconnu.' using errcode = '42501';
  end if;

  select count(*) into n
    from public.appels_ia a
   where a.tenant_id = moi
     and a.cree_le >= date_trunc('month', now());

  if n >= p then
    raise exception 'Quota mensuel atteint : % appels sur %.', n, p
      using errcode = '53400';
  end if;

  insert into public.appels_ia (tenant_id, route, modele)
       values (moi, la_route, le_modele)
    returning public.appels_ia.id into nouvel_id;

  return query select n + 1, p, nouvel_id;
end $$;

/* ==========================================================================
   ENREGISTRER CE QUE L'APPEL A COÛTÉ

   LEVER QUAND RIEN N'A ÉTÉ ÉCRIT — c'est le cœur de cette fonction, et la
   leçon du 16/08 appliquée telle quelle.

   Sous « force row level security », écrire chez autrui NE LÈVE PAS : la
   ligne sort simplement du périmètre et PostgreSQL rapporte zéro ligne
   touchée. Un appelant qui ne regarde pas ce compte croit avoir enregistré.
   Ici, zéro ligne est une erreur, et elle se voit.

   La condition « tenant_id = moi » double la politique au lieu de s'y fier.
   Ce n'est pas de la défiance envers PostgreSQL : c'est que la politique et
   cette clause protègent de deux choses différentes. La politique protège
   d'une requête mal écrite ; la clause donne à « get diagnostics » de quoi
   distinguer « refusé » de « inexistant ».
   ========================================================================== */
create or replace function public.enregistrer_usage_ia(
  l_appel      bigint,
  l_issue      text,
  l_entree     integer default null,
  l_sortie     integer default null,
  l_recherches integer default null)
returns void
language plpgsql as $$
declare
  moi   uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  touche integer;
begin
  if moi is null then
    raise exception 'Aucun locataire posé : impossible d''enregistrer un usage.'
      using errcode = '42501';
  end if;

  update public.appels_ia a
     set issue          = l_issue,
         jetons_entree  = l_entree,
         jetons_sortie  = l_sortie,
         recherches_web = l_recherches
   where a.id = l_appel
     and a.tenant_id = moi;

  get diagnostics touche = row_count;
  if touche = 0 then
    raise exception 'Appel % introuvable pour ce locataire.', l_appel
      using errcode = '42501';
  end if;
end $$;

/* ==========================================================================
   LE TARIF, À UN SEUL ENDROIT

   Mis à jour le 18/08/2026 depuis platform.claude.com/docs/en/about-claude/pricing
   et la page de l'outil de recherche web :

     claude-sonnet-5   2 $ le million de jetons d'entrée
                      10 $ le million de jetons de sortie
     recherche web    10 $ les mille recherches, quel que soit le modèle

   UN MODÈLE INCONNU REND NULL, et c'est une décision, pas un oubli. Appliquer
   « au pif » le tarif de Sonnet à un modèle qu'on ne connaît pas produirait un
   chiffre plausible et faux — le pire des deux mondes. NULL se remarque, se
   somme à NULL, et se corrige en ajoutant une ligne ici.

   Les jetons de cache ne sont pas comptés : nous n'utilisons pas encore la
   mise en cache d'invite. Le jour où elle arrivera, il faudra une colonne de
   plus — pas une estimation de plus. Une colonne toujours nulle serait un
   petit mensonge dans le schéma.
   ========================================================================== */
create or replace function public.cout_ia_dollars(
  le_modele text, entree integer, sortie integer, recherches integer)
returns numeric
language sql immutable as $$
  select case le_modele
    when 'claude-sonnet-5' then
        coalesce(entree,     0)::numeric / 1000000 *  2
      + coalesce(sortie,     0)::numeric / 1000000 * 10
      + coalesce(recherches, 0)::numeric /    1000 * 10
    else null
  end;
$$;

/* ==========================================================================
   CE QUE ÇA A COÛTÉ, PAR MOIS ET PAR ROUTE

   CE QUI PROTÈGE CETTE VUE N'EST PAS CE QUE JE CROYAIS, ET LA MUTATION L'A
   MONTRÉ (18/08/2026).

   J'avais écrit ici que « security_invoker = true » était ce qui empêchait la
   vue de rendre les lignes de tous les locataires. En retirant l'option pour
   éprouver le contrôle, RIEN N'A CHANGÉ : le cloisonnement tenait toujours.

   L'explication est que le propriétaire de la vue est le COMPTE APPLICATIF,
   qui est aussi le propriétaire des tables — et « force row level security »
   soumet jusqu'au propriétaire. Sans « security_invoker », la vue s'exécute
   donc sous un rôle qui est de toute façon filtré, avec le même
   « app.tenant_id ». Le vrai gardien est le « force » posé par 02 et 04, pas
   l'option de la vue.

   ON GARDE L'OPTION quand même, et c'est un choix, pas une superstition : le
   jour où les vues appartiendraient à un rôle distinct du rôle applicatif —
   une séparation qu'on peut vouloir — elle redeviendrait le seul gardien. Une
   protection inutile aujourd'hui et nécessaire demain se garde ; ce qui ne se
   garde pas, c'est un commentaire qui se trompe de gardien. Croire que
   l'option suffit conduirait à retirer le « force » sans crainte.

   « mesures » à côté de « appels » n'est pas de la décoration : c'est ce qui
   permet de lire le reste. Une somme de jetons portant sur trois lignes
   mesurées sur dix est un chiffre faux, et rien d'autre ne le dirait.
   ========================================================================== */
create or replace view public.cout_ia_par_mois
with (security_invoker = true) as
  select a.tenant_id,
         date_trunc('month', a.cree_le)                     as mois,
         a.route,
         a.modele,
         count(*)::int                                      as appels,
         count(*) filter (where a.issue = 'ok')::int        as mesures,
         count(*) filter (where a.issue = 'echec')::int     as echecs,
         sum(a.jetons_entree)::bigint                       as jetons_entree,
         sum(a.jetons_sortie)::bigint                       as jetons_sortie,
         sum(a.recherches_web)::bigint                      as recherches_web,
         sum(public.cout_ia_dollars(a.modele, a.jetons_entree,
                                    a.jetons_sortie, a.recherches_web)) as dollars
    from public.appels_ia a
   group by a.tenant_id, date_trunc('month', a.cree_le), a.route, a.modele;

/* ==========================================================================
   LE CONTRÔLE DE LA MESURE

   Une instrumentation qui cesse de fonctionner ne fait pas de bruit : elle
   écrit simplement moins de lignes, et le total baisse doucement sans que
   personne ne s'en étonne. C'est exactement ce qui rend un faux vert
   dangereux — on continue de faire confiance à un chiffre qui a cessé d'être
   produit.

   Cette vue nomme les lignes qui NE DEVRAIENT PAS EXISTER :

     — restées « en vol » plus d'une heure (processus mort, ou l'appel à
       « enregistrer_usage_ia » a disparu du code) ;
     — déclarées abouties sans le moindre jeton (comptabilité cassée) ;
     — sans modèle (un appelant qui n'a pas passé le second argument).

   Elle doit rendre ZÉRO LIGNE. Le contrôle qui l'interroge éprouve d'abord
   qu'elle sait dire non — on ne fait pas confiance à une vérification qu'on
   n'a pas vue échouer.

   L'heure de délai n'est pas arbitraire : un appel avec recherche web dure
   des dizaines de secondes, jamais des minutes. Une heure laisse passer le
   pire cas légitime sans masquer un vrai défaut plus d'une heure.
   ========================================================================== */
create or replace view public.appels_ia_sans_mesure
with (security_invoker = true) as
  select a.id, a.tenant_id, a.route, a.modele, a.cree_le, a.issue,
         case
           when a.issue is null            then 'resté en vol'
           when a.issue = 'ok'
            and a.jetons_entree is null    then 'abouti sans jetons'
           when a.modele is null           then 'sans modèle'
         end as anomalie
    from public.appels_ia a
   /* L'EXCLUSION EST EN TÊTE, pas dans une des trois branches. Une ligne
      antérieure à l'instrument n'a ni modèle, ni issue, ni jetons : elle
      remplirait DEUX motifs sur trois. La sortir une fois, au-dessus, plutôt
      que de la sortir trois fois et d'en oublier une à la quatrième. */
   where a.issue is distinct from 'avant_mesure'
     and a.cree_le < now() - interval '1 hour'
     and (   a.issue is null
          or (a.issue = 'ok' and a.jetons_entree is null)
          or a.modele is null);

/* --------------------------------------------------------------------------
   REMETTRE LE CLOISONNEMENT

   Sans cette ligne, le compte applicatif — propriétaire de la table —
   échapperait à la politique posée par 04. Les données seraient intactes, les
   contrôles de contenu au vert, et l'écriture libre pour tout le monde.

   test-rejeu.mjs le vérifie deux fois : dans pg_class après le rejeu, et par
   la règle « qui lève doit remettre », qui lit ce fichier.
   -------------------------------------------------------------------------- */
alter table public.appels_ia force row level security;
