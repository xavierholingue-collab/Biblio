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

/* SEPT JOURS, ET NON QUINZE MINUTES. Un lien de connexion est demandé par
   celui qui le reçoit : il est devant sa boîte, il attend. Une invitation
   arrive sans avoir été demandée, souvent un vendredi soir, et se lit le
   lundi. Quinze minutes en feraient un lien mort dans la quasi-totalité des
   cas — et la personne invitée ne saurait pas si c'est elle qui a tardé ou
   le service qui est en panne.

   Ce que cela coûte : une adresse de courriel compromise pendant sept jours
   donne accès à la bibliothèque où l'on invitait. C'est le même risque que
   pour tout lien magique, étalé sur plus longtemps — et il est borné à UNE
   bibliothèque, avec le rôle « membre », qui ne peut ni supprimer ni
   inviter. */
export const DUREE_INVITATION_JOURS = 7;

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

  /* LE PLAFOND JOURNALIER SE CONSULTE ICI, AVANT D'ENVOYER — 25/08/2026.
     Le déclencheur de 14-plafond-inscriptions.sql refuse à la CRÉATION,
     c'est-à-dire quand le lien est ouvert. Sans cette consultation, on
     expédierait un courriel dont le lien échouerait au clic : recevoir un
     lien qui ne marche pas est pire que ne rien recevoir.

     Ce n'est PAS une seconde version de la règle : le plafond n'est écrit
     qu'en base, et c'est la base qu'on interroge. Ici on lit, là-bas on
     refuse. Le refus reste la seule barrière — celle-ci n'est qu'une
     politesse, et le contrôle vérifie que la barrière tient sans elle.

     Le silence est le même que ci-dessus : dire « plus de place aujourd'hui »
     à une adresse inconnue apprendrait qu'elle est inconnue. */
  if (!connu) {
    const [{ possible }] = (await client.query(
      "select public.inscriptions_possibles() as possible")).rows;
    if (!possible) return { envoye: true, jeton: null };
  }

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

/* ===========================================================================
   INVITER QUELQU'UN DANS LA BIBLIOTHÈQUE OUVERTE

   ELLE NE DIT PAS SI L'ADRESSE EST CONNUE, et c'est la propriété qui compte
   le plus ici. Le propriétaire d'une bibliothèque n'a aucune raison
   d'apprendre, par un formulaire d'invitation, qui est déjà client du
   service. Le lien porte donc l'adresse dans tous les cas, et la
   consommation tranchera — c'est aussi ce qui rend cette fonction courte :
   elle n'a rien à décider.

   LE CONTRÔLE DE PROPRIÉTÉ EST EN BASE, dans « inviter_membre », et non ici.
   Le refaire en JavaScript créerait une seconde version de la même règle,
   et c'est ainsi qu'une condition finit par manquer d'un côté.
   =========================================================================== */
export async function inviterMembre(client, courrielBrut) {
  const courriel = normaliserCourriel(courrielBrut);
  if (!courrielPlausible(courriel)) {
    const e = new Error("Adresse de courriel invalide.");
    e.statut = 400;
    throw e;
  }

  const jeton = randomBytes(32).toString("base64url");
  await client.query(
    "select public.inviter_membre($1, $2, ($3 || ' days')::interval)",
    [courriel, empreinte(jeton), String(DUREE_INVITATION_JOURS)]);

  return { jeton, courriel };
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
/* ===========================================================================
   LA SEULE PORTE PAR OÙ NAÎT UNE BIBLIOTHÈQUE

   Ce fichier affirmait déjà, en tête de « oidc.mjs », qu'« un seul endroit
   sait créer un locataire ». C'ÉTAIT FAUX : il y en avait deux, et une seule
   consultait « INSCRIPTION_OUVERTE ».

   Constaté en production le 24/08/2026 : le drapeau valait 0 — donc le lien
   magique refusait les inconnus — et une connexion Google a pourtant créé une
   bibliothèque neuve. Le drapeau s'appelait « inscription ouverte » et ne
   fermait que l'inscription PAR COURRIEL.

   D'où cette fonction, et l'invariant qu'un contrôle vérifie désormais :
   « public.creer_locataire » n'est appelé QU'ICI, dans tout docker/api. Une
   porte future qui oublierait le drapeau devra passer par cette fonction, qui
   le lui demandera.

   LE DÉFAUT REFUSE. « inscriptionOuverte » vaut « false » quand l'appelant ne
   dit rien : celui qui oublie de se prononcer obtient la fermeture, pas
   l'ouverture. C'est l'inverse qui avait produit le défaut.

   ELLE LÈVE, elle ne rend pas un témoin. Un appelant qui oublie de lire un
   témoin rendu poursuit avec « undefined » et crée quand même ; une exception
   ne s'ignore pas.
   =========================================================================== */
async function creerLocataire(client, courriel, { inscriptionOuverte = false } = {}) {
  if (!inscriptionOuverte) {
    const e = new Error("Les inscriptions sont fermées.");
    e.inscriptionFermee = true;
    e.statut = 403;
    throw e;
  }
  try {
    const { rows } = await client.query(
      "select compte, locataire from public.creer_locataire($1)", [courriel]);
    return { compte: rows[0].compte, locataire: rows[0].locataire };
  } catch (e) {
    /* PLAFOND JOURNALIER ATTEINT — posé le 25/08/2026, quand les inscriptions
       ont été ouvertes. Le déclencheur de 14-plafond-inscriptions.sql lève
       « 53400 ».

       On le traduit dans le MÊME témoin que la fermeture volontaire : pour la
       personne, les deux disent la même chose — « pas d'inscription
       aujourd'hui, revenez, ou connectez-vous si vous avez déjà un compte ».
       Deux messages distincts l'obligeraient à comprendre une distinction qui
       ne change rien à ce qu'elle doit faire. */
    if (e.code === "53400") {
      const f = new Error("Les inscriptions sont momentanément fermées.");
      f.inscriptionFermee = true;
      f.statut = 403;
      throw f;
    }
    throw e;
  }
}

export async function consommerLien(client, jeton, options = {}) {
  if (!jeton || typeof jeton !== "string") return null;

  const { rows } = await client.query(
    `update liens_connexion
        set utilise_le = now()
      where empreinte = $1
        and utilise_le is null
        and expire_le > now()
      returning compte_id, courriel, rejoint`,
    [empreinte(jeton)]);

  if (!rows.length) return null;

  let compteId = rows[0].compte_id;
  let nouveau = false;

  /* =========================================================================
     LE LIEN D'INVITATION — il fabrique un COMPTE, jamais une BIBLIOTHÈQUE

     C'est toute la différence avec le lien ordinaire, et elle tient en une
     phrase : on est attendu quelque part. Créer au passage une bibliothèque
     personnelle vide donnerait à la personne invitée exactement l'inverse de
     ce qu'on lui a promis — elle arriverait chez elle, seule, devant rien.

     DEUX GARDE-FOUS NE S'APPLIQUENT PAS ICI, et c'est délibéré.
     « INSCRIPTION_OUVERTE » et le plafond journalier protègent contre
     l'afflux d'inconnus. Une invitation n'est pas cela : quelqu'un qui a
     déjà une bibliothèque répond de la personne qu'il y fait entrer. Les
     appliquer rendrait l'invitation muette et incompréhensible — le lien
     reçu ne marcherait pas, sans qu'on puisse dire pourquoi.
     ========================================================================= */
  if (rows[0].rejoint) {
    /* LE LIEN D'INVITATION PORTE TOUJOURS L'ADRESSE, jamais l'identifiant du
       compte — « inviter_membre » n'en connaît pas, et ne doit pas en
       chercher : le faire lui dirait si l'adresse est déjà cliente.

       On regarde donc ici, au moment où l'on a le droit de savoir. Et l'on
       REGARDE AVANT D'INSÉRER plutôt que de lire « found » après un
       « on conflict » : la réponse à « ce compte est-il nouveau ? » sert à
       choisir ce qu'on affichera à la personne, et « on conflict do update »
       aurait répondu « nouveau » à quelqu'un qui a un compte depuis six
       mois. */
    if (!compteId) {
      const { rows: connu } = await client.query(
        "select id from comptes where courriel = $1", [rows[0].courriel]);
      if (connu.length) {
        compteId = connu[0].id;
      } else {
        /* Course bénigne : deux liens pour la même adresse, ouverts
           ensemble. « do update » rend la ligne dans les deux cas — c'est
           le seul moyen d'obtenir l'identifiant sans second aller-retour. */
        const { rows: cree } = await client.query(
          `insert into comptes (courriel) values ($1)
           on conflict (courriel) do update set courriel = excluded.courriel
           returning id`, [rows[0].courriel]);
        compteId = cree[0].id;
        nouveau = true;
      }
    }

    await client.query("select public.rejoindre_locataire($1, $2)",
                       [compteId, rows[0].rejoint]);

    /* ON OUVRE LA BIBLIOTHÈQUE OÙ L'ON VIENT D'ÊTRE INVITÉ, et non « la
       dernière ouverte ». Quelqu'un qui clique un lien d'invitation veut
       voir CE fonds-là ; le faire atterrir dans sa bibliothèque personnelle
       parce qu'il l'a consultée plus récemment serait juste selon la règle
       générale, et faux selon son intention.

       « rejoindre_locataire » a posé « vu_le », si bien que la règle
       générale et celle-ci disent la même chose au coup d'après. */
    const { rows: langues } = await client.query(
      "select langue from tenants where id = $1", [rows[0].rejoint]);
    const { rows: comptes } = await client.query(
      "select courriel from comptes where id = $1", [compteId]);
    if (!comptes.length) return null;

    await client.query("update comptes set vu_le = now() where id = $1", [compteId]);
    return { compte_id: compteId, tenant_id: rows[0].rejoint,
             courriel: comptes[0].courriel, langue: langues[0]?.langue,
             nouveau, invitation: true };
  }

  if (!compteId) {
    /* Course possible et bénigne : deux personnes demandent un lien pour la
       même adresse, toutes deux l'ouvrent. La première crée, la seconde tombe
       sur l'index unique de « comptes.courriel ». On rattrape en lisant le
       compte qui vient d'être créé — le résultat est le même, et il n'y a
       qu'une bibliothèque. */
    try {
      const cree = await creerLocataire(client, rows[0].courriel, options);
      compteId = cree.compte;
      nouveau = true;
    } catch (e) {
      /* « inscriptionFermee » n'a pas de code SQL : elle traverse ce
         rattrapage et remonte. Un lien émis pendant que les inscriptions
         étaient ouvertes, ouvert après leur fermeture, échoue — c'est ce que
         « fermé » doit vouloir dire. */
      if (e.code !== "23505") throw e;
      const { rows: deja } = await client.query(
        "select id from comptes where courriel = $1", [rows[0].courriel]);
      if (!deja.length) throw e;
      compteId = deja[0].id;
    }
  }

  const ouverte = await ouvrirPour(client, compteId);

  const { rows: comptes } = await client.query(
    "select courriel from comptes where id = $1", [compteId]);
  if (!comptes.length) return null;

  await client.query("update comptes set vu_le = now() where id = $1", [compteId]);
  return { compte_id: compteId, tenant_id: ouverte.locataire,
           courriel: comptes[0].courriel, langue: ouverte.langue, nouveau };
}

/* ===========================================================================
   QUELLE BIBLIOTHÈQUE S'OUVRE — un seul endroit le sait

   Les trois chemins de connexion — lien magique, retour Google par « sub »,
   retour Google par courriel — avaient chacun leur « join tenants on
   t.id = c.tenant_id ». C'était juste tant qu'un compte appartenait à une
   bibliothèque et une seule ; ce ne l'est plus, et trois copies d'une règle
   de résolution auraient dérivé comme ont dérivé les deux plafonds.

   La règle vit en base — « bibliotheque_a_ouvrir » — parce que la connexion
   se fait en contexte VISITEUR : ni compte ni locataire posés, donc aucune
   requête ordinaire sur « membres » ne rendrait quoi que ce soit.

   Et l'on marque l'ouverture : sans cela « la dernière ouverte » ne changerait
   jamais, et le tri porterait sur une colonne morte — ce qui aurait l'air de
   marcher tant qu'on n'a qu'une bibliothèque.
   =========================================================================== */
async function ouvrirPour(client, compteId) {
  const { rows } = await client.query(
    "select locataire, langue from public.bibliotheque_a_ouvrir($1)", [compteId]);

  /* ON LÈVE, ON NE REND PAS « null ». Un compte sans appartenance est
     impossible en principe — « creer_locataire » en pose une, et la garde du
     propriétaire empêche la dernière de partir. Si cela survient malgré tout,
     c'est une donnée incohérente : rendre « null » ici la ferait traduire par
     l'appelant en « ce lien n'est plus valable », et la personne chercherait
     un défaut dans son courriel pendant que le vrai est en base. */
  if (!rows.length) {
    const e = new Error(`Le compte ${compteId} n'appartient à aucune bibliothèque.`);
    e.statut = 500;
    throw e;
  }

  await client.query("select public.marquer_ouverture($1, $2)",
                     [compteId, rows[0].locataire]);
  return rows[0];
}

/* ===========================================================================
   ARRIVER PAR GOOGLE

   Trois cas, et l'ordre dans lequel on les cherche N'EST PAS INDIFFÉRENT.

   1. LE « sub » EST CONNU — c'est la même personne, quelle que soit l'adresse
      qu'elle porte aujourd'hui. On entre. Le courriel est rafraîchi au
      passage : c'est un attribut, il a le droit d'avoir changé.

   2. LE COURRIEL EST CONNU, le « sub » non — quelqu'un inscrit par lien
      magique revient par Google. On RATTACHE, à condition que Google déclare
      l'adresse vérifiée. Sans cette condition, il suffirait de créer un
      Google Workspace sur un domaine qu'on contrôle et d'y déclarer l'adresse
      de sa victime.

   3. NI L'UN NI L'AUTRE — c'est une inscription. Même porte que le lien
      magique : « creer_locataire », qui décide seul du quota, du plafond et
      de l'identifiant d'URL.

   CHERCHER LE « sub » D'ABORD, ET C'EST LE POINT. L'inverse — chercher le
   courriel en premier — ferait qu'une personne ayant changé d'adresse Google
   tomberait sur le cas 3 et se verrait offrir une bibliothèque vide, alors
   que la sienne existe. Elle ne comprendrait pas, et nous non plus.

   CETTE FONCTION NE DÉCIDE PAS DU REFUS. Quand l'adresse n'est pas vérifiée
   et qu'un compte existe à ce nom, elle rend « rattachementRefuse » et laisse
   l'appelant formuler le message. Le refus est une décision de produit ; le
   rattachement est une règle de données.
   =========================================================================== */
export async function connexionParOidc(client, { sub, courriel: brut, verifie },
                                       options = {}) {
  const courriel = normaliserCourriel(brut);
  if (!sub) { const e = new Error("Identité Google incomplète."); e.statut = 400; throw e; }

  /* 1. Le sub est connu. */
  const { rows: parSub } = await client.query(
    "select id, courriel from comptes where oidc_sub = $1", [sub]);
  if (parSub.length) {
    const c = parSub[0];
    /* Le courriel a pu changer chez Google. On le suit — mais seulement s'il
       est vérifié : sinon on écraserait une adresse prouvée par une autre qui
       ne l'est pas, et c'est par là qu'on reprend un compte. */
    if (verifie && courriel && courriel !== c.courriel) {
      await client.query("update comptes set courriel = $1 where id = $2",
        [courriel, c.id]).catch(() => { /* déjà pris par un autre compte : on garde l'ancien */ });
    }
    await client.query("update comptes set vu_le = now() where id = $1", [c.id]);
    const o = await ouvrirPour(client, c.id);
    return { compte_id: c.id, tenant_id: o.locataire, courriel: c.courriel,
             nouveau: false };
  }

  /* 2. Le courriel est connu, le sub non. */
  const { rows: parCourriel } = await client.query(
    "select id, courriel from comptes where courriel = $1", [courriel]);
  if (parCourriel.length) {
    if (!verifie) return { rattachementRefuse: true, courriel };
    const c = parCourriel[0];
    await client.query(
      "update comptes set oidc_sub = $1, vu_le = now() where id = $2", [sub, c.id]);
    const o = await ouvrirPour(client, c.id);
    return { compte_id: c.id, tenant_id: o.locataire, courriel: c.courriel,
             nouveau: false, rattache: true };
  }

  /* 3. Personne. C'est une inscription.

     On exige la vérification ICI AUSSI, et pas seulement pour le
     rattachement. Créer un compte sur une adresse non prouvée reviendrait à
     donner une bibliothèque au nom de quelqu'un qui n'a rien demandé — et à
     lui envoyer ensuite des courriels de service qu'il n'attend pas. */
  if (!verifie) return { rattachementRefuse: true, courriel };
  if (!courrielPlausible(courriel)) {
    const e = new Error("Adresse de courriel invalide."); e.statut = 400; throw e;
  }

  /* LE DRAPEAU EST CONSULTÉ ICI AUSSI — c'est tout l'objet du correctif du
     24/08. Les deux cas précédents ne le consultent pas, et c'est voulu : se
     reconnecter à une bibliothèque qui existe déjà n'est pas s'inscrire. */
  const cree = await creerLocataire(client, courriel, options);
  await client.query("update comptes set oidc_sub = $1 where id = $2",
    [sub, cree.compte]);

  return { compte_id: cree.compte, tenant_id: cree.locataire,
           courriel, nouveau: true };
}

/* ---------------------------------------------------------------------------
   LE COURT ALLER-RETOUR CHEZ GOOGLE

   Trois valeurs — state, nonce, vérifieur PKCE — doivent survivre le temps
   d'un aller-retour de trente secondes, et revenir intactes.

   PAS EN BASE. Une table pour des valeurs de trente secondes serait une table
   à purger, un index à entretenir, et une écriture sur le chemin de connexion.
   Un cookie SIGNÉ suffit : le navigateur le garde, nous le vérifions, et il
   disparaît de lui-même.

   Il porte sa propre expiration parce qu'un cookie de session survit à
   l'onglet, pas au navigateur : sans date, un aller-retour interrompu la
   veille reviendrait valide le lendemain.
   --------------------------------------------------------------------------- */
export function signerTransit(secret, charge, secondes = 600) {
  const c = { ...charge, expire: Date.now() + secondes * 1000 };
  const donnees = Buffer.from(JSON.stringify(c)).toString("base64url");
  const signature = createHmac("sha256", secret).update(donnees).digest("base64url");
  return `${donnees}.${signature}`;
}

/** Rend la charge, ou null. Ne lève jamais. */
export function verifierTransit(secret, jeton) {
  if (!jeton || typeof jeton !== "string" || !jeton.includes(".")) return null;
  const [donnees, signature] = jeton.split(".");
  if (!donnees || !signature) return null;

  const attendue = createHmac("sha256", secret).update(donnees).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(attendue);
  /* Comparaison à temps constant, pour la même raison que la session : une
     comparaison ordinaire s'arrête au premier octet différent. */
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const c = JSON.parse(Buffer.from(donnees, "base64url").toString("utf8"));
    if (!c || c.expire < Date.now()) return null;
    return c;
  } catch { return null; }
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
