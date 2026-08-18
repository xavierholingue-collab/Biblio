/* ===========================================================================
   D'OÙ VIENT CETTE NOTICE

   Le 18/08/2026 au soir, un livre entre dans la bibliothèque sans éditeur.
   Pour savoir quoi réparer, il faut d'abord savoir QUI A RÉPONDU : la BnF,
   Open Library, Google Books, ou le modèle faute de mieux. Trois fichiers
   différents, trois correctifs différents.

   La réponse a demandé une demi-heure d'enquête — interroger la BnF à la
   main, comparer les notices, remonter le journal des appels — pour une
   information que l'API connaissait au moment même où elle écrivait la ligne,
   et qu'elle jetait aussitôt : « source » est renvoyée au navigateur et
   enregistrée nulle part.

   Ce fichier lui donne une colonne.

   ---------------------------------------------------------------------------
   POURQUOI SUR « ouvrages » ET PAS DANS « appels_ia »

   Le journal des appels aurait semblé le bon endroit — il porte déjà le coût,
   la route, l'heure. Mais il a été écrit avec une règle explicite : AUCUN
   CONTENU. Ni titre, ni ISBN, ni question posée. Y ajouter l'identifiant du
   livre pour relier une source à une notice reviendrait sur cette décision
   par la petite porte, et constituerait l'historique de lecture que ce
   journal refuse d'être.

   La provenance est de toute façon une propriété de la NOTICE, pas de
   l'appel qui l'a obtenue.

   ---------------------------------------------------------------------------
   CE CHAMP EST DÉCLARATIF, ET IL FAUT LE SAVOIR

   Il fait l'aller-retour par le navigateur : l'API le rend avec la fiche, la
   page le renvoie à l'enregistrement. Un client modifié pourrait donc écrire
   « bnf » sur une notice inventée.

   C'est acceptable parce que ce champ NE COMMANDE RIEN. Il ne décide d'aucune
   visibilité, d'aucune dépense, d'aucun droit. Il sert à répondre « pourquoi
   cette fiche est-elle pauvre ». Un mensonge n'y coûte qu'un diagnostic faux
   à celui qui a menti.

   On borne quand même la FORME — pas le vocabulaire. Les sources changeront ;
   une liste fermée en base devrait être migrée à chaque ajout, et une
   contrainte qu'on doit modifier souvent finit par être retirée. La
   contrainte ci-dessous interdit ce qui n'a rien à faire là — texte libre,
   balises, contenu venu d'ailleurs — et laisse la composition ouverte.
   « bnf », « bnf+openlibrary », « bnf:autre-edition », « modele ».

   ---------------------------------------------------------------------------
   DDL SEULEMENT : aucune écriture, donc aucune levée de politiques. Si l'on
   ajoute un jour un remplissage rétroactif, il faudra lever et remettre comme
   le font 02, 03, 04 et 05 — et test-rejeu.mjs l'exigera tout seul, puisque
   sa règle est déduite du contenu du fichier.
   =========================================================================== */

alter table public.ouvrages
  add column if not exists source    text,
  add column if not exists source_le timestamptz;

alter table public.ouvrages drop constraint if exists ouvrages_source_forme;
alter table public.ouvrages add constraint ouvrages_source_forme
  check (source is null or source ~ '^[a-z][a-z0-9:-]{0,29}(\+[a-z][a-z0-9:-]{0,29}){0,3}$');

/* Les notices existantes gardent « source » à NULL, et c'est exact : on ne
   sait pas d'où elles viennent, et l'inventer serait pire que l'ignorer.
   NULL se lit « avant que la question soit posée ». */

comment on column public.ouvrages.source is
  'Provenance déclarative de la notice (bnf, openlibrary, googlebooks, modele, '
  'ou composition). Diagnostic uniquement : ne commande aucun droit.';
