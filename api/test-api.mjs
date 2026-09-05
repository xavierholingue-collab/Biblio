/* Tests de l'API, à lancer contre la pile Docker en fonctionnement.
   Sans effet de bord : les ouvrages créés sont supprimés en fin de parcours.
   Les appels au modèle ne sont pas déclenchés (ils coûtent de l'argent) ;
   on vérifie seulement qu'ils sont correctement protégés.

   Usage, depuis le dossier docker :
     node --env-file=.env api/test-api.mjs                                     */

const BASE = process.env.BASE ?? "http://localhost:8080";
const MOT_DE_PASSE = process.env.MOT_DE_PASSE;

if (!MOT_DE_PASSE) {
  console.error("MOT_DE_PASSE absent. Lancez avec --env-file=.env depuis le dossier docker.");
  process.exit(1);
}

const ok = [], echecs = [];
function verifier(nom, condition, detail) {
  (condition ? ok : echecs).push(nom + (condition ? "" : " — " + (detail ?? "")));
}

let cookie = "";

async function appel(chemin, options = {}) {
  const aUnCorps = options.corps !== undefined;
  const r = await fetch(BASE + chemin, {
    method: options.methode ?? (aUnCorps ? "POST" : "GET"),
    headers: {
      ...(aUnCorps ? { "Content-Type": "application/json" } : {}),
      ...(cookie && !options.sansCookie ? { Cookie: cookie } : {}),
    },
    body: aUnCorps ? JSON.stringify(options.corps) : undefined,
  });
  const brut = r.headers.get("set-cookie");
  if (brut) cookie = brut.split(";")[0];
  let corps = null;
  try { corps = await r.json(); } catch (e) { /* réponse sans corps */ }
  return { statut: r.status, corps, entetes: r.headers };
}

// Ouvrages jetables, préfixés pour être reconnaissables et nettoyés.
const T1 = "zz-test-1", T2 = "zz-test-2";
const gabarit = (id, sphere) => ({
  id, titre: "Ouvrage de test " + id, auteur: "Zzz Testeur", editeur: "Ed. Test",
  annee: 2026, statut: "A lire", note: null, categorie: "Savoirs",
  sous_categorie: "Philosophie", sphere, isbn: "978000000000" + id.slice(-1),
});

async function nettoyer() {
  for (const id of [T1, T2]) await appel("/api/livres/" + id, { methode: "DELETE" });
}

let r;

try {
  /* ---------------------------------------------------- Accès sans session */

  r = await appel("/api/sante", { sansCookie: true });
  verifier("santé répond", r.statut === 200 && r.corps?.ok === true, "statut " + r.statut);

  r = await appel("/api/session", { sansCookie: true });
  verifier("session annoncée non connectée", r.corps?.connecte === false);
  verifier("l'IA n'est pas publique par défaut", r.corps?.ia_publique === false,
    String(r.corps?.ia_publique));

  r = await appel("/api/livres", { sansCookie: true });
  verifier("lecture publique autorisée", r.statut === 200, "statut " + r.statut);
  const publics = r.corps ?? [];

  /* =======================================================================
     ON NE TESTE PLUS LA SPHÈRE, ON TESTE LA VISIBILITÉ.

     Cette vérification exigeait « toutes les fiches publiques sont de sphère
     Pro ». C'était vrai tant que « Pro = public » était une règle écrite dans
     le code. Le menu de réglages, livré le 16/08/2026, l'a remplacée par une
     décision de l'utilisateur — et le contrôle a déclaré une fuite dès que
     Xavier a publié deux ouvrages personnels, c'est-à-dire dès qu'il s'est
     servi de la fonction qu'on venait de lui donner.

     Sixième occurrence de la même famille dans la semaine : un contrôle qui
     mesurait un état du moment plutôt qu'une propriété du système.

     La propriété, elle, ne dépend d'aucun réglage : RIEN DE CE QUI EST
     MARQUÉ PRIVÉ NE DOIT SORTIR. La sphère est un classement — Pro, Perso —
     et n'a plus rien à voir avec ce qui se montre.
     ======================================================================= */
  verifier("aucun ouvrage marqué privé n'est exposé",
    publics.length > 0 && publics.every(l => l.visibilite !== "privee"),
    "visibilités vues : " + [...new Set(publics.map(l => l.visibilite))].join(","));

  /* Le périmètre public, tel qu'il est À CET INSTANT. Il sert de référence
     aux deux vérifications de fin : un jeton falsifié et une déconnexion
     doivent rendre EXACTEMENT ceci, ni plus ni moins. Comparer des ensembles
     plutôt qu'une propriété des lignes attrape aussi ce qu'aucune règle sur
     les champs ne verrait — un ouvrage d'un autre locataire, par exemple. */
  const perimetrePublic = publics.map(l => l.id).sort().join("|");
  const memePerimetre = (liste) =>
    Array.isArray(liste) && liste.map(l => l.id).sort().join("|") === perimetrePublic;

  r = await appel("/api/statistiques", { sansCookie: true });
  const statsPub = r.corps ?? {};
  verifier("statistiques publiques", r.statut === 200 && statsPub.perimetre === "public",
    "statut " + r.statut + " / " + statsPub.perimetre);
  verifier("statistiques cohérentes avec la liste publique",
    statsPub.total === publics.length, statsPub.total + " vs " + publics.length);
  verifier("statistiques : compteurs présents",
    ["avec_resume", "auteurs", "rayons"]
      .every(c => typeof statsPub[c] === "number"));

  /* =====================================================================
     LES CHIFFRES DE LECTURE NE SONT PAS RENDUS À UN VISITEUR — 05/09/2026

     Depuis la migration 17, le statut de lecture appartient à la PERSONNE.
     Un visiteur n'en a aucun : la vue lui rend « A lire » partout, et
     compter ces lignes produirait « 0 lu, 348 à lire » sur la bibliothèque
     de quelqu'un d'autre. Faux, et crédible.

     CE CONTRÔLE EST PLUS EXIGEANT QUE CELUI QU'IL REMPLACE. L'ancien
     demandait « c'est un nombre » — satisfait par un zéro mensonger.
     Celui-ci demande « c'est explicitement null », ce que seul un serveur
     qui a pris la décision peut rendre. Un oubli redonnerait des nombres,
     et tomberait ici.

     Les CINQ champs partent ensemble : en laisser un seul passer laisserait
     une moitié de vérité, ce qui est la forme la plus commode de l'erreur.
     ===================================================================== */
  verifier("statistiques : AUCUN chiffre de lecture n'est rendu au visiteur",
    ["lus", "en_cours", "a_lire", "notes", "note_moyenne"]
      .every(c => statsPub[c] === null),
    JSON.stringify(Object.fromEntries(
      ["lus", "en_cours", "a_lire", "notes", "note_moyenne"]
        .map(c => [c, statsPub[c]])))
    + " — un zéro se lit comme un fait sur la bibliothèque d'autrui");

  verifier("statistiques : ni par rayon",
    Array.isArray(statsPub.sous_categories)
      && statsPub.sous_categories.every(x => x.lus === null),
    JSON.stringify(statsPub.sous_categories?.slice(0, 2))
    + " — la jauge de chaque tuile afficherait zéro");
  verifier("statistiques : listes présentes",
    ["sous_categories", "decennies", "auteurs_recurrents", "plus_recents"]
      .every(c => Array.isArray(statsPub[c])));
  verifier("statistiques : somme des rayons égale au total",
    statsPub.sous_categories.reduce((s, x) => s + x.n, 0) === statsPub.total,
    statsPub.sous_categories.reduce((s, x) => s + x.n, 0) + " vs " + statsPub.total);

  /* CE QUI SUIT A DÉMÉNAGÉ VERS LA SESSION CONNECTÉE — 05/09/2026.

     L'effectif des ouvrages notés, la cohérence de la moyenne avec son
     effectif, et la part lue par rayon restent des propriétés
     indispensables : « avg() » ignore les valeurs nulles sans le dire, et
     une moyenne sans son effectif est une affirmation qu'on ne peut pas
     évaluer. Mais elles n'ont de sujet que pour quelqu'un qui LIT.

     Elles sont donc vérifiées plus bas, sur la session connectée — voir
     « statistiques élargies une fois connecté ». Rien n'est perdu ; le même
     invariant est posé là où il a un sens. */

  /* ------------------------------------------- Ce qui reste fermé au public */

  for (const [chemin, options] of [
    ["/api/livres", { methode: "PUT", corps: [] }],
    ["/api/couvertures", { corps: [] }],
    ["/api/livres/" + T1, { methode: "DELETE" }],
    ["/api/resume", { corps: { bookId: "x000" } }],
    ["/api/recommandation", { corps: { intention: "un sujet de test" } }],
    ["/api/recherche-livre", { corps: { requete: "un titre de test" } }],
  ]) {
    r = await appel(chemin, { ...options, sansCookie: true });
    verifier(`${chemin} refusé sans session`, r.statut === 401, "statut " + r.statut);
  }

  /* ------------------------------------------------------------- Connexion */

  r = await appel("/api/connexion", { corps: { motDePasse: "mauvais" }, sansCookie: true });
  verifier("mauvais mot de passe refusé", r.statut === 401, "statut " + r.statut);

  r = await appel("/api/connexion", { corps: { motDePasse: MOT_DE_PASSE }, sansCookie: true });
  verifier("bon mot de passe accepté", r.statut === 200, "statut " + r.statut);
  const poseCookie = r.entetes.get("set-cookie") ?? "";
  verifier("cookie HttpOnly", /HttpOnly/i.test(poseCookie), poseCookie);
  verifier("cookie SameSite=Strict", /SameSite=Strict/i.test(poseCookie), poseCookie);

  r = await appel("/api/session");
  verifier("session reconnue", r.corps?.connecte === true);

  /* -------------------------------------------------------- Jeton falsifié */

  const vrai = cookie;
  cookie = "session=" + Buffer.from(JSON.stringify({ expire: Date.now() + 1e9 }))
    .toString("base64url") + ".signaturebidon";
  r = await appel("/api/livres");
  /* UN JETON FALSIFIÉ NE DOIT PAS ÊTRE REFUSÉ EN LECTURE — il doit être
     IGNORÉ. La différence compte : la lecture publique reste ouverte à tous,
     y compris à qui présente n'importe quoi. Ce qu'on exige, c'est qu'un tel
     visiteur obtienne exactement le périmètre public, à la ligne près.

     CE QUE CETTE VÉRIFICATION N'ÉPROUVE PAS, et il vaut mieux l'écrire que
     de le laisser croire. Mesuré le 16/08/2026 : désactiver entièrement la
     comparaison de signature dans server.js ne fait tomber AUCUN contrôle de
     ce fichier. Le jeton fabriqué ici ne porte pas de locataire, et le
     serveur refuse de son côté toute session sans locataire — c'est cette
     seconde barrière qui répond, pas la signature.

     Éprouver la signature demande un jeton qui désigne une bibliothèque
     existante, donc de connaître son identifiant : impossible depuis
     l'extérieur, ce qui est précisément le but. C'est test-http-cloisonnement
     qui s'en charge, sur un banc où les deux locataires sont connus — et la
     même mutation y fait bien tomber « un cookie dont on a changé le
     locataire est rejeté ». */
  verifier("jeton falsifié : aucune élévation de droits",
    r.statut === 200 && memePerimetre(r.corps),
    `statut ${r.statut}, ${r.corps?.length} ouvrages au lieu de ${publics.length}`);
  r = await appel("/api/livres", { methode: "PUT", corps: [] });
  verifier("jeton falsifié : écriture refusée", r.statut === 401, "statut " + r.statut);
  cookie = vrai;

  /* -------------------------------------------------- Lecture authentifiée */

  await nettoyer();

  r = await appel("/api/livres");
  const tous = r.corps ?? [];
  verifier("lecture complète autorisée", r.statut === 200 && tous.length >= publics.length);
  verifier("les ouvrages perso apparaissent une fois connecté",
    tous.some(l => l.sphere === "Perso"), "aucun Perso trouvé");
  verifier("le périmètre s'élargit", tous.length > publics.length,
    tous.length + " vs " + publics.length);

  r = await appel("/api/statistiques");
  verifier("statistiques élargies une fois connecté",
    r.corps?.perimetre === "complet" && r.corps?.total === tous.length,
    `${r.corps?.perimetre} / ${r.corps?.total} vs ${tous.length}`);

  /* LES CHIFFRES DE LECTURE EXISTENT POUR QUI EST IDENTIFIÉ. Sans cette
     moitié, on aurait seulement prouvé qu'ils sont toujours absents — ce
     qu'un serveur qui les aurait supprimés satisferait aussi. */
  const statsMoi = r.corps ?? {};
  verifier("statistiques : les chiffres de lecture reviennent une fois connecté",
    ["lus", "en_cours", "a_lire", "notes"]
      .every(c => typeof statsMoi[c] === "number"),
    JSON.stringify(Object.fromEntries(
      ["lus", "en_cours", "a_lire", "notes"].map(c => [c, statsMoi[c]]))));

  verifier("statistiques : les trois statuts couvrent le total",
    statsMoi.lus + statsMoi.en_cours + statsMoi.a_lire === statsMoi.total,
    `${statsMoi.lus} + ${statsMoi.en_cours} + ${statsMoi.a_lire} `
    + `vs ${statsMoi.total}`);

  // L'effectif sur lequel porte la note moyenne. avg() ignore les valeurs
  // nulles sans le dire : sans ce compte, la page affiche « 4,32 » à côté de
  // « 242 ouvrages » et personne ne peut savoir que 57 seulement sont notés.
  verifier("statistiques : les notés ne dépassent pas le total",
    statsMoi.notes <= statsMoi.total, statsMoi.notes + " sur " + statsMoi.total);
  verifier("statistiques : une moyenne n'est donnée que s'il y a des notes",
    (statsMoi.notes > 0) === (statsMoi.note_moyenne !== null),
    "notes = " + statsMoi.notes + ", moyenne = " + statsMoi.note_moyenne);

  // Chaque rayon annonce combien de ses ouvrages sont lus : c'est ce que
  // remplit la jauge de la mosaïque.
  verifier("statistiques : part lue fournie par rayon",
    statsMoi.sous_categories.every(x => typeof x.lus === "number" && x.lus <= x.n),
    JSON.stringify(statsMoi.sous_categories.find(x => typeof x.lus !== "number") ?? "—"));

  /* ------------------------------------------------------------- Écriture */

  r = await appel("/api/livres", { methode: "PUT", corps: [gabarit(T1, "Perso"), gabarit(T2, "Pro")] });
  verifier("création acceptée", r.statut === 200 && r.corps?.enregistres === 2, JSON.stringify(r.corps));

  r = await appel("/api/livres");
  const cree = r.corps.find(l => l.id === T1);
  verifier("ouvrage créé retrouvé", !!cree);
  verifier("sphere respectée à la création", cree?.sphere === "Perso", cree?.sphere);

  r = await appel("/api/livres", { methode: "PUT",
    corps: [{ ...cree, titre: "Titre modifié", statut: "Lu", note: 4 }] });
  r = await appel("/api/livres");
  const modifie = r.corps.find(l => l.id === T1);
  verifier("mise à jour sans doublon", r.corps.filter(l => l.id === T1).length === 1);
  verifier("titre modifié", modifie?.titre === "Titre modifié", modifie?.titre);
  verifier("note enregistrée", Number(modifie?.note) === 4, String(modifie?.note));

  /* -------------------------------- Mise à jour partielle des couvertures */

  r = await appel("/api/couvertures", { corps: [
    { id: T1, cover_url: "https://covers.openlibrary.org/b/isbn/9780000000001-M.jpg", cover_statut: "trouvee" },
    { id: T2, cover_url: null, cover_statut: "absente" },
  ] });
  verifier("couvertures enregistrées", r.statut === 200 && r.corps?.enregistrees === 2, JSON.stringify(r.corps));

  r = await appel("/api/livres");
  const apres = r.corps.find(l => l.id === T1);
  verifier("url de couverture conservée", apres?.cover_statut === "trouvee" && !!apres?.cover_url);
  verifier("le titre n'est pas écrasé par la mise à jour partielle",
    apres?.titre === "Titre modifié", apres?.titre);

  /* ------------------------------------- Étanchéité du périmètre personnel */

  const sansSession = await fetch(BASE + "/api/livres").then(x => x.json());
  verifier("l'ouvrage perso créé n'est pas exposé publiquement",
    !sansSession.find(l => l.id === T1), "fuite de " + T1);
  verifier("l'ouvrage pro créé est bien exposé publiquement",
    !!sansSession.find(l => l.id === T2), T2 + " absent du périmètre public");

  /* ------------------------------------------------ Validation des entrées */

  r = await appel("/api/recommandation", { corps: { intention: "ab" } });
  verifier("intention trop courte refusée", r.statut === 400, "statut " + r.statut);

  r = await appel("/api/recherche-livre", { corps: { requete: "" } });
  verifier("recherche vide refusée", r.statut === 400, "statut " + r.statut);

  r = await appel("/api/resume", { corps: { bookId: "identifiant-inexistant" } });
  verifier("résumé d'un ouvrage inconnu : 404", r.statut === 404, "statut " + r.statut);

  r = await appel("/api/inconnu");
  verifier("route inconnue : 404", r.statut === 404, "statut " + r.statut);

  /* ---------------------------------------------------------- Suppression */

  r = await appel("/api/livres/" + T1, { methode: "DELETE" });
  verifier("suppression acceptée", r.statut === 200);
  await appel("/api/livres/" + T2, { methode: "DELETE" });

  r = await appel("/api/livres");
  verifier("ouvrages de test bien supprimés",
    !r.corps.find(l => l.id === T1) && !r.corps.find(l => l.id === T2));
  verifier("bibliothèque revenue à son état initial",
    r.corps.length === tous.length, r.corps.length + " vs " + tous.length);

  /* ---------------------------------------------------------- Déconnexion */

  r = await appel("/api/deconnexion", { corps: {} });
  verifier("déconnexion acceptée", r.statut === 200);
  verifier("cookie effacé", /Max-Age=0/.test(r.entetes.get("set-cookie") ?? ""));
  cookie = "";

  r = await appel("/api/livres");
  /* Le périmètre doit être REVENU à ce qu'il était avant la connexion, et
     pas seulement « restreint ». Les ouvrages d'essai ont été supprimés
     juste au-dessus : les deux ensembles doivent coïncider exactement. */
  verifier("retour au périmètre public après déconnexion",
    r.statut === 200 && memePerimetre(r.corps),
    `statut ${r.statut}, ${r.corps?.length} ouvrages au lieu de ${publics.length}`);
  r = await appel("/api/livres", { methode: "PUT", corps: [] });
  verifier("écriture de nouveau refusée", r.statut === 401, "statut " + r.statut);

} catch (e) {
  echecs.push("exception : " + e.message);
  try { await nettoyer(); } catch (e2) { /* on a fait au mieux */ }
}

/* ----------------------------------------------------------------- Bilan */

console.log("\n" + ok.length + " vérifications passées");
ok.forEach(o => console.log("  ok   " + o));
if (echecs.length) {
  console.log("\n" + echecs.length + " ÉCHECS");
  echecs.forEach(e => console.log("  KO   " + e));
  process.exit(1);
}
console.log("\nAucune erreur.");
