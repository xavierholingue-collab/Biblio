#!/usr/bin/env bash
# =========================================================================
# Envoie le deployeur Biblio et son poseur de clef sur le VPS.
#
# A lancer depuis le terminal Ubuntu. La clef privee s'affichera UNE fois :
# gardez la fenetre ouverte jusqu'a l'avoir collee dans GitHub.
# =========================================================================

set -uo pipefail

SERVEUR=root@195.110.35.206
SOURCE=/mnt/c/Users/xavie/OneDrive/Doc/Claude/Projects/Bibliographie/deploiement

echo "== Clef de deploiement Biblio =="
echo

ssh "${SERVEUR}" 'cat > /root/deployer-biblio.source' < "${SOURCE}/vps-deployer-biblio.sh" || {
  echo "  ECHEC envoi du deployeur"; exit 1; }

ssh "${SERVEUR}" 'cat > /root/poser-cle-biblio.sh' < "${SOURCE}/vps-poser-cle-biblio.sh" || {
  echo "  ECHEC envoi du poseur"; exit 1; }

ssh "${SERVEUR}" "chmod 700 /root/poser-cle-biblio.sh && /root/poser-cle-biblio.sh; rm -f /root/poser-cle-biblio.sh"
