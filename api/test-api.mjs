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
  annee: 2026, statut: "A lire", note: null, categorie: "Académique",
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
  verifier("seuls les ouvrages Pro sont exposés",
    publics.length > 0 && publics.every(l => l.sphere === "Pro"),
    [...new Set(publics.map(l => l.sphere))].join(","));

  r = await appel("/api/statistiques", { sansCookie: true });
  const statsPub = r.corps ?? {};
  verifier("statistiques publiques", r.statut === 200 && statsPub.perimetre === "professionnel",
    "statut " + r.statut + " / " + statsPub.perimetre);
  verifier("statistiques cohérentes avec la liste publique",
    statsPub.total === publics.length, statsPub.total + " vs " + publics.length);
  verifier("statistiques : compteurs présents",
    ["lus", "en_cours", "a_lire", "avec_resume", "auteurs", "rayons"]
      .every(c => typeof statsPub[c] === "number"));
  verifier("statistiques : listes présentes",
    ["sous_categories", "decennies", "auteurs_recurrents", "plus_recents"]
      .every(c => Array.isArray(statsPub[c])));
  verifier("statistiques : somme des rayons égale au total",
    statsPub.sous_categories.reduce((s, x) => s + x.n, 0) === statsPub.total,
    statsPub.sous_categories.reduce((s, x) => s + x.n, 0) + " vs " + statsPub.total);

  // L'effectif sur lequel porte la note moyenne. avg() ignore les valeurs
  // nulles sans le dire : sans ce compte, la page affiche « 4,32 » à côté de
  // « 242 ouvrages » et personne ne peut savoir que 57 seulement sont notés.
  verifier("statistiques : effectif des ouvrages notés fourni",
    typeof statsPub.notes === "number", "notes = " + statsPub.notes);
  verifier("statistiques : les notés ne dépassent pas le total",
    statsPub.notes <= statsPub.total, statsPub.notes + " sur " + statsPub.total);
  verifier("statistiques : une moyenne n'est donnée que s'il y a des notes",
    (statsPub.notes > 0) === (statsPub.note_moyenne !== null),
    "notes = " + statsPub.notes + ", moyenne = " + statsPub.note_moyenne);

  // Chaque rayon doit annoncer combien de ses ouvrages sont lus : c'est ce
  // que remplit la jauge de la mosaïque.
  verifier("statistiques : part lue fournie par rayon",
    statsPub.sous_categories.every(x => typeof x.lus === "number" && x.lus <= x.n),
    JSON.stringify(statsPub.sous_categories.find(x => typeof x.lus !== "number") ?? "—"));

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
  verifier("jeton falsifié : aucune élévation de droits",
    r.statut === 200 && r.corps.every(l => l.sphere === "Pro"), "statut " + r.statut);
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
  verifier("retour au périmètre public après déconnexion",
    r.statut === 200 && r.corps.every(l => l.sphere === "Pro"), "statut " + r.statut);
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
