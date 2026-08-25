# Quatre gestes, et ce qui les a coûtés

Ce fichier n'est pas une liste de bonnes pratiques. C'est un registre de
fautes commises dans ce dépôt, avec leur date, et le geste qui aurait
suffi à les éviter.

Une règle abstraite se discute. Une bibliothèque restée ouverte trente
minutes ne se discute pas. C'est pourquoi chaque règle est écrite **sous**
son exemple, et non l'inverse.

---

## Le fond commun

Le défaut est presque toujours le même : **affirmer, puis vérifier**.
L'information nécessaire était à une commande de distance, et la commande a
été lancée après coup — parfois par quelqu'un d'autre.

Aucun de ces quatre gestes ne rend infaillible. Ils déplacent la
vérification *avant* l'affirmation, là où elle coûte le moins.

---

## 1. Voir le rouge avant d'écrire le vert

**Le geste.** Avant de corriger un défaut, introduire ce défaut à
l'identique et **lire le message d'échec du contrôle**. Pas le code de
sortie : le message. Puis seulement corriger.

**Ce qu'il a coûté de ne pas le faire — 24/08/2026.** Quatre bancs de
mutation faux dans la même journée, tous en croyant éprouver quelque chose :

| Le banc disait | Ce qu'il faisait vraiment |
|---|---|
| « M2 survit » | `perl -0p` sans `/g` avait muté la *première* occurrence, pas la visée |
| « M3, M4, M5 attrapées » | `cp -r api dossier-existant` crée `api/api` : les mutations s'empilaient |
| « mutation nulle » jamais signalé | le garde-fou comparait à une référence déjà modifiée |
| « N3 attrapée » | le processus plantait ; le contrôle avait *vu* le défaut et n'a jamais imprimé son rapport |

Un contrôle qu'on ne regarde que pour le confirmer ne se fait jamais
contredire.

**Deux corollaires, payés le même jour.**

- *Une mutation doit prouver qu'elle a muté.* Sinon « survit » ne veut rien
  dire. Le garde-fou compare à la référence **exacte** dont la copie est
  issue, transformations locales comprises.
- *Un contrôle qui plante n'est pas un contrôle qui échoue.* Quatrième
  occurrence dans ce dépôt. Ce qui casse doit devenir un échec **nommé**, et
  tout ce qui avait déjà été constaté doit s'afficher quand même. Voir
  `enChaine()` dans `tests/test-suppression.mjs`.

---

## 2. La question de l'unité

**Le geste.** Avant d'écrire un garde-fou, une ligne en français :

> *ceci protège **X**, et compte **X**.*

Si les deux noms diffèrent, il y a une conversion — et la conversion est le
trou. Dix secondes.

**Ce qu'il a coûté — quatre fois en une semaine.**

| Le contrôle prétendait protéger | Il comptait | Ce qui passait |
|---|---|---|
| des adresses de courriel | des IP | un même destinataire, arrosé depuis N adresses |
| un budget en dollars | des appels | dix résumés à 0,086 $ sous un quota de cinquante |
| « un seul domaine déclaré » | des occurrences du mot | ce que la ligne *fait*, jamais vérifié |
| les inscriptions, fermées | **une** fonction sur trois | Google créait des comptes, drapeau à 0 |

Le dernier, le 24/08/2026, a laissé Lisia ouverte au monde pendant trente
minutes, alors que la configuration disait « fermé ».

**Corollaire.** Quand le X est un ensemble — « toutes les portes », « chaque
table », « chaque fichier d'essai » —, l'ensemble se lit **du répertoire, du
catalogue PostgreSQL ou de la chaîne de livraison**, jamais d'une liste
écrite à la main. Six listes manuelles ont été trouvées et retirées ici ; la
septième aurait été celle des tables à effacer, et elle aurait laissé
derrière elle exactement les données qu'on promettait de supprimer.

---

## 3. La question du déploiement

**Le geste.** Avant chaque mise en production, une phrase en français :

> *qu'est-ce qu'un inconnu peut faire après, qu'il ne pouvait pas avant ?*

**Ce qu'il a coûté — 24/08/2026, 17 h 56.** La réponse aurait été « créer un
compte, par Google, sans limite ». Elle sautait aux yeux. Personne ne l'a
posée, et le défaut a été trouvé une demi-heure plus tard, par hasard.

Aucun test unitaire ne pose cette question : elle porte sur l'**effet**, pas
sur le code. Dix-huit suites étaient vertes — et toutes lançaient leurs
serveurs avec `INSCRIPTION_OUVERTE: "1"`. Le drapeau n'a jamais été éprouvé
dans la position où il protège.

**Corollaire.** Un réglage de sécurité doit être éprouvé dans ses **deux**
positions. Un contrôle qui n'a jamais eu l'occasion de refuser n'a rien
prouvé.

---

## 4. Une promesse sans contrôle n'est qu'une promesse

**Le geste.** Toute affirmation portant sur l'**ensemble** du dépôt — « un
seul », « toujours », « aucun », « chaque » — est soit adossée à un contrôle
exécutable, soit réécrite en observation locale.

**Ce qu'il a coûté — 24/08/2026.** L'en-tête d'`api/oidc.mjs` affirmait :

> « Un seul endroit sait parler à Google ; un seul endroit sait créer un
> locataire. »

La seconde moitié était **fausse le jour où elle a été écrite** : il y en
avait deux, et une seule consultait le drapeau. Le commentaire a survécu
deux jours en rassurant quiconque le lisait — moi compris.

Un commentaire n'est pas un contrôle. Il ne s'exécute pas, il ne vieillit
pas, et il ne prévient jamais qu'il a cessé d'être vrai.

**Les contrôles nés de cette règle.** Ils forment une famille, et non trois
accidents :

- `tests/test-domaine.mjs` — un seul domaine, déclaré une seule fois
- `tests/test-couverture.mjs` — chaque fichier d'essai est bien lancé
- `tests/test-portes-inscription.mjs` — une seule porte crée un locataire
- `tests/test-pages-legales.mjs` — chaque tiers appelé par le code est déclaré
- `tests/test-suppression.mjs` — chaque table casse en cascade, selon le catalogue

Le dernier a attrapé une dérive **le jour même où il a été écrit** : le code
sait parler à Resend, la politique de confidentialité ne nommait que Brevo.

---

## Ce qui ne s'automatise pas, et revient à Xavier

Le seul défaut réellement dangereux du 24/08 n'a été trouvé par aucun
contrôle. Il l'a été **en se connectant avec une seconde adresse**, comme
quelqu'un qui utilise le produit.

Ce n'est pas un manque de procédure : c'est une propriété de la situation.
Un contrôle vérifie ce qu'on a pensé à vérifier. Un utilisateur fait ce
qu'un utilisateur fait.

> **Après toute modification touchant l'authentification, se connecter en
> tant que quelqu'un d'autre.**

Deux minutes. C'est le geste le plus rentable de la semaine.

---

## La limite, écrite ici pour ne pas se raconter d'histoires

Aucune de ces quatre règles n'aurait empêché la faute suivante, commise le
même jour : une fenêtre `sed -n '840,880p'` commençant une ligne trop bas, et
la conclusion — annoncée puis retirée — qu'il manquait un cas dans une table
de messages. Le cas était à la ligne 839.

Même famille, remède différent : **une affirmation sur un fichier exige une
lecture qui couvre la portée de l'affirmation.** Un extrait ne soutient pas
une conclusion sur le tout.

Celle-là ne s'automatise pas. Elle a été attrapée en relisant avant de
parler, et c'est la seule discipline qui reste quand les autres ont fait
leur part.

---

*Registre ouvert le 24 août 2026. Toute entrée porte sa date et son
exemple. Une entrée fausse coûte plus cher qu'une entrée absente : c'est ce
qui justifie le commit de rectification du 22/08 sur la mesure d'audience,
où un constat erroné avait été inscrit avant vérification.*
