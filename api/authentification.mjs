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
 * Crée un lien pour ce courriel — de connexion, ou d'inscription.
 *
 * Rend TOUJOURS la même forme : { envoye: true, jeton, inscription }.
 * L'appelant n'envoie un courriel que si `jeton` est non nul, et répond au
 * visiteur sans jamais distinguer les cas.
 *
 * ---------------------------------------------------------------------------
 * CE QUI SE RÉVÈLE, ET À QUI — la distinction qui compte
 *
 * La RÉPONSE HTTP est identique dans les trois cas : compte connu, compte
 * inconnu avec inscription ouverte, compte inconnu avec inscription fermée.
 * Quelqu'un qui ne contrôle pas l'adresse n'apprend donc rien.
 *
 * Le COURRIEL, lui, dit clairement s'il s'agit d'une connexion ou d'une
 * première venue — les deux messages ne se ressemblent pas. Ce n'est pas une
 * fuite : celui qui le lit contrôle la boîte, et il a le droit de savoir si
 * un compte existe à son nom. Lui envoyer « voici votre lien de connexion »
 * alors qu'il n'a jamais rien créé serait mentir pour rien.
 *
 * ---------------------------------------------------------------------------
 * RIEN N'EST CRÉÉ ICI. Le lien d'inscription porte l'adresse, pas un compte.
 * Mille demandes vers mille adresses laissent mille lignes dans
 * « liens_connexion », que « purgerLiens » efface — et zéro locataire.
 */
export async function demanderLien(client, courrielBrut, { inscriptionOuverte = false } = {}) {
  const courriel = normaliserCourriel(courrielBrut);
  if (!courrielPlausible(courriel)) {
    const e = new Error("Adresse de courriel invalide.");
    e.statut = 400;
    throw e;
  }

  const { rows } = await client.query(
    "select id from comptes where courriel = $1", [courriel]);
  const connu = rows.length > 0;

  // Inconnu et porte fermée : on s'arrête ici, mais silencieusement.
  if (!connu && !inscriptionOuverte) return { envoye: true, jeton: null };

  const jeton = randomBytes(32).toString("base64url");
  /* UNE COLONNE OU L'AUTRE, jamais les deux — la contrainte
     « liens_une_seule_cible » le vérifie en base plutôt que de compter sur
     cet appel-ci pour bien se tenir. */
  await client.query(
    `insert into liens_connexion (empreinte, compte_id, courriel, expire_le)
     values ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [empreinte(jeton), connu ? rows[0].id : null, connu ? null : courriel,
     String(DUREE_LIEN_MINUTES)]);

  return { envoye: true, jeton, inscription: !connu,
           compte_id: connu ? rows[0].id : null };
}

/* ------------------------------------------------------ Usage du lien */

/**
 * Consomme un lien. Rend { compte_id, tenant_id, courriel, nouveau } ou null.
 *
 * L'UPDATE conditionnel est le cœur de l'affaire : la base garantit qu'un
 * jeton ne sert qu'une fois, même si deux requêtes arrivent ensemble.
 *
 * ---------------------------------------------------------------------------
 * C'EST ICI QUE NAÎT LE LOCATAIRE, et nulle part ailleurs.
 *
 * Un lien qui porte un courriel plutôt qu'un compte est une inscription : la
 * personne vient de prouver qu'elle relève cette boîte. La création se fait
 * donc APRÈS l'UPDATE qui consomme le jeton, jamais avant — sinon deux clics
 * simultanés sur le même lien créeraient deux locataires, et le second
 * n'aurait plus d'adresse pour y entrer.
 *
 * L'APPELANT DOIT ENVELOPPER CET APPEL DANS UNE TRANSACTION. Sans elle, un
 * échec entre la consommation du jeton et la création du compte laisserait un
 * lien brûlé sans rien en face : la personne recommencerait et recevrait un
 * nouveau lien, ce qui n'est pas grave — mais le locataire créé à moitié, lui,
 * resterait. « avecVisiteur » fournit cette transaction.
 */
export async function consommerLien(client, jeton) {
  if (!jeton || typeof jeton !== "string") return null;

  const { rows } = await client.query(
    `update liens_connexion
        set utilise_le = now()
      where empreinte = $1
        and utilise_le is null
        and expire_le > now()
      returning compte_id, courriel`,
    [empreinte(jeton)]);

  if (!rows.length) return null;

  let compteId = rows[0].compte_id;
  let nouveau = false;

  if (!compteId) {
    /* Course possible et bénigne : deux personnes demandent un lien pour la
       même adresse, toutes deux l'ouvrent. La première crée, la seconde tombe
       sur l'index unique de « comptes.courriel ». On rattrape en lisant le
       compte qui vient d'être créé — le résultat est le même, et il n'y a
       qu'une bibliothèque. */
    try {
      const { rows: cree } = await client.query(
        "select compte, locataire from public.creer_locataire($1)", [rows[0].courriel]);
      compteId = cree[0].compte;
      nouveau = true;
    } catch (e) {
      if (e.code !== "23505") throw e;
      const { rows: deja } = await client.query(
        "select id from comptes where courriel = $1", [rows[0].courriel]);
      if (!deja.length) throw e;
      compteId = deja[0].id;
    }
  }

  const { rows: comptes } = await client.query(
    `select c.id as compte_id, c.tenant_id, c.courriel, t.langue
       from comptes c join tenants t on t.id = c.tenant_id
      where c.id = $1`, [compteId]);

  if (!comptes.length) return null;
  await client.query("update comptes set vu_le = now() where id = $1", [compteId]);
  return { ...comptes[0], nouveau };
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
