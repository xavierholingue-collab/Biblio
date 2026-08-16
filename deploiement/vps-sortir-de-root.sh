#!/usr/bin/env bash
# =========================================================================
# L'API NE DOIT PAS TOURNER EN ROOT
#
# A lancer EN ROOT SUR LE VPS, et EN RECETTE D'ABORD :
#
#   bash vps-sortir-de-root.sh recette
#   ... verifier que la recette repond ...
#   bash vps-sortir-de-root.sh production
#
# ---------------------------------------------------------------------------
# CE N'EST PAS UNE FAILLE, C'EST LE MULTIPLICATEUR DE TOUTES LES AUTRES
#
# Les protections systemd deja en place — ProtectSystem=strict,
# NoNewPrivileges, ProtectHome, PrivateTmp — reduisent reellement la surface.
# Mais le processus reste root : toute execution de code arbitraire dans Node
# (une faille de « pg », une dependance compromise, une erreur de code)
# devient root sur une machine qui heberge aussi supperf.io et y-factor.fr.
#
# L'API n'a besoin d'aucun privilege : elle ecoute sur le port 3006, au-dessus
# de 1024, et ne touche qu'a son propre dossier et a PostgreSQL par le reseau
# local.
#
# ---------------------------------------------------------------------------
# UN FICHIER D'EXTENSION, PAS UNE REECRITURE DE L'UNITE
#
# vps-installer-biblio.sh reecrit l'unite systemd a chaque execution, avec
# « User=root » dedans. Modifier l'unite verrait donc le changement effacé a
# la prochaine installation, sans un mot — et l'API repasserait root sans que
# personne ne s'en apercoive.
#
# Un fichier d'extension (« drop-in ») vit a cote et SURVIT a la reecriture.
# C'est le seul endroit ou ce reglage tient.
#
# ---------------------------------------------------------------------------
# RETOUR ARRIERE : retirer le fichier d'extension et recharger.
#   rm -rf /etc/systemd/system/biblio-api.service.d
#   systemctl daemon-reload && systemctl restart biblio-api
# =========================================================================

set -uo pipefail
cd / || exit 1

case "${1:-}" in
  recette)
      SERVICE=biblio-recette-api; RACINE=/opt/biblio-recette-api
      ENVF=/etc/biblio-recette/env; PORT=3007; COMPTE=biblio-recette-api ;;
  production)
      SERVICE=biblio-api; RACINE=/opt/biblio-api
      ENVF=/etc/biblio/env; PORT=3006; COMPTE=biblio-api ;;
  *)  echo "usage : $0 recette | production" >&2; exit 1 ;;
esac

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Sortir ${SERVICE} du compte root =="
echo

[ -d "${RACINE}" ] || echec "${RACINE} absent : cet environnement n'est pas installe"
[ -f "${ENVF}" ]   || echec "${ENVF} absent"

# --- L'etat d'avant, pour pouvoir comparer -------------------------------
avant=$(systemctl show -p User --value "${SERVICE}" 2>/dev/null)
avant_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
             "http://127.0.0.1:${PORT}/api/session" 2>/dev/null)
echo "  avant : User=${avant:-root}, /api/session repond ${avant_code}"
[ "${avant_code}" = "200" ] || echo "  ATTENTION le service ne repondait deja pas avant ce script."

# --- 1. Un compte qui ne peut pas se connecter ----------------------------
#
# « --system » : pas de repertoire personnel, pas de mot de passe, un
# identifiant hors de la plage des humains. « nologin » : meme avec un mot
# de passe, personne n'ouvre de session avec.
if id -u "${COMPTE}" >/dev/null 2>&1; then
  ok "compte ${COMPTE} deja present"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "${COMPTE}" \
    || echec "creation du compte ${COMPTE}"
  ok "compte ${COMPTE} cree"
fi

# --- 2. Les fichiers de l'API lui appartiennent ---------------------------
chown -R "${COMPTE}:${COMPTE}" "${RACINE}" || echec "changement de proprietaire de ${RACINE}"
ok "${RACINE} appartient a ${COMPTE}"

# --- 3. LE FICHIER D'ENVIRONNEMENT : LISIBLE, PAS MODIFIABLE --------------
#
# Il contient tous les secrets. Le compte de service doit pouvoir le LIRE au
# demarrage — c'est systemd qui le lit, en root, mais on garde la lecture au
# groupe pour que « sudo -u ... node server.js » reste possible en depannage.
#
# Il ne doit pas etre MODIFIABLE par le service : sinon un code compromis
# reecrit ses propres secrets, ou pire, se donne une autre base.
chown "root:${COMPTE}" "${ENVF}" || echec "changement de proprietaire de ${ENVF}"
chmod 640 "${ENVF}"
ok "${ENVF} : root:${COMPTE}, 640 (lisible, non modifiable par le service)"

# --- 4. Le fichier d'extension systemd ------------------------------------
install -d -m 755 "/etc/systemd/system/${SERVICE}.service.d"
cat > "/etc/systemd/system/${SERVICE}.service.d/compte.conf" <<UNIT
# Pose par vps-sortir-de-root.sh — revue de securite du 16/08/2026.
#
# Ce fichier survit a la reecriture de l'unite par l'installeur. Le retirer
# et recharger systemd suffit a revenir en arriere.
[Service]
User=${COMPTE}
Group=${COMPTE}

# Le service n'a aucune raison d'ecrire ailleurs que chez lui.
ReadWritePaths=${RACINE}

# Durcissement supplementaire, possible maintenant qu'on n'est plus root.
PrivateDevices=true
ProtectKernelModules=true
ProtectClock=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
UNIT
systemctl daemon-reload
ok "extension systemd posee"

# --- 5. Redemarrer, et VERIFIER -------------------------------------------
systemctl restart "${SERVICE}"
sleep 5

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
       "http://127.0.0.1:${PORT}/api/session" 2>/dev/null)
utilisateur=$(systemctl show -p User --value "${SERVICE}" 2>/dev/null)

if [ "${code}" = "200" ]; then
  ok "le service repond (User=${utilisateur})"
  echo
  # LA PREUVE, pas la promesse : on demande au systeme sous quelle identite
  # le processus tourne reellement, plutot que de croire la configuration.
  pid=$(systemctl show -p MainPID --value "${SERVICE}")
  echo "  identite reelle du processus ${pid} : $(ps -o user= -p "${pid}" 2>/dev/null)"
  echo
  echo "== FIN — ${SERVICE} ne tourne plus en root =="
  [ "$1" = "recette" ] && echo "   Si la recette tient, passez la production :  bash $0 production"
else
  echo "  ECHEC le service ne repond plus (${code}) — RETOUR ARRIERE"
  journalctl -u "${SERVICE}" -n 20 --no-pager | sed 's/^/         /'
  rm -rf "/etc/systemd/system/${SERVICE}.service.d"
  systemctl daemon-reload
  systemctl restart "${SERVICE}"
  sleep 5
  retour=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
           "http://127.0.0.1:${PORT}/api/session" 2>/dev/null)
  [ "${retour}" = "200" ] \
    && echo "  le service est revenu en root et repond de nouveau" \
    || echo "  ATTENTION le service ne repond pas non plus apres retour arriere"
  echo
  echo "  Les fichiers appartiennent maintenant a ${COMPTE} : c'est sans effet"
  echo "  pour un service qui tourne en root, qui lit tout."
  exit 1
fi
