/* =========================================================================
   L'ENVOI DE COURRIEL — UN SEUL ENDROIT QUI SAIT PAR OÙ ÇA PART

   Resend aujourd'hui, Brevo probablement demain. Cette phrase, dite le
   16/08/2026, décide de la forme de ce fichier : le changement doit être
   UNE VARIABLE D'ENVIRONNEMENT, pas une chasse au trésor dans le code.

   Le reste de l'application appelle « envoyerCourriel » et ne sait rien
   d'autre. Aucune route, aucune page, aucun contrôle ne mentionne un
   fournisseur.

   ---------------------------------------------------------------------------
   POURQUOI DEUX FOURNISSEURS ÉCRITS TOUT DE SUITE

   Écrire Brevo « le jour venu » revient à écrire du code non éprouvé un jour
   où l'on est pressé, parce qu'on migre en général quand quelque chose ne va
   plus. Les deux chemins sont donc là, et les CONTRÔLES VÉRIFIENT CE QUI PART
   RÉELLEMENT — adresse, en-têtes, corps — pour chacun, contre un faux serveur.

   Aucun compte n'est nécessaire pour éprouver cela. Ce qui reste à découvrir
   le jour de la migration, c'est la configuration DNS, pas le code.

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
