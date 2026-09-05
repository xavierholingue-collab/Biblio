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

### La mutation doit reproduire la CONDITION, pas seulement changer le code

**25/08/2026, la porte de sortie.** Le bouton de suppression ne marchait
pas en production. La route lisait l'adresse à confirmer par
`select courriel from comptes limit 1` — sans clause `where`. « comptes »
est la seule table métier sans cloisonnement, volontairement : se connecter
exige de chercher une adresse à travers tous les comptes. La requête rendait
donc l'adresse d'un compte quelconque.

Trois fautes se sont recouvertes, et c'est ce qui rend le cas instructif.

**Première : j'ai éprouvé la base, pas la route.** `test-suppression.mjs`
appelle `supprimer_locataire()` directement. Il prouvait que PostgreSQL
efface bien — ce qui était vrai — et rien du chemin HTTP. Je l'avais même
dit à Xavier avant l'essai, sans en tirer la conséquence : écrire le
contrôle manquant.

**Deuxième : une assertion devinée a masqué une mutation survivante.**
J'avais écrit « la réponse annonce 2 ouvrages ». Il y en avait 3. La
vérification échouait donc *toujours*, mutation ou non — et son échec
ressemblait à celui de la mutation. Le banc semblait mordre ; il mordait sur
mon erreur. Les nombres attendus se **lisent en base**, ils ne se devinent
pas.

**Troisième, la plus subtile : la mutation ne reproduisait pas la
condition.** Mon montage insérait le compte de Xavier en premier. `limit 1`
rendait alors *sa* ligne, la bonne, et la mutation survivait au vert. Il a
fallu insérer le voisin d'abord pour que `limit 1` se trompe — c'est-à-dire
pour reproduire la production, où un compte datait du 14 août et l'autre du
24.

> Remettre le défaut dans le code ne suffit pas. Il faut aussi remettre les
> **données** dans l'état qui le rend visible. Un défaut peut être présent et
> muet.

Une fois la condition juste, le contrôle a dit ce que je n'avais pas
compris : avec `limit 1`, taper l'adresse d'un **inconnu** supprimait votre
bibliothèque. La confirmation n'était pas seulement inopérante ; elle
validait sur la donnée d'un tiers.

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

### Un nombre se borne là où on peut l'évaluer, pas là où il est écrit

**25/08/2026, le plafond d'inscriptions.** Pour empêcher qu'un plafond
journalier soit fixé à un million — c'est-à-dire absent, et muet —, j'ai
d'abord écrit une vérification qui lisait la valeur dans le fichier SQL,
par `select\s+(\d+)`.

Écrit `select (select 50)`, l'expression laissait la regex retrouver le 50 à
l'intérieur. La borne était contournée par une écriture parfaitement
légitime, et la mutation survivait au vert.

La borne est donc passée dans le contrôle qui **interroge la base** et
obtient la vraie valeur. La lecture de source garde ce qu'elle sait faire :
vérifier qu'un déclencheur existe, qu'un appel est unique, qu'un fichier est
cité. La structure se lit ; une valeur se calcule.

> Un contrôle qui lit du texte ne peut pas borner un nombre qu'il n'évalue
> pas. Il peut seulement borner la façon dont ce nombre est écrit — ce qui
> n'est pas la même chose, et ne protège de rien.

### La septième liste, trouvée quatre heures après avoir écrit ce corollaire

**25/08/2026, livraison #64.** `test-suppression.mjs` est ajouté à la chaîne
par une ligne `lancer supp test-suppression.mjs`. Ce que cette ligne ne dit
pas, c'est qu'une **autre** liste, trente lignes plus haut, énumérait les
bases à créer :

```yaml
for base in rls lang cat clois ctx rejeu regl durc lien usag bibl; do
```

Cinq minutes de contrôles verts — 28, 19, 13, 21, 16, 22, 42, 34, 81, 53,
81 vérifications — puis `database "biblio_supp" does not exist`.

Le corollaire ci-dessus avait été écrit le même jour, quelques heures plus
tôt. Le connaître n'a pas suffi : une liste manuelle ne se signale pas, elle
attend.

**Ce qui a été fait, et pourquoi ce n'est pas un contrôle.** On aurait pu
ajouter une vérification comparant les `lancer` aux `create database`. C'eût
été un contrôle de plus pour surveiller une faute qu'on peut simplement
rendre impossible : chaque `lancer` crée désormais **sa** base, au moment de
s'en servir. Il n'y a plus de liste, donc plus rien à oublier.

> **Une structure qui rend la faute impossible vaut mieux qu'un contrôle qui
> la signale.** Le contrôle se lit après coup ; la structure se lit en
> écrivant.

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

### Le second volet, ajouté le 25/08

La règle ci-dessus ne regardait que **vers l'extérieur** : l'inconnu, celui
qui n'a pas de compte. Elle était incomplète, et c'est le déploiement de la
porte de sortie — livraison #64, chaîne lancée le 25/08 à 08 h 19 — qui l'a
montré.

À la première question, ce déploiement répondait « rien, et même moins » :
la porte Google se refermait. Rassurant, et insuffisant — car il donnait par
ailleurs à tout utilisateur **déjà connecté** le pouvoir d'effacer sa
bibliothèque sans retour possible. Première action irréversible de
l'application, et la première question ne la voyait pas.

Deux questions, donc, et non une :

> 1. *Qu'est-ce qu'un **inconnu** peut faire après, qu'il ne pouvait pas
>    avant ?* — le risque d'intrusion.
> 2. *Qu'est-ce qu'un utilisateur **légitime** peut faire après, qu'il ne
>    pouvait pas avant ?* — le risque d'accident, et d'irréversibilité.

La seconde change ce qu'on livre : une capacité destructrice demande une
confirmation qui coûte un geste réfléchi — ici, recopier son adresse plutôt
que cocher une case — et un export offert juste avant.

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

## 5. Quand deux contrôles se contredisent, remonter à leur raison d'être

**Le geste.** Ne jamais désarmer le contrôle qui gêne. Relire *pourquoi*
chacun existe : le conflit se dénoue presque toujours là, et l'un des deux
se révèle hors de son domaine.

**Ce qu'il a coûté — 25/08/2026, livraison #65.** Deux contrôles écrits le
même jour, à quelques heures d'écart :

- `test-environnement.mjs` exigeait le bandeau de recette sur **chaque**
  page — parce qu'« on efface un jour des données en croyant être ailleurs ».
- `test-pages-legales.mjs` exigeait que les pages légales ne portent
  **aucun** script — parce qu'on ne mesure pas quelqu'un pendant qu'il lit
  ce qu'on fait de ses données.

Les pages légales sont arrivées, et les deux avaient raison localement.

La solution facile aurait été de nommer les deux fichiers comme exceptions.
La lecture des raisons donne mieux : le bandeau protège d'une **action**
faite sur le mauvais environnement, et une page sans action ne court pas ce
risque. Le script du bandeau, lui, appelle `/api/session` — donc contredit
frontalement la promesse de l'autre page.

**L'exemption est une propriété vérifiée, jamais un nom.** Non pas « ces
deux pages sont dispensées », mais « une page sans script, sans formulaire,
sans bouton et sans champ est dispensée ». Le jour où l'une gagne un bouton,
elle cesse d'être inerte et le contrôle la réclame de nouveau, tout seul —
vérifié par mutation.

**Et l'exemption elle-même s'éprouve.** Trois vérifications ajoutées pour
cela, dont une qui échoue si *toutes* les pages devenaient inertes : sans
elle, le contrôle aurait pu passer au vert en ne regardant plus rien.

> Un contrôle qui peut s'exempter lui-même n'est plus un contrôle.

---

## 6. Un commentaire qui explique *pourquoi* ça marche est une affirmation

*Ajoutée le 05/09/2026, sur la migration des bibliothèques partagées.*

J'ai écrit deux fonctions de connexion en `security definer`, avec ce
commentaire au-dessus :

> « `security definer`, parce que les politiques de `membres` ne montreraient
> rien à un visiteur. »

C'était faux. `security definer` exécute le corps avec les droits du
**propriétaire des tables** — et `force row level security` soumet
précisément le propriétaire aux politiques. Les fonctions ne voyaient rien.
Elles rendaient zéro ligne, sans la moindre erreur, et toute connexion
échouait sur « ce compte n'appartient à aucune bibliothèque ».

Ce n'est pas l'erreur qui est intéressante — le dépôt connaît ce piège, il
est écrit noir sur blanc quinze lignes plus haut dans le même fichier, à
propos de la reprise des données. C'est **le commentaire**. En énonçant un
mécanisme, il a rendu le code délibéré : quelque chose qui a l'air justifié
ne se relit plus. Un `security definer` posé sans explication aurait sans
doute déclenché la question ; expliqué, il l'a éteinte.

Même famille que la règle 4, un cran plus haut : là-bas c'était une promesse
sans contrôle, ici c'est **une explication sans vérification**. Et une
explication fausse est pire qu'absente, parce qu'elle immunise.

**Le remède, et il est court.** Quand un commentaire dit *pourquoi* un
mécanisme fonctionne, la phrase se vérifie comme du code — trois lignes dans
le bac à sable suffisaient ici :

```
en contexte VISITEUR, via la fonction security definer : []
```

Ce jour-là, une seconde vérification a suivi la première, et elle compte
autant : la politique corrigée a été **mutée en `using (true)`** pour voir si
quelque chose s'en apercevrait. Les vingt-sept vérifications du banc HTTP et
les dix-neuf du cloisonnement sont **restées vertes**. La table
`membres` — qui dit qui travaille avec qui — pouvait être ouverte à tous sans
qu'aucun contrôle bronche. Six vérifications ont été ajoutées pour cela.

> Une explication qui n'a pas été éprouvée n'explique rien : elle rassure.
> Et un mécanisme qu'on vient de corriger doit être cassé exprès, pour savoir
> si sa correction est tenue par autre chose que l'intention.

---

## 7. Sous RLS, toute question devient « qu'est-ce qu'on me montre ? »

*Ajoutée le 05/09/2026. Trois occurrences le même jour, sur trois mécanismes
qui n'ont rien à voir entre eux — c'est ce qui en fait une règle et non trois
anecdotes.*

**Le matin.** `security definer` posé sur les fonctions de connexion, avec le
commentaire « parce que les politiques ne montreraient rien à un visiteur ».
`security definer` exécute avec les droits du propriétaire des tables, et
`force row level security` soumet le propriétaire aux politiques. Les
fonctions rendaient zéro ligne. Sans erreur.

**L'après-midi.** Le déclencheur « une bibliothèque garde au moins un
propriétaire » comptait les propriétaires restants — sous RLS. Dans le
contexte de connexion, seules les lignes du compte concerné sont visibles :
pour un membre simple, la requête ne voyait AUCUN propriétaire, concluait au
départ du dernier, et refusait. Un membre ne pouvait pas ouvrir la
bibliothèque de son équipe.

**Le soir.** `insert … on conflict (compte_id, tenant_id) do nothing` a
répondu `new row violates row-level security policy`. La clause `with check`
était pourtant satisfaite. Ce qui manquait était la LECTURE : pour appliquer
`ON CONFLICT`, le moteur doit regarder la ligne en conflit, et regarder est
soumis aux politiques.

Trois fois la même confusion : **prendre ce qui m'est montré pour ce qui
existe.** Elle est difficile à voir parce que le résultat n'est jamais une
erreur franche — c'est un ensemble vide, un décompte à zéro, un message qui
désigne la mauvaise clause.

**Le remède, en trois questions à poser devant tout code qui touche une table
sous RLS :**

1. **Qui exécute, et sous quel contexte ?** Pas « qui appelle » — quel rôle,
   et quelles variables `app.*` sont posées à cet instant précis.
2. **Cette requête compte-t-elle, ou vérifie-t-elle une absence ?** Un
   `count`, un `not exists`, un `on conflict` répondent tous « je ne vois
   pas » quand la vraie réponse serait « il y en a ».
3. **La question porte-t-elle sur ce que je veux protéger ?** Un invariant
   sur la propriété ne se pose pas quand on met à jour une date de dernière
   ouverture. La bonne correction a souvent été de NE PAS POSER la question,
   plutôt que d'élargir la vue pour y répondre.

Et un corollaire du même jour, sur un contrôle cette fois : `test-portes-inscription.mjs`
cherchait un appel « dans les 4 000 premiers caractères après la signature ».
Une distance prise pour une portée. L'ajout d'une branche commentée l'a
poussé au-delà, et le contrôle a crié à tort — la version bénigne. La version
grave est l'inverse : un appel fautif placé plus loin, jamais regardé.

> Une vue restreinte répond toujours quelque chose, et ce quelque chose a
> l'air d'un fait. Avant de croire un décompte, demander qui le fait et ce
> qu'on lui laisse voir.

---

## 8. Deux remparts pour un défaut : lequel des deux mesure-t-on ?

*Ajoutée le 05/09/2026, en écrivant `test-lectures.mjs`.*

La vue `livres` borne sa jointure sur `compte_effectif()`, **et** la politique
`lectures_lecture` dit la même chose. C'est délibéré : la vue reste juste si
l'on relâche la politique, la politique reste juste si l'on modifie la vue.

En éprouvant le fichier, la mutation qui retire la condition de la jointure a
**survécu** — les vingt-six vérifications sont restées vertes, parce que la
politique rattrapait. La mutation symétrique, elle, était bien attrapée.

Le réflexe serait de conclure « c'est normal, ils se doublent ». C'est vrai,
et c'est insuffisant : **un rempart que rien ne distingue n'est pas un
rempart, c'est une intention.** Le jour où quelqu'un allège la vue en se
disant « la politique suffit », rien ne le dira ; et la fois d'après, quand
la politique bougera à son tour, il n'y aura plus rien du tout.

**Le remède.** Trouver l'instrument qui isole. Ici c'était l'observateur du
banc d'essai — superutilisateur, donc au-dessus des politiques : ce qui reste
alors est exactement la jointure de la vue. Deux vérifications ajoutées, et
la mutation tombe.

Quand aucun instrument n'isole les deux, la question devient franche :
faut-il vraiment les deux ? Si la réponse est oui, elle s'écrit — sinon le
second rempart est du code que personne ne relit et que rien ne tient.

Corollaire pratique du même jour, sur une expression régulière : le contrôle
cherchait `\blus\b` dans le texte concaténé des vignettes. Or `0lus` n'offre
aucune frontière de mot entre le chiffre et la lettre — la mutation passait,
et c'est la vérification d'à côté qui l'a attrapée. **Une frontière de mot
suppose un séparateur ; du texte concaténé n'en a pas.**

> Éprouver un contrôle, ce n'est pas vérifier qu'il devient rouge. C'est
> vérifier qu'il devient rouge POUR LA RAISON QU'IL ANNONCE.

---

## 9. Une reprise de données ne s'éprouve que sur des données qui existaient

*Ajoutée le 05/09/2026, sur la migration 17. C'est l'entrée la plus chère de
ce registre : sans le contrôle décrit ici, la livraison effaçait le statut de
lecture et la note de 348 ouvrages.*

Le banc d'essai applique toutes les migrations d'un bloc sur une base **vide**.
Une reprise qui ne reprend rien y est donc indiscernable d'une reprise
réussie : il n'y avait rien à reprendre. Le rejeu, de son côté, vérifie
qu'une migration s'applique deux fois — pas qu'elle déplace correctement ce
qui était là.

**Ce qui s'est passé.** La 17 déplace `statut` et `note` de `possessions`
vers `lectures`, puis supprime les colonnes d'origine. J'avais levé les
politiques sur `lectures` — la table où l'on écrit — en oubliant
`possessions` et `membres`, les tables qu'on lit. La migration s'exécutait
comme un visiteur anonyme, la lecture ne rendait rien, **zéro ligne reprise**,
et la suppression des colonnes s'exécutait quand même. Les vingt-quatre
suites étaient vertes.

**Le remède, en deux temps.**

1. **Un contrôle qui monte la base à l'état d'avant.** `ouvrirBanc({ jusqua })`
   arrête les migrations avant celle qu'on veut éprouver ; on sème alors des
   données comme elles existent en production, on applique la suite, et on
   regarde. C'est `test-reprise-lectures.mjs`, et c'est lui — et lui seul —
   qui a vu le défaut.

2. **Un garde-fou DANS la migration.** Un contrôle extérieur peut être retiré,
   ou ne pas tourner ; celui-ci part avec le fichier. Il refuse de supprimer
   les colonnes si la reprise n'a rien repris, et `raise exception` annule la
   transaction — donc la suppression avec elle. Le déploiement échoue
   bruyamment, la base reste intacte.

**Et le garde-fou lui-même s'est trompé d'abord.** Sa première rédaction
comptait « combien y a-t-il à reprendre » avec la même requête, donc à
travers les mêmes politiques : politiques oubliées, il rendait zéro lui
aussi. Zéro attendu, zéro repris, tout allait bien. Il vérifie désormais la
**précondition** — la levée a-t-elle eu lieu, question posée à `pg_class`, que
la RLS ne masque pas — et non le résultat.

C'est mot pour mot ce que `03-catalogue.sql` écrit depuis le 15/08 : *un
contrôle qui partage l'aveuglement de ce qu'il contrôle ne contrôle rien.* Je
l'ai réécrit sans le reconnaître, dans un fichier voisin, le même jour que
trois autres instances de la règle 7.

> Quand une migration détruit après avoir déplacé, l'ordre des deux gestes
> est une promesse. Elle se contrôle sur des données réelles, et depuis
> l'intérieur du fichier.

---

## 10. Une écriture qui n'écrit rien ne lève pas

*Ajoutée le 05/09/2026, en fin de journée. C'est la même racine que la règle
7, mais du côté de l'écriture — et il a fallu six occurrences pour que je
cesse de la traiter comme six accidents.*

`select` sous RLS répond « rien » quand il ne voit rien. `update` et `insert`
font pire : ils rapportent un succès. **Zéro ligne touchée n'est pas une
erreur pour PostgreSQL.**

Les six du jour, dans l'ordre :

| ce qui écrivait | ce qui manquait | ce qu'on aurait vu |
|---|---|---|
| `bibliotheque_a_ouvrir` | `security definer` ne franchit pas `force` | plus aucune connexion |
| `membres_garde_proprietaire` | décompte sous RLS | un membre ne peut pas ouvrir sa bibliothèque |
| `rejoindre_locataire` | `on conflict` a besoin de VOIR | invitation impossible |
| reprise de la 17 | politiques levées sur la destination seulement | **348 lectures effacées** |
| `dimensionner_sieges` (update) | `tenants_reglages` borne sur `app.tenant_id` | quota jamais recalculé |
| `dimensionner_sieges` (count) | décompte sous RLS | toute équipe dimensionnée pour une personne |

Quatre des six ne produisaient **aucune erreur**. Deux d'entre elles
auraient été trouvées par un utilisateur ; deux seraient restées invisibles.

Et un défaut dormant, découvert au passage : `regler_tarification`, écrite le
24/08, n'a jamais fonctionné que parce qu'on l'a toujours lancée en
superutilisateur. Appelée par le compte applicatif, elle rendait zéro ligne
comme un succès. Deux semaines de latence.

**Les trois réflexes, dans cet ordre.**

1. **Toute écriture sous RLS se relit.** `get diagnostics ... = row_count`,
   ou un `returning` qu'on compte. Un `update` dont on ne vérifie pas
   l'effet est une intention, pas une écriture.

2. **Lever les politiques sur TOUT ce que la requête touche, pas seulement
   sur ce qu'elle écrit.** Une insertion qui lit deux tables en a trois à
   lever. C'est la faute la plus chère de la journée.

3. **Éprouver sous le compte APPLICATIF, jamais seulement sous
   l'observateur.** Le banc d'essai a un superutilisateur, et il traverse
   tout en silence : c'est ce qui a laissé `regler_tarification` fausse
   pendant deux semaines. Chaque porte nommée mérite une vérification
   appelée par `dans(...)`, et non par `q(...)`.

> Un `select` qui ne voit rien se remarque. Un `update` qui n'écrit rien se
> félicite.

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

---

## Rectification du 31/08/2026 — les dates de ce registre étaient fausses

Le travail de refonte visuelle — jetons, polices hébergées, page d'accueil,
plafond à 0,900 $ — a été fait le **31 août**. Je l'avais daté du 25 août,
dans sept endroits : `jetons.css`, `test-jetons.mjs`,
`test-plafonds-coherents.mjs`, `11-plafond-depense.sql`, `calculer-csp.mjs`,
`bibliotheque-publique.html` et la chaîne de livraison. La section 5
ci-dessus disait aussi « ajouté le 24/08 au soir » pour un ajout du 25.

Personne ne l'a signalé : une date fausse ne casse rien, elle se contente de
mentir doucement. C'est Xavier qui l'a vue, en lisant `cree_le` d'un compte
créé le 31 à 16 h 35 alors que le registre parlait du 25.

**Ce qui a permis de trancher** : les horodatages, et eux seuls. Le compte
supprimé datait du 24/08 18 h 10, la chaîne de la suppression a tourné le
25/08 à 08 h 19, le nouveau compte est du 31/08 16 h 35. Aucune date n'a été
corrigée « de mémoire » ; celles que ces trois repères ne permettaient pas
d'établir ont été réécrites pour dire ce qu'on peut prouver plutôt qu'une
heure vraisemblable.

> Un registre dont on corrige les dates en silence vaut moins qu'un registre
> qui dit les avoir corrigées. La rectification fait partie de l'entrée.
