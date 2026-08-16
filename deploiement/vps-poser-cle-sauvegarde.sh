#!/usr/bin/env bash
# =========================================================================
# LA CLEF QUI NE SAIT QUE LIRE LES SAUVEGARDES
#
# A lancer EN ROOT SUR LE VPS. Il attend la clef publique du poste sur son
# entree standard :
#
#   cat ~/.ssh/biblio-sauvegarde.pub | ssh root@... "bash -s"
#
# ---------------------------------------------------------------------------
# POURQUOI UNE CLEF SANS PHRASE DE PASSE, ET COMMENT C'EST TENABLE
#
# Une tache planifiee ne peut pas taper une phrase de passe. La clef du
# poste sera donc utilisable telle quelle par quiconque met la main dessus.
# Ce qui rend la chose acceptable n'est pas la clef, c'est ce qu'elle
# AUTORISE : deux commandes, « lister » et « lire <nom> », et rien d'autre.
#
#   restrict            tout est refuse par defaut
#   command="..."       la seule chose qui puisse s'executer
#   no-pty              pas de terminal
#   no-port-forwarding  pas de tunnel vers la base
#
# Ce qu'elle donne malgre tout, et il faut le dire : le contenu de la
# bibliotheque. Quelqu'un qui vole cette clef peut lire les cliches. Il ne
# peut ni les effacer, ni en creer, ni toucher au serveur.
#
# ELLE N'EST PAS LA CLEF DE DEPLOIEMENT. La chaine de livraison en a une
# autre, qui ne sait que deployer. Deux clefs, deux pouvoirs disjoints : ni
# l'une ni l'autre ne devient la clef du royaume.
# =========================================================================

set -uo pipefail
cd / || exit 1

BIN=/usr/local/bin/sauvegarde-biblio
AUTH=/root/.ssh/authorized_keys
MARQUE="biblio-sauvegarde"

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Clef de lecture des sauvegardes =="

[ -x "${BIN}" ] || echec "${BIN} absent — lancez d'abord vps-sauvegarde-biblio.sh installer"

publique=$(cat)
[ -n "${publique}" ] || echec "aucune clef publique recue sur l'entree standard"
case "${publique}" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-*) ;;
  *) echec "ce qui a ete recu ne ressemble pas a une clef publique" ;;
esac

# UNE CLEF PRIVEE NE DOIT JAMAIS ARRIVER ICI. Une erreur de « .pub » oublie
# est vite arrivee, et la clef privee se retrouverait dans un fichier de
# configuration du serveur, en clair.
case "${publique}" in
  *PRIVATE*) echec "c'est une clef PRIVEE. Ne la posez nulle part. Envoyez le .pub." ;;
esac

install -d -m 700 /root/.ssh
touch "${AUTH}"; chmod 600 "${AUTH}"
cp -a "${AUTH}" "${AUTH}.avant-${MARQUE}-$(date +%Y%m%d-%H%M%S)"
ok "authorized_keys sauvegarde"

# On retire une eventuelle version precedente de CETTE clef, en la
# reconnaissant a son commentaire. On ne touche a aucune autre ligne : la
# clef de deploiement et la votre doivent survivre a ce script.
avant=$(wc -l < "${AUTH}")
grep -v "${MARQUE}" "${AUTH}" > "${AUTH}.neuf" 2>/dev/null || true

{
  printf 'restrict,command="%s",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ' "${BIN}"
  # Le commentaire de la clef est REMPLACE par notre marque : c'est lui qui
  # permettra de la retrouver et de la retirer plus tard.
  printf '%s %s\n' "$(printf '%s' "${publique}" | awk '{print $1" "$2}')" "${MARQUE}"
} >> "${AUTH}.neuf"

mv -f "${AUTH}.neuf" "${AUTH}"
chmod 600 "${AUTH}"
apres=$(wc -l < "${AUTH}")
ok "clef posee (${avant} -> ${apres} lignes)"

# --- Le filet : les autres clefs sont-elles toujours la ? ----------------
#
# Ecraser authorized_keys est la facon la plus rapide de se fermer la porte
# de son propre serveur. On verifie que la clef de deploiement y est encore.
if grep -q 'deployer-biblio' "${AUTH}"; then
  ok "la clef de deploiement est intacte"
else
  echo "  ATTENTION la clef de deploiement n'apparait plus dans ${AUTH}."
  echo "            Une copie datee est a cote. NE FERMEZ PAS cette session"
  echo "            avant d'avoir verifie que vous pouvez encore vous connecter."
fi

echo
echo "== FIN =="
echo "   Essayez depuis le poste, SANS fermer cette session :"
echo "     ssh -i ~/.ssh/biblio-sauvegarde root@195.110.35.206 lister"
echo "   Puis, pour verifier qu'elle ne peut rien d'autre :"
echo "     ssh -i ~/.ssh/biblio-sauvegarde root@195.110.35.206 'id'"
echo "   La seconde DOIT etre refusee."
