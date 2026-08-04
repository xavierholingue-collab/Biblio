#!/usr/bin/env bash
# =========================================================================
# Installe le deployeur Biblio et cree sa clef bridee.
#
# S'EXECUTE SUR LE VPS.
#
# La clef privee est affichee UNE SEULE FOIS, puis effacee au shred. Le
# serveur n'a besoin que de la partie publique.
#
# Cette clef est INDEPENDANTE de celle de Y-Factor. Deux projets, deux
# clefs, deux commandes forcees : la compromission de l'une ne donne pas
# acces a l'autre.
# =========================================================================

set -uo pipefail

BIN=/usr/local/bin/deployer-biblio
AUTH=/root/.ssh/authorized_keys
CLE=/root/.ssh/deploiement-biblio
ENVF=/etc/biblio/env

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Clef de deploiement Biblio =="

[ -f /root/deployer-biblio.source ] || echec "script de deploiement non recu"
install -m 700 -o root -g root /root/deployer-biblio.source "${BIN}"
rm -f /root/deployer-biblio.source
ok "${BIN} installe"

touch /var/log/deploiement-biblio.log && chmod 600 /var/log/deploiement-biblio.log
ok "journal /var/log/deploiement-biblio.log"

# On retire toute entree precedente : sans cela, une ancienne clef de
# deploiement resterait valable indefiniment apres rotation.
if [ -f "${AUTH}" ] && grep -q 'deploiement-biblio' "${AUTH}"; then
  sed -i '/deploiement-biblio/d' "${AUTH}"
  ok "entree precedente retiree"
fi

rm -f "${CLE}" "${CLE}.pub"
ssh-keygen -t ed25519 -N '' -C 'deploiement-biblio' -f "${CLE}" >/dev/null 2>&1 \
  || echec "generation de la clef"
ok "clef ed25519 generee"

install -d -m 700 /root/.ssh
{
  printf 'restrict,command="%s",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ' "${BIN}"
  cat "${CLE}.pub"
} >> "${AUTH}"
chmod 600 "${AUTH}"
ok "entree bridee ajoutee"

echo
echo "-- Ce que cette clef peut faire, et rien d autre --"
grep 'deploiement-biblio' "${AUTH}" | cut -c1-130 | sed 's/^/    /'

echo
echo "=========================================================================="
echo " CLEF PRIVEE — a copier MAINTENANT dans GitHub"
echo ""
echo "   Depot Biblio > Settings > Secrets and variables > Actions"
echo "   Name  : CLE_DEPLOIEMENT_BIBLIO"
echo "=========================================================================="
cat "${CLE}"
echo "=========================================================================="
echo
echo " Trois autres secrets a creer dans le meme depot :"
echo "   HOTE_VPS            = 195.110.35.206"
echo "   MOT_DE_PASSE_BIBLIO = le mot de passe d ouverture de l application"
echo "   EMPREINTE_HOTE      = la ligne ci-dessous"
ssh-keyscan -t ed25519 195.110.35.206 2>/dev/null | sed 's/^/     /'
echo "=========================================================================="

shred -u "${CLE}"; rm -f "${CLE}.pub"
echo
ok "clef privee effacee du serveur"

# Rappel : sans MOT_DE_PASSE, l'API refuse de demarrer — et sans lui dans
# les secrets GitHub, la verification d'apres-deploiement ne peut pas se
# connecter. Les deux doivent porter la MEME valeur.
echo
if grep -q '^MOT_DE_PASSE=.\+' "${ENVF}" 2>/dev/null; then
  echo "  MOT_DE_PASSE est renseigne dans ${ENVF}."
  echo "  Le secret GitHub MOT_DE_PASSE_BIBLIO doit porter la MEME valeur,"
  echo "  sans quoi la verification d apres-deploiement echouera a se connecter."
else
  echo "  A FAIRE  MOT_DE_PASSE est vide dans ${ENVF} : l API refusera de demarrer."
fi
echo
echo "== FIN =="
