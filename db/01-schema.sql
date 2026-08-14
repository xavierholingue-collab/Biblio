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

/* ---------------------------------------------------------------------------
   RAYONS AJOUTÉS

   Les treize rayons d'origine restent dans le code : ils sont stables et
   servent de garantie. Cette table ne contient QUE les rayons ajoutés en
   cours de route, quand un ouvrage n'entre dans aucun des rayons prévus.

   Pourquoi ne pas tout mettre en base ? Parce qu'une table vide ou une
   requête ratée priverait alors l'application de toute classification. Ici,
   le pire cas est de perdre les ajouts — le socle tient.

   Ajoutée le 12/08/2026, après « Pop Forever », catalogue d'exposition d'art
   qui n'entrait dans aucun rayon et que le modèle avait rangé en
   « Management & leadership » faute d'avoir le droit de dire non.
   --------------------------------------------------------------------------- */
create table if not exists public.rayons_ajoutes (
  categorie   text        not null check (categorie in ('Académique', 'Roman', 'BD')),
  libelle     text        not null check (length(btrim(libelle)) between 2 and 60),
  cree_le     timestamptz not null default now(),
  primary key (categorie, libelle)
);

/* ---------------------------------------------------------------------------
   PAGINATION

   Ajoutée le 14/08/2026. Volontairement NULLABLE, et c'est le cœur du sujet :
   une pagination inconnue doit rester inconnue.

   La tentation serait de mettre 0, ou la moyenne du rayon. Les deux mentent :
   la première efface un ouvrage réel des totaux, la seconde invente un volume
   et le rend indiscernable d'une mesure. C'est la même faute que le zéro sur
   une dimension non mesurée dans les rapports Adapsis.

   Les statistiques exposent donc TOUJOURS le volume ET le nombre d'ouvrages
   sur lequel il porte. Un total sans son effectif n'est pas interprétable.
   --------------------------------------------------------------------------- */
alter table public.books add column if not exists pages integer
  check (pages is null or (pages > 0 and pages < 20000));

-- « absente » signifie : toutes les sources ont été interrogées, aucune ne
-- l'a. Sans cette colonne, on ne saurait pas distinguer un ouvrage jamais
-- cherché d'un ouvrage cherché en vain — et on le rechercherait sans fin.
alter table public.books add column if not exists pages_statut text
  check (pages_statut is null or pages_statut in ('trouvee', 'absente'));
