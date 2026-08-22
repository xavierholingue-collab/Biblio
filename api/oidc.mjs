/* =========================================================================
   SE CONNECTER AVEC GOOGLE — EN OIDC, PAS EN OAUTH

   ---------------------------------------------------------------------------
   POURQUOI OIDC ET NON OAUTH 2.0, PUISQUE LES DEUX EXISTENT

   Ils ne répondent pas à la même question. OAuth 2.0 délivre un JETON D'ACCÈS :
   il dit ce que vous avez le droit de faire, jamais qui vous êtes. S'en servir
   pour authentifier oblige à appeler une API et à déduire l'identité de la
   réponse — et ouvre la SUBSTITUTION DE JETON : un jeton obtenu par une autre
   application, pour le même utilisateur, peut être présenté ici, et rien dans
   le jeton ne dit qu'il ne nous était pas destiné.

   OIDC ajoute l'« id_token » : un JWT signé par Google, qui porte « aud » —
   notre identifiant client — et le « nonce » que NOUS avons choisi. On vérifie
   la signature, l'émetteur, le destinataire et le nonce ; personne ne peut
   présenter un jeton pris ailleurs.

   ---------------------------------------------------------------------------
   LA CLÉ EST « sub », JAMAIS LE COURRIEL

   Une adresse Google change — mariage, changement de domaine, alias. « sub »
   est l'identifiant stable de la personne POUR CETTE APPLICATION. Clé sur le
   courriel et vous perdez le compte de qui change d'adresse ; pire, vous
   donnez le compte à qui récupère l'adresse abandonnée.

   ---------------------------------------------------------------------------
   « email_verified » N'EST PAS UN ORNEMENT

   Sans cette vérification, quelqu'un crée un Google Workspace sur un domaine
   qu'il contrôle, y déclare l'adresse de quelqu'un d'autre, et se connecte à
   sa place. Le rattachement à un compte existant est donc conditionné à
   « email_verified » — décidé avec Xavier le 22/08/2026, en connaissant le
   prix : lier les deux signifie qu'un compromis du compte Google donne accès
   à la bibliothèque, et réciproquement.

   Et quand « email_verified » est faux, ON REFUSE FRANCHEMENT. Un repli
   silencieux sur le lien magique ferait croire à une panne, et la personne
   chercherait le défaut là où il n'est pas.

   ---------------------------------------------------------------------------
   AUCUNE DÉPENDANCE NOUVELLE

   La vérification d'un JWT RS256 tient dans « node:crypto » : décoder du
   base64url, reconstruire une clé publique depuis un JWK, vérifier une
   signature. Ajouter une bibliothèque d'authentification pour cela reviendrait
   à confier le cœur de la sécurité à du code qu'on ne lit pas, pour économiser
   quarante lignes qu'on relit.

   ---------------------------------------------------------------------------
   CE QUE CE FICHIER NE FAIT PAS

   Il ne touche NI à la base, NI aux sessions, NI aux cookies. Il transforme un
   « code » en identité vérifiée, et c'est tout. Le rattachement au compte, la
   création du locataire et la pose de la session restent dans server.js, où
   ils sont déjà écrits pour le lien magique.

   Un seul endroit sait parler à Google ; un seul endroit sait créer un
   locataire. C'est ce qui permet de relire l'un sans démêler l'autre.
   ========================================================================= */

import { createHash, createPublicKey, randomBytes, verify as verifierSignature }
  from "node:crypto";

/* Les adresses de Google, relevées sur son document de découverte le
   22/08/2026. On ne les interroge PAS à chaque connexion : le document est
   stable, et une dépendance réseau de plus au moment de se connecter est une
   panne de plus. Le seul point qui bouge — les clés — est rechargé à la
   demande, plus bas. */
const GOOGLE = {
  emetteur:      "https://accounts.google.com",
  autorisation:  "https://accounts.google.com/o/oauth2/v2/auth",
  jeton:         "https://oauth2.googleapis.com/token",
  clefs:         "https://www.googleapis.com/oauth2/v3/certs",
};

/* Le même joint que « CATALOGUES_URL » : une adresse de remplacement, refusée
   si elle n'est pas locale. Un faux fournisseur d'identité est indispensable
   pour éprouver le refus d'un jeton mal signé — ce qu'aucun contrôle ne peut
   demander à Google. */
const OIDC_URL = process.env.OIDC_URL ?? "";
const adresse = (nom) => {
  if (!OIDC_URL) return GOOGLE[nom];
  const u = new URL(OIDC_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw new Error("OIDC_URL n'est acceptée qu'en local.");
  }
  return new URL(nom, OIDC_URL).href;
};

const ID     = process.env.OIDC_GOOGLE_ID ?? "";
const SECRET = process.env.OIDC_GOOGLE_SECRET ?? "";
const DELAI  = 10_000;

/** Configuré ou non — dit une fois au démarrage plutôt qu'à chaque écran. */
export function etatOidc() {
  if (!ID || !SECRET) {
    return { pret: false,
             detail: "OIDC_GOOGLE_ID ou OIDC_GOOGLE_SECRET absent de l'environnement" };
  }
  if (!/\.apps\.googleusercontent\.com$/.test(ID) && !OIDC_URL) {
    return { pret: false,
             detail: `OIDC_GOOGLE_ID ne ressemble pas à un identifiant Google : ${ID.slice(0, 20)}…` };
  }
  return { pret: true, detail: "Google, par OIDC" };
}

/* ------------------------------------------------------------- Outils */

const b64url = (b) => Buffer.from(b).toString("base64url");
const alea   = (n) => randomBytes(n).toString("base64url");

/* PKCE. Le vérifieur reste chez nous, seule son empreinte part chez Google.
   Un code intercepté au retour ne vaut donc rien sans le vérifieur.

   Sur un serveur qui garde son secret client, PKCE n'est pas indispensable —
   c'est une protection pensée pour les applications publiques. On le met quand
   même : il coûte trois lignes et couvre le cas où le code fuiterait par un
   journal, un référent ou l'historique du navigateur. */
const empreintePkce = (v) => b64url(createHash("sha256").update(v).digest());

/**
 * Le premier pas : où envoyer la personne, et ce qu'il faut retenir.
 *
 * Rend l'URL ET les trois secrets à conserver le temps de l'aller-retour.
 * L'appelant les range dans un cookie signé — pas en base : ce sont des
 * valeurs de trente secondes, et une table de plus serait une table à purger.
 */
export function commencer({ base, invite = "" }) {
  const etat      = alea(24);
  const nonce     = alea(24);
  const verifieur = alea(48);

  const p = new URLSearchParams({
    client_id: ID,
    redirect_uri: `${base}/api/oidc/retour`,
    response_type: "code",
    /* « openid email profile » : le strict nécessaire. Ce sont des portées
       NON SENSIBLES au sens de Google, donc publiables sans procédure de
       vérification. En demander davantage — contacts, agenda — déclencherait
       un examen, et surtout n'aurait aucune raison d'être. */
    scope: "openid email profile",
    state: etat,
    nonce,
    code_challenge: empreintePkce(verifieur),
    code_challenge_method: "S256",
    /* Sans cela, quelqu'un déjà connecté à Google est renvoyé sans qu'on lui
       demande rien — surprenant sur un écran où l'on venait juste de cliquer.
       « select_account » montre au moins quel compte sera utilisé. */
    prompt: "select_account",
    ...(invite ? { login_hint: invite } : {}),
  });

  return { url: `${adresse("autorisation")}?${p}`, etat, nonce, verifieur };
}

/* --------------------------------------------------- Les clés de Google

   Rechargées à la demande, et gardées en mémoire une heure. Google fait
   tourner ses clés : une clé inconnue n'est pas une attaque, c'est une
   rotation. On recharge une fois avant de conclure — mais UNE SEULE, sinon un
   jeton fabriqué avec un « kid » quelconque ferait interroger Google à chaque
   tentative, et l'attaquant choisirait quand nous appelons. */
let clefs = { quand: 0, par_kid: new Map() };

async function clefPour(kid, forcer = false) {
  const perime = Date.now() - clefs.quand > 3600_000;
  if (forcer || perime || !clefs.par_kid.has(kid)) {
    const r = await fetch(adresse("clefs"), { signal: AbortSignal.timeout(DELAI) });
    if (!r.ok) throw new Error(`clés de Google injoignables (HTTP ${r.status})`);
    const j = await r.json();
    clefs = { quand: Date.now(), par_kid: new Map((j.keys ?? []).map(k => [k.kid, k])) };
  }
  return clefs.par_kid.get(kid) ?? null;
}

/* ------------------------------------------------- Vérifier l'id_token

   L'ORDRE DES VÉRIFICATIONS N'EST PAS INDIFFÉRENT. On vérifie la SIGNATURE
   d'abord : tant qu'elle n'est pas établie, le contenu du jeton n'est qu'une
   suite d'octets fournie par l'appelant, et s'en servir pour décider quoi que
   ce soit — fût-ce quelle clé chercher — revient à faire confiance à ce qu'on
   n'a pas encore authentifié.

   Le « kid » de l'en-tête fait exception : il faut bien le lire pour choisir la
   clé. Mais il ne DÉCIDE de rien — au pire il désigne une clé qui n'existe
   pas, et la vérification échoue. */
async function verifierJeton(brut, nonceAttendu) {
  const morceaux = String(brut ?? "").split(".");
  if (morceaux.length !== 3) throw new Error("id_token malformé");

  const entete = JSON.parse(Buffer.from(morceaux[0], "base64url").toString("utf8"));

  /* « alg: none » est l'attaque la plus connue contre les JWT, et elle marche
     encore sur les implémentations qui font confiance à l'en-tête. On impose
     l'algorithme au lieu de le lire — c'est NOUS qui savons ce que Google
     signe, pas le jeton. « HS256 » serait pire encore : la clé publique de
     Google servirait alors de secret partagé, et n'importe qui pourrait
     forger.

     CE GARDE N'EST PAS ÉPROUVABLE PAR LE REFUS, et il faut le dire. Retiré,
     aucun contrôle ne tombe : la vérification de signature, plus bas, impose
     déjà « RSA-SHA256 » en dur et rejette « none » comme « HS256 ». Constaté
     en mutant le 22/08/2026.

     Il est gardé pour deux raisons, et aucune n'est la peur.

     D'abord le MESSAGE. « algorithme refusé : none » dit ce qui se passe ;
     « signature invalide » envoie chercher une clé mal chargée. Un contrôle
     éprouve donc le message, faute de pouvoir éprouver le refus.

     Ensuite parce qu'il redeviendrait porteur le jour où quelqu'un passerait
     « entete.alg » à la vérification — ce qui est exactement le raccourci
     qu'on prend en croyant généraliser. Le garde est alors la seule chose
     entre ce raccourci et un jeton forgeable. */
  if (entete.alg !== "RS256") throw new Error(`algorithme refusé : ${entete.alg}`);
  if (!entete.kid) throw new Error("id_token sans kid");

  let jwk = await clefPour(entete.kid);
  if (!jwk) jwk = await clefPour(entete.kid, true);   // rotation : une relance
  if (!jwk) throw new Error(`clé inconnue : ${entete.kid}`);

  const ok = verifierSignature(
    "RSA-SHA256",
    Buffer.from(`${morceaux[0]}.${morceaux[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(morceaux[2], "base64url"));
  if (!ok) throw new Error("signature invalide");

  const c = JSON.parse(Buffer.from(morceaux[1], "base64url").toString("utf8"));

  /* Google émet sous deux formes, avec et sans schéma. Les deux sont
     légitimes et documentées ; en accepter une seule ferait échouer des
     connexions valides sans raison compréhensible. */
  const emetteurs = OIDC_URL
    ? [GOOGLE.emetteur, "accounts.google.com", new URL(OIDC_URL).origin]
    : [GOOGLE.emetteur, "accounts.google.com"];
  if (!emetteurs.includes(c.iss)) throw new Error(`émetteur inattendu : ${c.iss}`);

  /* « aud » EST CE QUI DISTINGUE OIDC D'OAUTH. Sans cette ligne, un jeton
     émis pour une autre application serait accepté ici. */
  if (c.aud !== ID) throw new Error("ce jeton n'était pas destiné à ce service");

  const maintenant = Math.floor(Date.now() / 1000);
  const marge = 60;                       // horloges désynchronisées
  if (!c.exp || c.exp + marge < maintenant) throw new Error("id_token expiré");
  if (c.iat && c.iat - marge > maintenant) throw new Error("id_token daté du futur");

  /* Le nonce prouve que ce jeton répond à NOTRE demande, et pas à une autre
     capturée ailleurs. Sans lui, un jeton valide et non expiré, obtenu par
     n'importe quel moyen, serait rejouable. */
  if (!nonceAttendu || c.nonce !== nonceAttendu) throw new Error("nonce absent ou différent");

  return c;
}

/**
 * Le retour de Google : un code contre une identité vérifiée.
 *
 * Rend { sub, courriel, verifie, nom }. NE DÉCIDE RIEN d'autre — ni la
 * création du compte, ni le refus quand « verifie » est faux. C'est server.js
 * qui décide, parce que c'est lui qui connaît les comptes.
 */
export async function terminer({ code, verifieur, nonceAttendu, base }) {
  if (!code || !verifieur) throw new Error("retour incomplet");

  const r = await fetch(adresse("jeton"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(DELAI),
    body: new URLSearchParams({
      code,
      client_id: ID,
      client_secret: SECRET,
      redirect_uri: `${base}/api/oidc/retour`,
      grant_type: "authorization_code",
      code_verifier: verifieur,
    }),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.id_token) {
    /* Le message de Google est repris TEL QUEL dans le journal, jamais rendu
       au visiteur : il nomme parfois notre identifiant client. « invalid_grant »
       signifie le plus souvent un code déjà consommé — donc un double clic,
       pas une attaque. */
    throw new Error(`échange refusé : ${j?.error ?? `HTTP ${r.status}`}`);
  }

  const c = await verifierJeton(j.id_token, nonceAttendu);

  return {
    sub:      c.sub,
    courriel: String(c.email ?? "").trim().toLowerCase(),
    /* Google rend tantôt un booléen, tantôt la chaîne « true » — les deux
       formes figurent dans sa propre documentation. Comparer à « true » sans
       traiter la chaîne rendrait « non vérifié » un compte qui l'est, et l'on
       chercherait longtemps pourquoi. */
    verifie:  c.email_verified === true || c.email_verified === "true",
    nom:      String(c.name ?? "").trim(),
  };
}
