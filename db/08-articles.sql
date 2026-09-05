/* ===========================================================================
   LES ARTICLES DE RECHERCHE ENTRENT DANS LE CATALOGUE

   ---------------------------------------------------------------------------
   POURQUOI DANS « ouvrages » ET NON DANS UNE TABLE À PART

   La tentation était une seconde table : un article n'a ni couverture, ni
   ISBN, ni prêt, et porte une revue, un volume, un numéro. Deux tables
   auraient l'air plus propres.

   Elles auraient coûté le double de tout le reste. La clé partagée, les
   résumés mutualisés, les possessions, le cloisonnement, le quota, la
   visibilité en cascade, les sauvegardes, les contrôles — tout cela existe
   UNE fois, autour d'« ouvrages ». Le dupliquer pour changer cinq champs
   reviendrait à entretenir deux fois les mêmes propriétés, et à découvrir un
   jour qu'elles ont divergé.

   ET SURTOUT : LES RAYONS SONT LES MÊMES. C'est la décision qui tranche.
   « Décision, biais & rationalité » convient aussi bien à Kahneman & Tversky
   1979 qu'aux livres qui en sont issus, et voir les deux côte à côte sur un
   même sujet est précisément l'intérêt de la chose. Deux tables auraient
   rendu cette vue impossible sans une union à écrire partout.

   « Zone » reste une affaire d'ÉCRAN. Le formulaire d'un article ne montrera
   ni couverture ni prêt — mais c'est l'interface qui le décide, pas le
   schéma.

   ---------------------------------------------------------------------------
   LA CLÉ : « doi:10.1257/jep.5.1.193 »

   Le schéma prévoyait déjà des clés préfixées — « isbn:… » pour ce qui est
   mutualisable, « local:… » pour ce qui ne l'est pas. Le DOI s'y range sans
   rien changer : c'est un identifiant d'édition, unique, stable, et un article
   lu par dix personnes n'est catalogué qu'une fois.

   ---------------------------------------------------------------------------
   CE QUE CROSSREF DONNE, ET QUI CHANGE L'ÉCONOMIE

   Éprouvé le 19/08/2026 sur 10.1257/jep.5.1.193 (Kahneman, Knetsch & Thaler,
   Journal of Economic Perspectives, 1991) :

     — le RÉSUMÉ de l'éditeur, en clair. Pour un livre, un résumé coûte
       0,059 € et vient du modèle ; ici il est fourni, et c'est celui des
       auteurs. Le modèle ne sert plus qu'à traduire, s'il le faut.
     — les AUTEURS déjà structurés en « given » / « family ». Toute la
       gymnastique « Nom Prénom » que le modèle doit deviner pour les livres
       disparaît : il n'y a plus rien à deviner.
     — le NOMBRE DE CITATIONS. 3 531 pour cet article. C'est un fait, pas un
       jugement — le seul signal de portée qu'un ouvrage ne porte jamais.

   Autrement dit : un article coûte MOINS cher à cataloguer qu'un livre, et la
   fiche obtenue est plus sûre.

   ---------------------------------------------------------------------------
   DDL SEULEMENT — aucune écriture, donc aucune levée de politiques. La règle
   de test-rejeu.mjs le vérifiera d'elle-même.
   =========================================================================== */

/* ------------------------------------------------------------- Le type

   « livre » par défaut : les 347 possessions existantes sont des livres, et
   une valeur par défaut évite un remplissage rétroactif — donc une écriture,
   donc une levée de politiques, pour une information qu'on connaît déjà.

   La liste est FERMÉE. Un troisième type — thèse, rapport, chapitre — devra
   passer par une migration : c'est une décision de modèle, pas une saisie. */
alter table public.ouvrages
  add column if not exists type text not null default 'livre';

alter table public.ouvrages drop constraint if exists ouvrages_type_check;
alter table public.ouvrages add constraint ouvrages_type_check
  check (type in ('livre', 'article'));

/* --------------------------------------------------- Ce qu'un article porte

   « doi » est UNIQUE, comme « isbn » : deux notices pour le même DOI seraient
   deux fois le même article, et c'est exactement ce que le catalogue partagé
   sert à éviter.

   « citations » est un instantané, pas une vérité. Le compte de Crossref
   monte avec le temps ; la colonne dit ce qu'il valait au moment où la notice
   a été prise. On garde donc la date à côté — un nombre sans date se lit dans
   dix ans comme s'il était d'aujourd'hui.

   « resume_editeur » est le texte des AUTEURS, distinct du résumé produit par
   le modèle, qui vit dans « resumes_ouvrages ». Les confondre reviendrait à
   laisser une reformulation écraser une source — et l'on ne saurait plus
   laquelle on lit. */
alter table public.ouvrages
  add column if not exists doi              text,
  add column if not exists revue            text,
  add column if not exists volume           text,
  add column if not exists numero           text,
  add column if not exists citations        integer,
  add column if not exists citations_le     timestamptz,
  add column if not exists resume_editeur   text;

create unique index if not exists ouvrages_doi_unique
  on public.ouvrages (doi) where doi is not null;

/* Un article se cherche par sa revue bien plus souvent qu'un livre par son
   éditeur — c'est le premier filtre naturel d'une bibliographie. */
create index if not exists ouvrages_revue on public.ouvrages (revue)
  where revue is not null;

/* ---------------------------------------------------------------------------
   LA VUE EST REMPLACÉE D'UN BLOC, PAS MODIFIÉE PAR DIFFÉRENCE.

   « create or replace view » impose que la nouvelle définition commence par
   les mêmes colonnes, dans le même ordre. Il ne sait NI insérer au milieu, NI
   retirer. Les deux défauts ont été rencontrés à un jour d'intervalle :

     19/08, en recette : « ne peut pas modifier le nom de la colonne statut
     en avec_sources » — une colonne insérée au milieu.

     19/08, au banc d'essai : « cannot drop columns from view » — au deuxième
     passage, 03 proposait une vue PLUS COURTE que celle laissée par 08.

   Le second n'apparaît qu'au REJEU, et le premier que sur une base ayant déjà
   vécu. Deux filets différents, deux défauts différents, même cause.

   « drop » puis « create » n'a aucune de ces contraintes. Le bloc est enfermé
   dans une transaction : le DDL est transactionnel sous PostgreSQL, donc
   aucune autre session ne voit la vue disparaître — l'API continue de lire
   pendant la migration.

   Vérifié avant d'écrire : aucun objet de la base ne dépend de « livres ».
   Seul server.js la lit. Un « drop » sans CASCADE échouerait franchement si
   cela changeait un jour.
   --------------------------------------------------------------------------- */
/* ------------------------------------------------------------------------
   CETTE DÉFINITION NE VAUT QUE TANT QUE « possessions » PORTE LE STATUT
   — conditionnée le 05/09/2026, par 17-lectures.sql.

   La 17 déplace « statut » et « note » vers la table « lectures » et
   SUPPRIME les colonnes d'origine. Or les migrations sont REJOUÉES à chaque
   livraison, dans l'ordre des noms : ce fichier repasserait donc APRÈS que
   la colonne a disparu, et « create view … p.statut » échouerait — la
   livraison tomberait sur une base pourtant saine.

   La garde ne protège pas d'une erreur ; elle dit ce qui est vrai. Cette
   vue-ci est celle d'un schéma où la lecture appartient à la bibliothèque.
   Quand ce n'est plus le cas, c'est la 17 qui définit la vue, et elle seule.

   Sur une installation NEUVE, la colonne existe encore ici : le bloc
   s'exécute, puis 17 le remplace. Rien ne dépend de la vue entre les deux.
   ------------------------------------------------------------------------ */
do $garde$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'possessions'
                    and column_name = 'statut') then
    return;
  end if;

  execute 'drop view if exists public.livres';
  execute $vue$
    create view public.livres
    with (security_invoker = true) as
    select p.tenant_id,
           p.id,
           o.id as ouvrage_id,
           o.isbn, o.titre, o.auteur, o.editeur, o.annee, o.pages,
           o.cover_url, o.cover_statut,
           p.statut, p.note, p.categorie, p.sous_categorie, p.sphere, p.visibilite,
           p.ajoute_le, p.maj_le,
           o.avec_sources,
           o.type, o.doi, o.revue, o.volume, o.numero,
           o.citations, o.citations_le, o.resume_editeur
      from public.possessions p
      join public.ouvrages o on o.id = p.ouvrage_id
     where case
             when nullif(current_setting('app.tenant_id', true), '') is null
               then public.possession_publique(p)
             else p.tenant_id = current_setting('app.tenant_id', true)::uuid
           end;
  $vue$;
end $garde$;

