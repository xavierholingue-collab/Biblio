/* =========================================================================
   Monte la pile complète — base, schéma, API — sans Docker ni service
   installé, puis lance les vérifications de test-api.mjs.

   POURQUOI
   Jusqu'ici, les 48 vérifications de l'API ne pouvaient tourner qu'à deux
   endroits : sur le poste avec Docker, ou dans GitHub Actions. Entre les
   deux, une modification de requête SQL partait sans avoir jamais rencontré
   PostgreSQL. Le 04/08/2026, un ajout de colonne calculée a été poussé sur
   la seule foi de sa syntaxe JavaScript — le contrôle a bien eu lieu, mais
   après coup, dans la chaîne de livraison.

   COMMENT
   PGlite est PostgreSQL compilé en WebAssembly : il s'installe par npm, sans
   droits d'administration, et parle le vrai protocole. pglite-socket l'expose
   sur un port TCP, si bien que le client « pg » de l'API s'y connecte sans
   savoir que la base n'est pas un serveur ordinaire.

   CE QUE CETTE PILE NE PROUVE PAS — à lire avant de s'y fier

   1. La VERSION. PGlite suit la branche PostgreSQL 18, la production tourne
      en 17. Les requêtes de cette application n'utilisent rien qui diffère
      entre les deux, mais la garantie de version reste celle de GitHub
      Actions, qui monte un postgres:17-alpine.

   2. La CONCURRENCE. PGlite n'accepte qu'une connexion à la fois : au-delà,
      il ferme le canal et « pg » signale « Connection terminated
      unexpectedly ». Le pool est donc bridé à une connexion (PGMAX=1), ce
      qui sérialise les requêtes. Tout défaut ne se manifestant que sous
      plusieurs connexions simultanées — interblocage, épuisement du pool,
      transaction concurrente — passera ici sans être vu.

   Cette pile sert à ne pas partir à l'aveugle. Elle ne remplace pas l'étage
   de contrôle de la chaîne de livraison.

   USAGE
     npm install @electric-sql/pglite @electric-sql/pglite-socket
     node tests/pile-locale.mjs
   ========================================================================= */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const RACINE = trouverRacine();
const PORT_BASE = Number(process.env.PORT_BASE ?? 55432);
const PORT_API  = Number(process.env.PORT_API  ?? 3999);
const MOT_DE_PASSE = "mot-de-passe-de-controle";

function trouverRacine() {
  // Le script doit fonctionner qu'il soit lancé depuis docker/, depuis la
  // racine du dépôt, ou depuis tests/ — même leçon qu'avec test-fumee.js.
  const ici = path.dirname(new URL(import.meta.url).pathname);
  for (const c of [path.join(ici, ".."), process.cwd(), path.join(ici, "..", "..")]) {
    if (fs.existsSync(path.join(c, "api", "server.js"))) return c;
  }
  console.error("api/server.js introuvable depuis " + ici);
  process.exit(1);
}

const chemin = (...p) => path.join(RACINE, ...p);
const attendre = ms => new Promise(r => setTimeout(r, ms));

let serveurBase = null, api = null;

async function arreter(code) {
  if (api && !api.killed) api.kill("SIGTERM");
  if (serveurBase) { try { await serveurBase.stop(); } catch { /* déjà fermé */ } }
  await attendre(150);
  process.exit(code);
}
process.on("SIGINT", () => arreter(130));

(async () => {
  console.log("== Pile locale ==\n");

  /* -------------------------------------------------------- 1. La base --- */
  const db = await PGlite.create();
  const v = await db.query("select version()");
  console.log("  OK   " + v.rows[0].version.split(",")[0]);

  const schema = chemin("db", "01-schema.sql");
  if (!fs.existsSync(schema)) { console.error("  ECHEC db/01-schema.sql absent"); await arreter(1); }
  await db.exec(fs.readFileSync(schema, "utf8"));
  console.log("  OK   schéma appliqué");

  serveurBase = new PGLiteSocketServer({ db, port: PORT_BASE, host: "127.0.0.1" });
  await serveurBase.start();
  console.log("  OK   base exposée sur 127.0.0.1:" + PORT_BASE);

  /* --------------------------------------------------------- 2. L'API --- */
  const amorce = chemin("tests", "amorce-controle.json");
  if (!fs.existsSync(amorce)) { console.error("  ECHEC tests/amorce-controle.json absent"); await arreter(1); }

  api = spawn(process.execPath, [chemin("api", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT_API),
      PGHOST: "127.0.0.1", PGPORT: String(PORT_BASE),
      PGUSER: "postgres", PGPASSWORD: "", PGDATABASE: "postgres",
      // Une seule connexion : voir l'avertissement en tête de fichier.
      PGMAX: "1",
      MOT_DE_PASSE,
      // Aucune clef : les routes qui coûtent doivent refuser proprement,
      // et c'est ce que les vérifications attendent.
      ANTHROPIC_API_KEY: "",
      FICHIER_AMORCE: amorce,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const journal = [];
  api.stdout.on("data", d => journal.push(String(d)));
  api.stderr.on("data", d => journal.push(String(d)));
  api.on("exit", c => { if (c !== null && c !== 0) journal.push("\nl'API s'est arrêtée, code " + c); });

  let debout = false;
  for (let i = 0; i < 40 && !debout; i++) {
    await attendre(250);
    try { debout = (await fetch(`http://127.0.0.1:${PORT_API}/api/session`)).ok; } catch { /* pas encore */ }
  }
  if (!debout) {
    console.error("  ECHEC l'API n'a pas démarré. Journal :");
    console.error(journal.join("").split("\n").map(l => "         " + l).join("\n"));
    await arreter(1);
  }
  console.log("  OK   API sur http://127.0.0.1:" + PORT_API + "\n");

  /* ------------------------------------------------ 3. Les vérifications - */
  const test = spawn(process.execPath, [chemin("api", "test-api.mjs")], {
    env: { ...process.env, BASE: `http://127.0.0.1:${PORT_API}`, MOT_DE_PASSE },
    stdio: "inherit",
  });
  test.on("exit", async code => {
    if (code !== 0 && journal.length) {
      console.error("\n-- Journal de l'API --");
      console.error(journal.join("").split("\n").slice(-25).map(l => "   " + l).join("\n"));
    }
    await arreter(code ?? 1);
  });
})().catch(async e => {
  console.error("  ECHEC " + (e?.stack ?? e));
  await arreter(1);
});
