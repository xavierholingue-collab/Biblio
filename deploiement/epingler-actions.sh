#!/usr/bin/env bash
# =========================================================================
# EPINGLER LES ACTIONS GITHUB SUR L'EMPREINTE DE LEUR COMMIT
#
# « actions/checkout@v7 » designe une ETIQUETTE, et une etiquette se
# deplace. Celui qui la controle peut donc changer le code execute par la
# chaine de livraison sans que rien ne bouge dans ce depot.
#
# Ce n'est pas theorique : le travail de production detient la clef SSH de
# deploiement et le secret de session. Une action compromise s'execute avec
# eux. Le risque reste faible — ce sont des actions publiees par GitHub —
# mais il ne coute rien a supprimer.
#
# ---------------------------------------------------------------------------
# LES EMPREINTES SONT LUES CHEZ GITHUB, PAS ECRITES A LA MAIN
#
# Recopier une empreinte de memoire est le meilleur moyen d'arreter la
# chaine sur une erreur qu'on mettra une heure a comprendre — ou pire, de
# la faire pointer ailleurs. « git ls-remote » la demande a la source, sans
# jeton ni authentification.
#
# ATTENTION AUX ETIQUETTES ANNOTEES : « git ls-remote --tags » rend alors
# l'empreinte de l'OBJET etiquette, pas celle du commit. La ligne « ^{} »
# porte le commit reel. On prend celle-la quand elle existe.
#
# ---------------------------------------------------------------------------
# LE NUMERO DE VERSION RESTE EN COMMENTAIRE. Une empreinte seule ne se lit
# pas : dans six mois, « @8f4b7f8… » ne dira rien a personne, et on ne saura
# plus si la version est ancienne. « # v7 » a cote suffit.
#
# REJOUABLE : relancer ce script met a jour les empreintes vers l'etat
# actuel des memes etiquettes. C'est ainsi qu'on suit les correctifs.
#
# USAGE (depuis WSL, dans le dossier OneDrive du projet)
#   bash deploiement/epingler-actions.sh
#   bash deploiement/epingler-actions.sh --verifier    (ne modifie rien)
# =========================================================================

set -uo pipefail

SOURCE=/mnt/c/Users/xavie/OneDrive/Doc/Claude/Projects/Bibliographie
DOSSIER="${SOURCE}/.github/workflows"

VERIFIER=0
[ "${1:-}" = "--verifier" ] && VERIFIER=1

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Epinglage des actions GitHub =="
[ -d "${DOSSIER}" ] || echec "${DOSSIER} introuvable"
command -v git >/dev/null || echec "git est necessaire pour lire les empreintes"

# --- Les actions referencees, avec leur etiquette ------------------------
#
# On ne touche QUE les references par etiquette (« @v7 »). Une reference
# deja epinglee — quarante caracteres hexadecimaux — est laissee telle
# quelle : la reresoudre ferait perdre l'epinglage a chaque execution.
mapfile -t REFS < <(grep -rhoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@v[0-9][A-Za-z0-9_.-]*' \
                      "${DOSSIER}" | sed 's/^uses: //' | sort -u)

if [ ${#REFS[@]} -eq 0 ]; then
  ok "aucune action referencee par etiquette : rien a faire"
  exit 0
fi

echo "  ${#REFS[@]} action(s) a resoudre"
echo

modifiees=0
for ref in "${REFS[@]}"; do
  depot="${ref%@*}"
  etiquette="${ref##*@}"

  # « ^{} » d'abord : c'est le commit reel d'une etiquette annotee.
  sortie=$(git ls-remote --tags "https://github.com/${depot}" \
             "refs/tags/${etiquette}" "refs/tags/${etiquette}^{}" 2>/dev/null)
  [ -n "${sortie}" ] || echec "impossible de lire ${depot} (reseau ? depot renomme ?)"

  empreinte=$(printf '%s\n' "${sortie}" | awk '/\^\{\}$/ { print $1 }' | head -1)
  [ -n "${empreinte}" ] || empreinte=$(printf '%s\n' "${sortie}" | awk 'NR==1 { print $1 }')

  case "${empreinte}" in
    [0-9a-f]*) [ ${#empreinte} -eq 40 ] || echec "empreinte inattendue pour ${ref} : ${empreinte}" ;;
    *) echec "empreinte illisible pour ${ref} : ${empreinte}" ;;
  esac

  printf '  %-42s %s  # %s\n' "${depot}" "${empreinte:0:12}…" "${etiquette}"

  if [ "${VERIFIER}" = "0" ]; then
    # Le commentaire de version peut deja exister : on le remplace, sans
    # quoi on empilerait « # v7 # v7 » a chaque execution.
    for fichier in "${DOSSIER}"/*.yml; do
      sed -i -E "s|uses: ${depot}@${etiquette}([[:space:]]*#[^\$]*)?$|uses: ${depot}@${empreinte}  # ${etiquette}|" \
        "${fichier}"
    done
    modifiees=$((modifiees + 1))
  fi
done

echo
if [ "${VERIFIER}" = "1" ]; then
  ok "verification seule : aucun fichier modifie"
  exit 0
fi

# --- Le filet : le fichier doit rester du YAML lisible -------------------
#
# Un sed qui derape ne se voit qu'a la livraison suivante, sous la forme
# d'un workflow qui ne demarre pas. Python est present partout ou ce script
# tourne ; s'il manque, on le dit plutot que de conclure au succes.
if command -v python3 >/dev/null; then
  for fichier in "${DOSSIER}"/*.yml; do
    python3 -c "import sys,yaml; yaml.safe_load(open(sys.argv[1],encoding='utf-8'))" "${fichier}" \
      2>/dev/null && ok "$(basename "${fichier}") : YAML valide" \
      || echo "  ATTENTION $(basename "${fichier}") : YAML illisible OU module yaml absent"
  done
else
  echo "  ATTENTION python3 absent : la validite du YAML n'a pas ete verifiee"
fi

restantes=$(grep -rhoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@v[0-9]' "${DOSSIER}" | wc -l)
[ "${restantes}" -eq 0 ] \
  && ok "plus aucune action referencee par etiquette" \
  || echo "  ATTENTION ${restantes} reference(s) par etiquette subsistent"

echo
echo "== FIN — ${modifiees} action(s) epinglee(s) =="
echo "   Relisez le diff avant de pousser :  git -C ~/dev/biblio diff"
