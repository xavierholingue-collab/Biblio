# Bibliothèque — dossier de référence

Dernière mise à jour : 27 juillet 2026. **321 ouvrages** : 241 académiques, 43 romans, 37 BD.

L'application est passée d'un fichier autonome à une application connectée à
**Supabase** : les données vivent désormais sur un serveur, les mêmes sur tous
vos appareils, et Claude Sonnet 5 y ajoute des résumés et des recommandations.

## À faire une fois avant d'ouvrir l'application

Trois étapes, une quinzaine de minutes. Tant qu'elles ne sont pas faites,
l'application affiche l'écran de connexion sans pouvoir aller plus loin.

### 1. Créer une clé API Anthropic

1. Aller sur <https://console.anthropic.com> → **API Keys** → **Create Key**.
2. Copier la clé (elle commence par `sk-ant-`). Elle n'est affichée qu'une fois.
3. Créditer le compte dans **Billing** : 5 € suffisent largement.
   Ordre de grandeur : environ 1 centime par résumé de livre, 2 à 3 centimes
   par recommandation. Résumer les 321 ouvrages coûterait environ 3 €, mais
   rien ne vous y oblige : chaque résumé n'est produit qu'à la première ouverture
   de la fiche, puis conservé.

### 2. Déposer la clé côté serveur

1. Aller sur <https://supabase.com/dashboard/project/lzeroezqmrnewdmhquvf/settings/functions>
2. Section **Edge Function Secrets** → **Add new secret**.
3. Nom exactement `ANTHROPIC_API_KEY`, valeur : la clé copiée. **Save**.

La clé reste sur le serveur Supabase. Elle n'est jamais envoyée au navigateur,
donc jamais lisible dans le fichier HTML ni dans les outils de développement.

### 3. Créer votre compte

1. Aller sur <https://supabase.com/dashboard/project/lzeroezqmrnewdmhquvf/auth/users>
2. **Add user** → **Create new user**.
3. Saisir votre adresse e-mail et un mot de passe, cocher **Auto Confirm User**.

C'est le couple e-mail / mot de passe que vous utiliserez dans l'application.
Passer par le tableau de bord évite d'avoir à configurer l'envoi d'e-mails.

### 4. Lancer l'application

**Double-cliquez sur `Lancer ma bibliotheque.cmd`.** Une fenêtre noire s'ouvre
et le navigateur affiche l'application. Laissez la fenêtre ouverte tant que vous
utilisez la bibliothèque ; fermez-la pour arrêter.

N'ouvrez pas `ma-bibliotheque.html` par un double-clic direct : les navigateurs
refusent tout appel réseau depuis un fichier local (`file://`), et la connexion
échoue avec « Failed to fetch ». Le lanceur sert le dossier sur
`http://127.0.0.1:8765`, une adresse que le navigateur accepte. Il n'installe
rien : il s'appuie sur PowerShell, déjà présent sur Windows.

Connectez-vous ensuite avec l'e-mail et le mot de passe de l'étape 3. Au premier
lancement, les 321 ouvrages embarqués dans le fichier sont transférés vers
Supabase : comptez une poignée de secondes. Les fois suivantes, ils sont
simplement relus.

## Fichiers du dossier

| Fichier | Rôle |
|---|---|
| `Lancer ma bibliotheque.cmd` | **Le point d'entrée.** Double-clic : démarre le serveur local et ouvre l'application. |
| `serveur.ps1` | Le serveur local appelé par le lanceur. Ne pas ouvrir directement. |
| `ma-bibliotheque.html` | L'application elle-même. |
| `vendor/supabase-js-2.110.8.min.js` | Bibliothèque cliente Supabase, servie localement. **Doit rester à côté du HTML.** |
| `bibliotheque-data.json` | Les données seules, format réimportable. |
| `bibliotheque-data.csv` | Les mêmes données, lisibles dans Excel. |
| `test/test-fumee.js` | Test automatisé de l'application (voir plus bas). |
| `README-bibliotheque.md` | Ce document. |

L'application n'est plus un fichier unique : elle a besoin du dossier `vendor/`.
Déplacez toujours les deux ensemble.

## Les trois nouveautés

### Couvertures

La vue **Couvertures** affiche la bibliothèque en grille. Chaque couverture est
cherchée par ISBN sur Open Library, puis sur Google Books si Open Library ne l'a
pas. Quand aucune image n'existe, une couverture typographique est dessinée aux
couleurs du rayon. L'adresse trouvée est mémorisée : la recherche n'a lieu
qu'une fois par ouvrage, et les fois suivantes l'affichage est immédiat.

Un liseré indique les ouvrages non lus ; une barre verte en bas signale qu'un
résumé est disponible.

### Résumés

Cliquer sur un ouvrage ouvre sa fiche. Si le résumé n'existe pas encore, il est
demandé à Claude Sonnet 5, qui vérifie d'abord par recherche web de quel livre
il s'agit. Le résultat — un résumé, trois à cinq idées-clés, une poignée de
thèmes — est enregistré et ne sera plus jamais regénéré, sauf demande explicite
via **Régénérer le résumé**.

Les thèmes sont cliquables : ils relancent une recherche sur toute la
bibliothèque. La barre de recherche interroge donc aussi les thèmes, ce qui
permet de retrouver un livre par son sujet et non seulement par son titre.

Le modèle peut se tromper d'ouvrage, en particulier sur des titres ambigus ou
des rééditions. Il l'indique lui-même quand son identification est incertaine,
et la fiche porte toujours la mention de la date et du modèle. À vérifier avant
toute citation.

### Recommandation par intention

Le bloc en haut de page attend une intention, pas un mot-clé : « comprendre
pourquoi les équipes prennent de mauvaises décisions collectives » plutôt que
« décision ». Claude Sonnet 5 reçoit le catalogue complet et renvoie :

- un parcours ordonné de trois à six de **vos** ouvrages, chacun accompagné de
  ce qu'il apporte précisément à cette question et du chapitre à viser ;
- ce que votre bibliothèque ne couvre pas sur ce sujet ;
- deux ou trois ouvrages absents de vos rayons, vérifiés par recherche web,
  ajoutables en un clic à votre liste « A lire ».

Les identifiants renvoyés par le modèle sont recoupés avec la base côté serveur :
un titre inventé est écarté avant même d'atteindre l'écran. Les recherches sont
conservées dans la table `reading_quests`.

## Modèle de données

Table `books` sur Supabase. Les neuf champs d'origine sont conservés, cinq
s'y ajoutent.

| Champ | Contenu |
|---|---|
| `id`, `isbn`, `titre`, `auteur`, `editeur`, `annee` | Identité de l'ouvrage |
| `statut` | `Lu`, `En cours` ou `A lire` |
| `note` | Sur 5, ou `null` |
| `categorie`, `sous_categorie` | Taxonomie (voir ci-dessous) |
| `sphere` | `Perso` ou `Pro`. Voir ci-dessous. |
| `cover_url`, `cover_statut` | Couverture résolue et mémorisée |
| `resume`, `resume_points`, `resume_themes` | Production de Sonnet 5 |
| `resume_modele`, `resume_genere_le` | Traçabilité du résumé |
| `owner_id` | Votre compte. Renseigné automatiquement. |

`auteur` suit le format « Nom Prénom ».

## Perso et Pro

Champ indépendant de la taxonomie, modifiable ouvrage par ouvrage depuis le
formulaire. Répartition initiale : les 37 BD et les 43 romans sont en **Perso**,
les 241 académiques en **Pro**.

Ce découpage par défaut est grossier — la philosophie, la géopolitique ou les
sciences relèvent sans doute davantage du personnel chez vous. Le menu déroulant
« Perso et Pro » de la barre d'outils permet de filtrer, et la fiche de chaque
livre se corrige en deux clics via **Modifier**.

Le filtre agit aussi sur la recommandation : si vous avez sélectionné `Pro`
avant de lancer une recherche par intention, Claude ne puise que dans ce
périmètre. Sans filtre, il considère toute la bibliothèque.

## Taxonomie

Deux niveaux : trois catégories, vingt-et-une sous-catégories. Une sous-catégorie
appartient toujours à une seule catégorie, sauf « Polar & thriller » qui existe
pour les romans comme pour les BD.

### Académique
| Sous-catégorie | Livres |
|---|---|
| Politique, société & géopolitique | 43 |
| Philosophie | 32 |
| Management & leadership | 31 |
| Décision, biais & rationalité | 26 |
| Numérique, IA & SI | 19 |
| Sciences & environnement | 18 |
| Psychologie & développement personnel | 17 |
| Économie | 15 |
| Industrie, opérations & lean | 14 |
| Communication & influence | 12 |
| Stratégie & marketing | 9 |
| Innovation & entrepreneuriat | 5 |

### Roman
| Sous-catégorie | Livres |
|---|---|
| Polar & thriller | 35 |
| Littérature générale | 4 |
| SF & humour | 2 |
| Classique | 2 |

### BD
| Sous-catégorie | Livres |
|---|---|
| SF & fantastique | 15 |
| Aventure & historique | 10 |
| Polar & thriller | 6 |
| Roman graphique & récit | 4 |
| Humour & société | 2 |

## Règles de classement retenues

- **Décision, biais & rationalité** regroupe le corpus sciences de la décision
  (Kahneman, Taleb, Sibony, Bronner, Tetlock, Thaler, Galef) plutôt que de le
  disperser entre psychologie et management.
- **Philosophie** accueille les textes politiques classiques (Hobbes, Machiavel,
  Tocqueville, Olympe de Gouges) ; **Politique, société & géopolitique** reçoit
  les essais contemporains.
- La fiction est classée par l'ouvrage, pas par l'auteur : *Candide* et *1984*
  sont des romans, les essais historiques de Maalouf sont académiques.
- Une BD reste une BD quel que soit son éditeur : *Que faire des juifs ?* (Sfar)
  et *Platon La Gaffe* (Pépin) en font partie.

## Mettre à jour la liste

1. Exporter la bibliothèque depuis Babelio (Paramètres → export).
2. Fournir le fichier avec la consigne « mets à jour la liste ».
   Le classement existant est conservé, seuls les nouveaux titres sont classés
   et les statuts et notes modifiés sont repris.

Pour un ajout ponctuel, le bouton **+ Ajouter un livre** suffit : la recherche
par ISBN ou par titre passe par le serveur et remplit le formulaire, en
contraignant le classement proposé à la taxonomie ci-dessus.

## Architecture

```
ma-bibliotheque.html          navigateur, clé publique Supabase uniquement
        │
        ├── PostgREST ────────► table books        (RLS : vos lignes seulement)
        │                       table reading_quests
        │
        └── Edge Functions ───► book-summary   ─┐
                                recommend      ─┼─► API Anthropic (Sonnet 5)
                                book-lookup    ─┘    clé secrète, côté serveur
```

Choix de sécurité :

- La clé Supabase présente dans le HTML est **publiable** par conception : elle
  n'ouvre aucun accès sans session valide.
- Le *Row Level Security* est actif sur les deux tables. Chaque ligne porte le
  compte propriétaire ; une requête ne peut lire ou écrire que ses propres
  lignes, y compris depuis les fonctions serveur.
- Les trois fonctions serveur exigent un jeton de session valide (`verify_jwt`).
- La clé Anthropic est un secret de projet Supabase, hors du navigateur.
- La bibliothèque cliente Supabase est servie depuis `vendor/`, pas depuis un
  CDN : aucun code tiers n'est chargé à l'exécution. Version 2.110.8,
  empreinte `sha384-M65KxMm/JqBppck6onbmAgPVMBHrmPCf1L17Q+71EcvI9/VVI8j5cqoxQf6lj6h2`.
- Le contrôle qualité de Supabase (*advisors*, catégorie sécurité) ne remonte
  aucune alerte sur ce projet.

## Tester après modification

Le fichier `test/test-fumee.js` rejoue tout le parcours — connexion, import,
filtres, couvertures, fiche, résumé, recommandation, ajout, export — dans un
navigateur simulé, sans toucher au réseau ni dépenser un centime. Trente-trois
vérifications.

```
cd test
npm install jsdom
node test-fumee.js
```

Il doit se terminer par « Aucune erreur. »

## Limites connues

- **Tous les fichiers du dossier doivent rester ensemble**, `vendor/` compris.
- L'application ne peut pas être ouverte en double-cliquant sur le HTML : elle
  passe par le lanceur. C'est une contrainte des navigateurs, pas un défaut de
  l'application.
- Si le port 8765 est déjà pris, le lanceur le signale et s'arrête. Changez la
  valeur de `$port` en tête de `serveur.ps1`.
- Si Windows bloque le script, faites un clic droit sur le `.cmd` →
  **Propriétés** → cochez **Débloquer** en bas de la fenêtre.
- Sans crédit sur le compte Anthropic, résumés et recommandations renvoient une
  erreur explicite ; le reste de l'application continue de fonctionner.
- Les couvertures dépendent d'Open Library et de Google Books : quelques
  ouvrages français peu diffusés n'en ont nulle part et gardent une couverture
  dessinée.
