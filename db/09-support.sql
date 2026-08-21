/* ===========================================================================
   CE QUI CONTIENT L'ARTICLE N'EST PAS TOUJOURS UNE REVUE

   ---------------------------------------------------------------------------
   CE QUI L'A RÉVÉLÉ

   Premier article ajouté en production, le 21/08/2026 :
   10.1007/978-1-349-02701-9_2 — Herzberg, « One More Time: How Do You
   Motivate Employees? ». La fiche annonçait :

     Revue : Job Satisfaction — A Reader        (c'est un LIVRE)
     Année : 1976                               (le texte est de 1968)

   Crossref déclarait pourtant, dans le même message : « type »:
   « book-chapter ». Le champ était là, à côté de ceux que je lisais. Je ne
   l'ai pas lu parce que je cherchais des articles, et j'ai supposé que ce
   que Crossref appelle « container-title » était une revue.

   C'est la même erreur que l'ISBN qui identifie une édition et non une
   œuvre, transposée au DOI : un identifiant désigne un OBJET PUBLIÉ précis,
   pas le texte dont il porte le nom. Le DOI donné désigne bien ce
   chapitre-là, de ce recueil-là, de 1976. Rien n'est faux dans la notice —
   ce qui était faux, c'était l'étiquette que je posais dessus.

   ---------------------------------------------------------------------------
   POURQUOI « revue » GARDE UN NOM QUI SERA PARFOIS FAUX

   Le nom honnête serait « contenant ». Je ne renomme pas, et la raison
   tient au REJEU, pas au confort.

   08-articles.sql écrit « add column if not exists revue » et construit la
   vue avec « o.revue ». Ces fichiers sont rejoués à chaque déploiement. Si
   je renomme la colonne ici, le prochain passage de 08 recréera une colonne
   « revue » VIDE à côté de « contenant » qui, elle, porte les données — et
   la vue exposerait la vide. Rien ne lèverait. Pour renommer proprement il
   faudrait réécrire 08, donc changer un fichier déjà appliqué à la
   production, ce qui est exactement ce que la numérotation sert à éviter.

   Le coût du nom imparfait est un commentaire. Le coût du renommage est une
   classe de défaut silencieux. On garde le commentaire.

   ---------------------------------------------------------------------------
   ET « pagination », QUI EXISTAIT DÉJÀ SANS EXISTER

   chercherParDoi() rendait « pagination: texte(m.page) » depuis le premier
   jour. Aucune colonne ne l'accueillait, aucun écran ne l'affichait : la
   donnée était calculée puis jetée à chaque appel. Une bibliographie sans
   la plage de pages ne permet pas de citer — c'est « p. 17-32 » qui manque
   pour référencer un chapitre.

   Elle est TEXTE et non entière : « 17-32 », « e0234561 », « 17-32, 45 ».
   « pages » (entier) reste le nombre de pages d'un livre. Deux notions
   différentes, deux colonnes.

   ---------------------------------------------------------------------------
   LA FORME EN SQL, LE VOCABULAIRE EN JS — comme 06-source-notice.sql.

   La base refuse ce qui n'a pas la forme d'un jeton court ; la liste des
   jetons vit dans le code, où elle peut s'allonger sans migration. Crossref
   publie une trentaine de types et en ajoute : figer la liste ici
   obligerait à migrer la base le jour où un « peer-review » se présente.

   DDL SEULEMENT — aucune écriture, donc aucune levée de politiques.
   =========================================================================== */

alter table public.ouvrages
  add column if not exists support     text,
  add column if not exists pagination  text;

alter table public.ouvrages drop constraint if exists ouvrages_support_forme;
alter table public.ouvrages add constraint ouvrages_support_forme
  check (support is null or support ~ '^[a-z]{3,16}$');

/* --------------------------------------------------------------------------
   LA VUE, D'UN BLOC — voir 08-articles.sql pour le détail du raisonnement.

   Rappel de l'ordre : 03 puis 08 puis 09, par ordre alphabétique. Le DERNIER
   fichier gagne, en silence, depuis que « drop » a remplacé « create or
   replace » — c'est justement pourquoi verifier-migration.sql affirme
   désormais la présence de chaque colonne d'article au lieu de compter sur
   une erreur de PostgreSQL pour la signaler.
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
       p.statut, p.note, p.categorie, p.sous_categorie, p.sphere, p.visibilite,
       p.ajoute_le, p.maj_le,
       o.avec_sources,
       o.type, o.doi, o.revue, o.volume, o.numero,
       o.citations, o.citations_le, o.resume_editeur,
       o.support, o.pagination
  from public.possessions p
  join public.ouvrages o on o.id = p.ouvrage_id
 where case
         when nullif(current_setting('app.tenant_id', true), '') is null
           then public.possession_publique(p)
         else p.tenant_id = current_setting('app.tenant_id', true)::uuid
       end;
commit;
