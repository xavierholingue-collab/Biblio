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
ENVF=/etc/biblio/env
RACINE_API=/opt/biblio-api
RACINE_WEB=/var/www/biblio
PORT=3006

tracer() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "${JOURNAL}"; }

demande="${SSH_ORIGINAL_COMMAND:-}"
tracer "demande=[${demande}] depuis=${SSH_CLIENT%% *}"

case "${demande}" in
  "deployer biblio") ;;
  "sante")
      systemctl is-active biblio-api >/dev/null && echo "biblio:active" || echo "biblio:inactive"
      exit 0 ;;
  *)
      tracer "REFUSE"
      echo "Commande non autorisee." >&2
      exit 1 ;;
esac

TRAVAIL=$(mktemp -d); chmod 700 "${TRAVAIL}"
trap 'rm -rf "${TRAVAIL}"' EXIT INT TERM

echo "== Deploiement de Biblio =="

# --- Reception -------------------------------------------------------------
cat > "${TRAVAIL}/paquet.tar.gz"
taille=$(stat -c %s "${TRAVAIL}/paquet.tar.gz")
[ "${taille}" -gt 1000 ] || { echo "  ECHEC archive vide ou tronquee (${taille} octets)"; exit 1; }
echo "  archive recue : $((taille / 1024)) ko"

tar -tzf "${TRAVAIL}/paquet.tar.gz" >/dev/null 2>&1 || { echo "  ECHEC archive illisible"; exit 1; }
mkdir -p "${TRAVAIL}/contenu"
tar -xzf "${TRAVAIL}/paquet.tar.gz" -C "${TRAVAIL}/contenu" || { echo "  ECHEC extraction"; exit 1; }

for attendu in api/server.js api/package.json web/index.html db/01-schema.sql; do
  [ -f "${TRAVAIL}/contenu/${attendu}" ] \
    || { echo "  ECHEC fichier attendu absent : ${attendu}"; exit 1; }
done
echo "  contenu conforme"

# --- Sauvegarde de la version en place --------------------------------------
rm -rf "${RACINE_API}.precedent" "${RACINE_WEB}.precedent"
[ -f "${RACINE_API}/server.js" ] && cp -a "${RACINE_API}" "${RACINE_API}.precedent"
[ -d "${RACINE_WEB}" ] && cp -a "${RACINE_WEB}" "${RACINE_WEB}.precedent"
echo "  version precedente conservee"

# --- Le schema, AVANT le code -----------------------------------------------
#
# Il est ecrit en « create table if not exists » : le rejouer est sans
# effet. L'appliquer avant le redemarrage evite qu'un code attendant une
# colonne absente ne demarre puis echoue a la premiere requete — c'est-a-
# dire chez un visiteur, pas ici.
URL=$(sed -n 's/^PGPASSWORD=//p' "${ENVF}")
if [ -n "${URL}" ]; then
  if PGPASSWORD="${URL}" psql -h 127.0.0.1 -U biblio -d biblio \
       -v ON_ERROR_STOP=1 -qf "${TRAVAIL}/contenu/db/01-schema.sql" >/tmp/mig-biblio.log 2>&1; then
    echo "  schema applique"
  else
    echo "  ECHEC schema :"; tail -5 /tmp/mig-biblio.log | sed 's/^/         /'; exit 1
  fi
else
  echo "  ATTENTION PGPASSWORD introuvable : schema non applique"
fi

# --- Les pages, AVANT l'API -------------------------------------------------
# Elles ne peuvent pas echouer ; si l'API tombe ensuite, la page reste
# consultable et affiche son message d'erreur plutot que rien.
install -d -m 755 "${RACINE_WEB}"
rsync -a --delete "${TRAVAIL}/contenu/web/" "${RACINE_WEB}/"
chmod -R a+rX "${RACINE_WEB}"
echo "  pages posees : $(find "${RACINE_WEB}" -type f | wc -l) fichiers"

# --- L'API -------------------------------------------------------------------
rsync -a --delete --exclude='node_modules' "${TRAVAIL}/contenu/api/" "${RACINE_API}/"
cd "${RACINE_API}" || exit 1
npm install --omit=dev --no-audit --no-fund --silent >/tmp/npm-biblio.log 2>&1 \
  || { echo "  ECHEC dependances"; tail -5 /tmp/npm-biblio.log; exit 1; }
echo "  dependances installees"

# --- Redemarrage et verification ---------------------------------------------
systemctl restart biblio-api
sleep 5

if curl -sf --max-time 10 "http://127.0.0.1:${PORT}/api/session" >/dev/null 2>&1; then
  echo "  service actif"
  tracer "SUCCES"
else
  # RETOUR ARRIERE. Un service muet est pire qu'une version ancienne.
  echo "  ECHEC le service ne repond pas — retour arriere"
  journalctl -u biblio-api -n 15 --no-pager | sed 's/^/         /'
  if [ -d "${RACINE_API}.precedent" ]; then
    rm -rf "${RACINE_API}"; mv "${RACINE_API}.precedent" "${RACINE_API}"
    rm -rf "${RACINE_WEB}"; mv "${RACINE_WEB}.precedent" "${RACINE_WEB}"
    systemctl restart biblio-api; sleep 5
    curl -sf --max-time 8 "http://127.0.0.1:${PORT}/api/session" >/dev/null \
      && echo "  version precedente restauree" \
      || echo "  la version precedente ne repond pas non plus"
  else
    echo "  aucune version precedente a restaurer"
  fi
  tracer "ECHEC — retour arriere"
  exit 1
fi

echo "== Deploiement termine =="
