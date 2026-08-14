#!/usr/bin/env bash
# =========================================================================
# LE SEUL PROGRAMME QUE LA CLEF BIBLIO PEUT LANCER.
#
# Installe en /usr/local/bin/deployer-biblio, appele par la directive
# command= de authorized_keys. Quoi que GitHub envoie, c'est CE script qui
# s'execute ; la commande demandee arrive dans SSH_ORIGINAL_COMMAND, ou
# elle est comparee a une liste fermee — jamais interpretee.
#
# Cette clef est DISTINCTE de celle de Y-Factor. Si l'une fuit, elle
# n'ouvre pas l'autre : c'est tout l'interet d'en avoir deux.
# =========================================================================

set -uo pipefail

JOURNAL=/var/log/deploiement-biblio.log

tracer() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "${JOURNAL}"; }

demande="${SSH_ORIGINAL_COMMAND:-}"
tracer "demande=[${demande}] depuis=${SSH_CLIENT%% *}"

# =========================================================================
# DEUX ENVIRONNEMENTS, UN SEUL SCRIPT.
#
# Tout est prefixe : base, service, port, racines, fichier d'environnement,
# politique de contenu. Rien n'est partage entre les deux — c'est la
# condition pour qu'une betise en recette ne puisse pas atteindre la
# production.
#
# La liste des commandes reste FERMEE : ce qui n'y figure pas est refuse
# sans etre interprete. La clef de deploiement ne peut lancer que ceci.
# =========================================================================
case "${demande}" in
  "deployer biblio")
      ENVIRONNEMENT=production
      ENVF=/etc/biblio/env
      RACINE_API=/opt/biblio-api
      RACINE_WEB=/var/www/biblio
      SERVICE=biblio-api
      BASE=biblio
      PORT=3006
      CSP_FICHIER=/etc/caddy/csp-biblio.conf
      ;;
  "deployer biblio-recette")
      ENVIRONNEMENT=recette
      ENVF=/etc/biblio-recette/env
      RACINE_API=/opt/biblio-recette-api
      RACINE_WEB=/var/www/biblio-recette
      SERVICE=biblio-recette-api
      BASE=biblio_recette
      PORT=3007
      CSP_FICHIER=/etc/caddy/csp-biblio-recette.conf
      ;;
  "sante")
      for s in biblio-api biblio-recette-api; do
        systemctl is-active "${s}" >/dev/null \
          && echo "${s}:active" || echo "${s}:inactive"
      done
      exit 0 ;;
  *)
      tracer "REFUSE"
      echo "Commande non autorisee." >&2
      exit 1 ;;
esac

[ -f "${ENVF}" ] || {
  echo "  ECHEC ${ENVF} absent — environnement ${ENVIRONNEMENT} non installe."
  echo "        lancez d'abord vps-installer-recette-biblio.sh"
  exit 1
}

TRAVAIL=$(mktemp -d); chmod 700 "${TRAVAIL}"
trap 'rm -rf "${TRAVAIL}"' EXIT INT TERM

echo "== Deploiement de Biblio — ${ENVIRONNEMENT} =="

# --- Reception -------------------------------------------------------------
cat > "${TRAVAIL}/paquet.tar.gz"
taille=$(stat -c %s "${TRAVAIL}/paquet.tar.gz")
[ "${taille}" -gt 1000 ] || { echo "  ECHEC archive vide ou tronquee (${taille} octets)"; exit 1; }
echo "  archive recue : $((taille / 1024)) ko"

tar -tzf "${TRAVAIL}/paquet.tar.gz" >/dev/null 2>&1 || { echo "  ECHEC archive illisible"; exit 1; }
mkdir -p "${TRAVAIL}/contenu"
tar -xzf "${TRAVAIL}/paquet.tar.gz" -C "${TRAVAIL}/contenu" || { echo "  ECHEC extraction"; exit 1; }

for attendu in api/server.js api/package.json api/locataire.mjs web/index.html \
               db/01-schema.sql db/02-multi-locataire.sql db/03-catalogue.sql \
               deploiement/calculer-csp.mjs deploiement/verifier-migration.sql; do
  [ -f "${TRAVAIL}/contenu/${attendu}" ] \
    || { echo "  ECHEC fichier attendu absent : ${attendu}"; exit 1; }
done
echo "  contenu conforme"

# --- Sauvegarde de la version en place --------------------------------------
rm -rf "${RACINE_API}.precedent" "${RACINE_WEB}.precedent"
[ -f "${RACINE_API}/server.js" ] && cp -a "${RACINE_API}" "${RACINE_API}.precedent"
[ -d "${RACINE_WEB}" ] && cp -a "${RACINE_WEB}" "${RACINE_WEB}.precedent"
echo "  version precedente conservee"

# --- Le secret de session, POSE UNE FOIS ET JAMAIS REGENERE -----------------
#
# Depuis le 15/08/2026 l'API refuse de demarrer sans SECRET_SESSION derriere
# un proxy. On le fabrique s'il manque — et SEULEMENT s'il manque.
#
# Le « seulement » est tout le sujet. Le 12/08/2026, poser-cle-biblio.sh
# regenerait la clef SSH a chaque passage et cassait le deploiement. Un
# script qui refabrique un secret qu'il devait conserver ne se signale pas :
# tout continue de fonctionner, et l'effet — ici, tout le monde deconnecte —
# passe pour un alea.
URL=$(sed -n 's/^PGPASSWORD=//p' "${ENVF}")
if ! grep -q '^SECRET_SESSION=' "${ENVF}" 2>/dev/null; then
  printf 'SECRET_SESSION=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> "${ENVF}"
  chmod 600 "${ENVF}"
  echo "  SECRET_SESSION cree (premiere fois — les sessions en cours tombent)"
else
  echo "  SECRET_SESSION deja en place, conserve"
fi

# --- Le schema, AVANT le code -----------------------------------------------
#
# TOUS les fichiers db/*.sql, dans l'ordre des noms. Une premiere version
# n'appliquait que 01-schema.sql ; 02-multi-locataire.sql serait donc reste
# a quai, et l'API — qui exige desormais le locataire par defaut — aurait
# refuse de demarrer apres une livraison verte.
#
# SAUVEGARDE D'ABORD, et ce n'est pas une precaution de principe.
# 01-schema.sql est additif et idempotent : le rejouer ne coute rien.
# 02-multi-locataire.sql ne l'est pas — il ajoute des colonnes NOT NULL,
# convertit des donnees et active le cloisonnement. Une erreur a mi-parcours
# laisserait la base dans un etat qu'aucun « if not exists » ne rattrape.
if [ -n "${URL}" ]; then
  # LA SAUVEGARDE SE FAIT PAR UN COMPTE PRIVILEGIE, ET C'EST INDISPENSABLE.
  #
  # Defaut trouve le 15/08/2026 EN RECETTE — exactement ce pour quoi elle
  # existe. Le dump tournait sous « biblio », le compte applicatif. Une fois
  # « force row level security » actif, PostgreSQL le REFUSE :
  #
  #   ERREUR : la requete pourrait etre affectee par une politique de
  #            securite au niveau ligne pour la table « books »
  #
  # Et c'est un excellent comportement de sa part. S'il avait accepte, la
  # sauvegarde n'aurait contenu que les ouvrages PUBLICS — un filet qui ne
  # rattrape qu'un tiers de la bibliotheque, sans que rien ne le signale.
  # On ne s'en serait apercu qu'en essayant de restaurer.
  #
  # « sudo -u postgres » : le superutilisateur traverse les politiques. Ici
  # c'est ce qu'on veut, et c'est le seul endroit du deploiement ou on le
  # veut — une sauvegarde doit voir TOUT, par definition.
  SAUVEGARDE="/var/backups/${BASE}-avant-migration-$(date +%Y%m%d-%H%M%S).sql.gz"
  install -d -m 700 /var/backups
  if sudo -u postgres pg_dump -d "${BASE}" | gzip > "${SAUVEGARDE}" \
     && [ -s "${SAUVEGARDE}" ]; then
    chmod 600 "${SAUVEGARDE}"
    echo "  sauvegarde : $(du -h "${SAUVEGARDE}" | cut -f1) -> ${SAUVEGARDE}"
  else
    echo "  ECHEC sauvegarde impossible — aucune migration ne sera tentee"
    exit 1
  fi

  # LA SAUVEGARDE EST-ELLE COMPLETE ? Le poids ne dit rien : un dump
  # tronque pese quand meme quelque chose. On compte les lignes de donnees
  # de la table principale et on les compare a ce que la base contient.
  #
  # Sans ce controle, une sauvegarde partielle passerait pour bonne, et on
  # ne le decouvrirait qu'au moment de s'en servir — c'est-a-dire au pire
  # moment possible.
  table=possessions
  sudo -u postgres psql -tAd "${BASE}" -c "select 1 from possessions limit 1" \
    >/dev/null 2>&1 || table=books
  attendu=$(sudo -u postgres psql -tAd "${BASE}" -c "select count(*) from ${table}")
  # awk en guillemets SIMPLES et comparaison litterale du terminateur.
  # Une premiere version passait le motif a travers les couches shell : le
  # « \. » de fin de COPY n'etait plus reconnu, le drapeau restait leve, et
  # le compteur additionnait les lignes des tables suivantes. Il annoncait
  # cinq lignes la ou il y en avait trois — un controle de completude qui
  # comptait faux aurait ete pire que pas de controle.
  copie=$(gunzip -c "${SAUVEGARDE}" | awk -v t="public.${table}" '
    $0 ~ "^COPY " t " " { f=1; next }
    f && $0 == "\\."   { f=0; next }
    f                    { n++ }
    END { print n+0 }')
  if [ "${copie}" = "${attendu}" ]; then
    echo "  sauvegarde verifiee : ${copie} lignes de ${table}"
  else
    echo "  ECHEC sauvegarde INCOMPLETE : ${copie} lignes sauvegardees, ${attendu} en base"
    echo "        aucune migration ne sera tentee"
    exit 1
  fi

  # --- LA REPETITION ---------------------------------------------------------
  #
  # Les migrations passent D'ABORD sur une COPIE de la base de production, et
  # un controle privilegie compare la copie a l'original ligne a ligne. La
  # production n'est touchee que si tout concorde.
  #
  # POURQUOI LA SAUVEGARDE NE SUFFISAIT PAS. Elle permet de REPARER apres
  # coup ; elle ne dit rien AVANT. Or une migration qui perd des donnees ne
  # leve pas d'erreur : elle rend moins de lignes, en silence. On s'en
  # apercevrait en ouvrant la page, ou plus tard, en cherchant un livre.
  #
  # POURQUOI SUR LE SERVEUR, ET PAS EN INTEGRATION. La chaine GitHub ne peut
  # pas connaitre vos donnees — les y envoyer serait precisement ce que
  # l'application protege. La repetition se fait donc ici, et rien ne sort.
  #
  # POURQUOI « sudo -u postgres » POUR LE CONTROLE. Le compte applicatif est
  # soumis au cloisonnement : un controle execute sous son identite ne verrait
  # que les ouvrages publics, des deux cotes, et conclurait que tout va bien.
  # C'est exactement l'erreur du 15/08/2026, ou un garde-fou n'a pas vu
  # disparaitre toute la sphere personnelle.
  REPET="${BASE}_repetition"
  VERIF="${TRAVAIL}/contenu/deploiement/verifier-migration.sql"

  # LA RECETTE EST ELLE-MEME UNE REPETITION.
  #
  # Sa base est une copie de la production ; y appliquer les migrations, c'est
  # exactement ce que la repetition simule — en plus utile, puisqu'on peut
  # ensuite cliquer dans l'interface. Repeter la repetition ne prouverait
  # rien de plus et doublerait la duree du deploiement.
  if [ "${ENVIRONNEMENT}" = "recette" ]; then
    echo "  (recette : la base EST la repetition, pas de copie supplementaire)"
    VERIF=""
  fi

  if [ -n "${VERIF}" ] && [ -f "${VERIF}" ]; then
    echo "  -- repetition sur une copie des donnees reelles --"
    sudo -u postgres dropdb --if-exists "${REPET}" >/dev/null 2>&1
    if ! sudo -u postgres createdb -O biblio "${REPET}" >/dev/null 2>&1; then
      echo "  ECHEC creation de la base de repetition"; exit 1
    fi
    if ! gunzip -c "${SAUVEGARDE}" \
         | sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "${REPET}" \
             >/tmp/repet-${BASE}.log 2>&1; then
      echo "  ECHEC copie vers la repetition :"
      tail -5 /tmp/repet-${BASE}.log | sed 's/^/         /'; exit 1
    fi

    # LE PROPRIETAIRE DOIT AVOIR SURVECU A LA COPIE, et ce n'est pas acquis.
    #
    # pg_dump emet des « ALTER TABLE ... OWNER TO biblio », mais un dump
    # partiel, une version differente ou une option --no-owner les feraient
    # sauter : les tables appartiendraient alors a postgres.
    #
    # La repetition deviendrait alors MENSONGERE dans les deux sens :
    #   — « alter table books no force » echouerait, faute d'etre proprietaire ;
    #   — et surtout « force row level security » ne porterait plus sur le
    #     compte applicatif, donc le cloisonnement ne serait pas eprouve.
    # Une repetition qui ne reproduit pas les droits ne repete rien.
    proprio=$(sudo -u postgres psql -tAd "${REPET}" -c \
      "select tableowner from pg_tables where tablename = 'books'" 2>/dev/null)
    if [ "${proprio}" != "biblio" ]; then
      echo "  ECHEC la copie n'appartient pas a biblio (proprietaire : ${proprio:-inconnu})"
      echo "        la repetition ne reproduirait pas les droits de production"
      exit 1
    fi

    for fichier in $(ls -1 "${TRAVAIL}/contenu/db/"*.sql | sort); do
      nom=$(basename "${fichier}")
      if ! PGPASSWORD="${URL}" psql -h 127.0.0.1 -U biblio -d "${REPET}" \
             -v ON_ERROR_STOP=1 -qf "${fichier}" >/tmp/repet-${BASE}.log 2>&1; then
        echo "  ECHEC repetition (${nom}) — LA PRODUCTION N'A PAS ETE TOUCHEE :"
        tail -8 /tmp/repet-${BASE}.log | sed 's/^/         /'
        echo "         la copie reste en place pour examen : ${REPET}"
        exit 1
      fi
    done
    echo "  migrations appliquees a la copie"

    # LE FICHIER DOIT ETRE LISIBLE PAR « postgres », ET IL NE L'ETAIT PAS.
    #
    # Defaut du 15/08/2026. « mktemp -d » cree le dossier en 700, appartenant
    # a root ; l'utilisateur postgres n'y entre pas. psql rendait donc :
    #
    #   psql: erreur : .../verifier-migration.sql : Permission non accordee
    #
    # et le deploiement s'arretait en annoncant « la repetition ne concorde
    # pas » — ce qui etait FAUX. Elle n'avait pas refuse : elle n'avait pas
    # pu tourner. On a passe la production pour suspecte pendant une heure
    # a cause d'un droit de lecture.
    #
    # C'est la meme distinction que « couverture absente » contre
    # « couverture injoignable » : un controle qui ne peut pas s'executer
    # doit le dire, jamais se faire passer pour un refus.
    cp "${VERIF}" /tmp/verifier-migration.sql
    chmod 644 /tmp/verifier-migration.sql

    if sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${REPET}" \
         -f /tmp/verifier-migration.sql >/tmp/verif-${BASE}.log 2>&1; then
      grep -E '^(NOTICE|  )' /tmp/verif-${BASE}.log | sed 's/^NOTICE:  //' \
        | sed 's/^/       /' | head -20
    else
      # ON MONTRE TOUT. Une premiere version filtrait sur « ERROR|ERREUR » et
      # n'a RIEN affiche le 15/08/2026 : le journal est en francais, le
      # message pouvait etre ailleurs, et l'operateur s'est retrouve devant
      # « la repetition ne concorde pas » sans savoir quoi.
      #
      # Un rapport d'echec qui filtre risque de filtrer justement ce qu'on
      # cherche. Quinze lignes de trop coutent moins qu'un aller-retour.
      # « n'a pas pu tourner » et « a refuse » ne veulent pas dire la meme
      # chose, et l'operateur n'a pas a le deviner.
      if grep -qiE 'permission|denied|non accordee|could not connect|does not exist' \
           /tmp/verif-${BASE}.log; then
        echo "  ECHEC le controle N'A PAS PU S'EXECUTER — ce n'est pas un refus."
        echo "        la migration n'a donc PAS ete eprouvee, et rien n'a ete migre."
      else
        echo "  ECHEC la repetition NE CONCORDE PAS — la migration abimerait vos donnees."
      fi
      echo "  LA PRODUCTION N'A PAS ETE TOUCHEE"
      echo "  ---------------- ce que le controle a dit ----------------"
      tail -25 /tmp/verif-${BASE}.log | sed 's/^/  /'
      echo "  ----------------------------------------------------------"
      echo "  la copie reste en place pour examen : ${REPET}"
      echo "  pour rejouer le controle a la main :"
      echo "    sudo -u postgres psql -d ${REPET} -f verifier-migration.sql"
      exit 1
    fi
  elif [ "${ENVIRONNEMENT}" != "recette" ]; then
    # Un fichier de controle absent ne doit pas se traduire par « tout va
    # bien ». On le dit, bruyamment, plutot que de migrer sans filet.
    echo "  ATTENTION verifier-migration.sql absent : AUCUNE repetition"
    echo "            la migration part sans avoir ete eprouvee sur vos donnees"
  fi

  # --- LA PRODUCTION, seulement maintenant -----------------------------------
  for fichier in $(ls -1 "${TRAVAIL}/contenu/db/"*.sql | sort); do
    nom=$(basename "${fichier}")
    if PGPASSWORD="${URL}" psql -h 127.0.0.1 -U biblio -d "${BASE}" \
         -v ON_ERROR_STOP=1 -qf "${fichier}" >/tmp/mig-${BASE}.log 2>&1; then
      echo "  schema applique : ${nom}"
    else
      echo "  ECHEC schema (${nom}) :"; tail -5 /tmp/mig-${BASE}.log | sed 's/^/         /'
      echo "         retour arriere :"
      echo "           gunzip -c ${SAUVEGARDE} | sudo -u postgres psql -d ${BASE}"
      exit 1
    fi
  done
else
  echo "  ECHEC PGPASSWORD introuvable : on ne deploie pas a l aveugle"
  exit 1
fi

# --- Les pages, AVANT l'API -------------------------------------------------
# Elles ne peuvent pas echouer ; si l'API tombe ensuite, la page reste
# consultable et affiche son message d'erreur plutot que rien.
install -d -m 755 "${RACINE_WEB}"
rsync -a --delete "${TRAVAIL}/contenu/web/" "${RACINE_WEB}/"
chmod -R a+rX "${RACINE_WEB}"
echo "  pages posees : $(find "${RACINE_WEB}" -type f | wc -l) fichiers"

# --- La politique de contenu, recalculee sur les pages qu'on vient de poser --
#
# Chaque script en ligne est autorise par son empreinte sha256, jamais par
# 'unsafe-inline'. L'empreinte change des qu'une virgule change dans le
# script : elle DOIT donc etre recalculee a chaque livraison, ici, et non
# ecrite a la main dans le Caddyfile.
#
# TROIS PRECAUTIONS, parce qu'une politique fautive casse la page en silence
# — le script est refuse par le navigateur, aucune erreur serveur, aucun
# journal. C'est la panne du 04/08/2026.
#
#   1. On ecrit dans un fichier temporaire, jamais directement dans celui que
#      Caddy lit.
#   2. On valide la configuration complete AVANT de basculer.
#   3. Si le rechargement echoue, on remet l'ancienne politique et on
#      recharge : mieux vaut une politique perimee qu'un serveur arrete.
CALCUL="${TRAVAIL}/contenu/deploiement/calculer-csp.mjs"

if [ -f "${CALCUL}" ]; then
  if node "${CALCUL}" "${RACINE_WEB}" --caddy > /tmp/csp-${BASE}.nouveau 2>/tmp/csp-${BASE}.err; then
    [ -f "${CSP_FICHIER}" ] && cp -a "${CSP_FICHIER}" /tmp/csp-${BASE}.ancien
    cp /tmp/csp-${BASE}.nouveau "${CSP_FICHIER}"

    if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-valid.log 2>&1 \
       && systemctl reload caddy 2>>/tmp/caddy-valid.log; then
      echo "  politique de contenu : $(grep -c "^#   " "${CSP_FICHIER}") empreinte(s)"
    else
      echo "  ECHEC politique de contenu refusee par Caddy :"
      tail -5 /tmp/caddy-valid.log | sed 's/^/         /'
      if [ -f /tmp/csp-${BASE}.ancien ]; then
        cp /tmp/csp-${BASE}.ancien "${CSP_FICHIER}"
      else
        rm -f "${CSP_FICHIER}"
      fi
      systemctl reload caddy || true
      echo "  ancienne politique retablie"
      exit 1
    fi
  else
    echo "  ECHEC calcul de la politique :"; tail -3 /tmp/csp-${BASE}.err | sed 's/^/         /'
    exit 1
  fi
else
  echo "  ATTENTION calculer-csp.mjs absent du paquet : politique inchangee"
fi

# --- L'API -------------------------------------------------------------------
rsync -a --delete --exclude='node_modules' "${TRAVAIL}/contenu/api/" "${RACINE_API}/"
cd "${RACINE_API}" || exit 1
npm install --omit=dev --no-audit --no-fund --silent >/tmp/npm-${BASE}.log 2>&1 \
  || { echo "  ECHEC dependances"; tail -5 /tmp/npm-${BASE}.log; exit 1; }
echo "  dependances installees"

# --- Redemarrage et verification ---------------------------------------------
systemctl restart "${SERVICE}"
sleep 5

if curl -sf --max-time 10 "http://127.0.0.1:${PORT}/api/session" >/dev/null 2>&1; then
  echo "  service actif"
  tracer "SUCCES ${ENVIRONNEMENT}"
else
  # RETOUR ARRIERE. Un service muet est pire qu'une version ancienne.
  echo "  ECHEC le service ne repond pas — retour arriere"
  journalctl -u "${SERVICE}" -n 15 --no-pager | sed 's/^/         /'
  if [ -d "${RACINE_API}.precedent" ]; then
    rm -rf "${RACINE_API}"; mv "${RACINE_API}.precedent" "${RACINE_API}"
    rm -rf "${RACINE_WEB}"; mv "${RACINE_WEB}.precedent" "${RACINE_WEB}"
    systemctl restart "${SERVICE}"; sleep 5
    curl -sf --max-time 8 "http://127.0.0.1:${PORT}/api/session" >/dev/null \
      && echo "  version precedente restauree" \
      || echo "  la version precedente ne repond pas non plus"
  else
    echo "  aucune version precedente a restaurer"
  fi
  tracer "ECHEC ${ENVIRONNEMENT} — retour arriere"
  exit 1
fi

echo "== Deploiement ${ENVIRONNEMENT} termine =="
