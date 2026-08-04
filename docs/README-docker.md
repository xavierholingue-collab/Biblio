# Ma bibliothèque — version locale, en conteneurs

L'application, sa base de données et son API tournent sur votre machine.
Aucune donnée ne quitte votre PC, à deux exceptions près, inévitables :
les couvertures sont récupérées chez Open Library et Google Books, et les
résumés et recommandations passent par l'API d'Anthropic.

## Mise en route

### 1. Récupérer vos données depuis l'ancienne version

Ouvrez l'application actuelle (celle qui est reliée à Supabase) et cliquez sur
**Exporter en JSON** en bas de page. Renommez le fichier obtenu en
`bibliotheque.json` et déposez-le dans le dossier `seed/` à côté de ce README.

L'API l'importera automatiquement au premier démarrage, une seule fois. Si le
dossier `seed/` est vide, l'application démarre simplement sur une bibliothèque
vide.

### 2. Renseigner les secrets

Copiez `.env.exemple` en `.env`, puis remplissez trois valeurs :

| Variable | À quoi elle sert |
|---|---|
| `MOT_DE_PASSE` | Ce que vous saisirez pour ouvrir l'application. Prenez une phrase longue. |
| `PGPASSWORD` | Mot de passe interne de la base. Prenez du caractère aléatoire, vous n'aurez jamais à le taper. |
| `ANTHROPIC_API_KEY` | Votre clé `sk-ant-…`. Sans elle, tout fonctionne sauf les résumés et les recommandations. |

Ce fichier `.env` contient vos secrets. Il ne doit pas être partagé, et le
`.gitignore` du dossier l'exclut déjà d'un éventuel dépôt Git.

### 3. Démarrer

**Double-cliquez sur `Demarrer.cmd`.** La première fois, Docker télécharge les
images et construit l'API : comptez deux à trois minutes. Ensuite, le démarrage
prend quelques secondes. Le navigateur s'ouvre sur <http://localhost:8080>.

Les conteneurs continuent de tourner quand vous fermez la fenêtre, et
redémarrent automatiquement avec Docker Desktop. Pour tout arrêter :
**`Arreter.cmd`**.

## Ce qui est public, ce qui ne l'est pas

La séparation est faite **côté serveur**, pas dans l'interface : masquer un bouton
ne protège rien, c'est l'API qui décide.

| | Sans mot de passe | Avec mot de passe |
|---|---|---|
| Page d'accueil et statistiques | oui, sur le périmètre Pro | élargies à toute la bibliothèque |
| Consulter les ouvrages Pro et leurs résumés | oui | oui |
| Consulter les ouvrages Perso | **non** | oui |
| Générer un résumé, demander un parcours | **non** | oui |
| Ajouter, modifier, supprimer, importer | **non** | oui |

Les trois traitements qui appellent le modèle sont fermés par défaut : un visiteur
anonyme ne doit pas pouvoir dépenser vos crédits Anthropic. Pour les ouvrir malgré
tout, `IA_PUBLIQUE=true` dans `.env` — à ne faire qu'avec un plafond de dépenses
sur le compte Anthropic.

Un jeton de session falsifié ne donne aucun droit supplémentaire : il est traité
exactement comme une absence de session. C'est vérifié par les tests.

## Architecture

```
                         http://localhost:8080
                                   │
                          ┌────────▼────────┐
                          │  web  (nginx)   │   sert le HTML, relaie /api
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │  api  (node)    │──► api.anthropic.com
                          │  clé Anthropic  │    (résumés, recommandations)
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │  db (postgres)  │   volume pgdata
                          └─────────────────┘
```

Trois conteneurs, environ 200 Mo de mémoire au total.

## Choix de sécurité

- **Rien n'est exposé au réseau.** Le port est publié sur `127.0.0.1`
  uniquement : même les autres machines de votre réseau local ne peuvent pas
  s'y connecter. La base de données, elle, n'est joignable que depuis l'API.
- **La clé Anthropic ne quitte jamais le conteneur `api`.** Le navigateur ne la
  voit pas et ne peut pas la voir.
- **La session est un cookie `HttpOnly` et `SameSite=Strict`**, signé par un
  secret régénéré à chaque démarrage. Un script de page ne peut pas le lire ;
  redémarrer les conteneurs déconnecte.
- **Le mot de passe est comparé en temps constant**, et les tentatives sont
  limitées à dix par quart d'heure et par adresse.
- **Le processus de l'API ne tourne pas en root** dans son conteneur.
- **Une politique de contenu stricte** limite le navigateur à ce dont il a
  besoin : pas de script distant, images uniquement depuis Open Library et
  Google Books.

Ce qui reste à votre charge : les sauvegardes, et le fait que le chiffrement
HTTPS est absent — inutile ici puisque rien ne sort de la machine.

## Sauvegardes

**`Sauvegarder.cmd`** produit un fichier `sauvegardes\biblio_AAAA-MM-JJ_HHMM.sql`
et ne conserve que les trente plus récents.

Pour l'automatiser, ouvrez le Planificateur de tâches Windows :
Créer une tâche de base → déclencheur quotidien → démarrer un programme →
sélectionnez `Sauvegarder.cmd`.

Pour restaurer une sauvegarde :

```
docker compose down -v
docker compose up -d db
timeout /t 10
docker compose exec -T db psql -U biblio -d biblio < sauvegardes\le_fichier.sql
docker compose up -d
```

Attention : `down -v` efface le volume et donc la base actuelle.

## Utilisation courante

| Besoin | Commande |
|---|---|
| Démarrer | `Demarrer.cmd` |
| Arrêter | `Arreter.cmd` |
| Sauvegarder | `Sauvegarder.cmd` |
| Voir ce qui tourne | `docker compose ps` |
| Lire les journaux de l'API | `docker compose logs -f api` |
| Repartir d'une base vide | `docker compose down -v` puis `Demarrer.cmd` |

Après modification de `ma-bibliotheque.html`, un simple rafraîchissement du
navigateur suffit : le fichier est monté en direct, rien à reconstruire.
Après modification de `api/server.js`, il faut relancer :
`docker compose up -d --build api`.

## Tests

Deux jeux de tests, à lancer après toute modification.

**L'API**, contre la pile en fonctionnement, sans aucune dépendance à installer :

```
node --env-file=.env api/test-api.mjs
```

Une cinquantaine de vérifications : ce qui est ouvert au public, ce qui reste
fermé, l'étanchéité du périmètre personnel, le cookie, le jeton falsifié, la
création, la mise à jour, la mise à jour partielle des couvertures, la
suppression, la validation des entrées, la déconnexion. Le test crée deux
ouvrages jetables et les supprime : il ne laisse aucune trace dans votre
bibliothèque. Les appels au modèle ne sont pas déclenchés, ils coûteraient de
l'argent ; on vérifie seulement qu'ils sont protégés.

**Le front**, dans un navigateur simulé :

```
cd web\test
npm install jsdom
node test-fumee.js
```

Quarante-quatre vérifications, sans aucun accès réseau : mode visiteur, bascule
après connexion, masquage des actions réservées, absence d'appel payant
déclenché par un visiteur. Les deux doivent se terminer par « Aucune erreur. »

## Dépannage

**« Docker ne répond pas »** — Docker Desktop n'est pas lancé, ou termine encore
son démarrage. Attendez que sa baleine cesse de s'animer.

**Le port 8080 est déjà pris** — changez `PORT_WEB` dans `.env`, puis
`Demarrer.cmd`.

**« Serveur injoignable » dans l'application** — `docker compose logs api`
donnera la cause. Le plus souvent : `.env` incomplet.

**Les résumés renvoient une erreur** — clé Anthropic absente, invalide, ou
compte sans crédit. Le reste de l'application continue de fonctionner.

**La base est vide après le premier démarrage** — le fichier `seed/bibliotheque.json`
était absent ou mal formé au moment de la création du volume. L'amorçage n'a
lieu que sur une base vide : `docker compose down -v` puis `Demarrer.cmd`.

## Ce que vous perdez par rapport à la version en ligne

- L'accès depuis votre téléphone ou hors de chez vous.
- Les sauvegardes automatiques gérées par l'hébergeur.
- La disponibilité permanente : votre PC doit être allumé.

## Ce que vous gagnez

- Vos données restent chez vous.
- Aucune dépendance à un compte tiers, ni au fait que les projets Supabase
  gratuits se mettent en pause après une semaine d'inactivité.
- Pas de limite de stockage, et un accès direct à Postgres si vous voulez
  interroger votre bibliothèque en SQL.
