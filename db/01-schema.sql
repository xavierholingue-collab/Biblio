-- Schéma de la bibliothèque. Exécuté une seule fois, à la création du volume.

create table if not exists public.books (
  id              text primary key,
  isbn            text,
  titre           text not null,
  auteur          text not null,
  editeur         text,
  annee           integer,
  statut          text not null default 'A lire'
                    check (statut in ('Lu', 'En cours', 'A lire')),
  note            numeric(2,1) check (note >= 0 and note <= 5),
  categorie       text not null check (categorie in ('Académique', 'Roman', 'BD')),
  sous_categorie  text not null,
  sphere          text not null default 'Pro' check (sphere in ('Perso', 'Pro')),
  cover_url       text,
  cover_statut    text not null default 'inconnu'
                    check (cover_statut in ('inconnu', 'trouvee', 'absente')),
  resume          text,
  resume_points   text[],
  resume_themes   text[],
  resume_modele   text,
  resume_fiabilite text check (resume_fiabilite in ('haute', 'moyenne', 'faible')),
  resume_genere_le timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.books is 'Les ouvrages de la bibliothèque, avec couverture et résumé en cache.';

create index if not exists books_categorie_idx on public.books (categorie, sous_categorie);
create index if not exists books_statut_idx    on public.books (statut);
create index if not exists books_sphere_idx    on public.books (sphere);
create index if not exists books_auteur_idx    on public.books (auteur);
create index if not exists books_themes_idx    on public.books using gin (resume_themes);

create index if not exists books_fts_idx on public.books using gin (
  to_tsvector('french',
    coalesce(titre,'') || ' ' || coalesce(auteur,'') || ' ' ||
    coalesce(editeur,'') || ' ' || coalesce(resume,''))
);

-- Historique des recherches « qu'ai-je envie d'apprendre »
create table if not exists public.reading_quests (
  id         bigserial primary key,
  intention  text not null,
  reponse    jsonb not null,
  modele     text,
  created_at timestamptz not null default now()
);

create index if not exists reading_quests_date_idx on public.reading_quests (created_at desc);

-- updated_at automatique
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists books_touch_updated_at on public.books;
create trigger books_touch_updated_at
  before update on public.books
  for each row execute function public.touch_updated_at();
