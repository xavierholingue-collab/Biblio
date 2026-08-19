/* ===========================================================================
   « ACADÉMIQUE » DEVIENT « SAVOIRS »

   ---------------------------------------------------------------------------
   POURQUOI LE RENOMMAGE — LA BASE L'A DIT AVANT NOUS

   Relevé le 19/08/2026, sur 347 possessions :

     Académique   265   soit 76 %
     Roman         44
     BD            38

   Et dans ces 265 : « Art & histoire de l'art » 19 — sixième rayon de toute
   la bibliothèque —, « Psychologie & développement personnel » 17,
   « Management & leadership » 32, « Communication & influence » 12,
   « Gastronomie & œnologie » 3. Rien de tout cela n'est académique.

   La catégorie n'a jamais voulu dire « académique ». Elle a toujours voulu
   dire « ce qui n'est pas de la fiction » — et le nom mentait bien avant que
   des livres de vin ne le rendent visible.

   ZÉRO « NON CLASSÉ » DANS TOUTE LA BASE. C'est ce qui rendait le défaut
   invisible : la taxonomie trouve toujours une case, donc rien ne signale
   qu'elle est fausse. Un classement erroné ne se voit jamais dans les
   données ; il se voit à l'œil, sur une étiquette qui choque.

   ---------------------------------------------------------------------------
   POURQUOI PAS UNE QUATRIÈME CATÉGORIE

   Elle ne réduirait pas les 76 %, elle en déplacerait vingt. Le niveau
   « catégorie » ne porte presque aucune information pour ces 265 ouvrages :
   c'est le RAYON qui travaille, avec quatorze valeurs réparties de 3 à 43.
   Pour Roman et BD, en revanche, la catégorie dit une forme, et c'est réel.

   On assume donc trois cases : deux formes, et le reste.

   ---------------------------------------------------------------------------
   « avec_sources » : UNE DIMENSION, PAS UNE CATÉGORIE

   La proposition initiale était de garder « Académique » pour les auteurs
   ayant publié en revues à comité de lecture. L'intention était juste — on
   veut distinguer un ouvrage argumenté d'un beau livre — mais le critère
   portait sur l'AUTEUR et non sur le LIVRE.

   Contre-exemple pris dans cette base même : le rayon « Décision, biais &
   rationalité », 27 ouvrages, est celui de Kahneman, Thaler, Ariely. Tous ont
   publié en revues à comité de lecture ; aucun de ces livres n'est
   académique. Le critère les aurait tous basculés du mauvais côté.

   Le registre TRAVERSE les catégories : un livre d'art peut être savant, un
   livre de management anecdotique, une bande dessinée documentaire. Une
   dimension perpendiculaire ne se range pas dans un axe — elle mérite sa
   colonne, comme « sphere » qui cohabite déjà sans déformer personne.

   TROIS ÉTATS, ET LE TROISIÈME EST LE PLUS IMPORTANT :
     true   l'ouvrage porte des notes, une bibliographie, un appareil critique
     false  il n'en porte pas — ce n'est pas un reproche, c'est un fait
     NULL   on ne sait pas, et on ne prétend pas savoir

   NULL est le défaut, et il doit le rester à l'affichage : « non renseigné »
   n'est pas « non sourcé ». Même règle que « visibilite » depuis le 16/08 —
   l'absence d'information n'est pas une information.

   ---------------------------------------------------------------------------
   CE FICHIER ÉCRIT, DONC IL LÈVE LES POLITIQUES ET LES REMET.
   =========================================================================== */

/* --------------------------------------------------------------------------
   LEVER LE CLOISONNEMENT — « update » sans locataire ne lève pas sous
   « force row level security » : il touche zéro ligne, en silence.
   -------------------------------------------------------------------------- */
do $$
declare t text;
begin
  foreach t in array array['books', 'possessions', 'rayons_ajoutes',
                           'rayons_reglages', 'ouvrages']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I no force row level security', t);
    end if;
  end loop;
end $$;

/* --------------------------------------------- Retirer les contraintes d'abord

   LES NOMS SONT LUS DANS « pg_constraint », PAS SUPPOSÉS.
   « books_categorie_check » est le nom qu'on attend — c'est aussi le genre
   d'hypothèse qui rend un correctif silencieusement inopérant. Le 18/08, un
   traducteur d'erreur visait « possessions_tenant_id_ouvrage_id_key » ; le
   nom a été vérifié avant d'être écrit, et il était juste. Ici on ne vérifie
   même pas : on demande à PostgreSQL de nommer lui-même ce qu'il faut
   retirer, ce qui ne peut pas se tromper. */
do $$
declare c record;
begin
  for c in
    select rel.relname as table_nom, con.conname as contrainte
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
     where con.contype = 'c'
       and rel.relname in ('books', 'possessions', 'rayons_ajoutes')
       and pg_get_constraintdef(con.oid) ilike '%Académique%'
  loop
    execute format('alter table public.%I drop constraint %I',
                   c.table_nom, c.contrainte);
  end loop;
end $$;

/* ------------------------------------------------------------ Renommer

   Les quatre tables qui portent la valeur. « rayons_reglages » n'a pas de
   contrainte mais garde des libellés de catégorie : l'oublier laisserait des
   réglages de visibilité orphelins, rattachés à une catégorie qui n'existe
   plus. Ils ne lèveraient aucune erreur — ils cesseraient simplement de
   s'appliquer, ce qui est la pire façon pour un réglage de visibilité de
   disparaître. */
update public.books           set categorie = 'Savoirs' where categorie = 'Académique';
update public.possessions     set categorie = 'Savoirs' where categorie = 'Académique';
update public.rayons_ajoutes  set categorie = 'Savoirs' where categorie = 'Académique';
update public.rayons_reglages set categorie = 'Savoirs' where categorie = 'Académique';

/* ------------------------------------------- Remettre les contraintes

   La liste fermée reste fermée : c'est elle qui empêche une quatrième
   catégorie d'apparaître par accident, au détour d'une saisie ou d'une
   réponse du modèle. Ajouter une catégorie doit rester une migration, donc
   une décision.

   « Académique » N'EST PLUS ACCEPTÉE. Une page laissée ouverte dans un
   navigateur enverra pourtant l'ancienne valeur après la livraison : c'est
   l'API qui la traduit, à l'entrée, pour la durée de la transition. Le refus
   en base est le dernier mot ; la traduction évite qu'il tombe sur un
   utilisateur qui n'a rien fait de mal. */
/* Le « drop if exists » n'est pas redondant avec la boucle plus haut, et le
   cas qu'il couvre n'est pas théorique : sur une base NEUVE, 01-schema.sql
   crée déjà la contrainte — avec la bonne valeur — sous le nom automatique
   « books_categorie_check ». La boucle, qui ne retire que ce qui mentionne
   « Académique », ne la voit pas ; l'ajout ci-dessous échouerait alors sur un
   doublon de nom, et la migration entière avec lui.
   Trouvé en relisant, pas en exécutant. */
alter table public.books drop constraint if exists books_categorie_check;
alter table public.books
  add constraint books_categorie_check
  check (categorie in ('Savoirs', 'Roman', 'BD'));

alter table public.rayons_ajoutes drop constraint if exists rayons_ajoutes_categorie_check;
alter table public.rayons_ajoutes
  add constraint rayons_ajoutes_categorie_check
  check (categorie in ('Savoirs', 'Roman', 'BD'));

alter table public.possessions drop constraint if exists possessions_categorie_check;
alter table public.possessions
  add constraint possessions_categorie_check
  check (categorie in ('Savoirs', 'Roman', 'BD'));

/* --------------------------------------------------------------------------
   REMETTRE LE CLOISONNEMENT
   -------------------------------------------------------------------------- */
do $$
declare t text;
begin
  foreach t in array array['books', 'possessions', 'rayons_ajoutes',
                           'rayons_reglages', 'ouvrages']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;
