/* =========================================================================
   L'ENVOI DE COURRIEL — UN SEUL ENDROIT QUI SAIT PAR OÙ ÇA PART

   « Resend aujourd'hui, Brevo probablement demain », dit le 16/08/2026. Cette
   phrase a décidé de la forme du fichier : le changement devait être UNE
   VARIABLE D'ENVIRONNEMENT, pas une chasse au trésor dans le code.

   « Demain » a duré une heure. Resend demandait vingt euros par mois pour un
   second domaine — y-factor occupait déjà le seul autorisé en gratuit — et
   l'on est parti sur Brevo avant même le premier envoi. Le basculement a
   coûté un mot dans un fichier d'environnement, et ZÉRO ligne de code.

   C'est l'argument de cette forme, et il vaut d'être noté : la raison de
   changer de fournisseur n'est presque jamais technique. Elle est
   commerciale, elle arrive sans prévenir, et elle n'attend pas.

   Le reste de l'application appelle « envoyerCourriel » et ne sait rien
   d'autre. Aucune route, aucune page, aucun contrôle ne mentionne un
   fournisseur.

   ---------------------------------------------------------------------------
   POURQUOI LES DEUX RESTENT ÉCRITS

   Resend n'est plus utilisé, et son chemin demeure — éprouvé comme l'autre.
   Le supprimer économiserait vingt lignes et coûterait le retour : le jour
   où Brevo déplaît, il faudrait réécrire sous la contrainte ce qui existait.

   Les CONTRÔLES VÉRIFIENT CE QUI PART RÉELLEMENT — adresse, en-têtes, corps —
   pour chacun, contre un faux serveur. Aucun compte n'est nécessaire pour
   cela : ce qui reste à découvrir le jour d'une bascule, c'est la
   configuration DNS, pas le code.

   ---------------------------------------------------------------------------
   SANS CLEF, ON N'ENVOIE RIEN — ET ON LE DIT

   La recette n'a pas de clef, délibérément. Le lien s'inscrit alors dans le
   journal du serveur, en clair, et la fonction rend « journalise ». C'est ce
   qui permet d'éprouver la connexion par lien sans dépendre d'un service
   extérieur ni écrire à qui que ce soit.

   CE QUE CELA IMPLIQUE, ET IL FAUT LE SAVOIR : quiconque lit le journal du
   serveur peut se connecter. C'est acceptable en recette — dont l'accès est
   déjà protégé par un mot de passe HTTP — et ce serait inacceptable en
   production. D'où le refus de démarrer décrit plus bas.
   ========================================================================= */

const SERVICE = (process.env.COURRIEL_SERVICE ?? "").toLowerCase();
const CLEF = process.env.COURRIEL_CLEF ?? "";
const EXPEDITEUR = process.env.COURRIEL_EXPEDITEUR ?? "";

/* L'adresse du service, surchargeable UNIQUEMENT vers la machine locale.
 *
 * Même raisonnement que pour le modèle : les contrôles ont besoin d'un
 * serveur qui répond sans envoyer de vrai courriel, mais une destination
 * librement configurable est une fuite de clef en puissance — c'est vers
 * elle que part l'autorisation. Toute valeur hors de 127.0.0.1 est ignorée
 * avec un avertissement, plutôt que refusée en silence. */
const ADRESSES = {
  resend: "https://api.resend.com/emails",
  brevo: "https://api.brevo.com/v3/smtp/email",
};

function adresseDuService(nom) {
  const voulue = process.env.COURRIEL_URL ?? "";
  if (!voulue) return ADRESSES[nom];
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(voulue)) return voulue;
  console.warn(
    `COURRIEL_URL ignorée : « ${voulue} » n'est pas sur la machine locale.`);
  return ADRESSES[nom];
}

/* =========================================================================
   LA CONFIGURATION EST VÉRIFIÉE AU DÉMARRAGE, PAS AU PREMIER ENVOI

   Un expéditeur mal écrit ou une clef absente ne doivent pas se découvrir
   quand quelqu'un attend son lien de connexion. La fonction ci-dessous est
   appelée au démarrage du serveur ; elle décrit l'état, et l'appelant décide
   si cet état est tolérable dans son environnement.
   ========================================================================= */
export function etatCourriel() {
  if (!SERVICE || SERVICE === "journal") {
    return { mode: "journal", pret: true,
             detail: "aucun envoi : le lien est écrit dans le journal" };
  }
  if (!ADRESSES[SERVICE]) {
    return { mode: SERVICE, pret: false,
             detail: `service inconnu « ${SERVICE} » (attendu : resend, brevo, journal)` };
  }
  if (!CLEF) {
    return { mode: SERVICE, pret: false, detail: "COURRIEL_CLEF absente" };
  }

  /* UNE CLEF NE CONTIENT QUE DE L'ASCII IMPRIMABLE, ET IL FAUT LE VÉRIFIER ICI.
   *
   * Constaté en production le 17/08/2026. La clef posée valait « xkeysib-… » :
   * l'interface de Brevo n'affiche la clef ENTIÈRE qu'au moment de sa
   * création, et la montre tronquée ensuite — points de suspension compris.
   * Copiée depuis la liste, on emporte le « … ».
   *
   * Sans ce contrôle, l'erreur ne surgit qu'au premier envoi, et sous une
   * forme illisible :
   *
   *   Cannot convert argument to a ByteString because the character at
   *   index 8 has a value of 8230 which is greater than 255
   *
   * C'est « fetch » qui refuse de mettre un caractère non-ASCII dans un
   * en-tête HTTP. Le message est exact et parfaitement inutile : rien n'y
   * nomme la clef, ni Brevo, ni le courriel. On passe une demi-heure à
   * chercher un problème de réseau.
   *
   * Ici, le même défaut se dit au démarrage, en français, avec le nom de la
   * variable fautive. */
  const fautif = [...CLEF].findIndex((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e);
  if (fautif !== -1) {
    return { mode: SERVICE, pret: false,
             detail: `COURRIEL_CLEF contient un caractère interdit en position ${fautif + 1}`
                   + ` (« ${CLEF[fautif]} »). Une clef tronquée, copiée depuis l'affichage`
                   + ` du fournisseur ? Elle ne s'y montre entière qu'à sa création.` };
  }
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]{2,}$/.test(EXPEDITEUR)) {
    return { mode: SERVICE, pret: false,
             detail: `COURRIEL_EXPEDITEUR absent ou mal formé : « ${EXPEDITEUR} »` };
  }
  return { mode: SERVICE, pret: true, detail: `expéditeur ${EXPEDITEUR}` };
}

/* =========================================================================
   L'ENVOI

   Rend { envoye: true, mode } ou lève. Ne rend JAMAIS le contenu du message
   à l'appelant : ce qui a été écrit ne doit pas pouvoir remonter dans une
   réponse HTTP par mégarde.
   ========================================================================= */
export async function envoyerCourriel({ a, sujet, texte, html }) {
  const etat = etatCourriel();

  if (etat.mode === "journal") {
    /* En clair, et volontairement. Un lien de connexion inutilisable parce
       qu'on l'a masqué dans le journal ne sert à personne — et ce mode
       n'existe que là où le journal est déjà un secret. */
    console.log(`[courriel:journal] à ${a} — ${sujet}\n${texte}`);
    return { envoye: true, mode: "journal" };
  }

  if (!etat.pret) {
    const e = new Error(`Envoi de courriel indisponible : ${etat.detail}`);
    e.statut = 503;
    throw e;
  }

  /* Les deux fournisseurs diffèrent par trois choses seulement : l'adresse,
     le nom de l'en-tête d'autorisation, et le nom des champs. Tout le reste
     — délai, lecture de l'erreur, forme du retour — leur est commun, et
     c'est ce qui rend la bascule sûre. */
  const configurations = {
    resend: {
      entetes: { authorization: `Bearer ${CLEF}` },
      corps: { from: EXPEDITEUR, to: [a], subject: sujet, text: texte,
               ...(html ? { html } : {}) },
    },
    brevo: {
      entetes: { "api-key": CLEF },
      corps: { sender: { email: EXPEDITEUR }, to: [{ email: a }],
               subject: sujet, textContent: texte,
               ...(html ? { htmlContent: html } : {}) },
    },
  };
  const config = configurations[etat.mode];

  /* UN DÉLAI, SINON UNE ROUTE PEUT ATTENDRE INDÉFINIMENT. Le service peut
     être lent ou muet ; la personne qui demande un lien, elle, attend devant
     son écran, et une connexion du pool reste prise. */
  const arret = AbortSignal.timeout(15_000);

  let reponse;
  try {
    reponse = await fetch(adresseDuService(etat.mode), {
      method: "POST",
      headers: { "content-type": "application/json", ...config.entetes },
      body: JSON.stringify(config.corps),
      signal: arret,
    });
  } catch (e) {
    /* Le message d'origine peut contenir l'adresse appelée ; il part au
       journal, pas au client. */
    console.error("courriel : appel impossible —", e.message);
    const err = new Error("Le service de courriel ne répond pas.");
    err.statut = 502;
    throw err;
  }

  if (!reponse.ok) {
    const detail = (await reponse.text().catch(() => "")).slice(0, 300);
    console.error(`courriel : ${etat.mode} a refusé (HTTP ${reponse.status}) — ${detail}`);
    const err = new Error("Le service de courriel a refusé l'envoi.");
    err.statut = 502;
    throw err;
  }

  return { envoye: true, mode: etat.mode };
}

/* =========================================================================
   LE MESSAGE LUI-MÊME

   Écrit ici plutôt que dans la route : c'est un texte, il vivra plus
   longtemps que le code qui l'appelle, et il mérite d'être relu sans avoir
   à ouvrir le routeur.

   ON NE MET PAS LE NOM DU DESTINATAIRE, ni le titre d'un ouvrage, ni quoi
   que ce soit de la bibliothèque. Un courriel traverse des serveurs qu'on ne
   choisit pas et reste dans des boîtes qu'on ne maîtrise pas. Il ne porte
   donc que ce qui est strictement nécessaire : un lien, et sa durée.
   ========================================================================= */
export function messageDeConnexion(lien, minutes) {
  const texte =
`Voici votre lien de connexion à la bibliothèque :

${lien}

Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois.

Si vous n'avez rien demandé, ignorez ce message : personne ne peut se
connecter sans ce lien.`;

  /* Pas d'image, pas de feuille de style, pas de pixel de suivi. Un lien de
     connexion n'a rien à raconter, et tout ornement est une occasion de
     finir en indésirable. */
  const html =
`<p>Voici votre lien de connexion à la bibliothèque :</p>
<p><a href="${lien}">Se connecter</a></p>
<p>Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois.</p>
<p>Si vous n'avez rien demandé, ignorez ce message : personne ne peut se
connecter sans ce lien.</p>`;

  return { sujet: "Votre lien de connexion", texte, html };
}

/**
 * Le message d'une PREMIÈRE venue. Distinct de celui de connexion, et c'est
 * délibéré.
 *
 * Envoyer « voici votre lien de connexion » à quelqu'un qui n'a jamais rien
 * créé serait mentir sans raison : il chercherait un compte qu'il n'a pas.
 * Et si l'adresse a été saisie par un tiers, ce message-ci le lui dit —
 * « quelqu'un a demandé à ouvrir une bibliothèque avec cette adresse » — au
 * lieu de lui laisser croire qu'un compte existait déjà à son nom.
 *
 * Ce que cela ne révèle PAS : la réponse HTTP est identique dans tous les
 * cas. Seul celui qui relève la boîte voit la différence, et il y a droit.
 */
export function messageDInscription(lien, minutes) {
  const texte =
`Bienvenue. Ce lien ouvre votre bibliothèque :

${lien}

Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois. Votre
bibliothèque est créée quand vous l'ouvrez, et pas avant.

Elle est PRIVÉE par défaut : vous seul la voyez, tant que vous n'en décidez
pas autrement.

Si vous n'avez rien demandé, ignorez ce message. Rien n'a été créé, et sans
ce lien personne ne peut rien créer avec votre adresse.`;

  const html =
`<p>Bienvenue. Ce lien ouvre votre bibliothèque :</p>
<p><a href="${lien}">Ouvrir ma bibliothèque</a></p>
<p>Il est valable ${minutes} minutes et ne fonctionne qu'une seule fois. Votre
bibliothèque est créée quand vous l'ouvrez, et pas avant.</p>
<p>Elle est <strong>privée</strong> par défaut : vous seul la voyez, tant que
vous n'en décidez pas autrement.</p>
<p>Si vous n'avez rien demandé, ignorez ce message. Rien n'a été créé, et sans
ce lien personne ne peut rien créer avec votre adresse.</p>`;

  return { sujet: "Ouvrez votre bibliothèque", texte, html };
}
