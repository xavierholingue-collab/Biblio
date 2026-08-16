#!/usr/bin/env bash
# =========================================================================
# RAMENER LES SAUVEGARDES SUR LE POSTE
#
# A lancer depuis WSL. Demande au serveur ce qu'il a, compare a ce qui est
# deja ici, et ne rapatrie QUE ce qui manque.
#
# ---------------------------------------------------------------------------
# POURQUOI « CE QUI MANQUE » ET NON « LA DERNIERE »
#
# Un poste eteint trois jours laisserait trois trous si on ne prenait que la
# plus recente. Le serveur en conserve quatorze ; on rattrape donc toute
# absence qui n'a pas depasse deux semaines. C'est la seule chose qui rend
# tenable une sauvegarde tiree par une machine qui n'est pas toujours la.
#
# ---------------------------------------------------------------------------
# CE QUI EST VERIFIE APRES CHAQUE TRANSFERT
#
# Un fichier tronque par une coupure reseau ressemble a un fichier. On
# verifie donc que gzip le relit ENTIEREMENT, et on ne le garde qu'a cette
# condition. Un fichier d'apparence correcte qu'on decouvre illisible le
# jour d'une restauration est le pire des cas.
#
# USAGE
#   bash recuperer-sauvegardes.sh
#   DESTINATION=/un/autre/chemin bash recuperer-sauvegardes.sh
# =========================================================================

set -uo pipefail

SERVEUR=${SERVEUR:-root@195.110.35.206}
CLEF=${CLEF:-$HOME/.ssh/biblio-sauvegarde}
DESTINATION=${DESTINATION:-/mnt/c/Users/xavie/OneDrive/Doc/Claude/Projects/Bibliographie/sauvegardes}
RETENTION_JOURS=${RETENTION_JOURS:-60}

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Recuperation des sauvegardes de Biblio =="
echo "   serveur     : ${SERVEUR}"
echo "   destination : ${DESTINATION}"
echo

[ -f "${CLEF}" ] || echec "clef ${CLEF} absente — lancez vps-poser-cle-sauvegarde.sh"
mkdir -p "${DESTINATION}" || echec "destination inaccessible"

# --- Ce que le serveur possede -------------------------------------------
#
# « BatchMode=yes » : on ne veut AUCUNE question. Une tache planifiee qui
# attend une reponse reste bloquee pour toujours, et personne ne s'en
# apercoit avant d'avoir besoin des sauvegardes.
liste=$(ssh -n -i "${CLEF}" -o BatchMode=yes -o ConnectTimeout=20 \
          "${SERVEUR}" lister 2>/tmp/biblio-sauvegarde.err)
if [ -z "${liste}" ]; then
  echo "  ECHEC le serveur n'a rien renvoye :"
  sed 's/^/         /' /tmp/biblio-sauvegarde.err
  exit 1
fi
annoncees=$(printf '%s\n' "${liste}" | wc -l)
echo "  ${annoncees} sauvegarde(s) sur le serveur"

# --- Ce qui manque ici ----------------------------------------------------
rapatriees=0; ignorees=0; echecs=0

while read -r taille nom; do
  [ -n "${nom}" ] || continue
  local_fichier="${DESTINATION}/${nom}"

  # Deja la ET de la bonne taille : on ne retelecharge pas. Une taille
  # differente signale un transfert precedent interrompu ; on refait.
  if [ -f "${local_fichier}" ] && [ "$(stat -c %s "${local_fichier}")" = "${taille}" ]; then
    ignorees=$((ignorees + 1)); continue
  fi

  printf '  ... %s (%s ko)\n' "${nom}" "$((taille / 1024))"
  # « -n » N'EST PAS UN ORNEMENT ICI.
  #
  # Sans lui, ssh lit l'entree standard — qui est, dans cette boucle, le
  # RESTE DE LA LISTE. Il l'envoie a la commande distante, qui n'en fait
  # rien, et la boucle « while read » ne trouve plus rien a lire.
  #
  # Constate le 16/08/2026, a la premiere execution : « 2 sauvegardes sur le
  # serveur », une seule rapatriee, zero ignoree, et aucune erreur. Le
  # compte rendu annoncait un succes en ayant laisse un fichier derriere.
  #
  # C'est le meme piege que j'avais decrit dix minutes plus tot a propos
  # d'un copier-coller dans un terminal. Le connaitre ne suffit pas ; il
  # faut le chercher partout ou un ssh vit dans une boucle.
  if ! ssh -n -i "${CLEF}" -o BatchMode=yes -o ConnectTimeout=20 \
       "${SERVEUR}" "lire ${nom}" > "${local_fichier}.partiel" 2>>/tmp/biblio-sauvegarde.err; then
    rm -f "${local_fichier}.partiel"; echecs=$((echecs + 1))
    echo "      ECHEC transfert"; continue
  fi

  # LE FICHIER EST-IL ENTIER ? « gzip -t » relit tout et verifie la somme
  # de controle. Un transfert coupe echoue ici, pas dans six mois.
  if ! gzip -t "${local_fichier}.partiel" 2>/dev/null; then
    rm -f "${local_fichier}.partiel"; echecs=$((echecs + 1))
    echo "      ECHEC archive incomplete, ecartee"; continue
  fi

  # Le nom definitif n'est pose qu'une fois le fichier verifie : ce qui
  # porte le bon nom dans ce dossier est utilisable, sans exception.
  mv -f "${local_fichier}.partiel" "${local_fichier}"
  rapatriees=$((rapatriees + 1))
done <<< "${liste}"

# --- Le menage local ------------------------------------------------------
#
# Soixante jours ici, quatorze sur le serveur : le poste est la memoire
# longue. On ne supprime jamais le dernier fichier.
restants=$(find "${DESTINATION}" -name 'biblio-*.sql.gz' | wc -l)
if [ "${restants}" -gt 1 ]; then
  find "${DESTINATION}" -name 'biblio-*.sql.gz' -mtime "+${RETENTION_JOURS}" -delete 2>/dev/null
fi

echo
ok "${rapatriees} rapatriee(s), ${ignorees} deja presente(s)"

# LE COMPTE DOIT TOMBER JUSTE. Rapatriees + deja presentes + echecs doit
# egaler ce que le serveur a annonce. Sans cette ligne, la boucle amputee du
# 16/08/2026 rendait un compte rendu tout a fait rassurant.
traitees=$((rapatriees + ignorees + echecs))
if [ "${traitees}" != "${annoncees}" ]; then
  echo "  ATTENTION ${traitees} sauvegarde(s) traitee(s) sur ${annoncees} annoncee(s)."
  echo "            Il en manque : relancez, et si l'ecart persiste, dites-le."
fi
[ "${echecs}" -gt 0 ] && echo "  ATTENTION ${echecs} echec(s) — voir /tmp/biblio-sauvegarde.err"

recent=$(find "${DESTINATION}" -name 'biblio-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
           | sort -rn | head -1 | cut -d' ' -f2-)
if [ -n "${recent}" ]; then
  age=$(( ( $(date +%s) - $(stat -c %Y "${recent}") ) / 86400 ))
  echo "  plus recente : $(basename "${recent}") — ${age} jour(s)"
  # LE SEUL CHIFFRE QUI COMPTE VRAIMENT. Une sauvegarde de trois jours n'est
  # pas une sauvegarde quotidienne, et il vaut mieux l'apprendre maintenant.
  [ "${age}" -gt 2 ] && echo "  ATTENTION la sauvegarde la plus recente a plus de deux jours."
else
  echo "  ATTENTION aucune sauvegarde sur ce poste."
fi

echo
echo "== FIN =="
echo "   Pour restaurer, voir docs/architecture-biblio.html — section « Les gestes »."
