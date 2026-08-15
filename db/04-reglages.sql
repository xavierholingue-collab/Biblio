/* ===========================================================================
   LES RÉGLAGES : CE QUI EST MONTRÉ, DANS QUELLE LANGUE, ET CE QUE ÇA COÛTE

   Trois choses vivaient jusqu'ici hors de portée de l'utilisateur.

     LA LANGUE       existait dans « tenants », et rien ne permettait d'en
                     changer sans une requête SQL.
     LA VISIBILITÉ   se réglait à trois niveaux — bibliothèque, rayon, livre —
                     et ces trois niveaux n'avaient aucun écran.
     LE QUOTA        « quota_ia_mois » existait depuis le 14/08/2026. Il
                     n'était NI COMPTÉ NI APPLIQUÉ. Un champ mort, qui donnait
                     l'apparence d'une protection sans en être une.

   Ce dernier point mérite d'être dit franchement : un plafond inscrit dans
   un schéma et jamais vérifié est pire qu'un plafond absent. Absent, on sait
   qu'on n'est pas protégé. Inscrit, on le croit.

   ---------------------------------------------------------------------------
   POURQUOI LE QUOTA SE COMPTE DANS LA BASE ET NON DANS L'APPLICATION

   Le quota protège de l'argent. C'est la seule dépense du service : chaque
   résumé, chaque recommandation, chaque recherche de fiche est un appel
   facturé. Un invité qui lance « résumer toute ma bibliothèque » sur 400
   titres dépense sur le compte du propriétaire.

   Une vérification écrite dans l'API ne protège que les routes où on a pensé
   à l'écrire. Une route ajoutée dans six mois l'oubliera. On place donc le
   décompte dans une fonction que TOUTE route payante doit traverser, et qui
   REFUSE DE FONCTIONNER si le locataire n'est pas posé.

   C'est le point le plus important de ce fichier : le quota échoue FERMÉ.
   Sans contexte de locataire, un simple « select count(*) » rendrait zéro —
   c'est-à-dire un quota infini — et personne ne verrait rien. La fonction
   lève une erreur à la place.

   ---------------------------------------------------------------------------
   LA TABLE « tenants » PASSE SOUS CLOISONNEMENT, ET C'EST UN CHANGEMENT

   Jusqu'ici elle en était volontairement exclue : l'authentification la lit
   AVANT qu'un locataire soit établi, elle ne pouvait donc pas dépendre de
   l'un d'eux. Cela restait sans danger tant que personne n'y écrivait.

   Le menu de réglages y écrit. Sans politique, une faute de frappe dans une
   route — un « where id = $1 » oublié — changerait la langue et la
   visibilité de TOUT LE MONDE. On ne veut pas dépendre d'un filtre écrit à
   la main : c'est exactement ce que la bascule du 15/08 a supprimé partout
   ailleurs.

   La lecture reste donc ouverte à tous — l'authentification et les pages
   publiques en dépendent — mais l'ÉCRITURE est bornée à sa propre ligne par
   PostgreSQL.

   CE QUE CELA INTERDIT, ET C'EST VOULU : plus personne ne peut CRÉER un
   locataire par le chemin applicatif ordinaire. La future invitation d'un
   ami devra lever explicitement la politique, comme le font les migrations.
   Créer un compte est un geste d'administration, pas une requête d'API.

   ---------------------------------------------------------------------------
   REJOUABLE, et pour la même raison que les précédents : ce fichier LÈVE les
   politiques avant de travailler et les REMET à la fin. Une migration qui
   s'exécute sous le cloisonnement qu'elle installe est la famille de défauts
   qui a coûté trois arrêts de livraison cette semaine.
   =========================================================================== */

/* --------------------------------------------------------------------------
   LEVER LE CLOISONNEMENT AVANT DE TRAVAILLER

   « force row level security » soumet jusqu'au PROPRIÉTAIRE des tables, et
   le compte applicatif est ce propriétaire. Au deuxième passage, ce fichier
   travaillerait donc sous ses propres politiques.
   -------------------------------------------------------------------------- */
do $$
declare t text;
begin
  foreach t in array array['tenants', 'appels_ia']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I no force row level security', t);
    end if;
  end loop;
end $$;

/* ----------------------------------------------------- Le journal des appels

   UNE LIGNE PAR APPEL, pas un compteur mensuel incrémenté.

   Un compteur serait plus court. Mais le jour où quelqu'un demande « d'où
   viennent mes 40 appels ? », un compteur ne sait rien répondre. Le journal
   sait. Et son coût est dérisoire : un locataire à 10 appels par mois écrit
   120 lignes par an.

   On ne journalise PAS le contenu — ni le titre, ni la question, ni la
   réponse. La route et l'heure suffisent à compter et à expliquer. Garder le
   reste serait constituer un historique de lecture dont personne n'a besoin.
   -------------------------------------------------------------------------- */
create table if not exists public.appels_ia (
  id        bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  route     text not null,
  cree_le   timestamptz not null default now()
);

/* L'index porte l'ordre exact de la question posée à chaque appel payant :
   « combien pour CE locataire depuis le début du mois ». Sans lui, le
   décompte parcourt toute la table — et il tourne avant chaque résumé. */
create index if not exists appels_ia_tenant_date
  on public.appels_ia (tenant_id, cree_le desc);

/* ------------------------------------------------------------ Cloisonnement */

alter table public.appels_ia enable row level security;
alter table public.tenants   enable row level security;

drop policy if exists appels_ia_locataire on public.appels_ia;
create policy appels_ia_locataire on public.appels_ia
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* LECTURE OUVERTE, et il faut assumer ce qu'elle découvre.

   « tenants » porte un identifiant d'URL, un nom, une langue, une
   visibilité et un plafond. Une connexion SQL directe peut donc lister les
   utilisateurs du service.

   C'est le prix d'une contrainte réelle : l'authentification lit cette table
   AVANT qu'un locataire soit posé — c'est elle qui l'établit — et les pages
   publiques la lisent SANS locataire du tout. Une politique de lecture
   cloisonnée les casserait toutes les deux.

   Aucune route de l'API n'expose cette table en bloc. Et le nom d'un
   utilisateur dont la bibliothèque est publique est de toute façon affiché
   sur sa page publique : ce n'est pas ce qu'on protège ici. Ce qu'on protège,
   c'est l'ÉCRITURE. */
drop policy if exists tenants_lecture on public.tenants;
create policy tenants_lecture on public.tenants for select using (true);

drop policy if exists tenants_reglages on public.tenants;
create policy tenants_reglages on public.tenants for update
  using      (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* Pas de politique d'insertion ni de suppression : sous « force », leur
   absence vaut refus. Créer ou supprimer un locataire passe par une
   migration, jamais par l'application. */

/* ==========================================================================
   LE DÉCOMPTE

   Deux fonctions, et la séparation entre les deux n'est pas cosmétique :
   LIRE le quota est une opération de consultation, que l'écran de réglages
   fait à chaque affichage. LE CONSOMMER engage de l'argent.
   ========================================================================== */

/* Combien d'appels ce mois-ci, pour le locataire courant.

   NE PAS METTRE « security definer » ICI. La fonction doit rester soumise
   aux politiques : c'est ce qui garantit qu'elle ne peut pas compter les
   appels d'un autre, même en cas d'erreur dans la clause « where ». */
create or replace function public.appels_ia_du_mois()
returns integer
language plpgsql stable as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  n   integer;
begin
  /* ÉCHOUER FERMÉ.
     Sans cette levée, un contexte visiteur donnerait un compte de zéro —
     c'est-à-dire un quota jamais atteint, donc jamais appliqué. Le défaut
     serait parfaitement silencieux : aucune erreur, aucun refus, juste une
     facture. */
  if moi is null then
    raise exception 'Aucun locataire posé : le quota ne peut pas être compté.'
      using errcode = '42501';
  end if;

  select count(*) into n
    from public.appels_ia
   where tenant_id = moi
     and cree_le >= date_trunc('month', now());
  return n;
end $$;

/* Consommer un appel, ou refuser.

   LE VERROU N'EST PAS UNE PRÉCAUTION DÉCORATIVE.

   Sans lui : deux requêtes simultanées d'un même locataire à 9 appels sur 10
   lisent toutes les deux « 9 », concluent toutes les deux « il reste de la
   place », et écrivent toutes les deux. Le plafond de 10 laisse passer 11.

   Ce n'est pas un cas d'école : l'écran de bibliothèque peut lancer
   plusieurs résumés d'affilée, et le navigateur les envoie en parallèle.

   « for update » sur la ligne du locataire sérialise les appels d'un MÊME
   locataire, et seulement de celui-là. Deux personnes différentes ne
   s'attendent pas.

   ORDRE : on consomme AVANT d'appeler le modèle. Un appel qui échoue est
   donc décompté. C'est délibéré — ce qui coûte, c'est la tentative, et
   l'ordre inverse laisserait une panne au mauvais moment effacer la trace
   d'un appel déjà facturé. */
create or replace function public.consommer_appel_ia(la_route text)
returns table (consomme integer, plafond integer)
language plpgsql as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  n   integer;
  p   integer;
begin
  if moi is null then
    raise exception 'Aucun locataire posé : impossible de décompter un appel.'
      using errcode = '42501';
  end if;

  -- Le verrou et la lecture du plafond, en un seul geste.
  select t.quota_ia_mois into p
    from public.tenants t where t.id = moi for update;

  if p is null then
    raise exception 'Locataire inconnu.' using errcode = '42501';
  end if;

  select count(*) into n
    from public.appels_ia
   where tenant_id = moi
     and cree_le >= date_trunc('month', now());

  if n >= p then
    /* Code « 53400 » : configuration_limit_exceeded. Un code distinct permet
       à l'API de répondre 429 plutôt qu'un 500 indifférencié — la différence
       entre « revenez le mois prochain » et « c'est cassé ». */
    raise exception 'Quota mensuel atteint : % appels sur %.', n, p
      using errcode = '53400';
  end if;

  insert into public.appels_ia (tenant_id, route) values (moi, la_route);
  return query select n + 1, p;
end $$;

/* ==========================================================================
   CE QUI EST RÉELLEMENT PUBLIÉ

   L'écran de réglages doit montrer l'effet, pas le réglage. « Rayon :
   hérité » ne dit rien à personne ; « Rayon : hérité — donc privé, car votre
   bibliothèque l'est » se comprend.

   La règle de cascade vit dans possession_publique (03-catalogue.sql), et
   c'est ELLE qui fait foi. La vue ci-dessous ne la réimplémente pas : elle
   la rappelle, en comptant par rayon ce qui sort effectivement.

   RÉÉCRIRE LA RÈGLE ICI SERAIT LE DÉFAUT À NE PAS FAIRE. Deux copies d'une
   règle de visibilité divergent toujours, et c'est la copie affichée qui
   rassure pendant que l'autre publie.
   ========================================================================== */
create or replace view public.rayons_visibilite
with (security_invoker = true) as
  select p.tenant_id,
         p.categorie,
         p.sous_categorie,
         coalesce(r.visibilite, 'heritee')            as reglage,
         count(*)::int                                as livres,
         count(*) filter (where public.possession_publique(p))::int as publies
    from public.possessions p
    left join public.rayons_reglages r
      on r.tenant_id = p.tenant_id
     and r.categorie = p.categorie
     and r.sous_categorie = p.sous_categorie
   /* CETTE CLAUSE N'EST PAS UNE PROTECTION, C'EST UNE DÉFINITION.
    *
    * Défaut trouvé le 16/08/2026 en écrivant le contrôle. Sans elle, la
    * politique de lecture de « possessions » faisait son travail — elle
    * laisse voir les possessions PUBLIQUES de tout le monde, c'est ce qui
    * fait vivre les pages publiques — et l'écran de réglages de Bob
    * affichait donc les rayons de Xavier, avec leur nombre de livres.
    *
    * Rien ne fuyait qui ne fût déjà public. Mais on aurait proposé à Bob de
    * régler la visibilité d'un rayon qui ne lui appartient pas, et le
    * réglage aurait porté sur SON rayon du même nom. Un écran qui ment sur
    * ce qu'il montre finit par faire faire des gestes qu'on ne voulait pas.
    *
    * Sans locataire posé, la comparaison porte sur NULL : aucune ligne. */
   where p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   group by p.tenant_id, p.categorie, p.sous_categorie, r.visibilite;

/* --------------------------------------------------------------------------
   REMETTRE LE CLOISONNEMENT

   Sans ces deux lignes, le compte applicatif — propriétaire des tables —
   échapperait aux politiques qu'on vient d'écrire. Les données seraient
   intactes, les contrôles de contenu au vert, et l'écriture libre.

   test-rejeu.mjs vérifie cet état dans pg_class, pas dans les données :
   c'est le seul contrôle qui puisse voir un oubli ici.
   -------------------------------------------------------------------------- */
alter table public.appels_ia force row level security;
alter table public.tenants   force row level security;
