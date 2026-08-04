#!/usr/bin/env bash
# =========================================================================
# Installe Biblio sur le VPS, a cote de SupPerf et d'Adapsis.
#
# S'EXECUTE SUR LE VPS.
#
# CHOIX D'ARCHITECTURE : pas de Docker.
#
#   La version locale tourne en conteneurs — c'etait le bon choix sur un
#   poste Windows. Sur ce serveur, ce serait un SECOND PostgreSQL, une
#   seconde logique de sauvegarde et une seconde facon de deployer, a cote
#   de ce qui existe deja. L'API n'ayant qu'une dependance — pg — le
#   portage ne coute presque rien et rend Biblio justiciable des memes
#   sauvegardes, du meme cloisonnement et de la meme chaine de livraison.
#
# NE TOUCHE A RIEN D'EXISTANT : ni supperf, ni adapsis, ni leurs bases.
# Verifie en fin de course que les trois sont intacts.
#
# IDEMPOTENT.
# =========================================================================

set -uo pipefail

PORT=3006
ENVF=/etc/biblio/env
RACINE_API=/opt/biblio-api
RACINE_WEB=/var/www/biblio

ok()    { printf '  OK      %s\n' "$1"; }
info()  { printf '  ...     %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Installation de Biblio =="

# --- 0. Etat de reference AVANT ------------------------------------------
avant_adapsis=$(systemctl is-active adapsis-api 2>/dev/null)
avant_supperf=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://supperf.io 2>/dev/null)

# --- 1. Node ---------------------------------------------------------------
# L'API exige Node >= 22. Le refuser tot evite un service qui demarre puis
# echoue sur une syntaxe non reconnue.
version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
[ -z "${version}" ] && echec "node introuvable"
[ "${version}" -ge 22 ] || echec "node ${version} : l API exige 22 ou plus"
ok "node v$(node --version | sed 's/^v//')"

# --- 2. Base et role -------------------------------------------------------
echo
echo "-- Base biblio --"
MDP=$(openssl rand -hex 24)

role_existe() { sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$1'" 2>/dev/null; }
base_existe() { sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$1'" 2>/dev/null; }

if [ "$(role_existe biblio)" = "1" ]; then
  sudo -u postgres psql -qc "ALTER ROLE biblio WITH LOGIN PASSWORD '${MDP}'" >/dev/null
  info "role existant, mot de passe renouvele"
else
  sudo -u postgres psql -qc "CREATE ROLE biblio WITH LOGIN PASSWORD '${MDP}'" >/dev/null
  ok "role cree"
fi

if [ "$(base_existe biblio)" = "1" ]; then
  info "base deja presente"
else
  sudo -u postgres createdb -O biblio biblio && ok "base creee"
fi

# --- 3. Cloisonnement ------------------------------------------------------
#
# PostgreSQL accorde CONNECT a PUBLIC par defaut. Sans ces revocations,
# le role biblio pourrait lire les passations psychometriques d'Adapsis et
# les 67 tables de supperf. C'est ainsi que le role adapsis voyait supperf
# avant qu'on ne s'en apercoive.
echo
echo "-- Cloisonnement --"
sudo -u postgres psql -q <<'SQL' >/dev/null
REVOKE CONNECT ON DATABASE biblio FROM PUBLIC;
GRANT  CONNECT ON DATABASE biblio TO   biblio;
SQL
sudo -u postgres psql -q -d biblio <<'SQL' >/dev/null
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT  ALL ON SCHEMA public TO   biblio;
SQL

# Preuve, pas affirmation : on TENTE les connexions interdites.
for cible in adapsis adapsis_recette supperf; do
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${cible}'" 2>/dev/null | grep -q 1 || continue
  if PGPASSWORD="${MDP}" psql -h 127.0.0.1 -U biblio -d "${cible}" -tAc 'SELECT 1' >/dev/null 2>&1; then
    echec "le role biblio accede a ${cible} — cloisonnement en defaut"
  fi
  ok "acces a ${cible} refuse (verifie)"
done

# Et l'inverse : les autres ne doivent pas voir biblio.
sudo -u postgres psql -q -c "REVOKE CONNECT ON DATABASE biblio FROM adapsis, adapsis_recette" >/dev/null 2>&1
ok "adapsis ne voit pas biblio"

# --- 4. Emplacements -------------------------------------------------------
install -d -m 755 "${RACINE_API}" "${RACINE_WEB}"
install -d -m 700 /etc/biblio
ok "${RACINE_API} et ${RACINE_WEB}"

# --- 5. Configuration ------------------------------------------------------
#
# On CONSERVE le mot de passe d'ouverture s'il existe deja : le renouveler
# a chaque execution deconnecterait sans prevenir.
echo
echo "-- Configuration --"
ancien_mdp=$(sed -n 's/^MOT_DE_PASSE=//p' "${ENVF}" 2>/dev/null)

umask 077
cat > "${ENVF}" <<ENV
PORT=${PORT}
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=biblio
PGPASSWORD=${MDP}
PGDATABASE=biblio
MODELE=claude-sonnet-5
MOT_DE_PASSE=${ancien_mdp}
ANTHROPIC_API_KEY=$(sed -n 's/^ANTHROPIC_API_KEY=//p' "${ENVF}" 2>/dev/null)
DERRIERE_PROXY=1
ENV
chmod 600 "${ENVF}"
umask 022
unset MDP
ok "${ENVF} ecrit (chmod 600)"

[ -z "${ancien_mdp}" ] && echo "  A FAIRE MOT_DE_PASSE est vide : l API refusera de demarrer."
grep -q '^ANTHROPIC_API_KEY=.\+' "${ENVF}" || \
  echo "  A FAIRE ANTHROPIC_API_KEY absente : resumes et recommandations indisponibles."

# --- 6. Service ------------------------------------------------------------
cat > /etc/systemd/system/biblio-api.service <<'UNIT'
[Unit]
Description=API Biblio
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/biblio-api
EnvironmentFile=/etc/biblio/env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
User=root

ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/biblio-api
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable biblio-api >/dev/null 2>&1
ok "unite systemd installee (non demarree : pas encore de code)"

# --- 7. L'existant est-il intact ? ----------------------------------------
echo
echo "-- Ce qui tournait avant tourne-t-il encore ? --"
apres_adapsis=$(systemctl is-active adapsis-api 2>/dev/null)
apres_supperf=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://supperf.io 2>/dev/null)

[ "${apres_adapsis}" = "${avant_adapsis}" ] \
  && ok "adapsis-api : ${apres_adapsis}, inchange" \
  || echec "adapsis-api : ${avant_adapsis} -> ${apres_adapsis}"
[ "${apres_supperf}" = "${avant_supperf}" ] \
  && ok "supperf.io : ${apres_supperf}, inchange" \
  || echec "supperf.io : ${avant_supperf} -> ${apres_supperf}"

echo
echo "== FIN =="
echo "   Reste a : poser MOT_DE_PASSE et ANTHROPIC_API_KEY dans ${ENVF},"
echo "             deployer le code, ajouter le bloc Caddy."
