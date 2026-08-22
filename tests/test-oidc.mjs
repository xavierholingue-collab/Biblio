/* =========================================================================
   GOOGLE EN OIDC — CHAQUE VÉRIFICATION, RETIRÉE UNE À UNE

   Un module d'authentification qui « marche » ne prouve rien : le chemin
   nominal passe aussi quand toutes les vérifications sont absentes. Ce qui se
   contrôle ici, ce sont les REFUS.

   D'où un faux fournisseur d'identité, avec sa propre paire de clés. On peut
   alors fabriquer exactement les jetons qu'un attaquant fabriquerait — mauvais
   destinataire, mauvais émetteur, expiré, rejoué, « alg: none », signature
   d'une autre clé — ce qu'aucun contrôle ne peut demander à Google.

   USAGE
     node tests/test-oidc.mjs
   ========================================================================= */

import { createServer } from "node:http";
import { generateKeyPairSync, createSign, createHash, randomUUID } from "node:crypto";

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const PORT = 3479;
const CLIENT = "essai.apps.googleusercontent.com";

/* --------------------------------------------------- Le faux fournisseur */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "essai-1", alg: "RS256", use: "sig" };

/* Une SECONDE paire, jamais publiée. Elle sert à signer un jeton d'apparence
   parfaite dont la signature ne correspond à aucune clé connue — le cas qu'un
   contrôle de signature doit attraper, et le seul que le chemin nominal ne
   rencontre jamais. */
const { privateKey: cleIntruse } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function fabriquer(charge = {}, { alg = "RS256", cle = privateKey, kid = "essai-1" } = {}) {
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = { alg, kid, typ: "JWT" };
  const corps = {
    iss: `http://127.0.0.1:${PORT}`,
    aud: CLIENT,
    sub: "1076915035000615071",
    email: "alice@exemple.fr",
    email_verified: true,
    iat: maintenant,
    exp: maintenant + 3600,
    ...charge,
  };
  const tete = `${b64(entete)}.${b64(corps)}`;
  if (alg === "none") return `${tete}.`;
  const s = createSign("RSA-SHA256"); s.update(tete); s.end();
  return `${tete}.${s.sign(cle).toString("base64url")}`;
}

/* Ce que le faux fournisseur rendra au prochain échange. Chaque contrôle le
   pose avant d'appeler — c'est ainsi qu'on choisit le jeton à éprouver. */
let prochainJeton = null;
let refusEchange = null;

const faux = createServer(async (req, rep) => {
  const chemin = new URL(req.url, "http://x").pathname;

  if (chemin === "/clefs") {
    rep.writeHead(200, { "content-type": "application/json" });
    return rep.end(JSON.stringify({ keys: [jwk] }));
  }
  if (chemin === "/jeton") {
    for await (const _ of req) { /* on vide le corps */ }
    if (refusEchange) {
      rep.writeHead(400, { "content-type": "application/json" });
      return rep.end(JSON.stringify({ error: refusEchange }));
    }
    rep.writeHead(200, { "content-type": "application/json" });
    return rep.end(JSON.stringify({ id_token: prochainJeton, token_type: "Bearer" }));
  }
  rep.writeHead(404); rep.end();
});
await new Promise(r => faux.listen(PORT, "127.0.0.1", r));

/* L'environnement AVANT l'import : le module lit sa configuration au
   chargement, et un import statique serait hissé au-dessus de ces lignes. */
process.env.OIDC_URL = `http://127.0.0.1:${PORT}/`;
process.env.OIDC_GOOGLE_ID = CLIENT;
process.env.OIDC_GOOGLE_SECRET = "secret-de-controle";

const { commencer, terminer, etatOidc } = await import("../api/oidc.mjs");

const BASE = "https://lisia.y-factor.fr";

/* ===================================================================== */
/* 1. LA CONFIGURATION S'ANNONCE                                          */
/* ===================================================================== */

verifier("configuré, le module le dit", etatOidc().pret === true,
  JSON.stringify(etatOidc()));

/* ===================================================================== */
/* 2. LE DÉPART : CE QU'ON ENVOIE À GOOGLE                                */
/* ===================================================================== */

const depart = commencer({ base: BASE });
const u = new URL(depart.url);

verifier("le départ demande un « code », pas un jeton implicite",
  u.searchParams.get("response_type") === "code",
  u.searchParams.get("response_type"));

verifier("… avec PKCE en S256",
  u.searchParams.get("code_challenge_method") === "S256"
  && !!u.searchParams.get("code_challenge"),
  u.searchParams.get("code_challenge_method"));

/* L'EMPREINTE PART, LE VÉRIFIEUR RESTE. Envoyer le vérifieur reviendrait à
   n'avoir rien fait : PKCE ne protège que parce que le secret ne voyage pas. */
verifier("… et le vérifieur ne part PAS avec la demande",
  !depart.url.includes(depart.verifieur),
  "le vérifieur figure dans l'URL — PKCE ne sert alors à rien");

const empreinteAttendue = Buffer.from(
  createHash("sha256").update(depart.verifieur).digest()).toString("base64url");
verifier("… l'empreinte envoyée est bien celle du vérifieur",
  u.searchParams.get("code_challenge") === empreinteAttendue,
  u.searchParams.get("code_challenge"));

verifier("le state et le nonce sont tirés au sort, et distincts",
  depart.etat !== depart.nonce && depart.etat.length >= 20 && depart.nonce.length >= 20,
  `${depart.etat} / ${depart.nonce}`);

verifier("les portées restent au strict nécessaire",
  u.searchParams.get("scope") === "openid email profile",
  u.searchParams.get("scope"));

/* Deux départs consécutifs ne doivent RIEN partager : un state réutilisé
   rendrait la protection contre la falsification purement décorative. */
const depart2 = commencer({ base: BASE });
verifier("deux départs ne partagent ni state, ni nonce, ni vérifieur",
  depart.etat !== depart2.etat && depart.nonce !== depart2.nonce
  && depart.verifieur !== depart2.verifieur,
  "des valeurs sont réutilisées d'une connexion à l'autre");

/* ===================================================================== */
/* 3. LE RETOUR NOMINAL                                                   */
/* ===================================================================== */

const revenir = async (charge, options, nonce = depart.nonce) => {
  prochainJeton = fabriquer({ nonce: nonce, ...charge }, options);
  return terminer({ code: "un-code", verifieur: depart.verifieur,
                    nonceAttendu: depart.nonce, base: BASE });
};

const refuse = async (quoi, charge, options, nonce) => {
  try {
    await revenir(charge, options, nonce);
    verifier(quoi, false, "le jeton a été ACCEPTÉ");
  } catch (e) {
    verifier(quoi, true, e.message);
  }
};

{
  const id = await revenir({});
  verifier("un jeton conforme rend l'identité",
    id.sub === "1076915035000615071" && id.courriel === "alice@exemple.fr"
    && id.verifie === true,
    JSON.stringify(id));
}

/* ===================================================================== */
/* 4. CHAQUE VÉRIFICATION, RETIRÉE UNE À UNE                              */
/* ===================================================================== */

/* « aud » EST CE QUI DISTINGUE OIDC D'OAUTH. Sans lui, un jeton émis pour une
   AUTRE application — parfaitement signé par Google, non expiré — serait
   accepté ici. C'est la substitution de jeton, et c'est la raison même de
   préférer OIDC. */
await refuse("un jeton destiné à une autre application est refusé",
  { aud: "quelquun-dautre.apps.googleusercontent.com" });

await refuse("… un émetteur inattendu aussi",
  { iss: "https://un-autre-fournisseur.example" });

await refuse("… un jeton expiré aussi",
  { exp: Math.floor(Date.now() / 1000) - 3600 });

await refuse("… un jeton daté du futur aussi",
  { iat: Math.floor(Date.now() / 1000) + 7200,
    exp: Math.floor(Date.now() / 1000) + 10800 });

/* Le nonce prouve que ce jeton répond à NOTRE demande. Sans lui, un jeton
   valide capturé ailleurs serait rejouable tant qu'il n'a pas expiré. */
await refuse("… un jeton portant un autre nonce aussi", {}, {}, "un-nonce-etranger");
await refuse("… un jeton sans nonce du tout aussi", { nonce: undefined });

/* « alg: none » est l'attaque la plus connue contre les JWT, et elle marche
   encore là où l'en-tête fait autorité.

   ON ÉPROUVE LE MESSAGE, PAS SEULEMENT LE REFUS. Retirer le garde sur « alg »
   ne fait tomber aucun contrôle de refus : la vérification de signature impose
   déjà RSA-SHA256 en dur, et rejette « none ». Constaté en mutant.

   Ce que le garde apporte réellement est donc un DIAGNOSTIC : « algorithme
   refusé : none » dit ce qui se passe, quand « signature invalide » envoie
   chercher une clé mal chargée. C'est cela qu'on vérifie. */
{
  prochainJeton = fabriquer({ nonce: depart.nonce }, { alg: "none" });
  let message = "";
  try {
    await terminer({ code: "un-code", verifieur: depart.verifieur,
                     nonceAttendu: depart.nonce, base: BASE });
  } catch (e) { message = e.message; }

  verifier("… « alg: none » aussi", message !== "", "le jeton a été ACCEPTÉ");
  verifier("… et le refus NOMME l'algorithme au lieu d'accuser la signature",
    /algorithme refusé/.test(message), message);
}

/* Signé par une clé que le fournisseur n'a jamais publiée. Tout le reste du
   jeton est irréprochable — c'est exactement le cas que le chemin nominal ne
   rencontre jamais. */
await refuse("… un jeton signé par une clé étrangère aussi",
  {}, { cle: cleIntruse });

await refuse("… un « kid » inconnu aussi", {}, { kid: "jamais-publie" });

/* ===================================================================== */
/* 5. CE QUE LE MODULE NE DÉCIDE PAS                                      */
/* ===================================================================== */

/* « email_verified » faux ne fait PAS échouer la vérification du jeton : le
   jeton est authentique, c'est l'adresse qui n'est pas prouvée. Le module le
   RAPPORTE ; server.js décide d'en faire un refus.
   Confondre les deux mettrait la décision de produit dans le code de
   cryptographie, où personne n'irait la chercher. */
{
  const id = await revenir({ email_verified: false });
  verifier("une adresse non vérifiée est rapportée, pas jugée ici",
    id.verifie === false && id.sub === "1076915035000615071",
    JSON.stringify(id));
}

/* Google rend tantôt un booléen, tantôt la chaîne « true » — les deux figurent
   dans sa documentation. Traiter la chaîne comme fausse rendrait « non
   vérifié » un compte qui l'est, et le refus serait incompréhensible. */
{
  const id = await revenir({ email_verified: "true" });
  verifier("… et « true » en toutes lettres compte comme vérifié",
    id.verifie === true, JSON.stringify(id));
}

/* Le courriel est normalisé ici, une fois, pour que la comparaison avec les
   comptes existants ne dépende pas d'une majuscule. */
{
  const id = await revenir({ email: "  Alice@Exemple.FR " });
  verifier("le courriel est normalisé avant d'être rendu",
    id.courriel === "alice@exemple.fr", `« ${id.courriel} »`);
}

/* ===================================================================== */
/* 6. QUAND GOOGLE REFUSE L'ÉCHANGE                                       */
/* ===================================================================== */

{
  refusEchange = "invalid_grant";
  let message = "";
  try { await terminer({ code: "deja-consomme", verifieur: depart.verifieur,
                         nonceAttendu: depart.nonce, base: BASE }); }
  catch (e) { message = e.message; }
  refusEchange = null;

  verifier("un refus de Google est rapporté avec sa raison",
    /invalid_grant/.test(message), message);
}

/* Un retour sans code ne doit pas atteindre le réseau : c'est un appel fautif,
   pas une panne de Google. */
{
  let message = "";
  try { await terminer({ code: "", verifieur: depart.verifieur,
                         nonceAttendu: depart.nonce, base: BASE }); }
  catch (e) { message = e.message; }
  verifier("un retour sans code échoue avant tout appel réseau",
    /incomplet/.test(message), message);
}

/* ------------------------------------------------------------- Verdict */
faux.close();

for (const l of ok) console.log("  ok   " + l);
for (const l of ko) console.log("  KO   " + l);
console.log(`\n  ${ok.length + ko.length} vérifications, ${ko.length ? ko.length + " échec(s)" : "aucune erreur"}.`);
if (ko.length) process.exit(1);
