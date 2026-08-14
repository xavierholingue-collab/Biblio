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

   USAGE
     sudo -u postgres psql -v ON_ERROR_STOP=1 -d biblio_repetition \
       -f verifier-migration.sql
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
begin
  /* --------------------------------------------------------- 1. Le compte */

  select count(*) into n_books       from public.books;
  select count(*) into n_possessions from public.possessions;
  select count(*) into n_ouvrages    from public.ouvrages;

  raise notice '  books %, possessions %, ouvrages distincts %',
    n_books, n_possessions, n_ouvrages;

  if n_books = 0 then
    raise exception 'La table books est VIDE. La répétition ne porte sur rien : '
      'soit la copie a échoué, soit ce contrôle regarde la mauvaise base.';
  end if;

  if n_possessions <> n_books then
    raise exception 'Compte divergent : % ouvrages, % possessions.',
      n_books, n_possessions;
  end if;

  /* ------------------------------------------- 2. Les manquants, nommément */

  select count(*), string_agg(b.id, ', ' order by b.id)
    into manquants, exemples
    from public.books b
   where not exists (select 1 from public.possessions p
                      where p.tenant_id = b.tenant_id and p.id = b.id);

  if manquants > 0 then
    raise exception '% ouvrage(s) non repris : %', manquants, left(exemples, 300);
  end if;

  /* ------------------------------------------------- 3. Les champs, un à un

     On compare ce que la VUE rend à ce que books contenait. C'est la vue que
     l'application interroge : comparer les tables sous-jacentes vérifierait
     la migration sans vérifier ce qui sera affiché. */

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
    raise exception '% ouvrage(s) dont un champ a changé : %',
      divergents, left(exemples, 300);
  end if;

  /* ----------------------------------------------- 4. Le périmètre public

     La seule propriété qu'un visiteur constate. On la mesure des deux côtés
     avec la MÊME définition qu'appliquera l'application. */

  select count(*) into perimetre_av
    from public.books b where public.livre_public(b);

  select count(*) into perimetre_ap
    from public.possessions p where public.possession_publique(p);

  raise notice '  périmètre public : % avant, % après', perimetre_av, perimetre_ap;

  /* Ce qui est devenu public sans l'être : une FUITE. On la nomme
     séparément du reste, car c'est la seule divergence qui expose des
     données plutôt que d'en cacher. */
  select count(*), string_agg(b.id, ', ' order by b.id)
    into fuites, exemples
    from public.books b
    join public.possessions p on p.tenant_id = b.tenant_id and p.id = b.id
   where public.possession_publique(p) and not public.livre_public(b);

  if fuites > 0 then
    raise exception 'FUITE : % ouvrage(s) deviennent publics : %',
      fuites, left(exemples, 300);
  end if;

  if perimetre_ap <> perimetre_av then
    select string_agg(b.id, ', ' order by b.id) into exemples
      from public.books b
      join public.possessions p on p.tenant_id = b.tenant_id and p.id = b.id
     where public.livre_public(b) and not public.possession_publique(p);
    raise exception 'Périmètre public réduit : % -> %. Disparus : %',
      perimetre_av, perimetre_ap, left(coalesce(exemples, '?'), 300);
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

  select count(*) into orphelins
    from public.ouvrages o
   where not exists (select 1 from public.possessions p where p.ouvrage_id = o.id);
  if orphelins > 0 then
    raise exception '% ouvrage(s) que personne ne possède : le catalogue '
      'partagé se remplirait d''entrées inutiles.', orphelins;
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

  raise notice '  RÉPÉTITION CONCLUANTE — % ouvrages, aucun écart.', n_books;
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
