/* ===========================================================================
   RATTACHER UN COMPTE GOOGLE — SUR « sub », JAMAIS SUR LE COURRIEL

   ---------------------------------------------------------------------------
   POURQUOI UNE COLONNE ET PAS UNE TABLE

   Une table « identités » avec un fournisseur, un identifiant et un compte
   serait la forme générale — celle qu'on écrit quand on prévoit Apple,
   Microsoft, GitHub. Nous en avons UN, et nous n'en aurons peut-être jamais
   deux.

   La forme générale coûte une jointure sur le chemin de connexion, une
   politique de cloisonnement de plus, et un contrôle de plus. Le jour où un
   second fournisseur arrive, la migration qui déplacera cette colonne vers
   une table prendra dix lignes — et elle sera écrite en sachant ce dont on a
   réellement besoin, au lieu de le deviner aujourd'hui.

   ---------------------------------------------------------------------------
   « sub » EST L'IDENTIFIANT, LE COURRIEL EST UN ATTRIBUT

   Une adresse Google change : mariage, changement de domaine, alias qui
   devient principal. « sub » ne change pas — c'est l'identifiant stable de la
   personne POUR CE SERVICE.

   Clé sur le courriel, et deux choses arrivent. Celui qui change d'adresse
   perd son compte. Et celui qui RÉCUPÈRE une adresse abandonnée hérite du
   compte de son prédécesseur — ce qui est arrivé assez souvent, chez d'assez
   gros fournisseurs, pour qu'on n'ait pas à l'expérimenter soi-même.

   L'index est UNIQUE : deux comptes portant le même « sub » seraient deux
   bibliothèques pour une seule personne, et la connexion choisirait au hasard.

   ---------------------------------------------------------------------------
   LE RATTACHEMENT À UN COMPTE EXISTANT EST UNE DÉCISION, PAS UN AUTOMATISME

   Quelqu'un s'inscrit par lien magique, revient par Google avec la même
   adresse. On rattache — décidé avec Xavier le 22/08/2026 — MAIS seulement
   si Google déclare l'adresse vérifiée.

   Sans cette condition, la prise de contrôle est triviale : on crée un Google
   Workspace sur un domaine qu'on contrôle, on y déclare l'adresse de
   quelqu'un d'autre, et on se connecte à sa place.

   Le prix du rattachement est accepté en connaissance de cause : les deux
   chemins mènent désormais à la même bibliothèque, donc un compromis de l'un
   vaut compromis de l'autre. C'est le prix de la commodité, et il se paie
   dans les deux sens.

   DDL SEULEMENT — aucune écriture, donc aucune levée de politiques.
   =========================================================================== */

alter table public.comptes
  add column if not exists oidc_sub text;

/* Partiel : les comptes venus du lien magique n'ont pas de « sub », et un
   index unique ordinaire les compterait tous comme un seul NULL en double sur
   certains moteurs. Ici PostgreSQL les tolère, mais l'index partiel dit
   l'intention — cette colonne est unique QUAND elle est renseignée — et il
   est plus petit. */
create unique index if not exists comptes_oidc_sub_unique
  on public.comptes (oidc_sub) where oidc_sub is not null;

/* Un compte peut donc venir de trois états : lien magique seul (« oidc_sub »
   nul), Google seul, ou les deux rattachés. Aucun n'est privilégié, et aucun
   n'est un état transitoire à nettoyer — c'est pourquoi il n'y a ni drapeau
   ni date de rattachement. Ce qu'on ne peut pas déduire de la colonne n'a pas
   besoin d'être su. */
