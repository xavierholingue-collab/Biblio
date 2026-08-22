/* ===========================================================================
   LA MIGRATION A-T-ELLE PERDU QUELQUE CHOSE ?

   Exécuté sur la RÉPÉTITION — une copie de la base de production sur laquelle
   les migrations viennent de passer. La production n'est touchée qu'ensuite,
   et seulement si ce fichier ne dit rien.

   ---------------------------------------------------------------------------
   À EXÉCUTER PAR UN COMPTE PRIVILÉGIÉ. C'est la condition qui rend le reste
   utile.

   Le 15/08/2026, un garde-fou intégré à la migration comptait les ouvrages
   AVANT et APRÈS depuis l'intérieur du cloisonnement : il ne voyait que les
   ouvrages publics des deux côtés. Quatre avant, quatre après, tout allait
   bien — alors que la sphère personnelle entière avait disparu.

   Un contrôle qui partage l'aveuglement de ce qu'il contrôle ne contrôle
   rien. D'où « sudo -u postgres » dans le script appelant.

   ---------------------------------------------------------------------------
   CE QU'ON VÉRIFIE, ET POURQUOI CHACUN

     0. Le compte AVANT et APRÈS la migration. La seule garantie qui vaille
        pour toujours : elle ne dépend d'aucune table gelée.
     1. Le compte. Détecte une perte massive.
     2. Les manquants NOMMÉMENT. Le compte seul est aveugle à une double
        erreur compensée — autant d'ouvrages perdus que de doublons créés.
     3. Les champs, un par un. Une ligne peut survivre en ayant perdu sa
        note, son statut ou son rangement.
     4. Le PÉRIMÈTRE PUBLIC. C'est la seule chose qu'un visiteur constate.
        Un livre personnel devenu public est une fuite ; un livre public
        devenu invisible est une régression silencieuse.
     5. Les résumés. Ils coûtent de l'argent : en perdre un se paie deux fois.
     6. La cohérence de la nouvelle structure.
     7. Le cloisonnement, lu dans pg_class et non dans les données.

   ---------------------------------------------------------------------------
   « books » EST UN FILET GELÉ, PLUS UNE RÉFÉRENCE — et l'avoir oublié a
   arrêté la livraison du 16/08/2026.

   Les contrôles 1 à 4 ont été écrits le 15/08, le jour de la bascule. Ce
   jour-là, « books » et « possessions » disaient la même chose : l'une
   venait d'être copiée dans l'autre, et toute différence était une perte.

   Le lendemain, la bibliothèque avait vécu. Deux ouvrages ajoutés puis
   retirés pendant une vérification à l'œil, et le contrôle a annoncé une
   anomalie sur une base parfaitement saine. Or « books » n'est plus écrite
   par personne depuis la bascule : elle ne bouge plus, tandis que la
   bibliothèque, elle, bouge. Comparer les deux, c'est mesurer l'activité
   normale et l'appeler corruption.

   Ce n'est pas un détail d'exactitude. Un garde-fou qui arrête une livraison
   saine finit par être désactivé — et il emporte alors les cas où il avait
   raison. On préfère perdre une vérification que perdre la confiance dans
   toutes.

   Les contrôles historiques ne s'exécutent donc QUE tant que la
   bibliothèque n'a pas divergé de son filet. Dès qu'elle diverge, ils le
   DISENT et s'effacent, et c'est le contrôle 0 — avant/après, mesuré sur la
   même table — qui prend le relais. Lui ne périmera pas.

   USAGE
     sudo -u postgres psql -v ON_ERROR_STOP=1 -d biblio_repetition \
       -f verifier-migration.sql

   Le script appelant dépose, s'il le peut, une table « controle_avant »
   portant le nombre de possessions MESURÉ SUR LA PRODUCTION avant la copie.
   Sans elle, le contrôle 0 s'annonce comme non effectué plutôt que de se
   taire — un contrôle absent qui ne dit rien passe pour un contrôle réussi.
   =========================================================================== */

\set ON_ERROR_STOP on
\timing off

do $$
declare
  n_books        integer;
  n_possessions  integer;
  n_ouvrages     integer;
  manquants      integer;
  divergents     integer;
  perimetre_av   integer;
  perimetre_ap   integer;
  fuites         integer;
  resumes_av     integer;
  resumes_ap     integer;
  orphelins      integer;
  exemples       text;
  ajoutes        integer;
  retires        integer;
  historique     boolean;
  avant          integer;
begin
  /* ------------------------------- 0. AVANT ET APRÈS, SUR LA MÊME TABLE

     La seule garantie durable. Elle ne compare pas deux tables différentes,
     mais la même avant et après le passage des migrations — c'est ce qui la
     rend insensible à l'activité normale de la bibliothèque.

     Le nombre « avant » est mesuré sur la PRODUCTION par le script
     appelant, avec un compte privilégié, et déposé ici. S'il manque, on le
     dit : un contrôle silencieusement absent se lit comme un contrôle
     réussi, et c'est la pire des deux erreurs. */

  select count(*) into n_possessions from public.possessions;

  if to_regclass('public.controle_avant') is null then
    raise notice '  (avant/après NON EFFECTUÉ : le compte de référence n''a pas été fourni)';
  else
    execute 'select possessions from public.controle_avant limit 1' into avant;
    raise notice '  possessions : % avant migration, % après', avant, n_possessions;
    if avant is null then
      raise notice '  (avant/après NON EFFECTUÉ : compte de référence vide)';
    elsif n_possessions < avant then
      raise exception 'La migration PERD des ouvrages : % avant, % après.',
        avant, n_possessions;
    end if;
  end if;

  /* --------------------------------------------------------- 1. Le compte */

  select count(*) into n_books    from public.books;
  select count(*) into n_ouvrages from public.ouvrages;

  raise notice '  books %, possessions %, ouvrages distincts %',
    n_books, n_possessions, n_ouvrages;

  if n_books = 0 then
    raise exception 'La table books est VIDE. La répétition ne porte sur rien : '
      'soit la copie a échoué, soit ce contrôle regarde la mauvaise base.';
  end if;

  /* LA BIBLIOTHÈQUE A-T-ELLE VÉCU DEPUIS LA BASCULE ?

     Ajouts et retraits sont comptés séparément, parce qu'ils ne se
     compensent pas : deux ajouts et deux retraits laisseraient les comptes
     égaux et le filet périmé quand même. C'est exactement ce qui est arrivé
     le 16/08 — 324 des deux côtés, et 326 ouvrages au catalogue. */
  select count(*) into ajoutes
    from public.possessions p
   where not exists (select 1 from public.books b
                      where b.tenant_id = p.tenant_id and b.id = p.id);

  select count(*) into retires
    from public.books b
   where not exists (select 1 from public.possessions p
                      where p.tenant_id = b.tenant_id and p.id = b.id);

  historique := (ajoutes = 0 and retires = 0);

  if not historique then
    raise notice '  contrôles historiques ÉCARTÉS : % ajout(s) et % retrait(s) '
      'depuis la bascule. « books » est un filet gelé, plus une référence.',
      ajoutes, retires;
  end if;

  /* ------------------------------------------- 2. Les manquants, nommément */

  if historique then
    select count(*), string_agg(b.id, ', ' order by b.id)
      into manquants, exemples
      from public.books b
     where not exists (select 1 from public.possessions p
                        where p.tenant_id = b.tenant_id and p.id = b.id);

    if manquants > 0 then
      raise exception '% ouvrage(s) non repris : %', manquants, left(exemples, 300);
    end if;
  end if;

  /* ------------------------------------------------- 3. Les champs, un à un

     On compare ce que la VUE rend à ce que books contenait. C'est la vue que
     l'application interroge : comparer les tables sous-jacentes vérifierait
     la migration sans vérifier ce qui sera affiché.

     ---------------------------------------------------------------------
     CE CONTRÔLE NE PEUT PLUS ÊTRE BLOQUANT, ET C'EST UNE PERTE ASSUMÉE.

     Il ne suffit pas qu'aucun livre n'ait été ajouté ni retiré : il suffit
     d'avoir CHANGÉ UNE NOTE. « books » est gelée depuis le 15/08 ; noter un
     livre lu, le déplacer de rayon, corriger un titre — chacun de ces gestes
     rend « b.note » différent de « p.note ». C'est le plus probable des
     quatre pièges trouvés le 16/08 : les trois autres demandaient un ajout
     ou une suppression, celui-ci se déclenche à la première étoile posée.

     Et surtout, AUCUNE ASTUCE NE LE SAUVE. Face à une différence entre une
     table gelée et une table vivante, rien ne permet de distinguer « la
     migration a déformé un champ » de « l'utilisateur a modifié son livre ».
     L'information n'existe pas. Un contrôle qui ne peut pas trancher ne doit
     pas arrêter une livraison : il rapporte.

     CE QUE CELA COÛTE, ET JE NE VEUX PAS L'ENJOLIVER : plus rien ne vérifie
     qu'une migration future ne DÉFORME pas un champ sans en perdre. Le
     contrôle 0 compte les lignes, il ne les lit pas.

     LE REMPLACEMENT DURABLE, nommé ici pour ne pas être oublié : relever une
     empreinte des possessions SUR LA PRODUCTION avant la copie, et la
     comparer après migration. Comparer la même table à elle-même est la
     seule façon de rendre la question décidable. C'est un chantier à part
     entière, pas quelque chose à improviser à la fin d'une livraison. */

  select count(*), string_agg(t.id, ', ' order by t.id)
    into divergents, exemples
    from (
      select b.id
        from public.books b
        join public.possessions p on p.tenant_id = b.tenant_id and p.id = b.id
        join public.ouvrages o on o.id = p.ouvrage_id
       where b.titre          is distinct from o.titre
          or b.auteur         is distinct from o.auteur
          or b.annee          is distinct from o.annee
          or b.statut         is distinct from p.statut
          or b.note           is distinct from p.note
          or b.categorie      is distinct from p.categorie
          or b.sous_categorie is distinct from p.sous_categorie
          or b.sphere         is distinct from p.sphere
          or b.visibilite     is distinct from p.visibilite
       limit 20) t;

  if divergents > 0 then
    raise notice '  % ouvrage(s) diffèrent du filet gelé « books » — modifiés '
      'depuis la bascule, ou déformés par une migration. Ce contrôle ne sait '
      'pas trancher : %', divergents, left(exemples, 200);
  end if;

  /* ----------------------------------------------- 4. Le périmètre public

     La seule propriété qu'un visiteur constate. On la mesure des deux côtés
     avec la MÊME définition qu'appliquera l'application. */

  /* MESURÉ SUR L'INTERSECTION, ET C'EST CE QUI ÉVITE LA FAUSSE ALERTE.

     Compter tous les « books » d'un côté et toutes les « possessions » de
     l'autre revenait à compter les ouvrages supprimés depuis la bascule
     comme perdus, et les ouvrages ajoutés comme des fuites. Le premier livre
     public ajouté après le 15/08 aurait déclenché « périmètre public
     réduit » avec une liste de disparus VIDE — un message impossible à
     comprendre, sur une base saine.

     On compare donc les mêmes ouvrages des deux côtés. Ce que devient un
     livre ajouté depuis, aucune table gelée ne peut le dire ; c'est le rôle
     des contrôles de l'application, pas de celui-ci. */
  select count(*) filter (where public.livre_public(b)),
         count(*) filter (where public.possession_publique(p))
    into perimetre_av, perimetre_ap
    from public.books b
    join public.possessions p on p.tenant_id = b.tenant_id and p.id = b.id;

  raise notice '  (rappel, contre le filet gelé : % publics le 15/08, % aujourd''hui '
    'sur les % ouvrages communs)', perimetre_av, perimetre_ap,
    (select count(*) from public.books b
       join public.possessions p on p.tenant_id = b.tenant_id and p.id = b.id);

  /* ------------------------------------------------------------------------
     LA FUITE SE MESURE CONTRE LA PRODUCTION D'AVANT, PLUS CONTRE « books ».

     L'ancienne version comparait la visibilité d'aujourd'hui à celle gelée le
     15/08. Elle a arrêté la livraison #32 sur le geste le plus normal qui
     soit : deux livres publiés depuis l'écran de réglages, livré le matin
     même. Le contrôle a crié « FUITE » sur une publication délibérée.

     C'est le cinquième piège de la même famille, et le plus embarrassant :
     celui-là accusait l'utilisateur d'une fuite alors qu'il exerçait
     exactement la fonction qu'on venait de lui donner.

     La référence est désormais LA LISTE des ouvrages publics relevée sur la
     PRODUCTION juste avant la copie. Tout ce que vous avez publié
     volontairement s'y trouve déjà : le contrôle ne le voit pas. Ce qui
     apparaît en plus ne peut venir que de la migration.

     ON COMPARE DES ENSEMBLES, PAS DES COMPTES. Un ouvrage qui fuit et un
     autre qui disparaît laisseraient le compte inchangé — et c'est
     précisément la double erreur compensée qu'un compte ne voit jamais. */

  if to_regclass('public.controle_public') is null then
    raise notice '  (contrôle de FUITE affaibli : périmètre de référence non fourni)';

    /* Repli sur l'ancienne méthode, en NOTICE seulement. Sans référence, on
       ne peut pas distinguer une fuite d'une publication voulue — et une
       livraison ne doit pas s'arrêter sur une question qu'on ne sait pas
       trancher. */
    select count(*), string_agg(b.id, ', ' order by b.id)
      into fuites, exemples
      from public.books b
      join public.possessions p on p.tenant_id = b.tenant_id and p.id = b.id
     where public.possession_publique(p) and not public.livre_public(b);
    if fuites > 0 then
      raise notice '  % ouvrage(s) publics aujourd''hui et non le 15/08 — publiés '
        'depuis, ou fuite. Sans référence, ce contrôle ne sait pas trancher : %',
        fuites, left(exemples, 200);
    end if;

  else
    select count(*), string_agg(p.id, ', ' order by p.id)
      into fuites, exemples
      from public.possessions p
     where public.possession_publique(p)
       and (p.tenant_id::text || '|' || p.id)
           not in (select cle from public.controle_public);

    if fuites > 0 then
      raise exception 'FUITE : % ouvrage(s) deviennent publics que la migration '
        'aurait dû laisser privés : %', fuites, left(exemples, 300);
    end if;

    select count(*), string_agg(split_part(c.cle, '|', 2), ', ' order by c.cle)
      into divergents, exemples
      from public.controle_public c
     where not exists (
       select 1 from public.possessions p
        where (p.tenant_id::text || '|' || p.id) = c.cle
          and public.possession_publique(p));

    if divergents > 0 then
      raise exception 'Périmètre public RÉDUIT : % ouvrage(s) cessent d''être '
        'visibles : %', divergents, left(exemples, 300);
    end if;

    raise notice '  périmètre public : % ouvrages avant, tous retrouvés après',
      (select count(*) from public.controle_public);
  end if;

  /* ------------------------------------------------------- 5. Les résumés

     La dé-duplication est ATTENDUE : deux locataires ayant la même édition
     n'ont plus qu'un résumé. On vérifie donc qu'aucun OUVRAGE ne perd le
     sien, pas que le nombre de lignes est conservé. */

  select count(distinct (p.ouvrage_id, r.langue)) into resumes_av
    from public.resumes r
    join public.possessions p on p.tenant_id = r.tenant_id and p.id = r.book_id
   where r.resume is not null;

  select count(*) into resumes_ap
    from public.resumes_ouvrages where resume is not null;

  raise notice '  résumés : % attendus, % en place', resumes_av, resumes_ap;

  if resumes_ap < resumes_av then
    raise exception 'Résumés perdus : % attendus, % en place. '
      'Chacun a été payé au modèle.', resumes_av, resumes_ap;
  end if;

  /* ---------------------------------------- 6. Cohérence de la structure */

  select count(*) into orphelins
    from public.possessions p
   where not exists (select 1 from public.ouvrages o where o.id = p.ouvrage_id);
  if orphelins > 0 then
    raise exception '% possession(s) sans ouvrage.', orphelins;
  end if;

  /* ------------------------------------------------------------------------
     LES OUVRAGES QUE PERSONNE NE POSSÈDE : UNE INFORMATION, PAS UNE FAUTE.

     Cette vérification a ARRÊTÉ la livraison du 16/08/2026 sur deux ouvrages
     orphelins, et elle avait tort. Il faut le dire précisément, parce que
     l'erreur est instructive.

     Elle a été écrite le 15/08, le jour de la bascule, où le seul chemin
     possible était la migration : chaque ouvrage venait d'un livre, donc
     chacun avait un possesseur. Zéro orphelin était alors la vérité.

     Elle a cessé de l'être le lendemain, sans que rien ne soit cassé. Deux
     gestes ordinaires laissent légitimement un ouvrage sans possesseur :

       — SUPPRIMER UN LIVRE. On retire la possession, pas l'ouvrage : sa
         fiche bibliographique n'est pas la vôtre à effacer, et quelqu'un
         d'autre peut posséder la même édition. C'est écrit ainsi dans
         server.js, délibérément.
       — CORRIGER UN ISBN. La possession se rattache au bon ouvrage, et
         l'ancien reste au catalogue.

     Le contrôle mesurait donc une propriété vraie d'un instant, pas une
     propriété du système. Un garde-fou qui arrête une livraison saine finit
     par être désactivé — et il emporte alors les cas où il avait raison.

     ON L'AFFICHE, ET ON NOMME. Un compte qui grimpe sans qu'aucun livre
     n'ait été supprimé mérite un regard ; les titres permettent de le
     décider en une seconde, au lieu d'ouvrir une session SQL.

     LE VRAI DÉFAUT, lui, reste une exception : une POSSESSION sans ouvrage
     est une bibliothèque qui a perdu un livre. Voir juste au-dessus. */
  select count(*) into orphelins
    from public.ouvrages o
   where not exists (select 1 from public.possessions p where p.ouvrage_id = o.id);
  if orphelins > 0 then
    raise notice '  % ouvrage(s) au catalogue que plus personne ne possède '
      '(suppression ou correction d''ISBN) : %', orphelins,
      (select string_agg(o.titre || ' — ' || o.auteur, ' | ' order by o.titre)
         from public.ouvrages o
        where not exists (select 1 from public.possessions p
                           where p.ouvrage_id = o.id));
  end if;

  /* Deux possessions du même ouvrage chez le même locataire : la contrainte
     l'interdit, mais si elle sautait un jour, la bibliothèque afficherait
     des doublons sans que rien ne le signale. */
  select count(*) into orphelins
    from (select tenant_id, ouvrage_id from public.possessions
           group by 1, 2 having count(*) > 1) d;
  if orphelins > 0 then
    raise exception '% ouvrage(s) en double dans une même bibliothèque.', orphelins;
  end if;

  /* ------------------------------- 7. LE CLOISONNEMENT EST-IL EN PLACE ?

     Ce contrôle ne regarde AUCUNE donnée, et c'est sa raison d'être. Une
     migration peut laisser toutes les lignes intactes et les droits grands
     ouverts : les six vérifications ci-dessus seraient vertes, et le compte
     applicatif lirait la bibliothèque de tout le monde.

     « force row level security » est le mot qui compte. Sans lui, les
     politiques existent mais ne s'appliquent pas au PROPRIÉTAIRE des
     tables — c'est-à-dire au compte que l'API utilise. */
  select count(*) into orphelins
    from unnest(array['books', 'resumes', 'possessions', 'ouvrages',
                      'resumes_ouvrages', 'rayons_ajoutes', 'rayons_reglages',
                      'reading_quests', 'tenants', 'appels_ia']) as t(nom)
   where to_regclass('public.' || t.nom) is not null
     and not exists (select 1 from pg_class c
                      where c.relname = t.nom
                        and c.relrowsecurity and c.relforcerowsecurity);
  if orphelins > 0 then
    raise exception '% table(s) hors « force row level security » : les '
      'politiques ne s''appliqueraient pas au compte de l''application.', orphelins;
  end if;

  /* ------------------------------------------------------------------
     LE RENOMMAGE « Académique » → « Savoirs » A-T-IL PORTÉ ? — 19/08/2026

     Ce contrôle ne peut PAS exister dans le banc d'essai, et c'est pour cela
     qu'il est ici. Sur une base neuve, 01-schema.sql crée la contrainte avec
     la nouvelle valeur : « Académique » ne peut même pas y être semée, donc
     la migration n'a rien à migrer et un test ne prouverait rien.

     Seule la RÉPÉTITION SUR UNE COPIE DE LA PRODUCTION voit les 265 lignes
     réelles. C'est le seul endroit d'où l'on peut affirmer que le renommage
     a effectivement eu lieu.

     Un « update » qui ne touche aucune ligne ne lève pas — c'est la famille
     de défaut de toute cette base de code. Ici, la contrainte remise l'aurait
     attrapé (elle refuse « Académique »), mais compter est plus clair qu'un
     effet de bord : on veut savoir que zéro reste, pas espérer qu'une autre
     règle l'a empêché.
     ------------------------------------------------------------------ */
  select count(*) into orphelins
    from public.possessions where categorie = 'Académique';
  if orphelins > 0 then
    raise exception '% possession(s) encore en « Académique » après 07-savoirs.sql.',
      orphelins;
  end if;

  select count(*) into orphelins
    from public.rayons_reglages where categorie = 'Académique';
  if orphelins > 0 then
    raise exception '% réglage(s) de rayon encore en « Académique » : ils ne '
      's''appliqueraient plus à rien, sans lever la moindre erreur.', orphelins;
  end if;
  raise notice '  renommage Savoirs : aucune trace d''« Académique »';

  /* ------------------------------------------------------------------
     LA VUE EXPOSE-T-ELLE ENCORE LES COLONNES D'ARTICLE ? — 21/08/2026

     Ce contrôle existe parce que j'ai RETIRÉ une erreur en fiabilisant la
     migration. « create or replace view » refusait de raccourcir une vue :
     si 03 repassait après 08, PostgreSQL levait « cannot drop columns from
     view » et la migration s'arrêtait. Bruyant, mais protecteur.

     « drop view » puis « create view » n'a plus cette contrainte — c'est
     précisément pourquoi je l'ai adopté. Le dernier fichier appliqué gagne,
     en silence. L'ordre alphabétique fait aujourd'hui gagner 08 ; le jour où
     une migration 09 recopiera la vue depuis 03 sans les colonnes d'article,
     la migration passera au VERT et l'API tombera ensuite sur un « column
     l.resume_editeur does not exist » qui ne dira pas d'où il vient.

     Rendre un mécanisme robuste a donc déplacé le risque au lieu de le
     supprimer. La propriété que l'erreur garantissait doit maintenant être
     affirmée ici, explicitement.
     ------------------------------------------------------------------ */
  select count(*) into orphelins
    from unnest(array['type', 'doi', 'revue', 'volume', 'numero',
                      'citations', 'citations_le', 'resume_editeur',
                      'avec_sources', 'support', 'pagination']) as c(nom)
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'livres'
                        and column_name = c.nom);
  if orphelins > 0 then
    raise exception '% colonne(s) d''article absente(s) de la vue « livres » : '
      'une migration ultérieure l''a recréée sans elles, et l''API échouera '
      'APRÈS cette migration, pas pendant.', orphelins;
  end if;
  raise notice '  vue « livres » : colonnes d''article présentes';

  /* Un ouvrage ne peut pas être à la fois un livre et un article. Aucune
     contrainte ne l'interdit — un ISBN et un DOI sur la même ligne est
     structurellement possible — mais ce serait le signe que la cascade des
     catalogues a écrit dans le mauvais champ.

     NON PROUVÉ PAR MUTATION, et il faut le dire. J'ai essayé trois fois de
     fabriquer une telle ligne depuis une migration : les trois fois, un
     autre garde-fou a levé avant celui-ci — l'index unique sur le DOI, ou
     la règle qui exige une levée de politiques pour écrire. La propriété
     est défendue en profondeur, ce qui est une bonne nouvelle, mais me
     laisse sans démonstration que CE contrôle-ci fonctionne.

     Il est gardé parce qu'il couvre un chemin qu'aucune migration ne peut
     simuler : l'APPLICATION écrivant un DOI sur la ligne d'un livre. Le
     jour où Crossref sera branché sur la recherche de livres, c'est le seul
     endroit qui le verra. Mais il est à ce jour affirmé, pas éprouvé. */
  select count(*) into orphelins
    from public.ouvrages where isbn is not null and doi is not null;
  if orphelins > 0 then
    raise exception '% ouvrage(s) portent à la fois un ISBN et un DOI : '
      'deux identifiants d''édition pour une seule notice.', orphelins;
  end if;

  /* ------------------------------------------------------------------
     AUCUN LOCATAIRE N'A UN PLAFOND ABSURDE — 22/08/2026

     Le plafond de dépense se change par « regler_tarification », qui borne à
     mille dollars, et par une migration. Les deux sont des gestes délibérés.

     Ce contrôle existe pour le cas où ils ne l'auraient pas été : une valeur
     aberrante en production ne se verrait nulle part avant la facture. Deux
     dollars par compte est déjà quatre fois le défaut ; au-delà, c'est une
     décision, et une décision doit avoir été prise.

     Le locataire d'origine est écarté : c'est le vôtre, il n'a pas de raison
     d'être bridé comme un inscrit.
     ------------------------------------------------------------------ */
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'tenants'
                and column_name = 'plafond_usd') then
    select count(*) into orphelins
      from public.tenants
     where identifiant <> 'xavier' and plafond_usd > 2;
    if orphelins > 0 then
      raise exception '% locataire(s) au plafond de dépense supérieur à 2 $ : '
        'une valeur aberrante ne se verrait qu''à la facture.', orphelins;
    end if;
    raise notice '  plafonds de dépense : aucun au-dessus de 2 $';
  end if;

  /* On annonce le compte des POSSESSIONS, pas celui de « books ». C'est la
     bibliothèque d'aujourd'hui, pas celle du 15/08 — et sur une base ayant
     vécu, les deux nombres diffèrent. */
  raise notice '  RÉPÉTITION CONCLUANTE — % ouvrages, aucun écart.', n_possessions;
end $$;

/* Le détail qui rend le compte rendu lisible : ce qui a effectivement été
   mutualisé. Sur une seule bibliothèque, tout est « local ou unique » — le
   gain n'apparaîtra qu'avec le premier invité. */
select
  count(*) filter (where cle like 'isbn:%')  as "clés ISBN",
  count(*) filter (where cle like 'local:%') as "sans ISBN, non partagés",
  (select count(*) from public.possessions)  as "possessions",
  (select count(*) from public.resumes_ouvrages) as "résumés partagés"
from public.ouvrages;
