/* ===========================================================================
   LE CATALOGUE EST PARTAGÉ, LA BIBLIOTHÈQUE EST PERSONNELLE

   Un livre d'ISBN donné est le même livre pour tout le monde. Son titre, son
   auteur, sa couverture, son résumé ne dépendent de personne. Ce qui dépend
   de vous, c'est de le posséder, de l'avoir lu, de l'avoir noté, de l'avoir
   rangé quelque part, et de vouloir ou non le montrer.

   Jusqu'au 15/08/2026, tout était dans une seule table dupliquée par
   locataire. Trois amis possédant le même ouvrage, c'était trois lignes,
   trois recherches de couverture et TROIS APPELS AU MODÈLE pour produire
   trois fois le même texte — c'est-à-dire trois fois la dépense de la seule
   fonction payante du service.

   ---------------------------------------------------------------------------
   TROIS TABLES, TROIS RESPONSABILITÉS

     ouvrages           partagé. Ce que le livre EST. Clé : l'ISBN-13.
     resumes_ouvrages   partagé. Un résumé par ouvrage et par langue.
     possessions        par locataire. Ce que VOUS en faites.

   Le classement reste personnel, et ce n'est pas un détail : ranger « Sapiens »
   en Histoire ou en Économie est un jugement, pas une propriété du livre.
   statut, note, catégorie, rayon, sphère et visibilité restent donc chez vous.

   ---------------------------------------------------------------------------
   CE QUE CETTE DÉCOUPE NE RÉSOUT PAS, ET IL FAUT LE SAVOIR

   L'ISBN identifie une ÉDITION, pas une ŒUVRE. Deux éditions du même livre
   sont deux ouvrages, donc deux résumés. Le partage sera moins large
   qu'espéré. Le niveau « œuvre » (identifiant OpenLibrary) est la vraie
   réponse ; c'est un chantier distinct, pas un oubli.

   Mesuré le 15/08/2026 SUR UN EXPORT de 321 ouvrages : 318 portaient un
   ISBN-13 valide, et les 3 autres des ASIN Amazon préfixés « 978 » — qui
   ressemblent à des ISBN sans en être.

   Ce chiffre décrit un export, pas la production : le jour même, la base en
   comptait 324. Il est laissé ici comme ORDRE DE GRANDEUR, pas comme
   vérité — un nombre exact dans un commentaire vieillit sans prévenir, et
   finit par être cru. Le compte qui fait foi est celui qu'imprime
   verifier-migration.sql à chaque livraison.

   La règle, elle, ne dépend d'aucun chiffre : ce qui n'est pas un ISBN-13
   valide reçoit une identité LOCALE, non partagée. Mieux vaut ne rien
   mutualiser que mutualiser sur une clé fausse.

   ---------------------------------------------------------------------------
   REJOUABLE. Le remplissage ne s'exécute que si possessions est vide, et les
   créations sont toutes en « if not exists ».

   La table « books » n'est PAS supprimée. Elle reste en place, intacte, tant
   que la nouvelle structure n'a pas vécu. Supprimer est irréversible ; garder
   coûte quelques mégaoctets.
   =========================================================================== */

/* ------------------------------------------------------- Le catalogue */

create table if not exists public.ouvrages (
  id            uuid primary key default gen_random_uuid(),

  /* La clé de dédoublonnage, et elle est EXPLICITE.
     « isbn:9782070368228 » pour un vrai ISBN, « local:<locataire>:<id> »
     pour le reste. Une clé qui dit d'où elle vient permet de constater, en
     lisant la table, ce qui a été mutualisé et ce qui ne l'a pas été. */
  cle           text not null unique,

  isbn          text unique,     -- ISBN-13 normalisé, NULL si absent
  titre         text not null,
  auteur        text not null,
  editeur       text,
  annee         integer,
  pages         integer check (pages is null or (pages > 0 and pages < 20000)),
  cover_url     text,
  cover_statut  text not null default 'inconnu'
                check (cover_statut in ('inconnu', 'trouvee', 'absente')),
  cree_le       timestamptz not null default now(),
  maj_le        timestamptz not null default now()
);

create index if not exists ouvrages_auteur on public.ouvrages(auteur);

/* --------------------------------------------------- Ce que vous possédez */

create table if not exists public.possessions (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  /* L'identifiant HISTORIQUE — « x042 », « b195 ». Il reste la clé exposée
     par l'API et manipulée par les pages. Le changer aurait obligé à
     réécrire le front-end en même temps que la base : deux chantiers
     simultanés, et aucun moyen de savoir lequel a cassé quoi. */
  id             text not null,

  ouvrage_id     uuid not null references public.ouvrages(id) on delete restrict,

  statut         text not null default 'A lire'
                 check (statut in ('Lu', 'En cours', 'A lire')),
  note           numeric(2,1) check (note >= 0 and note <= 5),
  categorie      text not null check (categorie in ('Académique', 'Roman', 'BD')),
  sous_categorie text not null,
  sphere         text not null default 'Pro' check (sphere in ('Perso', 'Pro')),
  visibilite     text not null default 'heritee'
                 check (visibilite in ('heritee', 'publique', 'privee')),
  ajoute_le      timestamptz not null default now(),
  maj_le         timestamptz not null default now(),

  primary key (tenant_id, id),
  -- Le même ouvrage deux fois dans la même bibliothèque n'a pas de sens.
  unique (tenant_id, ouvrage_id)
);

create index if not exists possessions_ouvrage on public.possessions(ouvrage_id);

/* ------------------------------------------------- Les résumés partagés */

create table if not exists public.resumes_ouvrages (
  ouvrage_id  uuid not null references public.ouvrages(id) on delete cascade,
  langue      text not null check (langue in ('fr', 'en')),
  resume      text,
  points      text[],
  themes      text[],
  modele      text,
  fiabilite   text check (fiabilite in ('haute', 'moyenne', 'faible')),
  genere_le   timestamptz not null default now(),
  primary key (ouvrage_id, langue)
);

/* =========================================================================
   REMPLISSAGE — une seule fois, à partir de books.
   ========================================================================= */

do $$
declare nb_avant integer; nb_apres integer; oublies integer;
begin
  if exists (select 1 from public.possessions) then
    raise notice 'possessions déjà rempli : reprise ignorée.';
    return;
  end if;

  /* ---------------------------------------------------------------------
     UNE MIGRATION NE DOIT PAS ÊTRE SOUMISE AU CLOISONNEMENT QU'ELLE MIGRE.

     Défaut trouvé le 15/08/2026, et il détruisait des données.

     03 s'exécute APRÈS que 02 a activé la RLS. Le script tourne donc comme
     un VISITEUR ANONYME — app.tenant_id n'est pas posé — et la politique
     books_visiteur ne lui montre que les ouvrages PUBLICS. Toute la sphère
     personnelle disparaissait à la migration, sans erreur ni message.

     Pire : le garde-fou ne pouvait pas le voir. Il comptait books avec
     EXACTEMENT LA MÊME CÉCITÉ des deux côtés — quatre avant, quatre après,
     tout allait bien. Un contrôle qui partage l'aveuglement de ce qu'il
     contrôle ne contrôle rien.

     « no force » lève l'application des politiques au PROPRIÉTAIRE des
     tables, le temps de la reprise. Les autres rôles restent cloisonnés, et
     ALTER TABLE prend un verrou exclusif : aucune lecture concurrente ne
     traverse cette fenêtre.
     --------------------------------------------------------------------- */
  alter table public.books   no force row level security;
  alter table public.resumes no force row level security;

  select count(*) into nb_avant from public.books;

  /* 1. Le catalogue. « distinct on » garde UNE ligne par clé ; l'ordre
        décide laquelle, et on prend la plus récemment modifiée — celle qui
        a le plus de chances de porter une couverture et une pagination. */
  insert into public.ouvrages (cle, isbn, titre, auteur, editeur, annee, pages,
                               cover_url, cover_statut)
  select distinct on (t.cle)
         t.cle, t.nisbn, t.titre, t.auteur, t.editeur, t.annee, t.pages,
         t.cover_url, t.cover_statut
    from (
      select b.*,
             nullif(regexp_replace(coalesce(b.isbn, ''), '[^0-9Xx]', '', 'g'), '') as brut
        from public.books b
    ) x
    cross join lateral (
      select case when length(x.brut) = 13 then x.brut else null end as nisbn
    ) n
    cross join lateral (
      select case when n.nisbn is not null
                  then 'isbn:' || n.nisbn
                  else 'local:' || x.tenant_id::text || ':' || x.id end as cle
    ) c
    cross join lateral (select x.*, n.nisbn, c.cle) t
   order by t.cle, t.updated_at desc nulls last
  on conflict (cle) do nothing;

  /* 2. Les possessions, rattachées par la même clé. */
  insert into public.possessions (tenant_id, id, ouvrage_id, statut, note,
                                  categorie, sous_categorie, sphere, visibilite,
                                  ajoute_le, maj_le)
  select b.tenant_id, b.id, o.id, b.statut, b.note,
         b.categorie, b.sous_categorie, b.sphere, b.visibilite,
         coalesce(b.created_at, now()), coalesce(b.updated_at, now())
    from public.books b
    join public.ouvrages o
      on o.cle = case
           when length(nullif(regexp_replace(coalesce(b.isbn,''), '[^0-9Xx]', '', 'g'), '')) = 13
             then 'isbn:' || regexp_replace(coalesce(b.isbn,''), '[^0-9Xx]', '', 'g')
           else 'local:' || b.tenant_id::text || ':' || b.id end;

  select count(*) into nb_apres from public.possessions;

  /* AUCUN OUVRAGE NE DOIT SE PERDRE EN ROUTE.

     Deux contrôles, parce qu'ils ne disent pas la même chose. Le compte
     détecte une perte massive ; la recherche nominative dit LESQUELS
     manquent, ce qui est la seule information utile quand il faut réparer.

     La recherche nominative est aussi la seule qui résiste à une double
     erreur compensée — autant d'ouvrages perdus que de doublons créés. */
  select count(*) into oublies
    from public.books b
   where not exists (select 1 from public.possessions p
                      where p.tenant_id = b.tenant_id and p.id = b.id);

  if oublies > 0 or nb_apres <> nb_avant then
    raise exception 'Migration incomplète : % ouvrages, % possessions, % laissés de côté (dont %).',
      nb_avant, nb_apres, oublies,
      (select string_agg(b.id, ', ') from (
         select b.id from public.books b
          where not exists (select 1 from public.possessions p
                             where p.tenant_id = b.tenant_id and p.id = b.id)
          limit 5) b);
  end if;
  raise notice 'Catalogue : % possessions, % ouvrages distincts.',
    nb_apres, (select count(*) from public.ouvrages);

  /* 3. Les résumés. Si deux locataires en ont un pour le même ouvrage et la
        même langue, on garde le plus récent — arbitraire, mais explicite. */
  insert into public.resumes_ouvrages (ouvrage_id, langue, resume, points, themes,
                                       modele, fiabilite, genere_le)
  select distinct on (p.ouvrage_id, r.langue)
         p.ouvrage_id, r.langue, r.resume, r.points, r.themes,
         r.modele, r.fiabilite, r.genere_le
    from public.resumes r
    join public.possessions p
      on p.tenant_id = r.tenant_id and p.id = r.book_id
   where r.resume is not null
   order by p.ouvrage_id, r.langue, r.genere_le desc
  on conflict (ouvrage_id, langue) do nothing;

  raise notice 'Résumés partagés : %.', (select count(*) from public.resumes_ouvrages);

  -- On remet le cloisonnement AVANT de rendre la main, quoi qu'il arrive.
  -- Les « raise exception » ci-dessus annulent la transaction entière, donc
  -- ces deux lignes avec : la fenêtre ne peut pas rester ouverte.
  alter table public.books   force row level security;
  alter table public.resumes force row level security;
end $$;

/* =========================================================================
   VISIBILITÉ — la même règle, appliquée à une possession.
   ========================================================================= */

/* SECURITY DEFINER NE SUFFIT PAS, ET C'EST LE PIÈGE DU 15/08/2026.
 *
 * On croit qu'une fonction SECURITY DEFINER lit les tables sans restriction.
 * C'est faux dès que « force row level security » est actif : le
 * PROPRIÉTAIRE y est soumis comme les autres, et la fonction s'exécute
 * précisément sous son identité.
 *
 * La sous-requête sur rayons_reglages ne rendait donc RIEN. Conséquences :
 *   — un rayon marqué PUBLIC ne rendait pas ses ouvrages visibles ;
 *   — un rayon marqué PRIVÉ « fonctionnait »… par accident, la valeur par
 *     défaut étant justement « privée ». La protection paraissait active
 *     alors qu'elle ne s'appliquait jamais.
 *
 * C'est réparé en rendant rayons_reglages LISIBLE (voir sa politique plus
 * bas). SECURITY DEFINER reste utile pour le search_path figé, mais on ne
 * s'appuie plus sur lui pour traverser les politiques.
 */
create or replace function public.possession_publique(p public.possessions)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    -- VERROU MAÎTRE. Rien ne passe si la bibliothèque est privée.
    when (select t.visibilite from public.tenants t where t.id = p.tenant_id)
         is distinct from 'publique' then false
    when p.visibilite = 'privee'   then false
    when p.visibilite = 'publique' then true
    -- Sans décision explicite, on ne publie pas. Voir 02-multi-locataire.sql.
    else coalesce((select r.visibilite from public.rayons_reglages r
                    where r.tenant_id = p.tenant_id
                      and r.categorie = p.categorie
                      and r.sous_categorie = p.sous_categorie), 'privee') = 'publique'
  end;
$$;

/* Les réglages de rayon sont LISIBLES par tous, et il faut assumer ce que
   cela découvre : on peut savoir qu'un locataire a marqué tel rayon privé.

   Ce n'est pas un contenu, c'est un réglage — et il est déjà déductible en
   regardant ce qui apparaît ou non sur une page publique. Aucune route de
   l'API n'expose cette table ; seule une connexion SQL directe la lit.

   En échange, la règle de visibilité s'applique VRAIMENT. Une protection
   qui ne s'applique pas mais qu'on croit active est bien pire qu'un réglage
   découvrable. */
drop policy if exists rayons_reglages_lecture on public.rayons_reglages;
create policy rayons_reglages_lecture on public.rayons_reglages for select
  using (true);

/* Un résumé est lisible si vous possédez l'ouvrage, ou si quelqu'un l'a
   rendu public.

   POURQUOI PAS « lisible par tous », qui serait plus simple.

   Le catalogue est partagé, mais l'EXISTENCE d'un résumé dit que quelqu'un
   a demandé ce livre. Avec deux ou trois utilisateurs, cela revient à dire
   qui possède quoi — y compris pour les ouvrages qu'ils gardent privés.
   L'économie recherchée, elle, est préservée : elle se matérialise quand un
   second lecteur possède le livre, et à ce moment-là il peut le lire.

   SECURITY DEFINER : la fonction lit possessions, elle-même cloisonnée. Sans
   cela, un visiteur ne verrait aucune possession, la fonction rendrait faux,
   et AUCUN résumé ne s'afficherait sur les pages publiques. */
create or replace function public.resume_lisible(ouvrage uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.possessions p
     where p.ouvrage_id = ouvrage
       and (p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
            or public.possession_publique(p)));
$$;

/* =========================================================================
   CLOISONNEMENT
   ========================================================================= */

alter table public.possessions      enable row level security;
alter table public.possessions      force  row level security;
alter table public.ouvrages         enable row level security;
alter table public.ouvrages         force  row level security;
alter table public.resumes_ouvrages enable row level security;
alter table public.resumes_ouvrages force  row level security;

/* LECTURE : ce qui est à vous, plus ce que d'autres ont rendu public.
 *
 * La politique dit ce qui NE PEUT PAS sortir ; c'est la vue « livres » qui
 * dit ce que l'application VEUT montrer. Séparer les deux évite le défaut
 * qu'on a eu le 15/08/2026 dans l'autre sens : une politique qui essayait
 * de faire les deux montrait à un utilisateur connecté les ouvrages publics
 * des autres, mélangés à sa propre bibliothèque.
 *
 * Cette forme permissive est aussi ce qui permet à resume_lisible() de
 * fonctionner pour quelqu'un de connecté : sans elle, un visiteur voyait
 * les résumés des pages publiques, mais pas un utilisateur identifié. */
drop policy if exists possessions_lecture on public.possessions;
create policy possessions_lecture on public.possessions for select
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         or public.possession_publique(possessions));

/* ÉCRITURE : chez soi, et nulle part ailleurs. Trois politiques distinctes
   plutôt qu'une clause « for all » — parce qu'une politique « for all »
   avec un USING permissif rendrait aussi les autres modifiables. */
drop policy if exists possessions_locataire on public.possessions;
drop policy if exists possessions_visiteur on public.possessions;

drop policy if exists possessions_ajout on public.possessions;
create policy possessions_ajout on public.possessions for insert
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists possessions_maj on public.possessions;
create policy possessions_maj on public.possessions for update
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists possessions_retrait on public.possessions;
create policy possessions_retrait on public.possessions for delete
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* Le catalogue se LIT sans restriction : il ne contient que des faits
   bibliographiques publiés, et aucune trace de qui possède quoi.

   Il ne s'ÉCRIT que depuis une session ouverte. Un visiteur anonyme qui
   pourrait insérer dans le catalogue partagé le corromprait pour tout le
   monde d'un seul appel. */
drop policy if exists ouvrages_lecture on public.ouvrages;
create policy ouvrages_lecture on public.ouvrages for select using (true);

drop policy if exists ouvrages_ajout on public.ouvrages;
create policy ouvrages_ajout on public.ouvrages for insert
  with check (nullif(current_setting('app.tenant_id', true), '') is not null);

/* La modification est réservée à ceux qui possèdent l'ouvrage. Sans cette
   condition, n'importe quel compte pourrait réécrire le titre d'un livre
   qu'il n'a pas — et le changement s'afficherait chez tous les autres. */
drop policy if exists ouvrages_correction on public.ouvrages;
create policy ouvrages_correction on public.ouvrages for update
  using (exists (select 1 from public.possessions p
                  where p.ouvrage_id = ouvrages.id
                    and p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (true);

drop policy if exists resumes_ouvrages_lecture on public.resumes_ouvrages;
create policy resumes_ouvrages_lecture on public.resumes_ouvrages for select
  using (public.resume_lisible(ouvrage_id));

drop policy if exists resumes_ouvrages_ecriture on public.resumes_ouvrages;
create policy resumes_ouvrages_ecriture on public.resumes_ouvrages for insert
  with check (exists (select 1 from public.possessions p
                       where p.ouvrage_id = resumes_ouvrages.ouvrage_id
                         and p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

drop policy if exists resumes_ouvrages_maj on public.resumes_ouvrages;
create policy resumes_ouvrages_maj on public.resumes_ouvrages for update
  using (exists (select 1 from public.possessions p
                  where p.ouvrage_id = resumes_ouvrages.ouvrage_id
                    and p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid))
  with check (true);

/* =========================================================================
   LA VUE QUE L'APPLICATION INTERROGE

   « security_invoker » est indispensable : sans lui, la vue s'exécuterait
   avec les droits de son PROPRIÉTAIRE et court-circuiterait toutes les
   politiques ci-dessus. Une vue qui contourne la sécurité des tables qu'elle
   assemble est pire que pas de vue du tout — elle a l'air d'un simple
   raccourci de lecture.
   ========================================================================= */

/* LA VUE EXPRIME L'INTENTION DE L'APPLICATION, PAS LA SÉCURITÉ.
 *
 * « Ma bibliothèque » quand on est identifié ; « ce qui est public » quand
 * on ne l'est pas. Sans ce filtre, un utilisateur connecté verrait les
 * ouvrages publics des autres mélangés aux siens — le compte de sa
 * bibliothèque changerait selon les invités inscrits.
 *
 * La sécurité, elle, reste dans les politiques : même si ce filtre était
 * retiré, rien de privé ne pourrait sortir. */
create or replace view public.livres
with (security_invoker = true) as
select p.tenant_id,
       p.id,
       o.id as ouvrage_id,
       o.isbn, o.titre, o.auteur, o.editeur, o.annee, o.pages,
       o.cover_url, o.cover_statut,
       p.statut, p.note, p.categorie, p.sous_categorie, p.sphere, p.visibilite,
       p.ajoute_le, p.maj_le
  from public.possessions p
  join public.ouvrages o on o.id = p.ouvrage_id
 where case
         when nullif(current_setting('app.tenant_id', true), '') is null
           then public.possession_publique(p)
         else p.tenant_id = current_setting('app.tenant_id', true)::uuid
       end;

comment on view public.livres is
  'Assemblage lecture seule du catalogue partagé et des possessions. Les
   écritures passent par possessions, ouvrages et resumes_ouvrages.';
