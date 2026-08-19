/* =========================================================================
   LES MIGRATIONS SONT-ELLES REJOUABLES ? ON LES REJOUE.

   Chaque livraison applique TOUS les db/*.sql, y compris ceux qui sont déjà
   passés. Une migration non rejouable réussit donc la première fois et
   échoue la seconde — le pire des deux mondes : on la croit acquise, et
   elle bloque la livraison suivante sans rapport avec ce qu'on livrait.

   C'est arrivé le 15/08/2026, EN RECETTE, au deuxième déploiement :

     02-multi-locataire.sql:187: ERREUR : la nouvelle ligne viole la
     politique de sécurité au niveau ligne pour la table « resumes »

   La cause est toujours la même, et elle a trois visages dans ce projet :
   une migration, un garde-fou ou une sauvegarde qui s'exécute SOUS le
   cloisonnement qu'elle installe. « force row level security » soumet
   jusqu'au propriétaire des tables.

   ---------------------------------------------------------------------------
   CE QU'ON VÉRIFIE, ET POURQUOI TROIS PASSAGES

   Deux suffiraient à attraper le défaut ci-dessus. Le troisième attrape une
   autre famille : un fichier qui se « répare » tout seul au deuxième
   passage mais repart de travers au suivant. Trois est le premier nombre
   qui distingue « stable » de « alterné ».

   ET LE CLOISONNEMENT DOIT ÊTRE REMIS. Une migration qui lève les
   politiques pour travailler et oublie de les remettre laisserait
   l'application libre de tout lire — sans aucun message, et avec des
   contrôles au vert puisqu'ils regardent les données, pas les droits.

   USAGE
     node tests/test-rejeu.mjs
     PGURL=... PGURL_OEIL=... node tests/test-rejeu.mjs               (CI)
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const DB = ["db", path.join("..", "db")].find(c => fs.existsSync(path.join(c, "01-schema.sql")));
if (!DB) { console.error("  ECHEC db/ introuvable"); process.exit(1); }

const ok = [], ko = [];
const verifier = (nom, cond, detail) =>
  (cond ? ok : ko).push(nom + (cond ? "" : " — " + (detail ?? "")));

const FICHIERS = fs.readdirSync(DB).filter(f => f.endsWith(".sql")).sort();

/* --------------------------------------------------- Monter PostgreSQL */

let moteur = null, url = process.env.PGURL;
if (!url) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  moteur = new EmbeddedPostgres({
    databaseDir: fs.mkdtempSync("/tmp/biblio-rejeu-"),
    user: "postgres", password: "postgres", port: 55515, persistent: false,
  });
  await moteur.initialise();
  await moteur.start();
  const admin = new pg.Client({
    host: "127.0.0.1", port: 55515, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("create role biblio login password 'controle' nosuperuser nobypassrls");
  await admin.query("create database biblio owner biblio");
  await admin.end();
  url = "postgres://biblio:controle@127.0.0.1:55515/biblio";
}

const u = new URL(url);
const appli = new pg.Client({ connectionString: url });
await appli.connect();

const oeil = new pg.Client(process.env.PGURL_OEIL ?? {
  host: u.hostname, port: u.port, database: u.pathname.slice(1),
  user: "postgres", password: "postgres",
});
await oeil.connect();
const q = (t, p) => oeil.query(t, p).then(r => r.rows);

/* ---------------------------------------------------- L'état d'origine

   On sème dans « books » APRÈS 01 et AVANT 02 : c'est exactement l'ordre
   qu'a connu la production. Semer après 02 ne reproduirait pas le cas —
   les données seraient déjà rattachées à un locataire. */

await appli.query(fs.readFileSync(path.join(DB, "01-schema.sql"), "utf8"));

const poser = (id, isbn, sphere) => q(
  `insert into books (id,isbn,titre,auteur,categorie,sous_categorie,sphere,resume)
   values ($1,$2,'Titre '||$1,'Auteur','Savoirs','Philosophie',$3,'Résumé de '||$1)`,
  [id, isbn, sphere]);

/* TOUT EN « Perso », donc TOUT EN PRIVÉ. Ce n'est pas une bibliothèque
   représentative — c'est le cas qui PIÈGE.

   Mesuré le 15/08/2026 : avec des ouvrages publics dans le jeu d'essai,
   retirer la levée des politiques devant le garde-fou de 03 ne faisait
   tomber aucun contrôle. La raison est instructive : la politique de
   lecture laisse voir les possessions PUBLIQUES même sans locataire posé.
   Le garde-fou apercevait donc quelques lignes, concluait « déjà rempli »,
   et le défaut restait invisible.

   Une bibliothèque entièrement privée — celle d'un invité qui n'a rien
   publié — ne lui montre rien du tout. Il conclurait alors que la table
   est vide et relancerait la reprise sur une base déjà migrée.

   Le cas le plus fermé est celui qui éprouve le mieux. */
await poser("r1", "9781111111111", "Perso");
await poser("r2", "9782222222222", "Perso");
await poser("r3", "978ASINBIDON1", "Perso");   // ASIN déguisé
const AVANT = (await q("select count(*)::int n from books"))[0].n;

/* ------------------------------------------------------- Trois passages */

const etat = async () => ({
  possessions: (await q("select count(*)::int n from possessions"))[0].n,
  ouvrages:    (await q("select count(*)::int n from ouvrages"))[0].n,
  resumes:     (await q("select count(*)::int n from resumes_ouvrages"))[0].n,
  /* Les tables qui DOIVENT être sous « force » à la fin. On lit pg_class,
     pas les données : une migration peut laisser les bonnes lignes et les
     mauvais droits, et aucun contrôle de contenu ne le verrait. */
  forcees: (await q(
    `select count(*)::int n from pg_class
      where relname in ('books','resumes','possessions','ouvrages',
                        'resumes_ouvrages','rayons_ajoutes','rayons_reglages',
                        'reading_quests','tenants','appels_ia')
        and relrowsecurity and relforcerowsecurity`))[0].n,
});

const passages = [];
for (const tour of [1, 2, 3]) {
  let echec = null;
  for (const f of FICHIERS) {
    try { await appli.query(fs.readFileSync(path.join(DB, f), "utf8")); }
    catch (e) { echec = `${f} : ${e.message}`; break; }
  }
  verifier(`passage ${tour} : toutes les migrations s'appliquent`, echec === null, echec);
  if (echec) break;
  passages.push(await etat());
}

if (passages.length === 3) {
  const [p1, p2, p3] = passages;

  verifier("rien ne se perd au premier passage",
    p1.possessions === AVANT, `${p1.possessions} au lieu de ${AVANT}`);

  verifier("rejouer ne duplique ni ne perd rien",
    JSON.stringify(p1) === JSON.stringify(p2) &&
    JSON.stringify(p2) === JSON.stringify(p3),
    JSON.stringify(passages));

  verifier("les trois ouvrages privés survivent aux trois passages",
    (await q("select id from possessions order by id")).length === 3,
    JSON.stringify(await q("select id from possessions order by id")));

  verifier("aucun n'est devenu public au passage",
    (await q("select id from possessions where visibilite <> 'privee'")).length === 0,
    JSON.stringify(await q("select id, visibilite from possessions")));

  verifier("l'ASIN déguisé n'a pas été mutualisé",
    (await q("select cle from ouvrages where cle like 'local:%'")).length === 1,
    JSON.stringify(await q("select cle from ouvrages order by cle")));

  /* LE CONTRÔLE QUI NE REGARDE PAS LES DONNÉES.
     Une migration qui lève les politiques pour travailler et oublie de les
     remettre laisse l'application libre de tout lire. Les comptes ci-dessus
     seraient identiques, et rien ne le signalerait. */
  verifier("les dix tables sont sous « force row level security »",
    p3.forcees === 10, `${p3.forcees} tables sur 10`);

  /* ------------------------------------------------ UN CONTRÔLE DE FORME,
     et je préfère dire pourquoi plutôt que laisser croire à mieux.

     Les deux défauts de rejouabilité demandent des jeux de données QUI
     S'EXCLUENT :

       — le garde-fou aveugle de 03 ne se manifeste que si AUCUNE possession
         n'est visible sans locataire, donc si tout est privé ;
       — l'échec d'écriture de 02 ne se manifeste que si AU MOINS UN ouvrage
         public porte un résumé — sinon son « select » source est vide et il
         n'insère rien, donc ne viole rien.

     Aucune base ne peut satisfaire les deux à la fois. Le jeu ci-dessus est
     tout-privé, il éprouve donc 03 par le comportement. Pour 02, on vérifie
     la PRÉSENCE de la levée dans le fichier — c'est plus faible, et c'est
     dit. La preuve par le comportement, elle, a eu lieu une fois : en
     recette, le 15/08/2026, sur la vraie bibliothèque. */
  /* LA LISTE ÉCRITE À LA MAIN A DISPARU — 18/08/2026.
   *
   * Ces trois fichiers étaient nommés un par un. Le contrôle vérifiait donc
   * exactement ce que quelqu'un avait pensé à y inscrire, et 05-usage-ia.sql
   * est arrivé sans que rien ne s'en aperçoive. Une migration future qui
   * écrirait sans lever les politiques ne ferait tomber aucune vérification :
   * elle n'écrirait rien, en silence, et la livraison passerait au vert.
   *
   * C'est le troisième exemplaire du même défaut cette semaine — après le
   * garde-fou RLS de SupPerf qui comparait le schéma à une liste, et la liste
   * de migrations du banc d'essai. On dérive donc la règle du CONTENU.
   *
   * DEUX RÈGLES, ET AUCUNE EXCEPTION À DÉCLARER :
   *
   *   ① qui écrit doit lever. Sous « force row level security », une migration
   *     qui insère sans lever n'échoue pas : la ligne sort du périmètre et
   *     PostgreSQL rapporte zéro ligne touchée.
   *   ② qui lève doit remettre. C'est le cas grave — les données restent
   *     intactes, les contrôles de contenu au vert, et l'application lit tout.
   *
   * CE QU'ON RETIRE AVANT DE CHERCHER, et pourquoi chaque retrait compte :
   * les commentaires (ces fichiers en sont pleins, en français, et le mot
   * « update » y apparaît), et LES CORPS DE FONCTION — « as $$ … $$ ». Le
   * corps de « consommer_appel_ia » contient un « insert into » qui ne
   * s'exécute PAS au moment de la migration ; le compter exigerait une levée
   * inutile de 04 et 05, et un contrôle qui réclame l'inutile finit désactivé.
   * Les blocs « do $$ … $$ », eux, s'exécutent : on les garde. */
  const sansCommentaires = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  for (const fichier of FICHIERS) {
    const brut = fs.readFileSync(path.join(DB, fichier), "utf8");
    const propre = sansCommentaires(brut);
    const executable = propre.replace(/\bas\s+\$\$[\s\S]*?\$\$/gi, "");

    const ecrit  = /\b(insert\s+into|update\s+public\.|delete\s+from)/i.test(executable);
    const leve   = /no\s+force\s+row\s+level\s+security/i.test(propre);
    const remet  = /(?<!no\s)force\s+row\s+level\s+security/i.test(propre);

    if (ecrit) {
      verifier(`${fichier} écrit, donc lève les politiques`, leve,
        "des écritures sans levée : elles ne toucheront aucune ligne, en silence");
    }
    if (leve) {
      verifier(`${fichier} lève les politiques, donc les remet`, remet,
        "levée sans remise : l'application lirait tout, et rien ne le dirait");
    }
    if (!ecrit && !leve) {
      verifier(`${fichier} n'écrit rien, donc n'a rien à lever`, true);
    }
  }

  const ouvertes = await q(
    `select relname from pg_class
      where relname in ('books','resumes','possessions','ouvrages',
                        'resumes_ouvrages','rayons_ajoutes','rayons_reglages',
                        'reading_quests','tenants','appels_ia')
        and not (relrowsecurity and relforcerowsecurity)
      order by relname`);
  verifier("aucune table n'est restée ouverte au propriétaire",
    ouvertes.length === 0, JSON.stringify(ouvertes.map(r => r.relname)));
}

/* --------------------------------------------------------------- Bilan */

await appli.end(); await oeil.end();
if (moteur) await moteur.stop();

console.log("\n=== Rejeu des migrations ===\n");
ok.forEach(o => console.log("  ok   " + o));
if (ko.length) {
  console.log("");
  ko.forEach(e => console.log("  KO   " + e));
  console.log(`\n${ko.length} échec(s) sur ${ok.length + ko.length}.`);
  process.exit(1);
}
console.log(`\n${ok.length} vérifications, aucune erreur.`);
