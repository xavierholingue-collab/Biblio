/* =========================================================================
   AUTHENTIFICATION PAR LIEN MAGIQUE

   Aucun mot de passe n'est stocké : il n'y a donc rien à voler, rien à
   réinitialiser, et aucune fuite de base ne permet de se connecter.

   ---------------------------------------------------------------------------
   CINQ PROPRIÉTÉS, ET LA FAÇON DE SE FAIRE PRENDRE SANS ELLES

   1. LE JETON N'EST PAS STOCKÉ, SON EMPREINTE L'EST.
      Une copie de la base ne donne pas les jetons en cours de validité.
      Stocker le jeton en clair reviendrait à stocker des mots de passe.

   2. USAGE UNIQUE, GARANTI PAR LA BASE.
      La consommation est un UPDATE … WHERE utilise_le IS NULL … RETURNING :
      deux requêtes simultanées avec le même jeton, une seule gagne. Vérifier
      puis marquer en deux temps laisserait passer les deux.

   3. COURTE DURÉE. Quinze minutes. Un lien traîne dans une boîte aux lettres
      bien plus longtemps qu'il n'est utile.

   4. AUCUNE ÉNUMÉRATION. Demander un lien pour une adresse inconnue répond
      exactement comme pour une adresse connue. Sans cela, le point d'entrée
      devient un annuaire : on y teste des adresses jusqu'à trouver un compte.

   5. LE JETON NE SURVIT PAS À SON USAGE DANS L'URL. Une adresse de page
      finit dans l'historique, les journaux du serveur, et l'en-tête Referer.
      La page de connexion doit donc le retirer de la barre d'adresse
      immédiatement après l'avoir échangé.

   ---------------------------------------------------------------------------
   LE SECRET DE SESSION DOIT ÊTRE PERSISTANT

   Le serveur actuel régénère son secret à chaque démarrage : redémarrer
   déconnecte tout le monde. Acceptable pour un outil personnel, pas pour un
   service — chaque livraison déconnecterait vos utilisateurs. Le secret doit
   venir de l'environnement (SECRET_SESSION) et survivre au redémarrage.
   ========================================================================= */

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

export const DUREE_LIEN_MINUTES = 15;
export const DUREE_SESSION_JOURS = 30;

/** Empreinte du jeton. C'est elle, et elle seule, qui va en base. */
export const empreinte = (jeton) =>
  createHash("sha256").update(String(jeton), "utf8").digest("base64url");

/** Un courriel normalisé : comparaisons fiables, doublons impossibles. */
export const normaliserCourriel = (c) => String(c ?? "").trim().toLowerCase();

export const courrielPlausible = (c) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normaliserCourriel(c));

/* --------------------------------------------------------- Demande de lien */

/**
 * Crée un lien de connexion pour ce courriel, s'il correspond à un compte.
 *
 * Rend TOUJOURS la même forme, que le compte existe ou non :
 * { envoye: true, jeton: <string|null> }. L'appelant n'envoie un courriel
 * que si `jeton` est non nul, et répond au visiteur sans jamais distinguer
 * les deux cas.
 */
export async function demanderLien(client, courrielBrut) {
  const courriel = normaliserCourriel(courrielBrut);
  if (!courrielPlausible(courriel)) {
    const e = new Error("Adresse de courriel invalide.");
    e.statut = 400;
    throw e;
  }

  const { rows } = await client.query(
    "select id from comptes where courriel = $1", [courriel]);

  // Compte inconnu : on s'arrête ici, mais silencieusement.
  if (!rows.length) return { envoye: true, jeton: null };

  const jeton = randomBytes(32).toString("base64url");
  await client.query(
    `insert into liens_connexion (empreinte, compte_id, expire_le)
     values ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [empreinte(jeton), rows[0].id, String(DUREE_LIEN_MINUTES)]);

  return { envoye: true, jeton, compte_id: rows[0].id };
}

/* ------------------------------------------------------ Usage du lien */

/**
 * Consomme un lien. Rend { compte_id, tenant_id, courriel } ou null.
 *
 * L'UPDATE conditionnel est le cœur de l'affaire : la base garantit qu'un
 * jeton ne sert qu'une fois, même si deux requêtes arrivent ensemble.
 */
export async function consommerLien(client, jeton) {
  if (!jeton || typeof jeton !== "string") return null;

  const { rows } = await client.query(
    `update liens_connexion
        set utilise_le = now()
      where empreinte = $1
        and utilise_le is null
        and expire_le > now()
      returning compte_id`,
    [empreinte(jeton)]);

  if (!rows.length) return null;

  const { rows: comptes } = await client.query(
    `select c.id as compte_id, c.tenant_id, c.courriel, t.langue
       from comptes c join tenants t on t.id = c.tenant_id
      where c.id = $1`, [rows[0].compte_id]);

  if (!comptes.length) return null;
  await client.query("update comptes set vu_le = now() where id = $1", [rows[0].compte_id]);
  return comptes[0];
}

/** Ménage : les liens périmés n'ont aucune raison de s'accumuler. */
export const purgerLiens = (client) =>
  client.query("delete from liens_connexion where expire_le < now() - interval '1 day'");

/* ---------------------------------------------------------------- Session */

/**
 * Jeton de session signé. Il porte désormais QUI est connecté — sans cela,
 * l'application ne saurait pas quel locataire poser dans le contexte.
 */
export function signerSession(secret, { compte_id, tenant_id }) {
  const charge = {
    c: compte_id,
    t: tenant_id,
    expire: Date.now() + DUREE_SESSION_JOURS * 24 * 3600 * 1000,
  };
  const donnees = Buffer.from(JSON.stringify(charge)).toString("base64url");
  const signature = createHmac("sha256", secret).update(donnees).digest("base64url");
  return `${donnees}.${signature}`;
}

/** Rend { compte_id, tenant_id } ou null. Ne lève jamais. */
export function verifierSession(secret, jeton) {
  if (!jeton || typeof jeton !== "string" || !jeton.includes(".")) return null;
  const [donnees, signature] = jeton.split(".");
  if (!donnees || !signature) return null;

  const attendue = createHmac("sha256", secret).update(donnees).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(attendue);
  // Comparaison à temps constant : une comparaison ordinaire s'arrête au
  // premier octet différent, ce qui laisse mesurer combien on avait juste.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const charge = JSON.parse(Buffer.from(donnees, "base64url").toString("utf8"));
    if (!charge || charge.expire < Date.now()) return null;
    if (typeof charge.t !== "string" || typeof charge.c !== "string") return null;
    return { compte_id: charge.c, tenant_id: charge.t };
  } catch { return null; }
}
