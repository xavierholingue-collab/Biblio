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

/* LA LISTE N'EST PLUS ÉCRITE À LA MAIN.
 *
 * Elle l'était, et il a suffi d'ajouter 04-reglages.sql pour que le banc
 * d'essai éprouve une base DIFFÉRENTE de celle qu'on livre — sans la moindre
 * erreur, simplement en ignorant un fichier. Les contrôles auraient été verts
 * sur un schéma qui n'existe nulle part.
 *
 * On lit donc le dossier, comme le fait le déployeur. Le seul contrat est
 * l'ordre alphabétique, qui est déjà celui des numéros. */
const fichiersMigration = (dossier) =>
  fs.readdirSync(dossier).filter(f => f.endsWith(".sql")).sort();

/* « jusqua » — s'arrêter avant une migration, pour éprouver ce qu'elle fait
 *
 * Le rejeu vérifie qu'une migration peut être appliquée deux fois. Il ne
 * vérifie pas qu'elle DÉPLACE CORRECTEMENT LES DONNÉES EXISTANTES : au banc,
 * tout est appliqué d'un bloc sur une base vide, si bien qu'une reprise qui
 * ne reprend rien passe au vert.
 *
 * Ce n'est pas théorique. La migration 17 déplace le statut de lecture et la
 * note de 348 ouvrages réels. Une reprise silencieusement vide les rendrait
 * tous « à lire », sans erreur, et on ne s'en apercevrait qu'en regardant.
 *
 * On peut donc monter la base À L'ÉTAT D'AVANT, y semer des données, puis
 * appliquer la suite — c'est-à-dire reproduire ce que le serveur vivra.
 */
export async function ouvrirBanc({ port = 55501, jusqua = null } = {}) {
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
  const toutes = fichiersMigration(DB);
  const posees = jusqua ? toutes.filter(f => f < jusqua) : toutes;
  if (jusqua && posees.length === toutes.length) {
    throw new Error(
      `ouvrirBanc({ jusqua: "${jusqua}" }) : aucune migration n'a été écartée. `
      + `Le contrôle croirait éprouver une reprise et ne l'éprouverait pas.`);
  }

  /* LA BASE DOIT ÊTRE VIERGE POUR ÉPROUVER UNE REPRISE — 05/09/2026.
   *
   * Sans PGURL, chaque appel monte SON PostgreSQL dans un dossier neuf :
   * deux « ouvrirBanc » dans le même fichier sont donc isolés. Avec PGURL —
   * c'est-à-dire dans la chaîne de livraison — ils partagent la MÊME base.
   *
   * « test-sieges.mjs » appelait « ouvrirBanc() » puis
   * « ouvrirBanc({ jusqua }) ». En local, le second repartait de zéro et le
   * contrôle passait. En intégration, il rejouait 01→18 sur une base où la
   * 17 avait déjà supprimé « possessions.statut » — et la reprise de 03
   * échouait sur une colonne absente.
   *
   * L'isolation était une SUPPOSITION, vraie sur mon poste et fausse là où
   * ça compte. On la vérifie donc, plutôt que d'y compter : un fichier qui
   * éprouve une reprise doit avoir sa propre base, donc sa propre ligne
   * « lancer » dans la chaîne. */
  if (jusqua) {
    const { rows } = await appli.query(
      "select to_regclass('public.tenants') is not null as deja");
    if (rows[0].deja) {
      throw new Error(
        `ouvrirBanc({ jusqua: "${jusqua}" }) : la base porte déjà un schéma. `
        + `Une reprise ne s'éprouve que sur une base vierge — donnez à ce `
        + `fichier sa propre base (sa propre ligne « lancer »), ou ne faites `
        + `qu'un seul ouvrirBanc par fichier.`);
    }
  }
  for (const f of posees) {
    await appli.query(fs.readFileSync(path.join(DB, f), "utf8"));
  }

  /* Appliquer la suite, une fois les données d'avant semées. */
  const appliquerLaSuite = async () => {
    for (const f of toutes.filter(f => !posees.includes(f))) {
      await appli.query(fs.readFileSync(path.join(DB, f), "utf8"));
    }
  };

  const oeil = new pg.Client(process.env.PGURL_OEIL ?? {
    host: u.hostname, port: u.port, database: u.pathname.slice(1),
    user: "postgres", password: "postgres",
  });
  await oeil.connect();

  const q = (texte, params) => oeil.query(texte, params).then(r => r.rows);

  /* Une requête vue par l'application, avec un locataire posé — ou aucun,
     ce qui est le cas du visiteur anonyme. Transaction-local, comme
     avecContexte() : le réglage ne survit pas au COMMIT. */
  /* DEUX FORMES, comme avecContexte() — 05/09/2026.
   *
   *   dans(uuid, texte)                     le locataire seul
   *   dans({ locataire, compte }, texte)    et l'identité qui agit
   *
   * La seconde est née avec les bibliothèques à plusieurs membres :
   * « supprimer_locataire » demande maintenant QUI le demande, pas seulement
   * OÙ. Garder la première forme évite de réécrire les dizaines d'appels qui
   * n'ont que faire de l'identité — et le banc reste le miroir exact de ce
   * que fait l'application. */
  const dans = async (qui, texte, params) => {
    const objet  = qui !== null && typeof qui === "object";
    const tenant = objet ? (qui.locataire ?? null) : qui;
    const compte = objet ? (qui.compte ?? null)    : null;
    await appli.query("begin");
    await appli.query("select set_config('app.tenant_id', $1, true)", [tenant ?? ""]);
    await appli.query("select set_config('app.compte_id', $1, true)", [compte ?? ""]);
    try { return (await appli.query(texte, params)).rows; }
    finally { await appli.query("commit").catch(() => appli.query("rollback")); }
  };

  /* Semer directement en base, par l'observateur : le catalogue puis la
     possession, dans cet ordre. Les contrôles décrivent ce qu'ils veulent
     éprouver, pas la mécanique d'insertion. */
  /* « statut » ET « note » ONT QUITTÉ LA POSSESSION — 05/09/2026.
   *
   * Ils vivent dans « lectures », attachés à une personne : dans une
   * bibliothèque partagée, marquer un ouvrage « Lu » le marquait pour toute
   * l'équipe. Le banc les accepte encore, mais il faut alors lui dire POUR
   * QUI — « lecteur ». Sans lecteur, aucune ligne de lecture n'est posée, et
   * l'ouvrage est « A lire » pour tout le monde : c'est la vérité, pas un
   * pis-aller.
   *
   * Passer « statut » sans « lecteur » serait en revanche une demande qu'on
   * ne peut pas satisfaire — on le dit plutôt que de l'ignorer. Un contrôle
   * qui croit avoir semé un « Lu » et n'en a pas semé mesurerait autre chose
   * que ce qu'il annonce. */
  const semer = async ({ tenant, id, isbn = null, titre = "Titre " + id,
                         auteur = "Auteur", categorie = "Savoirs",
                         sous_categorie = "Philosophie", sphere = "Pro",
                         visibilite = "heritee", statut = null,
                         note = null, annee = null, pages = null,
                         lecteur = null }) => {
    if ((statut !== null || note !== null) && !lecteur) {
      throw new Error(
        `semer(${id}) : « statut » ou « note » sans « lecteur ». Depuis la `
        + `migration 17 une lecture appartient à quelqu'un.`);
    }
    const propre = String(isbn ?? "").replace(/[^0-9Xx]/g, "");
    const valide = propre.length === 13 ? propre : null;
    const cle = valide ? `isbn:${valide}` : `local:${tenant}:${id}`;
    const [o] = await q(
      `insert into ouvrages (cle, isbn, titre, auteur, annee, pages)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (cle) do update set cle = excluded.cle
       returning id`, [cle, valide, titre, auteur, annee, pages]);
    await q(
      `insert into possessions (tenant_id, id, ouvrage_id,
                                categorie, sous_categorie, sphere, visibilite)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [tenant, id, o.id, categorie, sous_categorie, sphere, visibilite]);

    if (lecteur) {
      await q(
        `insert into lectures (tenant_id, possession, compte_id, statut, note)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, possession, compte_id) do update
            set statut = excluded.statut, note = excluded.note`,
        [tenant, id, lecteur, statut ?? "A lire", note]);
    }
    return o.id;
  };

  /* Poser une lecture après coup — le cas courant quand le compte n'existe
     pas encore au moment où l'on sème l'étagère. */
  const lire = (tenant, possession, compte, statut = "Lu", note = null) => q(
    `insert into lectures (tenant_id, possession, compte_id, statut, note)
     values ($1,$2,$3,$4,$5)
     on conflict (tenant_id, possession, compte_id) do update
        set statut = excluded.statut, note = excluded.note`,
    [tenant, possession, compte, statut, note]);

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

  /* Semé par l'OBSERVATEUR, qui est superutilisateur — donc au-dessus de la
     politique « tenants_reglages » posée par 04. C'est voulu : créer un
     locataire est un geste d'administration, et le banc doit pouvoir en
     fabriquer deux pour éprouver qu'ils ne se voient pas.

     « quota » est bas par défaut. Un plafond à 100 000, comme celui de la
     production, rendrait tout contrôle de quota irréalisable en pratique. */
  const locataire = async (identifiant, visibilite = "privee", langue = "fr",
                           quota = 3) => {
    const [t] = await q(
      `insert into tenants (identifiant, nom, visibilite, langue, quota_ia_mois)
       values ($1,$1,$2,$3,$4)
       on conflict (identifiant) do update
          set visibilite = excluded.visibilite, quota_ia_mois = excluded.quota_ia_mois
       returning id`, [identifiant, visibilite, langue, quota]);
    return t.id;
  };

  /* Un compte ET son appartenance — 05/09/2026.
   *
   * Les contrôles écrivaient « insert into comptes (tenant_id, courriel) » à
   * dix endroits. La migration 15 a retiré cette colonne : l'appartenance vit
   * dans « membres ». Dix corrections identiques auraient été dix occasions
   * d'en oublier une, et la onzième serait écrite à la main le mois prochain.
   *
   * « proprietaire » par défaut, parce que c'est ce qu'un compte d'essai est
   * presque toujours — celui qui a créé la bibliothèque. Les contrôles qui
   * éprouvent un simple membre le disent explicitement. */
  const compte = async (tenant, courriel, role = "proprietaire") => {
    const [c] = await q(
      "insert into comptes (courriel) values ($1) returning id", [courriel]);
    await q(`insert into membres (compte_id, tenant_id, role, vu_le)
             values ($1, $2, $3, now())`, [c.id, tenant, role]);
    return c.id;
  };

  const fermer = async () => {
    await appli.end().catch(() => {});
    await oeil.end().catch(() => {});
    if (moteur) await moteur.stop().catch(() => {});
  };

  return { url, u, appli, oeil, q, dans, semer, lire, resumer, locataire, compte,
           appliquerLaSuite, fermer,
           env: {
             PGHOST: u.hostname, PGPORT: u.port,
             PGUSER: decodeURIComponent(u.username),
             PGPASSWORD: decodeURIComponent(u.password),
             PGDATABASE: u.pathname.slice(1),
           } };
}
