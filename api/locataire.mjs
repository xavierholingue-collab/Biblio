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

/**
 * Exécute `travail` dans une transaction, sous l'identité du locataire.
 *
 * @param {import('pg').Pool} bd
 * @param {string|null} tenantId  UUID, ou null pour le contexte visiteur
 * @param {(client) => Promise<any>} travail
 */
export async function avecContexte(bd, tenantId, travail) {
  if (tenantId !== null && !UUID.test(String(tenantId))) {
    // Fermé par défaut : un identifiant douteux n'ouvre pas un contexte
    // visiteur par accident, il arrête la requête.
    const e = new Error("Identifiant de locataire invalide.");
    e.statut = 400;
    throw e;
  }

  const client = await bd.connect();
  try {
    await client.query("begin");
    // « true » : LOCAL à la transaction. C'est toute la sûreté du dispositif.
    await client.query("select set_config('app.tenant_id', $1, true)",
                       [tenantId ?? ""]);
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
