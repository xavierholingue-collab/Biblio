# Livraison de la version collaborative — 05/09/2026

Quatre migrations, `15` à `19`. C'est la plus lourde livraison du projet :
elle **supprime trois colonnes qui portent des données** — `comptes.tenant_id`,
`possessions.statut`, `possessions.note` — après les avoir déplacées.

Ce fichier existe pour une seule raison : la reprise est contrôlée sur des
données fabriquées (`test-reprise-lectures.mjs`), jamais sur les 348 ouvrages
réels. Le relevé ci-dessous est la seule vérification qui porte sur eux.

---

## Ce que la livraison change, en une phrase chacun

| Migration | Ce qu'elle fait |
|---|---|
| `15-membres.sql` | Une bibliothèque peut avoir plusieurs membres. `comptes.tenant_id` disparaît. |
| `16-invitation.sql` | Inviter par lien magique ; rejoindre ; quitter. |
| `17-lectures.sql` | Le statut de lecture et la note appartiennent à la **personne**, plus à l'étagère. Les colonnes d'origine disparaissent. |
| `18-emporter.sql` | Emporter une copie de l'étagère vers une autre de ses bibliothèques. |
| `19-sieges.sql` | Le quota suit le nombre de membres — **sauf** ce qui a été réglé à la main. |

---

## 1. AVANT de pousser — le relevé

Sur le VPS, **avant** que la chaîne ne parte. Ces chiffres n'existeront plus
après : les colonnes qui les portent seront supprimées.

```bash
sudo -u postgres psql -d biblio -c "
  select count(*)                                   as ouvrages,
         count(*) filter (where statut = 'Lu')      as lus,
         count(*) filter (where statut = 'En cours') as en_cours,
         count(*) filter (where statut = 'A lire')   as a_lire,
         count(note)                                as notes,
         round(avg(note), 3)                        as note_moyenne
    from possessions;"
```

**Notez la ligne quelque part.** C'est le seul témoin.

### Le relevé du 05/09/2026, pris avant la livraison

| ouvrages | lus | en_cours | a_lire | notes | note_moyenne |
|---:|---:|---:|---:|---:|---:|
| 348 | 310 | 0 | 38 | 70 | 4.300 |

Cohérent : 310 + 0 + 38 = 348.

La bibliothèque n'ayant qu'un membre, `lectures` doit contenir **exactement
348 lignes** après la migration, avec la même répartition et la même moyenne.
Tout écart signifie que la reprise n'a pas repris.

*(Le message « could not change directory to /root » est du bruit : le compte
`postgres` ne peut pas se placer dans `/root`. La requête, elle, s'est bien
exécutée.)*

Et, pour savoir combien de membres chaque bibliothèque aura :

```bash
sudo -u postgres psql -d biblio -c "
  select t.identifiant, t.quota_ia_mois, t.plafond_usd,
         count(c.id) as comptes
    from tenants t left join comptes c on c.tenant_id = t.id
   group by t.id order by t.identifiant;"
```

---

## 2. La livraison

```bash
cd ~ && bash /mnt/c/Users/xavie/OneDrive/Doc/Claude/Projects/Bibliographie/deploiement/assembler-depot.sh
cd ~/dev/biblio && git add -A && git status
```

Relire le `git status` **avant** de valider : quatre fichiers `db/`, quatre
`tests/`, et les modifications de `api/`, `web/`, `deploiement/`, `.github/`.

```bash
git commit -m "Version collaborative : membres, lectures par personne, emporter, sièges"
git push
```

La chaîne prend un `pg_dump` complet avant toute migration et **refuse de
migrer si la sauvegarde échoue ou est incomplète**. Ce filet-là existe déjà.

---

## 3. APRÈS — la vérification qui compte

```bash
sudo -u postgres psql -d biblio -c "
  select count(*)                                   as lectures,
         count(*) filter (where statut = 'Lu')      as lus,
         count(*) filter (where statut = 'En cours') as en_cours,
         count(*) filter (where statut = 'A lire')   as a_lire,
         count(note)                                as notes,
         round(avg(note), 3)                        as note_moyenne
    from lectures;"
```

**Chaque bibliothèque n'ayant qu'un membre, ces six nombres doivent être
IDENTIQUES à ceux du relevé initial.** Un écart, quel qu'il soit, veut dire
que la reprise n'a pas repris — et il faut restaurer depuis
`/var/backups/biblio-avant-migration-*.sql.gz` avant toute autre chose.

La migration porte son propre garde-fou : elle refuse de supprimer les
colonnes si la reprise n'a rien repris. Mais un garde-fou qui n'a jamais
servi n'est qu'une intention ; ces six nombres sont la preuve.

### Et le quota

```bash
sudo -u postgres psql -d biblio -c "
  select identifiant, quota_ia_mois, plafond_usd, tarification
    from tenants order by identifiant;"
```

La bibliothèque à **100 000 appels / 20 $** doit être en `tarification =
'manuelle'`. Si elle est en `'sieges'`, elle vaut désormais 10 appels — c'est
le blocage du 25/08, et il faut la remettre :

```bash
sudo -u postgres psql -d biblio -c "
  select * from public.regler_tarification(
    (select id from tenants where identifiant = 'xavier'), 100000, 20.000);"
```

---

## 4. Le parcours à faire à la main

Aucun contrôle automatique ne remplace ceci — c'est ce qui a trouvé les deux
défauts les plus graves du mois d'août.

1. **Se connecter par Google.** La bibliothèque doit s'ouvrir, avec ses
   348 ouvrages et leurs statuts.
2. **Ouvrir un ouvrage marqué « Lu ».** Il doit l'être encore.
3. **Aller dans Réglages.** La section « Qui partage cette bibliothèque »
   apparaît, avec une seule adresse et le bouton d'invitation.
4. **S'inviter soi-même sur une seconde adresse**, ouvrir le lien reçu.
   Vérifier que **AUCUNE** nouvelle bibliothèque n'a été créée, et que la
   seconde adresse voit le fonds.
5. **Vérifier le quota** : il doit être passé à deux sièges — *sauf* si la
   bibliothèque est en `manuelle`, auquel cas il ne bouge pas.
6. **Marquer un ouvrage « Lu » avec le second compte**, et vérifier qu'il
   reste « à lire » pour le premier.
7. **Emporter une copie**, puis quitter avec le second compte.
8. **Ouvrir la page publique en navigation privée** : plus aucun chiffre de
   lecture n'y figure. C'est voulu.

---

## 5. Ce que la livraison a réellement donné — 18/09/2026

**Les six nombres sont identiques au relevé** : 348 · 310 · 0 · 38 · 70 ·
4,300. La reprise a repris. `xavier` est bien en `manuelle` (100 000 / 20 $,
2 membres), `9ddc7911d5` en `sieges` (10 / 0,900, 1 membre).

### La régression, et ce qui l'a laissée passer

Entre le déploiement et ce constat, la production a été **cassée pendant
quelques heures** : sur une bibliothèque à plusieurs membres, la porte par
mot de passe ne pouvait plus ajouter **aucun** ouvrage. `enregistrer_lecture`
levait, et une exception annule la transaction entière — l'étagère tombait
avec la lecture.

Le contrôle qui aurait dû l'attraper était vert. Il éprouvait une charge
**sans `statut`**, que l'application n'envoie jamais : la page met toujours ce
champ dans son objet livre. Il vérifiait la bonne règle sur la mauvaise
charge.

Corrigé le même jour : l'écriture de l'étagère et celle de la lecture sont
séparées, la réponse porte `lecture_ignoree`, et `/api/session` publie
`lecteur` pour que l'écran sache masquer les champs plutôt que de les
proposer en vain. Les contrôles éprouvent désormais la charge de la page.

### Le parcours manuel, fait le 18/09

| | |
|---|---|
| Session Google, bibliothèque à **un** membre : statut et note tiennent | ✅ |
| Session Google, bibliothèque à **deux** membres : la lecture est bien la sienne | ✅ |
| Porte par mot de passe, deux membres : champs masqués, ajout qui **aboutit** | ✅ |
| Import **JSON** par cette porte : les livres entrent, les statuts sont annoncés perdus | **non fait** |

Le premier de ces quatre est le seul chemin que la chaîne n'éprouve jamais :
`test-api.mjs` ne franchit que la porte par mot de passe, faute de session
Google en intégration. Il restera à faire à la main à chaque livraison qui
touche aux lectures.

---

## Ce qui reste ouvert

- Le dos des livres se lit de bas en haut (convention anglo-saxonne) ; en
  français il se lit de haut en bas. `transform: rotate(180deg)` à retirer.
- La pastille PLUS passe à la ligne sur « Parcours par intention ».
- Le rendu mobile n'a jamais été vérifié.
- `Cache-Control "no-cache"` de Caddy s'applique aussi aux polices.
- `ma-bibliotheque.html` et `reglages.html` n'utilisent pas encore les jetons.
- Le raccourci « Académique » → « Savoirs » n'a pas de date de péremption.
- **L'avis d'un professionnel du droit avant le premier euro encaissé.**
