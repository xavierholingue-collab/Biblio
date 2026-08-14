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
#
# ---------------------------------------------------------------------------
# LA CLEF EST CONSERVEE PAR DEFAUT. C'est un changement du 15/08/2026, et il
# repare un vrai degat.
#
# La premiere version regenerait la clef A CHAQUE PASSAGE. Or ce script sert
# aussi a METTRE A JOUR le programme de deploiement — on le lance donc pour
# une raison qui n'a rien a voir avec les clefs, et la livraison GitHub casse
# aussitot : le secret CLE_DEPLOIEMENT_BIBLIO ne correspond plus a rien. Le
# 12/08/2026, c'est exactement ce qui est arrive.
#
# Le sens du defaut compte. Oublier de renouveler une clef est un risque
# theorique ; la renouveler par megarde casse la livraison a coup sur. On
# choisit donc le geste sur : conserver, sauf demande explicite.
#
# USAGE
#   bash vps-poser-cle-biblio.sh                     met a jour le deployeur,
#                                                    CONSERVE la clef
#   bash vps-poser-cle-biblio.sh --renouveler-la-clef  rotation explicite
# =========================================================================

set -uo pipefail

RENOUVELER=0
for arg in "$@"; do
  case "${arg}" in
    --renouveler-la-clef) RENOUVELER=1 ;;
    --conserver-la-clef)  RENOUVELER=0 ;;   # explicite, meme si c'est le defaut
    *) echo "Option inconnue : ${arg}"; exit 1 ;;
  esac
done

BIN=/usr/local/bin/deployer-biblio
AUTH=/root/.ssh/authorized_keys
CLE=/root/.ssh/deploiement-biblio
ENVF=/etc/biblio/env

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Clef de deploiement Biblio =="

[ -f /root/deployer-biblio.source ] || echec "script de deploiement non recu"

# On verifie que le nouveau script est SYNTAXIQUEMENT VALIDE avant de
# remplacer celui qui fonctionne. Un deployeur casse ne se signale qu'a la
# prochaine livraison, et par un message qui ne dit pas d'ou il vient.
bash -n /root/deployer-biblio.source || echec "le nouveau deployeur ne compile pas"
[ -f "${BIN}" ] && cp -a "${BIN}" "${BIN}.precedent"
install -m 700 -o root -g root /root/deployer-biblio.source "${BIN}"
rm -f /root/deployer-biblio.source
ok "${BIN} installe"

# Les commandes qu'il accepte, listees ici : c'est ce qui dit si la recette
# est joignable, sans avoir a lire le script.
# « tr -d ' ' » avalait l'espace et affichait « deployerbiblio » : une liste
# de commandes qui ne sont pas celles qu'on peut taper n'aide personne.
echo "  commandes acceptees :"
grep -oE '^  "[a-z -]+"\)' "${BIN}" | sed 's/^  "//; s/")$//; s/^/          /' 

touch /var/log/deploiement-biblio.log && chmod 600 /var/log/deploiement-biblio.log
ok "journal /var/log/deploiement-biblio.log"

# --- LA CLEF ---------------------------------------------------------------
#
# Elle n'est refaite QUE si on le demande, ou si l'entree bridee a disparu
# de authorized_keys — auquel cas il n'y a de toute facon plus rien qui
# fonctionne.
entree_presente=0
grep -q 'deploiement-biblio' "${AUTH}" 2>/dev/null && entree_presente=1

if [ "${RENOUVELER}" = "0" ] && [ "${entree_presente}" = "1" ]; then
  echo
  ok "clef existante CONSERVEE (--renouveler-la-clef pour la refaire)"
  echo "  le secret GitHub CLE_DEPLOIEMENT_BIBLIO reste valable"
  echo
  echo "== FIN =="
  exit 0
fi

if [ "${entree_presente}" = "0" ] && [ "${RENOUVELER}" = "0" ]; then
  echo
  echo "  aucune clef en place : une nouvelle va etre creee"
fi

# On retire toute entree precedente : sans cela, une ancienne clef de
# deploiement resterait valable indefiniment apres rotation.
if [ "${entree_presente}" = "1" ]; then
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
echo "   AUTH_RECETTE_BIBLIO = recette:<mot de passe HTTP de la recette>"
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
