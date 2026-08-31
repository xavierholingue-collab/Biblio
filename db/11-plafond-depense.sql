/* ===========================================================================
   CE QU'UN COMPTE A LE DROIT DE DÉPENSER — ET NON COMBIEN D'APPELS IL FAIT

   ---------------------------------------------------------------------------
   LE QUOTA COMPTAIT UN SUBSTITUT

   « quota_ia_mois » compte les APPELS. Or vos propres mesures, relevées le
   19/08/2026 en production :

     /api/recherche-livre              17 appels   1,4677 $   → 0,086 $ l'appel
     /api/recherche-livre-classement    2 appels   0,0049 $   → 0,0025 $ l'appel

   UN FACTEUR TRENTE-QUATRE. Dix résumés et dix scans consomment le même
   quota et coûtent trente-quatre fois moins l'un que l'autre. Le compteur
   mesure donc l'activité, pas la dépense — alors que c'est la dépense qui
   sort de votre poche.

   C'est exactement la famille de défaut que ce dépôt traque : un contrôle
   qui mesure ce qui est facile à compter plutôt que ce qu'il prétend
   protéger. Le limiteur de liens comptait les IP en croyant protéger des
   adresses ; celui-ci comptait les appels en croyant protéger un budget.

   ---------------------------------------------------------------------------
   DEUX PLAFONDS, ET CE N'EST PAS UNE REDONDANCE

   Ils protègent de deux pannes différentes, et aucun ne couvre l'autre :

     quota_ia_mois   protège de la BOUCLE FOLLE — beaucoup d'appels, chacun
                     dérisoire. Mille classements à 0,0025 $ ne déclenchent
                     aucun plafond de dépense raisonnable, et pourtant
                     quelque chose ne va pas.

     plafond_usd     protège du PORTEFEUILLE — peu d'appels, chacun cher. Dix
                     résumés avec recherche web passent sous un quota de
                     cinquante appels et coûtent presque un dollar.

   Garder les deux évite aussi de casser le contrat de
   « consommer_appel_ia », dont deux contrôles lisent le résultat par
   position. Sa forme ne change pas.

   ---------------------------------------------------------------------------
   UN APPEL NON MESURÉ EST PRÉSUMÉ CHER

   « cout_ia_dollars » rend NULL pour un modèle inconnu, et « issue » vaut
   « sans_mesure » quand l'enregistrement de l'usage a échoué. Sommer
   naïvement ferait de ces appels-là des appels GRATUITS aux yeux du plafond.

   Ce serait un trou, et un trou perversement incitatif : plus la mesure
   tombe en panne, plus on peut dépenser. On présume donc un coût élevé pour
   ce qui n'a pas été mesuré — au-dessus du plus cher qu'on ait observé.

   La pression est ainsi dans le bon sens : une instrumentation cassée
   RESSERRE le plafond au lieu de l'ouvrir, et cela se remarque.

   Les lignes « avant_mesure » sont exclues : elles précèdent l'instrument du
   18/08 et ne portent aucun jeton. Les présumer chères ferait sauter le
   plafond de Xavier au premier appel, pour des appels vieux d'une semaine.

   ---------------------------------------------------------------------------
   LE DÉPASSEMENT EST BORNÉ, PAS NUL

   Le coût d'un appel n'est connu QU'APRÈS l'appel. On vérifie donc la
   dépense DÉJÀ ACCUMULÉE, ce qui autorise un dernier appel à cheval sur le
   plafond. Le dépassement maximal est le coût d'un appel — de l'ordre de
   0,09 $. C'est écrit ici pour n'avoir pas à le redécouvrir en lisant un
   compte à 0,58 $ sur un plafond de 0,50 $.

   ---------------------------------------------------------------------------
   POURQUOI 0,50 $ PAR MOIS POUR UN COMPTE NEUF

   Ce que cela achète, aux prix mesurés :

     ~200 identifications par catalogue  (0,0025 $ pièce)
     ~ 10 fiches complètes avec résumé   (0,046 $ pièce)
     un mélange réaliste : 150 scans + 3 résumés = 0,51 $

   Assez pour cataloguer une vraie bibliothèque de départ sans se heurter au
   mur, et assez peu pour que vingt inscrits gratuits coûtent dix dollars par
   mois dans le pire des cas — pas cent.

   LE CHIFFRE EST À VOUS. Il se change ici, ou par locataire avec
   « regler_plafond ». Ce qui compte est qu'il soit maintenant EXPRIMÉ EN
   ARGENT, donc décidable.
   =========================================================================== */

alter table public.tenants
  add column if not exists plafond_usd numeric(8,3) not null default 0.500;

/* --------------------------------------------------------------------------
   0,900 — ET CE CHIFFRE N'EST PLUS LIBRE : IL DÉCOULE DE L'AUTRE

   31/08/2026. En écrivant la page d'accueil, il a fallu dire au visiteur ce
   que l'offre gratuite lui donne. Et les deux plafonds ne disaient pas la
   même chose :

     quota_ia_mois = 10 appels
     plafond_usd   = 0,500 $
     un résumé     = 0,086 $   →  le portefeuille ferme au 6e, pas au 10e

   Annoncer « une dizaine de demandes » aurait donc été faux dès qu'on
   demande la fonction la plus utile. Non par mauvaise foi : parce que deux
   bornes posées séparément, à quinze jours d'intervalle, avaient dérivé sans
   que rien ne le signale.

   LA RÈGLE, DÉSORMAIS :

     plafond_usd  >=  quota_ia_mois  ×  coût du plus cher appel mesuré

   10 × 0,086 = 0,86 $, arrondi à 0,900. Le quota devient la borne qui se
   voit, le plafond d'argent redevient ce qu'il doit être : un garde-fou
   contre l'imprévu, pas la limite réelle.

   « test-plafonds-coherents.mjs » vérifie l'inégalité. Changer l'un des deux
   sans l'autre fera désormais échouer la livraison, avec le calcul en clair.

   « ALTER COLUMN SET DEFAULT » et non « ADD COLUMN » : la colonne existe
   déjà en production, et « add column if not exists » ne toucherait pas son
   défaut. Le rejeu resterait vert en ne changeant rien — un silence de plus.
   -------------------------------------------------------------------------- */
alter table public.tenants alter column plafond_usd set default 0.900;

alter table public.tenants drop constraint if exists tenants_plafond_borne;
alter table public.tenants add constraint tenants_plafond_borne
  check (plafond_usd >= 0 and plafond_usd <= 1000);

/* --------------------------------------------------------------------------
   CE QUE CE LOCATAIRE A DÉPENSÉ CE MOIS-CI

   PAS « security definer ». La fonction doit rester soumise aux politiques :
   c'est ce qui garantit qu'elle ne peut pas additionner les appels d'un
   autre, même si la clause « where » était fautive. Même raisonnement que
   « appels_ia_du_mois », écrit le 16/08.
   -------------------------------------------------------------------------- */
create or replace function public.depense_ia_du_mois()
returns numeric
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  d   numeric;
begin
  /* ÉCHOUER FERMÉ. Sans locataire posé, la somme vaudrait zéro — c'est-à-dire
     un plafond jamais atteint, donc jamais appliqué, et parfaitement
     silencieux. La même leçon que « appels_ia_du_mois ». */
  if moi is null then
    raise exception 'Aucun locataire posé : la dépense ne peut pas être comptée.'
      using errcode = '42501';
  end if;

  select coalesce(sum(
           coalesce(
             public.cout_ia_dollars(a.modele, a.jetons_entree,
                                    a.jetons_sortie, a.recherches_web),
             0.100)          -- non mesuré : présumé plus cher que le pire mesuré
         ), 0)
    into d
    from public.appels_ia a
   where a.tenant_id = moi
     and a.cree_le >= date_trunc('month', now())
     and a.issue is distinct from 'avant_mesure';

  return d;
end $$;

/* --------------------------------------------------------------------------
   LE DÉCOMPTE, AVEC SES DEUX PLAFONDS

   La forme du résultat NE CHANGE PAS — « consomme, plafond, appel_id », dans
   cet ordre. Deux contrôles la lisent par position, et 05-usage-ia.sql le dit
   déjà en toutes lettres. Ajouter une colonne au milieu casserait les deux
   sans qu'aucun ne l'annonce.
   -------------------------------------------------------------------------- */
create or replace function public.consommer_appel_ia(
  la_route text, le_modele text default null)
returns table (consomme integer, plafond integer, appel_id bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  n   integer;
  p   integer;
  pu  numeric;
  d   numeric;
  nouvel_id bigint;
begin
  if moi is null then
    raise exception 'Aucun locataire posé : impossible de décompter un appel.'
      using errcode = '42501';
  end if;

  -- Le verrou et la lecture des DEUX plafonds, en un seul geste. Sans
  -- « for update », huit appels simultanés passent un plafond de trois.
  select t.quota_ia_mois, t.plafond_usd into p, pu
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

  /* LE PLAFOND D'ARGENT, APRÈS CELUI DES APPELS.
     Le message dit des dollars, pas des appels : c'est la seule façon que la
     personne comprenne ce qui la limite, et que vous sachiez ce que ça vous
     a coûté. Un « quota atteint » sans montant n'apprend rien à personne. */
  d := public.depense_ia_du_mois();
  if d >= pu then
    raise exception 'Plafond de dépense atteint : % $ ce mois-ci sur % $.',
      round(d, 3), round(pu, 3)
      using errcode = '53400';
  end if;

  insert into public.appels_ia (tenant_id, route, modele)
       values (moi, la_route, le_modele)
    returning public.appels_ia.id into nouvel_id;

  return query select n + 1, p, nouvel_id;
end $$;

/* ===========================================================================
   LE PLAFOND NE SE RELÈVE PAS TOUT SEUL

   TROUVÉ LE 21/08/2026. La politique « tenants_reglages » autorise l'UPDATE
   de N'IMPORTE QUELLE colonne de sa propre ligne — « quota_ia_mois » compris.
   Seule l'API l'empêchait, en n'écrivant que « langue » et « visibilite ».

   Or le commentaire de cette route dit, mot pour mot : « la sécurité ne tient
   pas au code de l'API. Elle tient à PostgreSQL. » Pour le quota, c'était
   faux : elle tenait à une liste blanche en JavaScript, et le jour où une
   route ajouterait un champ, elle tomberait.

   ---------------------------------------------------------------------------
   POURQUOI UN DÉCLENCHEUR ET NON UN PRIVILÈGE DE COLONNE

   J'ai d'abord essayé « revoke update (quota_ia_mois) ». ÇA NE MORD PAS, et
   la raison est instructive : les privilèges de colonne S'AJOUTENT à ceux de
   la table. Le propriétaire a UPDATE sur « tenants » entière, donc
   « has_column_privilege » reste vrai et l'ACL reste vide. Il faudrait
   retirer UPDATE sur la table puis le rendre colonne par colonne — ce qui
   casse au premier ajout de colonne oublié.

   Éprouvé, pas supposé : la tentative est consignée parce qu'elle a l'air
   raisonnable et qu'un autre s'y essaierait.

   Le déclencheur, lui, échoue par un message qui NOMME la cause, au lieu
   d'un « permission denied for column » qui laisse chercher.
   =========================================================================== */
create or replace function public.tenants_garde_tarification()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  /* IL NE GARDE QUE LES ÉCRITURES D'APPLICATION, et ce n'est pas un
     substitut — c'est une déduction.

     La politique « tenants_reglages » borne l'UPDATE à
     « id = current_setting('app.tenant_id')::uuid ». Sans locataire posé,
     cette comparaison vaut NULL : AUCUNE LIGNE n'est visible, donc aucune
     écriture applicative n'est possible. Toute écriture arrivant sans
     locataire posé vient donc nécessairement d'un compte qui contourne les
     politiques — psql en superutilisateur, ou le banc d'essai.

     Or celui-là a déjà tous les droits sur la base : lui interdire une
     colonne serait du théâtre. Ce qu'on protège est le chemin par lequel un
     UTILISATEUR pourrait relever son propre plafond.

     PREMIÈRE VERSION SANS CETTE CONDITION, et elle a cassé le jeu d'essai :
     test-usage-ia.mjs règle le quota par un update direct pour éprouver le
     refus, et « locataire() » du banc fait un upsert. Le garde-fou faisait
     son travail — sur des écritures qui n'étaient pas la menace. Un contrôle
     qui gêne l'administration légitime finit par être retiré, et il emporte
     alors les cas où il avait raison. */
  if nullif(current_setting('app.tenant_id', true), '') is not null
     and (new.quota_ia_mois is distinct from old.quota_ia_mois
          or new.plafond_usd is distinct from old.plafond_usd)
     and coalesce(nullif(current_setting('app.tarification', true), ''), '')
         <> 'en cours'
  then
    raise exception 'Le quota et le plafond de dépense ne se changent pas par '
      'ce chemin.'
      using errcode = '42501',
            hint = 'public.regler_tarification() est le seul endroit prévu.';
  end if;
  return new;
end $$;

drop trigger if exists tenants_garde_tarification on public.tenants;
create trigger tenants_garde_tarification
  before update on public.tenants
  for each row execute function public.tenants_garde_tarification();

/* --------------------------------------------------------------------------
   LA PORTE NOMMÉE, comme pour l'inscription.

   Le drapeau est TRANSACTION-LOCAL : une connexion reprise dans le pool ne le
   porte jamais d'une requête à l'autre. C'est le défaut classique des
   réglages de session, et celui qui rendrait cette porte grande ouverte.

   Ce n'est pas un rempart contre du SQL arbitraire — celui-là poserait le
   drapeau lui-même. C'est un rempart contre l'ACCIDENT, et surtout le SEUL
   ENDROIT À RELIRE quand on se demande qui peut changer un plafond.

   Le jour où Lisia encaissera 2,99 €, c'est par ici que passera le
   relèvement. Elle existe donc avant d'être utile, et cela vaut mieux que
   l'inverse.
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
           plafond_usd   = le_plafond
     where t.id = le_tenant
    returning t.id, t.quota_ia_mois, t.plafond_usd;
end $$;

revoke all on function public.regler_tarification(uuid, integer, numeric) from public;

/* --------------------------------------------------------------------------
   CE QUE L'ENSEMBLE DES LOCATAIRES A COÛTÉ CE MOIS-CI

   POUR UN ŒIL PRIVILÉGIÉ, et c'est le point. « appels_ia » est sous « force
   row level security » : l'application ne verra jamais que sa propre ligne.
   Cette vue s'interroge depuis psql, en superutilisateur, quand on veut
   savoir ce que le service coûte réellement.

     sudo -u postgres psql -d biblio -c 'select * from cout_ia_par_locataire'

   Sans elle, la seule façon de connaître la facture serait de la recevoir.

   ---------------------------------------------------------------------------
   « security_invoker » EST INDISPENSABLE, ET JE L'AVAIS OUBLIÉ — 22/08/2026

   Livrée sans cette option, la vue rendait ZÉRO LIGNE, même interrogée en
   superutilisateur. Une vue s'exécute par défaut avec les droits de son
   PROPRIÉTAIRE — ici le compte applicatif, qui est aussi le propriétaire des
   tables, et que « force row level security » soumet aux politiques comme
   tout le monde. Sans locataire posé, la politique ne rend rien.

   « security_invoker » la fait s'exécuter avec les droits de CELUI QUI
   INTERROGE : postgres, qui contourne les politiques et voit tout.

   L'ironie est que cette explication était déjà écrite, mot pour mot, dans
   05-usage-ia.sql — le fichier que j'étendais, à propos de la vue voisine.
   Je l'avais lue le matin même. Connaître un piège ne suffit pas ; il faut se
   demander à chaque vue si on vient d'y tomber.

   Le symptôme est le pire qui soit : pas d'erreur, pas de refus, un tableau
   vide qui ressemble à « aucun appel ce mois-ci ». On conclut sur l'usage au
   lieu de la configuration — exactement comme pour la mesure d'audience,
   quelques heures plus tôt.
   -------------------------------------------------------------------------- */
create or replace view public.cout_ia_par_locataire
with (security_invoker = true) as
  select t.identifiant,
         t.plafond_usd,
         count(*)::int                                       as appels,
         count(*) filter (where a.issue <> 'ok')::int        as non_mesures,
         round(sum(coalesce(
           public.cout_ia_dollars(a.modele, a.jetons_entree,
                                  a.jetons_sortie, a.recherches_web),
           0.100)), 4)                                       as dollars,
         max(a.cree_le)                                      as dernier_appel
    from public.appels_ia a
    join public.tenants t on t.id = a.tenant_id
   where a.cree_le >= date_trunc('month', now())
     and a.issue is distinct from 'avant_mesure'
   group by t.identifiant, t.plafond_usd
   order by 5 desc;
