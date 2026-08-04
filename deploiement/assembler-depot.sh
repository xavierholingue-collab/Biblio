#!/usr/bin/env bash
# =========================================================================
# Assemble le depot git ~/dev/biblio a partir du dossier OneDrive.
#
# Meme montage que Y-Factor : OneDrive est la SOURCE, le depot vit dans
# WSL. OneDrive synchronise en continu tout ce qu'il voit, y compris .git,
# et une synchronisation qui survient pendant une ecriture d'objet corrompt
# le depot — corruption qui ne se manifeste souvent qu'au commit suivant.
#
# SENS UNIQUE : OneDrive -> depot. Ne jamais editer dans ~/dev/biblio.
# =========================================================================

set -uo pipefail

SOURCE=/mnt/c/Users/xavie/OneDrive/Doc/Claude/Projects/Bibliographie
DEPOT=${DEPOT:-$HOME/dev/biblio}

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Assemblage du depot Biblio =="
echo "   source : ${SOURCE}"
echo "   depot  : ${DEPOT}"
echo

[ -d "${SOURCE}/docker" ] || echec "dossier source introuvable"

mkdir -p "${DEPOT}"/{api,web,db,deploiement,docs,.github/workflows}

# --- Le schema de la base ------------------------------------------------
#
# OUBLI CORRIGE le 04/08/2026 : une premiere version de ce script ne
# copiait pas db/. Sans 01-schema.sql, aucune table n'est creee sur le
# serveur — et l'erreur ne se manifeste qu'au premier appel de l'API, sous
# la forme d'un « relation books does not exist » qui ne dit pas d'ou il
# vient. C'est le depot GitHub existant qui l'a revele, pas ce script.
rsync -a --delete "${SOURCE}/docker/db/" "${DEPOT}/db/" || echec "recopie du schema"
[ -f "${DEPOT}/db/01-schema.sql" ] || echec "01-schema.sql absent apres recopie"
ok "db : schema present"

# --- L'API ---------------------------------------------------------------
# Le Dockerfile part avec : il decrit la version locale, qui reste
# utilisable sur le poste. Sur le VPS, c'est systemd qui lance node.
rsync -a --delete \
  --exclude='node_modules' --exclude='.env' \
  "${SOURCE}/docker/api/" "${DEPOT}/api/" || echec "recopie de l API"
ok "api : $(find "${DEPOT}/api" -name '*.js' -o -name '*.mjs' | wc -l) fichiers"

# --- Le web ---------------------------------------------------------------
#
# On EXCLUT web/test/ : ces tests s'executent, ils n'ont pas a etre servis.
# Caddy les ferme deja en 404, mais deux protections valent mieux qu'une —
# et surtout, ce qui n'est pas deploye ne peut pas fuir.
rsync -a --delete --delete-excluded \
  --exclude='test' \
  "${SOURCE}/docker/web/" "${DEPOT}/web/" || echec "recopie du web"
ok "web : $(ls -1 "${DEPOT}/web" | wc -l) fichiers"

# Les tests du web vivent a part, hors de ce qui est publie.
mkdir -p "${DEPOT}/tests"
rsync -a --delete "${SOURCE}/docker/web/test/" "${DEPOT}/tests/" 2>/dev/null
ok "tests : $(ls -1 "${DEPOT}/tests" 2>/dev/null | wc -l) fichiers"

# --- Deploiement, documentation, workflows -------------------------------
rsync -a --delete "${SOURCE}/deploiement/" "${DEPOT}/deploiement/" 2>/dev/null
ok "deploiement"

cp -f "${SOURCE}/docker/README-docker.md" "${DEPOT}/docs/" 2>/dev/null
cp -f "${SOURCE}/files/README-bibliotheque.md" "${DEPOT}/docs/" 2>/dev/null
ok "docs : $(ls -1 "${DEPOT}/docs"/*.md 2>/dev/null | wc -l) documents"

if [ -d "${SOURCE}/.github/workflows" ]; then
  rsync -a --delete "${SOURCE}/.github/workflows/" "${DEPOT}/.github/workflows/"
  ok "workflows : $(ls -1 "${DEPOT}/.github/workflows" | wc -l)"
else
  echo "  (aucun workflow pour l instant)"
fi

# --- Le fichier de configuration d'exemple -------------------------------
# Ce qui fait vivre la version LOCALE. Elle reste utilisable sur le poste :
# le VPS n'est pas un remplacement, c'est une seconde facon d'y acceder.
for f in .env.exemple .gitattributes docker-compose.yml nginx.conf \
         Demarrer.cmd Arreter.cmd Sauvegarder.cmd README.md; do
  cp -f "${SOURCE}/docker/${f}" "${DEPOT}/" 2>/dev/null
done
ok "version locale : $(ls -1 "${DEPOT}"/*.cmd 2>/dev/null | wc -l) scripts, compose, nginx"
cp -f "${SOURCE}/deploiement/gitignore.modele" "${DEPOT}/.gitignore" 2>/dev/null && ok ".gitignore"

# --- Le filet : rien de secret, rien de personnel ------------------------
#
# Deux dangers distincts.
#
#   Les SECRETS — clef Anthropic, mot de passe d'ouverture. Un secret
#   pousse reste dans l'historique apres suppression du fichier : il faut
#   le considerer comme divulgue et le revoquer.
#
#   Les DONNEES — seed/bibliotheque.json fait 772 ko et contient toute
#   votre bibliotheque, y compris la sphere Perso. Elle n'a rien a faire
#   dans un depot, meme prive : c'est precisement ce que l'application
#   protege derriere un mot de passe.
echo
echo "-- Ni secret ni donnee personnelle dans le depot --"

# Le motif doit distinguer un SECRET d'un CODE QUI MANIPULE un secret.
#
# Une premiere version cherchait « ^MOT_DE_PASSE=.+ » et signalait
# vps-installer-biblio.sh, qui contient « MOT_DE_PASSE=${ancien_mdp} » —
# une reference de variable dans le heredoc qui ECRIT le fichier
# d'environnement. Meme erreur que le 31/07/2026, ou le prefixe
# « sk-ant- » de la validation zod passait pour une clef.
#
# On exige donc une valeur LITTERALE : ni « $ » ni guillemet en tete, et
# au moins huit caracteres. Un vrai secret colle par megarde correspond ;
# une variable, non.
secrets=$(grep -rlE "sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{30,}|^(MOT_DE_PASSE|PGPASSWORD|ANTHROPIC_API_KEY)=[^\$\"'[:space:]]{8,}" \
  "${DEPOT}" --exclude-dir=.git --exclude-dir=node_modules --exclude='*.exemple' 2>/dev/null | head -5)
if [ -n "${secrets}" ]; then
  echo "  ALERTE valeurs sensibles trouvees :"
  printf '%s\n' "${secrets}" | sed 's/^/         /'
  echo "  NE PAS POUSSER."
  exit 1
fi
ok "aucun secret"

donnees=$(find "${DEPOT}" -name 'bibliotheque.json' -o -name '*.dump' -o -name 'Biblio_export*' 2>/dev/null | head -3)
if [ -n "${donnees}" ]; then
  echo "  ALERTE donnees de bibliotheque presentes :"
  printf '%s\n' "${donnees}" | sed 's/^/         /'
  echo "  NE PAS POUSSER."
  exit 1
fi
ok "aucune donnee de bibliotheque"

echo
echo "-- Etat du depot --"
cd "${DEPOT}" || exit 1
if [ -d .git ]; then
  git status --short | head -20
else
  echo "  depot non initialise :"
  echo "    cd ${DEPOT} && git init -b main && git add -A && git commit -m 'Socle'"
  echo "    git remote add origin https://github.com/xavierholingue-collab/Biblio.git"
fi

echo
echo "== FIN =="
