#!/usr/bin/env bash
# =========================================================================
# Envoie et execute, sur le VPS :
#   1. l'installation de Biblio — base, role, service ;
#   2. les blocs Caddy des quatre noms de xavier-holingue.eu.
#
# A lancer depuis le terminal Ubuntu.
#
# N'INSTALLE PAS ENCORE LE CODE : c'est le deploiement qui s'en charge,
# une fois le depot en place.
# =========================================================================

set -uo pipefail

SERVEUR=root@195.110.35.206
SOURCE=/mnt/c/Users/xavie/OneDrive/Doc/Claude/Projects/Bibliographie/deploiement

echo "== Biblio sur le VPS =="
echo

echo "-- 1. Base, role, service --"
ssh "${SERVEUR}" 'cat > /root/installer-biblio.sh' < "${SOURCE}/vps-installer-biblio.sh" || {
  echo "  ECHEC envoi"; exit 1; }
ssh "${SERVEUR}" "chmod 700 /root/installer-biblio.sh && /root/installer-biblio.sh; rm -f /root/installer-biblio.sh" || exit 1

echo
echo "-- 2. Blocs Caddy --"
ssh "${SERVEUR}" 'cat > /root/caddy-xh.sh' < "${SOURCE}/vps-caddy-xavier-holingue.sh" || {
  echo "  ECHEC envoi"; exit 1; }
ssh "${SERVEUR}" "chmod 700 /root/caddy-xh.sh && /root/caddy-xh.sh; rm -f /root/caddy-xh.sh"
