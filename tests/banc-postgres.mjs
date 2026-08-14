/* =========================================================================
   LE BANC D'ESSAI COMMUN — un vrai PostgreSQL, deux comptes distincts

   Quatre fichiers de contrôle montaient chacun leur propre pile. Une seule
   d'entre elles était juste ; les autres se sont trompées de la même façon,
   à quelques jours d'intervalle. Mieux vaut une erreur commune, visible et
   corrigée une fois, que quatre variantes qui divergent en silence.

   ---------------------------------------------------------------------------
   DEUX COMPTES, ET C'EST LA RAISON D'ÊTRE DE CE FICHIER

     appli — ce dont l'API se sert. Propriétaire des tables, NI
             superutilisateur NI BYPASSRLS. « force row level security » le
             soumet aux politiques : c'est exactement la production.

     oeil  — l'observateur. Privilégié, sur SA PROPRE CONNEXION. Il doit voir
             ce que la base contient réellement, sinon il ne peut pas
             distinguer « la ligne a été protégée » de « je ne la vois pas ».

   POURQUOI PAS PGlite, qui serait plus léger. Il n'a qu'UNE session : celle
   du pont réseau et celle de l'observateur sont la même. Quand le sujet
   change de rôle, l'observateur change avec lui — et le contrôle finit par
   mesurer sa propre cécité. Constaté le 15/08/2026 : deux vérifications
   d'effacement passaient au vert alors qu'elles ne regardaient rien.

   USAGE
     const banc = await ouvrirBanc();
     await banc.q("select ...");         // l'observateur
     await banc.dans(tenantId, "...");   // l'application, locataire posé
     await banc.fermer();
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const FICHIERS = ["01-schema.sql", "02-multi-locataire.sql", "03-catalogue.sql"];

export async function ouvrirBanc({ port = 55501 } = {}) {
  const DB = ["db", path.join("..", "db")]
    .find(c => fs.existsSync(path.join(c, "01-schema.sql")));
  if (!DB) throw new Error("db/ introuvable");

  let moteur = null, url = process.env.PGURL;

  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    moteur = new EmbeddedPostgres({
      databaseDir: fs.mkdtempSync("/tmp/biblio-banc-"),
      user: "postgres", password: "postgres", port, persistent: false,
    });
    await moteur.initialise();
    await moteur.start();

    /* « biblio » comme en production : propriétaire, et rien de plus. Le
       laisser superutilisateur — ce qu'est le compte créé par initdb —
       ferait passer tous les contrôles de cloisonnement au vert. */
    const admin = new pg.Client({
      host: "127.0.0.1", port, user: "postgres", password: "postgres",
      database: "postgres" });
    await admin.connect();
    await admin.query(
      "create role biblio login password 'controle' nosuperuser nobypassrls");
    await admin.query("create database biblio owner biblio");
    await admin.end();
    url = `postgres://biblio:controle@127.0.0.1:${port}/biblio`;
  }

  const u = new URL(url);
  const appli = new pg.Client({ connectionString: url });
  await appli.connect();

  /* Le schéma est appliqué PAR le compte applicatif : il devient donc
     propriétaire des tables, comme sur le serveur. Appliqué par un
     superutilisateur, les tables appartiendraient à quelqu'un d'autre et
     « force row level security » ne porterait pas sur le même rôle. */
  for (const f of FICHIERS) {
    await appli.query(fs.readFileSync(path.join(DB, f), "utf8"));
  }

  const oeil = new pg.Client(process.env.PGURL_OEIL ?? {
    host: u.hostname, port: u.port, database: u.pathname.slice(1),
    user: "postgres", password: "postgres",
  });
  await oeil.connect();

  const q = (texte, params) => oeil.query(texte, params).then(r => r.rows);

  /* Une requête vue par l'application, avec un locataire posé — ou aucun,
     ce qui est le cas du visiteur anonyme. Transaction-local, comme
     avecContexte() : le réglage ne survit pas au COMMIT. */
  const dans = async (tenant, texte, params) => {
    await appli.query("begin");
    await appli.query("select set_config('app.tenant_id', $1, true)", [tenant ?? ""]);
    try { return (await appli.query(texte, params)).rows; }
    finally { await appli.query("commit").catch(() => appli.query("rollback")); }
  };

  /* Semer directement en base, par l'observateur : le catalogue puis la
     possession, dans cet ordre. Les contrôles décrivent ce qu'ils veulent
     éprouver, pas la mécanique d'insertion. */
  const semer = async ({ tenant, id, isbn = null, titre = "Titre " + id,
                         auteur = "Auteur", categorie = "Académique",
                         sous_categorie = "Philosophie", sphere = "Pro",
                         visibilite = "heritee", statut = "A lire",
                         note = null, annee = null, pages = null }) => {
    const propre = String(isbn ?? "").replace(/[^0-9Xx]/g, "");
    const valide = propre.length === 13 ? propre : null;
    const cle = valide ? `isbn:${valide}` : `local:${tenant}:${id}`;
    const [o] = await q(
      `insert into ouvrages (cle, isbn, titre, auteur, annee, pages)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (cle) do update set cle = excluded.cle
       returning id`, [cle, valide, titre, auteur, annee, pages]);
    await q(
      `insert into possessions (tenant_id, id, ouvrage_id, statut, note,
                                categorie, sous_categorie, sphere, visibilite)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenant, id, o.id, statut, note, categorie, sous_categorie, sphere, visibilite]);
    return o.id;
  };

  /* points et themes suivent la langue : sans eux, un contrôle qui vérifie
     « les points suivent la langue demandée » lirait null des deux côtés et
     ne prouverait rien. */
  const resumer = (ouvrageId, langue, resume, points, themes) => q(
    `insert into resumes_ouvrages (ouvrage_id, langue, resume, points, themes,
                                   modele, fiabilite)
     values ($1,$2,$3,$4,$5,'modele-de-controle','haute')
     on conflict (ouvrage_id, langue) do update
        set resume = excluded.resume, points = excluded.points,
            themes = excluded.themes`,
    [ouvrageId, langue, resume,
     points ?? [`point ${langue}`], themes ?? [`theme-${langue}`]]);

  const locataire = async (identifiant, visibilite = "privee", langue = "fr") => {
    const [t] = await q(
      `insert into tenants (identifiant, nom, visibilite, langue)
       values ($1,$1,$2,$3)
       on conflict (identifiant) do update set visibilite = excluded.visibilite
       returning id`, [identifiant, visibilite, langue]);
    return t.id;
  };

  const fermer = async () => {
    await appli.end().catch(() => {});
    await oeil.end().catch(() => {});
    if (moteur) await moteur.stop().catch(() => {});
  };

  return { url, u, appli, oeil, q, dans, semer, resumer, locataire, fermer,
           env: {
             PGHOST: u.hostname, PGPORT: u.port,
             PGUSER: decodeURIComponent(u.username),
             PGPASSWORD: decodeURIComponent(u.password),
             PGDATABASE: u.pathname.slice(1),
           } };
}
