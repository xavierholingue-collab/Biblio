# biblio

Une bibliothèque de lecture personnelle et professionnelle, en trois conteneurs :
Postgres, une petite API Node sans dépendance de framework, et nginx.

Chaque ouvrage porte un résumé produit par Claude Sonnet 5 et vérifié par
recherche web, avec son degré de certitude. On peut décrire ce que l'on cherche
à comprendre : un parcours de lecture est alors construit dans les rayons.

Le rayon professionnel est consultable sans mot de passe ; le rayon personnel,
l'édition et tout ce qui appelle le modèle demandent une session.

## Démarrer

```bash
cp .env.exemple .env      # puis remplir MOT_DE_PASSE et ANTHROPIC_API_KEY
docker compose up -d --build
```

L'application écoute sur <http://localhost:8080>. Sous Windows, `Demarrer.cmd`
fait la même chose en double-clic.

Pour amorcer la base au premier démarrage, déposer un export JSON de la
bibliothèque dans `seed/bibliotheque.json`. Sans lui, l'application démarre sur
une bibliothèque vide.

## Organisation

```
api/          serveur Node : routes, session, appels au modèle
db/           schéma SQL, exécuté à la création du volume
web/          page d'accueil, application, tests du front
nginx.conf    service des fichiers et relais vers l'API
docker-compose.yml
```

## Tests

```bash
node --env-file=.env api/test-api.mjs      # API, contre la pile en marche
cd web/test && npm install jsdom && node test-fumee.js   # front, hors ligne
```

Les deux doivent se terminer par « Aucune erreur. »

## Documentation

`README-docker.md` détaille la mise en route pas à pas, les choix de sécurité,
les sauvegardes et le dépannage.

## Ce qui n'est pas dans ce dépôt

Le fichier `.env`, le contenu de `seed/`, les sauvegardes et les journaux sont
exclus par `.gitignore` : ils contiennent des secrets ou des données
personnelles. Le dépôt ne contient que du code et de la configuration.
