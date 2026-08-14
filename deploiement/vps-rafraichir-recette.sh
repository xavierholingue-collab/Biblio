#!/usr/bin/env bash
# =========================================================================
# REMPLIR LA RECETTE AVEC UNE COPIE DE LA PRODUCTION
#
# Une recette vide ne sert a rien : elle ne montre ni les accents, ni les
# editeurs manquants, ni les trois ASIN deguises en ISBN, ni les cas que
# personne n'a pense a inventer. Un banc d'essai sur donnees inventees ne
# rencontre que les problemes qu'on avait deja imagines.
#
# ---------------------------------------------------------------------------
# LE SENS EST UNIQUE, ET C'EST VERIFIE TROIS FOIS
#
#   production ---> recette          jamais l'inverse
#
# Une copie qui partirait dans l'autre sens ecraserait la vraie
# bibliotheque par des donnees d'essai. C'est la seule facon dont ce script
# pourrait faire des degats, donc c'est ce qu'on verifie le plus.
#
# ---------------------------------------------------------------------------
# CE QUE CETTE COPIE IMPLIQUE, ET QU'IL FAUT SAVOIR
#
# La recette contiendra une copie complete de votre bibliotheque, sphere
# personnelle comprise. Elle est protegee par un mot de passe HTTP et par
# celui de l'application, mais cela fait un deuxieme endroit ou ces donnees
# existent. C'est un choix : le prix a payer pour eprouver les migrations
# sur du reel plutot que sur de l'invente.
#
# USAGE (en root sur le VPS)
#   bash vps-rafraichir-recette.sh
# =========================================================================

set -uo pipefail

# Meme raison que dans l'installeur : « could not change directory to /root »
# a chaque appel de sudo -u postgres brouille une sortie qu'on lit pour y
# reperer des anomalies.
cd / || exit 1

SOURCE=biblio
CIBLE=biblio_recette
SERVICE=biblio-recette-api
ENVF=/etc/biblio-recette/env

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Rafraichissement de la recette =="
echo "   ${SOURCE} --> ${CIBLE}"
echo

# --- LE SENS DE LA COPIE, verifie avant tout -----------------------------
[ "${CIBLE}" != "biblio" ] || echec "la cible est la PRODUCTION. Rien n'a ete fait."
[ "${SOURCE}" != "${CIBLE}" ] || echec "source et cible identiques."
case "${CIBLE}" in
  *recette*) ;;
  *) echec "la cible « ${CIBLE} » ne ressemble pas a une recette." ;;
esac
ok "sens de la copie : production -> recette"

[ -f "${ENVF}" ] || echec "${ENVF} absent — la recette n'est pas installee."
MDP_PG=$(sed -n 's/^PGPASSWORD=//p' "${ENVF}")
[ -n "${MDP_PG}" ] || echec "PGPASSWORD introuvable dans ${ENVF}"

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${SOURCE}'" \
  | grep -q 1 || echec "la base ${SOURCE} n'existe pas"

# --- Combien y a-t-il a copier ? -----------------------------------------
#
# Mesure AVANT, par un compte privilegie. Le compte applicatif est soumis
# au cloisonnement : il ne verrait que les ouvrages publics, et le compte
# rendu final annoncerait fierement d'avoir copie un tiers de la
# bibliotheque sans que rien ne le signale.
avant=$(sudo -u postgres psql -tAd "${SOURCE}" -c \
  "select count(*) from possessions" 2>/dev/null \
  || sudo -u postgres psql -tAd "${SOURCE}" -c "select count(*) from books" 2>/dev/null)
[ -n "${avant}" ] || echec "impossible de compter les ouvrages de ${SOURCE}"
echo "  ${avant} ouvrages en production"

# --- L'arret du service, le temps de la copie ----------------------------
#
# Une base qu'on remplace sous les pieds d'une application donne des
# erreurs incomprehensibles. On l'arrete, et on la redemarre quoi qu'il
# arrive — y compris si la copie echoue.
etait_actif=$(systemctl is-active "${SERVICE}" 2>/dev/null)
relancer() {
  if [ "${etait_actif}" = "active" ]; then
    systemctl start "${SERVICE}" 2>/dev/null && echo "  ${SERVICE} redemarre"
  fi
}
trap relancer EXIT INT TERM
[ "${etait_actif}" = "active" ] && { systemctl stop "${SERVICE}"; echo "  ${SERVICE} arrete"; }

# --- La copie ------------------------------------------------------------
#
# On passe par un dump plutot que par « createdb --template » : le modele
# exige zero connexion a la base source, or l'API de production y est
# connectee en permanence. L'arreter pour rafraichir la recette serait
# absurde — la recette existe justement pour ne pas deranger la production.
TMP=$(mktemp -d); chmod 700 "${TMP}"
trap 'rm -rf "${TMP}"; relancer' EXIT INT TERM

echo "  copie en cours..."
if ! PGPASSWORD="${MDP_PG}" pg_dump -h 127.0.0.1 -U biblio -d "${SOURCE}" \
     > "${TMP}/copie.sql" 2>"${TMP}/erreur.log"; then
  echo "  ECHEC lecture de ${SOURCE} :"; tail -3 "${TMP}/erreur.log" | sed 's/^/         /'
  exit 1
fi
[ -s "${TMP}/copie.sql" ] || echec "la copie est vide"
ok "copie lue ($(du -h "${TMP}/copie.sql" | cut -f1))"

sudo -u postgres dropdb --if-exists "${CIBLE}" || echec "suppression de ${CIBLE}"
sudo -u postgres createdb -O biblio "${CIBLE}" || echec "recreation de ${CIBLE}"

if ! sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "${CIBLE}" \
     < "${TMP}/copie.sql" >"${TMP}/restaure.log" 2>&1; then
  echo "  ECHEC ecriture dans ${CIBLE} :"; tail -5 "${TMP}/restaure.log" | sed 's/^/         /'
  exit 1
fi

# --- Le proprietaire a-t-il survecu ? ------------------------------------
#
# pg_dump emet des « OWNER TO biblio », mais s'ils sautaient, les tables
# appartiendraient a postgres — et « force row level security » ne
# porterait plus sur le compte applicatif. La recette montrerait alors a
# chacun la bibliotheque de tous, sans que rien ne le signale.
proprio=$(sudo -u postgres psql -tAd "${CIBLE}" -c \
  "select tableowner from pg_tables where tablename in ('books','possessions') limit 1")
[ "${proprio}" = "biblio" ] \
  || echec "les tables de ${CIBLE} appartiennent a « ${proprio:-inconnu} », pas a biblio"
ok "proprietaire des tables : biblio"

# --- AUTANT D'OUVRAGES DES DEUX COTES ? ----------------------------------
apres=$(sudo -u postgres psql -tAd "${CIBLE}" -c \
  "select count(*) from possessions" 2>/dev/null \
  || sudo -u postgres psql -tAd "${CIBLE}" -c "select count(*) from books" 2>/dev/null)
[ "${apres}" = "${avant}" ] \
  || echec "copie incomplete : ${avant} en production, ${apres} en recette"
ok "${apres} ouvrages copies, aucun ecart"

# --- LES SECRETS DE LA RECETTE RESTENT LES SIENS -------------------------
#
# La copie a apporte les locataires et leurs comptes. Les LIENS DE
# CONNEXION en cours, eux, n'ont rien a faire ici : un lien magique emis
# pour la production ouvrirait la recette, et inversement. On les efface.
sudo -u postgres psql -q -d "${CIBLE}" -c "delete from liens_connexion" 2>/dev/null \
  && ok "liens de connexion en cours effaces"

echo
echo "== FIN =="
echo "  La recette contient une copie de votre bibliotheque."
echo "  Mot de passe d'ouverture : celui de ${ENVF}, DISTINCT de la production."
