/* ===========================================================================
   MULTI-LOCATAIRE — cloisonnement, visibilité, résumés par langue

   Rejouable : tout est en « if not exists » ou en « create or replace ».

   ---------------------------------------------------------------------------
   CE QUI PROTÈGE, ET POURQUOI CE N'EST PAS L'APPLICATION

   Le cloisonnement repose sur la Row-Level Security de PostgreSQL, pas sur
   des « where tenant_id = ... » écrits à la main. La différence est décisive :
   une clause oubliée dans une seule requête ferait fuir la bibliothèque d'un
   inconnu, et rien ne le signalerait. Ici, c'est le moteur qui refuse.

   CONDITION IMPÉRATIVE
   Le rôle applicatif ne doit être NI superutilisateur NI BYPASSRLS. Un
   superutilisateur contourne toutes les politiques, silencieusement.
   Vérifié le 15/08/2026 sur PGlite : en superutilisateur, alice voyait les
   données de bob alors que les politiques étaient en place et paraissaient
   correctes. Le contrôle de cloisonnement doit donc TOUJOURS s'exécuter sous
   le rôle applicatif.

   ---------------------------------------------------------------------------
   RÈGLE DE VISIBILITÉ

   La bibliothèque est un VERROU MAÎTRE : privée ferme tout, sans exception.
   Un ouvrage explicitement public dans une bibliothèque privée reste
   invisible. C'est la seule règle qu'un utilisateur peut tenir en tête, et
   la seule où le geste de panique — « je passe tout en privé » — fonctionne
   réellement.

   Sous ce verrou, le plus précis l'emporte : l'ouvrage prime sur le rayon,
   qui prime sur la bibliothèque.
   =========================================================================== */

/* Pas d'extension pgcrypto : gen_random_uuid() est intégré à PostgreSQL
   depuis la version 13, et la production tourne en 17. Une extension de
   moins est une dépendance de moins — et PGlite, qui sert au banc d'essai
   local, ne la fournit pas. */

/* ------------------------------------------------------------- Locataires */

create table if not exists public.tenants (
  id           uuid primary key default gen_random_uuid(),
  -- Identifiant d'URL : /u/xavier. Minuscules, sans accent, unique.
  identifiant  text not null unique
               check (identifiant ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  nom          text not null,
  visibilite   text not null default 'privee'
               check (visibilite in ('privee', 'publique')),
  langue       text not null default 'fr' check (langue in ('fr', 'en')),
  -- Quota mensuel d'appels au modèle. Mesure de la demande autant que
  -- protection : sans lui, une bibliothèque de 400 titres résumée d'un coup
  -- se paie sur le compte du propriétaire du service.
  quota_ia_mois integer not null default 10 check (quota_ia_mois >= 0),
  cree_le      timestamptz not null default now()
);

create table if not exists public.comptes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  courriel   text not null unique check (position('@' in courriel) > 1),
  cree_le    timestamptz not null default now(),
  vu_le      timestamptz
);
create index if not exists comptes_tenant on public.comptes(tenant_id);

/* Liens magiques : pas de mot de passe stocké, donc rien à voler ni à
   réinitialiser. On ne garde qu'une EMPREINTE du jeton — un vol de la base
   ne permettrait pas de s'authentifier. */
create table if not exists public.liens_connexion (
  empreinte  text primary key,
  compte_id  uuid not null references public.comptes(id) on delete cascade,
  expire_le  timestamptz not null,
  utilise_le timestamptz
);

/* ------------------------------------------- Rattachement de l'existant */

-- Locataire d'origine : la bibliothèque déjà en place. Créé une seule fois.
insert into public.tenants (identifiant, nom, visibilite, langue, quota_ia_mois)
values ('xavier', 'Xavier Holingue', 'publique', 'fr', 100000)
on conflict (identifiant) do nothing;

alter table public.books
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

-- Les ouvrages existants reviennent au locataire d'origine. Idempotent.
update public.books
   set tenant_id = (select id from public.tenants where identifiant = 'xavier')
 where tenant_id is null;

alter table public.books alter column tenant_id set not null;
create index if not exists books_tenant on public.books(tenant_id);

/* Visibilité de l'ouvrage. « heritee » suit le rayon, qui suit la
   bibliothèque. La valeur par défaut n'expose donc rien tant que la
   bibliothèque est privée. */
alter table public.books add column if not exists visibilite text not null default 'heritee'
  check (visibilite in ('heritee', 'publique', 'privee'));

/* La sphère Pro/Perso d'origine devient un réglage de visibilité explicite :
   Pro était public, Perso privé. On préserve le comportement observable,
   mais désormais il est INSCRIT plutôt qu'implicite dans le code. */
update public.books set visibilite = case when sphere = 'Pro' then 'publique' else 'privee' end
 where visibilite = 'heritee';

create table if not exists public.rayons_reglages (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  categorie      text not null,
  sous_categorie text not null,
  visibilite     text not null default 'heritee'
                 check (visibilite in ('heritee', 'publique', 'privee')),
  primary key (tenant_id, categorie, sous_categorie)
);

alter table public.rayons_ajoutes
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
update public.rayons_ajoutes
   set tenant_id = (select id from public.tenants where identifiant = 'xavier')
 where tenant_id is null;

alter table public.reading_quests
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
update public.reading_quests
   set tenant_id = (select id from public.tenants where identifiant = 'xavier')
 where tenant_id is null;

/* ------------------------------------------------- Résumés, un par langue */

create table if not exists public.resumes (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  book_id    text not null,
  langue     text not null check (langue in ('fr', 'en')),
  resume     text,
  points     text[],
  themes     text[],
  modele     text,
  fiabilite  text,
  genere_le  timestamptz not null default now(),
  primary key (tenant_id, book_id, langue)
);

-- Reprise des résumés existants, tous français. Idempotent.
insert into public.resumes (tenant_id, book_id, langue, resume, points, themes, modele, fiabilite, genere_le)
select b.tenant_id, b.id, 'fr', b.resume, b.resume_points, b.resume_themes,
       b.resume_modele, b.resume_fiabilite, coalesce(b.resume_genere_le, now())
  from public.books b
 where b.resume is not null
on conflict (tenant_id, book_id, langue) do nothing;

/* -------------------------------------------------- Calcul de visibilité

   En base, et non dans l'application : une règle de visibilité écrite dans
   le code se contourne en oubliant de l'appeler. */
/* SECURITY DEFINER, et il faut dire pourquoi.

   Cette fonction lit rayons_reglages, qui est elle-même protégée par RLS.
   Appelée pour un VISITEUR anonyme — donc sans app.tenant_id —, la
   sous-requête ne rendrait aucune ligne : le rayon serait tenu pour
   « hérité », et un rayon explicitement marqué PRIVÉ deviendrait visible.

   Le réglage de confidentialité aurait été accepté, affiché comme actif, et
   n'aurait rien protégé. C'est le défaut le plus grave qu'on puisse écrire
   ici, et il ne se serait vu qu'en consultant la page publique de
   quelqu'un d'autre.

   search_path figé : sans cela, un objet homonyme dans un schéma en tête de
   chemin pourrait détourner l'exécution d'une fonction privilégiée. */
create or replace function public.livre_public(l public.books) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    -- VERROU MAÎTRE. Rien ne passe si la bibliothèque est privée.
    when (select t.visibilite from public.tenants t where t.id = l.tenant_id)
         is distinct from 'publique' then false
    when l.visibilite = 'privee'   then false
    when l.visibilite = 'publique' then true
    -- Ouvrage hérité : on suit le rayon. Un rayon hérité suit la
    -- bibliothèque, qui est publique à ce stade.
    else coalesce((select r.visibilite from public.rayons_reglages r
                    where r.tenant_id = l.tenant_id
                      and r.categorie = l.categorie
                      and r.sous_categorie = l.sous_categorie), 'heritee') <> 'privee'
  end;
$$;

/* ------------------------------------------------------------------- RLS */

alter table public.books           enable row level security;
alter table public.books           force  row level security;
alter table public.rayons_ajoutes  enable row level security;
alter table public.rayons_ajoutes  force  row level security;
alter table public.rayons_reglages enable row level security;
alter table public.rayons_reglages force  row level security;
alter table public.reading_quests  enable row level security;
alter table public.reading_quests  force  row level security;
alter table public.resumes         enable row level security;
alter table public.resumes         force  row level security;

/* app.tenant_id est posé au début de chaque requête HTTP. Non posé, il vaut
   NULL : la comparaison est fausse, et le locataire ne voit rien. Fermé par
   défaut, c'est le sens de la marche. */
drop policy if exists books_locataire on public.books;
create policy books_locataire on public.books
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* Le visiteur — et LUI SEUL.

   PostgreSQL combine les politiques permissives par un OU. Sans la première
   condition, un locataire connecté verrait ses ouvrages PLUS les ouvrages
   publics de tout le monde : sa propre bibliothèque contiendrait les livres
   des autres, ses statistiques les compteraient, sa mosaïque les
   dessinerait.

   Constaté le 15/08/2026 : bob, connecté, voyait trois ouvrages d'alice.
   Ce n'était pas une fuite de données privées — elles étaient publiques —
   mais c'était faux, et cela se serait vu comme un défaut d'affichage
   inexplicable plutôt que comme une erreur de cloisonnement.

   D'où la règle : UN CONTEXTE PAR REQUÊTE. Soit un locataire agit chez lui,
   soit un visiteur consulte le public. Pour servir la page publique de
   quelqu'un, l'application VIDE app.tenant_id — un geste explicite, visible
   dans le code, et non un effet de bord. */
drop policy if exists books_visiteur on public.books;
create policy books_visiteur on public.books for select
  using (nullif(current_setting('app.tenant_id', true), '') is null
         and public.livre_public(books));

drop policy if exists resumes_locataire on public.resumes;
create policy resumes_locataire on public.resumes
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Un résumé n'est lisible publiquement que si SON ouvrage l'est.
drop policy if exists resumes_visiteur on public.resumes;
create policy resumes_visiteur on public.resumes for select
  using (nullif(current_setting('app.tenant_id', true), '') is null
         and exists (select 1 from public.books b
                      where b.id = resumes.book_id
                        and b.tenant_id = resumes.tenant_id
                        and public.livre_public(b)));

drop policy if exists rayons_ajoutes_locataire on public.rayons_ajoutes;
create policy rayons_ajoutes_locataire on public.rayons_ajoutes
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists rayons_reglages_locataire on public.rayons_reglages;
create policy rayons_reglages_locataire on public.rayons_reglages
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists quests_locataire on public.reading_quests;
create policy quests_locataire on public.reading_quests
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

/* Les tables de comptes ne sont jamais lues par le chemin applicatif
   ordinaire : l'authentification s'exécute avant qu'un locataire soit établi.
   Elles restent hors RLS, et ne doivent être atteintes que par les routes
   d'authentification. */
