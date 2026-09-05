/* =========================================================================
   CONTEXTE DE LOCATAIRE

   Toute requête à la base passe par ici. C'est le seul endroit qui pose
   app.tenant_id, dont dépend l'ensemble du cloisonnement.

   ---------------------------------------------------------------------------
   DEUX PIÈGES, ET LA FAÇON DE LES RENDRE IMPOSSIBLES

   1. LE POOL DE CONNEXIONS

   set_config('app.tenant_id', x, false) pose la valeur pour toute la SESSION
   PostgreSQL. Une connexion rendue au pool la conserve : la requête suivante,
   servie par cette même connexion, hériterait du locataire précédent.

   Un utilisateur verrait alors la bibliothèque d'un autre — pas toujours,
   seulement quand le pool recycle la bonne connexion. C'est-à-dire jamais en
   développement, et sous charge en production.

   On ne compte donc pas sur un « nettoyage après usage » qu'il faudrait
   penser à écrire : TOUT passe par une transaction, et set_config est posé
   avec « true », c'est-à-dire LOCAL à la transaction. PostgreSQL le défait
   lui-même au COMMIT comme au ROLLBACK. Oublier de nettoyer devient
   impossible, parce qu'il n'y a rien à nettoyer.

   2. L'INJECTION PAR LA COMMANDE SET

   « SET app.tenant_id = ... » n'accepte pas de paramètre : on serait tenté
   d'y interpoler l'identifiant. Ce serait ouvrir une injection SQL au cœur
   même du mécanisme censé isoler les locataires. set_config() est une
   fonction : elle prend un paramètre lié, comme toute requête.

   ---------------------------------------------------------------------------
   UN CONTEXTE PAR REQUÊTE

   Soit un locataire agit chez lui, soit un visiteur consulte le public.
   Jamais les deux : les politiques de la base sont écrites ainsi. Servir la
   page publique de quelqu'un se fait donc SANS locataire — avecVisiteur() —
   et c'est un geste explicite, lisible dans le code.
   ========================================================================= */

/** Motif d'un identifiant de locataire. Un UUID, rien d'autre. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------------------
   UNE SECONDE IDENTITÉ : « app.compte_id » — 05/09/2026

   Jusqu'ici le contexte ne portait que le locataire, parce qu'un locataire
   valait une personne. La version collaborative l'a défait : une bibliothèque
   peut avoir plusieurs membres, et supprimer cette bibliothèque demande de
   savoir QUI le demande, pas seulement OÙ.

   Elle suit exactement les mêmes règles que le locataire : posée avec
   « true », donc LOCALE à la transaction, et par un paramètre lié, jamais par
   interpolation. Les deux pièges décrits plus haut valent pour elle.

   ELLE EST FACULTATIVE, ET C'EST VOULU. Absente, elle vaut la chaîne vide,
   donc NULL côté SQL, donc toute comparaison est fausse : « supprimer_locataire »
   refuse, « mes_bibliotheques » ne rend rien. Un appelant qui oublie de la
   poser obtient la fermeture, pas l'ouverture.

   DEUX FORMES ACCEPTÉES. « avecContexte(bd, uuid, travail) » continue de
   marcher — test-contexte.mjs l'appelle ainsi treize fois, sur la fonction la
   plus critique du dépôt, et casser ces contrôles pour ajouter un paramètre
   serait un mauvais échange. La forme longue,
   « avecContexte(bd, { locataire, compte }, travail) », sert quand l'identité
   compte.
   --------------------------------------------------------------------------- */

/**
 * Exécute `travail` dans une transaction, sous l'identité du locataire.
 *
 * @param {import('pg').Pool} bd
 * @param {string|null|{locataire: string|null, compte?: string|null}} qui
 *        UUID du locataire, null pour le contexte visiteur, ou un objet
 *        portant en plus le compte à l'origine de la requête.
 * @param {(client) => Promise<any>} travail
 */
export async function avecContexte(bd, qui, travail) {
  const objet    = qui !== null && typeof qui === "object";
  const tenantId = objet ? (qui.locataire ?? null) : qui;
  const compteId = objet ? (qui.compte ?? null)    : null;

  if (tenantId !== null && !UUID.test(String(tenantId))) {
    // Fermé par défaut : un identifiant douteux n'ouvre pas un contexte
    // visiteur par accident, il arrête la requête.
    const e = new Error("Identifiant de locataire invalide.");
    e.statut = 400;
    throw e;
  }
  /* Le compte est vérifié avec la MÊME sévérité que le locataire. Une valeur
     douteuse ne devient pas silencieusement « aucun compte » : elle arrête la
     requête. Sans quoi une faute de frappe dégraderait un propriétaire en
     anonyme, et le refus qui suivrait serait incompréhensible. */
  if (compteId !== null && !UUID.test(String(compteId))) {
    const e = new Error("Identifiant de compte invalide.");
    e.statut = 400;
    throw e;
  }

  const client = await bd.connect();
  try {
    await client.query("begin");
    // « true » : LOCAL à la transaction. C'est toute la sûreté du dispositif.
    await client.query("select set_config('app.tenant_id', $1, true)",
                       [tenantId ?? ""]);
    await client.query("select set_config('app.compte_id', $1, true)",
                       [compteId ?? ""]);
    const resultat = await travail(client);
    await client.query("commit");
    return resultat;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connexion déjà perdue */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Le contexte d'un visiteur : aucun locataire, donc seulement le public. */
export const avecVisiteur = (bd, travail) => avecContexte(bd, null, travail);

/**
 * Lit le locataire courant tel que la BASE le voit.
 * Sert aux contrôles : on ne demande pas à l'application ce qu'elle croit
 * avoir posé, on demande à PostgreSQL ce qu'il applique réellement.
 */
export async function locataireCourant(client) {
  const { rows } = await client.query(
    "select nullif(current_setting('app.tenant_id', true), '') as tenant");
  return rows[0].tenant;
}

/**
 * Le compte courant tel que la BASE le voit — même raison d'être que
 * « locataireCourant », et fonction distincte plutôt qu'une colonne de plus.
 *
 * Changer la forme du résultat de « locataireCourant » aurait cassé
 * test-contexte.mjs, qui compare sa valeur de retour à une chaîne. Deux
 * fonctions qui disent chacune une chose valent mieux qu'une qui en dit deux
 * et oblige tous ses appelants à s'adapter.
 */
export async function compteCourant(client) {
  const { rows } = await client.query(
    "select nullif(current_setting('app.compte_id', true), '') as compte");
  return rows[0].compte;
}
