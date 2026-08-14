#!/usr/bin/env bash
# =========================================================================
# L'ENVIRONNEMENT DE RECETTE DE BIBLIO
#
# biblio-recette.xavier-holingue.eu — port 3007, base biblio_recette,
# service biblio-recette-api. Rien de partage avec la production : c'est
# la condition pour qu'une betise en recette ne puisse pas l'atteindre.
#
# ---------------------------------------------------------------------------
# QUATRE PROPRIETES, ET CE QU'IL EN COUTE DE LES OUBLIER
#
# 1. LA RECETTE NE DEPENSE PAS D'ARGENT. ANTHROPIC_API_KEY reste VIDE. Un
#    environnement d'essai qui appelle un service payant finit toujours par
#    etre lance en boucle, et la facture arrive sans qu'on sache pourquoi.
#    Pour eprouver les resumes, on pose la clef a la main, le temps voulu.
#
# 2. ELLE N'EST PAS PUBLIQUE. Mot de passe HTTP au niveau de Caddy, plus
#    « X-Robots-Tag: noindex ». Sans cela, une version a moitie finie
#    apparait dans les moteurs de recherche — et une page de recette
#    indexee raconte a tout le monde ce qui n'est pas encore sorti.
#
# 3. SES SECRETS SONT DISTINCTS. Mot de passe d'ouverture et secret de
#    session lui sont propres. Les partager reviendrait a dire qu'une fuite
#    en recette est une fuite en production.
#
# 4. ELLE SE VOIT. L'API annonce ENVIRONNEMENT=recette, et les pages
#    affichent un bandeau. On efface un jour des donnees en croyant etre
#    ailleurs ; autant que « ailleurs » soit ecrit en haut de l'ecran.
#
# ---------------------------------------------------------------------------
# CE SCRIPT NE TOUCHE JAMAIS A LA PRODUCTION. Il refuse de s'executer s'il
# detecte qu'il ecrirait sur un chemin de production.
#
# USAGE (en root sur le VPS)
#   bash vps-installer-recette-biblio.sh
# =========================================================================

set -uo pipefail

# « could not change directory to "/root" » : l'utilisateur postgres n'a pas
# le droit d'entrer dans /root, et chaque « sudo -u postgres » le signale.
# C'est sans consequence, mais du bruit dans une sortie qu'on lit pour y
# reperer des anomalies finit par masquer les vraies.
cd / || exit 1

REFAIRE_HTTP=0
for arg in "$@"; do
  case "${arg}" in
    --refaire-le-mot-de-passe-http) REFAIRE_HTTP=1 ;;
    *) echo "Option inconnue : ${arg}"; exit 1 ;;
  esac
done

PORT=3007
BASE=biblio_recette
SERVICE=biblio-recette-api
ENVF=/etc/biblio-recette/env
RACINE_API=/opt/biblio-recette-api
RACINE_WEB=/var/www/biblio-recette
DOMAINE=biblio-recette.xavier-holingue.eu

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Installation de la recette Biblio =="
echo

# --- 0. LE GARDE-FOU : rien de ce qui suit ne doit viser la production ----
#
# Une faute de frappe dans une des variables ci-dessus ecraserait la
# configuration en service. On le verifie AVANT d'ecrire quoi que ce soit,
# pas apres.
for chemin in "${ENVF}" "${RACINE_API}" "${RACINE_WEB}"; do
  case "${chemin}" in
    /etc/biblio/env|/opt/biblio-api|/var/www/biblio)
      echec "« ${chemin} » est un chemin de PRODUCTION. Rien n'a ete ecrit." ;;
  esac
done
[ "${BASE}" = "biblio" ] && echec "la base visee est celle de production."
[ "${SERVICE}" = "biblio-api" ] && echec "le service vise est celui de production."
[ "${PORT}" = "3006" ] && echec "le port vise est celui de production."
ok "aucun chemin de production dans la cible"

# --- 0 bis. L'etat d'avant, pour pouvoir le comparer apres ---------------
avant_prod=$(systemctl is-active biblio-api 2>/dev/null)
avant_page=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
             https://biblio.xavier-holingue.eu 2>/dev/null)
echo "  avant : biblio-api ${avant_prod}, page ${avant_page}"

# --- 1. La base ----------------------------------------------------------
echo
echo "-- La base --"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${BASE}'" | grep -q 1; then
  ok "${BASE} existe deja, conservee"
else
  sudo -u postgres createdb -O biblio "${BASE}" || echec "creation de ${BASE}"
  ok "${BASE} creee, proprietaire biblio"
fi

# Le compte applicatif est le MEME role qu'en production — c'est ce qui
# rend la recette representative : les tables lui appartiennent, et
# « force row level security » l'y soumet exactement pareil.
MDP_PG=$(sed -n 's/^PGPASSWORD=//p' /etc/biblio/env 2>/dev/null)
[ -n "${MDP_PG}" ] || echec "PGPASSWORD introuvable dans /etc/biblio/env"

# --- 2. Les dossiers -----------------------------------------------------
install -d -m 755 "${RACINE_API}" "${RACINE_WEB}"
install -d -m 700 "$(dirname "${ENVF}")"
ok "${RACINE_API} et ${RACINE_WEB}"

# --- 3. La configuration -------------------------------------------------
#
# On CONSERVE ce qui existe deja. Regenerer le mot de passe a chaque
# execution deconnecterait sans prevenir, et regenerer SECRET_SESSION
# ferait tomber toutes les sessions — c'est l'erreur du 12/08/2026 avec la
# clef SSH, sous une autre forme.
echo
echo "-- Configuration --"
ancien_mdp=$(sed -n 's/^MOT_DE_PASSE=//p' "${ENVF}" 2>/dev/null)
ancien_sec=$(sed -n 's/^SECRET_SESSION=//p' "${ENVF}" 2>/dev/null)
ancienne_cle=$(sed -n 's/^ANTHROPIC_API_KEY=//p' "${ENVF}" 2>/dev/null)

nouveau_mdp=0
if [ -z "${ancien_mdp}" ]; then
  ancien_mdp=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  nouveau_mdp=1
fi
[ -z "${ancien_sec}" ] && ancien_sec=$(openssl rand -base64 48 | tr -d '\n')

umask 077
cat > "${ENVF}" <<ENV
PORT=${PORT}
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=biblio
PGPASSWORD=${MDP_PG}
PGDATABASE=${BASE}
MODELE=claude-sonnet-5
MOT_DE_PASSE=${ancien_mdp}
SECRET_SESSION=${ancien_sec}
DERRIERE_PROXY=1
TENANT_DEFAUT=xavier

# L'environnement s'annonce : l'API le renvoie, les pages affichent un
# bandeau. On efface un jour des donnees en croyant etre ailleurs.
ENVIRONNEMENT=recette

# VIDE DELIBEREMENT. Une recette qui appelle un service payant finit lancee
# en boucle, et la facture arrive sans qu'on sache pourquoi. Pour eprouver
# les resumes : poser la clef ici, redemarrer, ESSAYER, puis la retirer.
ANTHROPIC_API_KEY=${ancienne_cle}
ENV
chmod 600 "${ENVF}"
umask 022
ok "${ENVF} ecrit (chmod 600)"

# --- 4. Le service -------------------------------------------------------
cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=API Biblio (recette)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${RACINE_API}
EnvironmentFile=${ENVF}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
User=root

ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=${RACINE_API}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1
ok "unite systemd ${SERVICE} installee (non demarree : pas encore de code)"

# --- 5. Le mot de passe HTTP ---------------------------------------------
#
# Caddy attend un condensat bcrypt. On le fabrique une seule fois : le
# refaire a chaque execution changerait le mot de passe en silence.
echo
echo "-- Acces HTTP --"
# LE MOT DE PASSE HTTP EST IRRECUPERABLE une fois pose : Caddy n'en garde
# qu'un condensat bcrypt, et c'est bien ce qu'on veut. La seule facon de le
# retrouver est donc de le REFAIRE — d'ou cette option.
FICHIER_AUTH=/etc/caddy/recette-biblio-auth.conf
if [ -f "${FICHIER_AUTH}" ] && [ "${REFAIRE_HTTP}" = "0" ]; then
  ok "mot de passe HTTP deja pose, conserve"
  echo "         (--refaire-le-mot-de-passe-http si vous l'avez perdu)"
  MDP_HTTP=""
else
  MDP_HTTP=$(openssl rand -base64 15 | tr -d '/+=' | cut -c1-16)
  HACHE=$(caddy hash-password --plaintext "${MDP_HTTP}" 2>/dev/null)
  [ -n "${HACHE}" ] || echec "caddy hash-password a echoue"
  umask 077
  cat > "${FICHIER_AUTH}" <<AUTH
basic_auth {
	recette ${HACHE}
}
AUTH
  umask 022
  chmod 640 "${FICHIER_AUTH}"
  chgrp caddy "${FICHIER_AUTH}" 2>/dev/null
  ok "mot de passe HTTP cree"
fi

# --- 6. Le bloc Caddy ----------------------------------------------------
#
# Dans un fichier a part, importe par le Caddyfile : ainsi la recette ne
# peut pas casser la configuration de la production par une faute de
# syntaxe — « caddy validate » refuserait, et on remet en place.
echo
echo "-- Caddy --"
BLOC=/etc/caddy/recette-biblio.caddy
cp -a "${BLOC}" "${BLOC}.precedent" 2>/dev/null

cat > "${BLOC}" <<CADDY
# La recette de Biblio. Genere par vps-installer-recette-biblio.sh.
${DOMAINE} {
	encode zstd gzip

	# Le mot de passe protege TOUT, y compris l'API : sans cela, les
	# routes resteraient ouvertes et la page seule serait fermee.
	import ${FICHIER_AUTH}

	handle /api/* {
		reverse_proxy 127.0.0.1:${PORT} {
			transport http {
				read_timeout 180s
				write_timeout 180s
			}
		}
	}

	@interdit path /test/* /node_modules/*
	handle @interdit {
		respond 404
	}

	handle {
		root * ${RACINE_WEB}
		file_server

		# L'import reste au NIVEAU DU HANDLE, jamais dans header { } :
		# Caddy y attend des noms d'en-tetes et poserait un en-tete
		# nomme « import », faisant disparaitre la politique entiere.
		# C'est la panne du 14/08/2026.
		import /etc/caddy/csp-biblio-recette.conf

		header {
			X-Content-Type-Options "nosniff"
			X-Frame-Options "DENY"
			Referrer-Policy "no-referrer"
			Strict-Transport-Security "max-age=31536000; includeSubDomains"
			Cache-Control "no-cache"
			# Une recette indexee raconte a tout le monde ce qui n'est
			# pas encore sorti.
			X-Robots-Tag "noindex, nofollow, noarchive"
			-Server
		}
	}
}
CADDY

# Une politique de contenu vide au depart : le deploiement la recalculera.
[ -f /etc/caddy/csp-biblio-recette.conf ] || : > /etc/caddy/csp-biblio-recette.conf

if ! grep -q "import ${BLOC}" /etc/caddy/Caddyfile 2>/dev/null; then
  printf '\nimport %s\n' "${BLOC}" >> /etc/caddy/Caddyfile
fi

if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-recette.log 2>&1; then
  systemctl reload caddy && ok "Caddy recharge"
else
  echo "  ECHEC Caddy refuse la configuration :"
  tail -8 /tmp/caddy-recette.log | sed 's/^/         /'
  # RETOUR ARRIERE. Une recette qui casse la production est pire que pas
  # de recette du tout.
  if [ -f "${BLOC}.precedent" ]; then mv "${BLOC}.precedent" "${BLOC}"
  else rm -f "${BLOC}"; sed -i "\\|import ${BLOC}|d" /etc/caddy/Caddyfile; fi
  systemctl reload caddy || true
  echec "configuration precedente retablie"
fi

# --- 7. LA PRODUCTION EST-ELLE INTACTE ? ---------------------------------
#
# La question qui compte. Monter une recette n'a aucun interet si cela
# derange ce qui tourne.
echo
echo "-- Ce qui tournait avant tourne-t-il encore ? --"
apres_prod=$(systemctl is-active biblio-api 2>/dev/null)
apres_page=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
             https://biblio.xavier-holingue.eu 2>/dev/null)

[ "${apres_prod}" = "${avant_prod}" ] \
  && ok "biblio-api : ${apres_prod}, inchange" \
  || echec "biblio-api : ${avant_prod} -> ${apres_prod}"

[ "${apres_page}" = "${avant_page}" ] \
  && ok "biblio.xavier-holingue.eu : ${apres_page}, inchange" \
  || echo "  A VOIR  biblio.xavier-holingue.eu : ${avant_page} -> ${apres_page}"

# La politique de contenu de la PRODUCTION doit toujours etre servie.
csp=$(curl -sI --max-time 20 https://biblio.xavier-holingue.eu/ 2>/dev/null \
      | grep -ic '^content-security-policy:')
[ "${csp}" -ge 1 ] \
  && ok "politique de contenu toujours servie en production" \
  || echo "  A VOIR  la production ne sert plus de politique de contenu"

# --- CE QU'IL RESTE A FAIRE, CONSTATE ET NON RECITE ----------------------
#
# Une premiere version recitait une liste figee — « poser le DNS », « mettre
# a jour la clef » — y compris quand c'etait deja fait. Une consigne qui ne
# regarde pas l'etat reel finit par etre survolee, et le jour ou elle dit
# quelque chose d'important, on ne la lit plus.
echo
echo "-- Ce qu'il reste a faire --"

ip_dns=$(getent hosts "${DOMAINE}" 2>/dev/null | awk '{print $1; exit}')
mon_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "${ip_dns}" ]; then
  echo "  A FAIRE  DNS : ${DOMAINE} ne resout pas encore"
elif [ "${ip_dns}" = "${mon_ip}" ] || [ "${ip_dns}" = "195.110.35.206" ]; then
  ok "DNS : ${DOMAINE} -> ${ip_dns}"
else
  echo "  A VOIR   DNS : ${DOMAINE} -> ${ip_dns}, or ce serveur est ${mon_ip}"
fi

if grep -q '"deployer biblio-recette"' /usr/local/bin/deployer-biblio 2>/dev/null; then
  ok "la clef de deploiement accepte « deployer biblio-recette »"
else
  echo "  A FAIRE  le deployeur ne connait pas encore « deployer biblio-recette »"
  echo "           envoyer vps-deployer-biblio.sh puis relancer vps-poser-cle-biblio.sh"
fi

nb=$(sudo -u postgres psql -tAd "${BASE}" -c \
  "select count(*) from possessions" 2>/dev/null \
  || sudo -u postgres psql -tAd "${BASE}" -c "select count(*) from books" 2>/dev/null)
if [ -n "${nb}" ] && [ "${nb}" -gt 0 ] 2>/dev/null; then
  ok "la base contient ${nb} ouvrages"
else
  echo "  A FAIRE  base vide :  bash /root/vps-rafraichir-recette.sh"
fi

if systemctl is-active "${SERVICE}" >/dev/null 2>&1; then
  ok "${SERVICE} tourne"
else
  echo "  A FAIRE  premier deploiement depuis GitHub (le service attend son code)"
fi

# --- Les secrets, affiches SEULEMENT s'il y a quelque chose a montrer ----
#
# « Notez-les MAINTENANT » sous une liste vide est un message qui ment. On
# ne l'ecrit que quand il y a effectivement quelque chose a noter.
if [ "${nouveau_mdp}" = "1" ] || [ -n "${MDP_HTTP}" ]; then
  echo
  echo "=========================================================================="
  echo " A NOTER MAINTENANT — ces valeurs ne seront pas reaffichees"
  [ "${nouveau_mdp}" = "1" ] && echo "   mot de passe de l'application : ${ancien_mdp}"
  [ -n "${MDP_HTTP}" ] && {
    echo "   mot de passe HTTP             : recette / ${MDP_HTTP}"
    echo "   secret GitHub AUTH_RECETTE_BIBLIO = recette:${MDP_HTTP}"
  }
  echo "=========================================================================="
else
  echo
  echo "  (aucun secret cree cette fois : tout etait deja en place)"
  echo "   mot de passe de l'application : sed -n 's/^MOT_DE_PASSE=//p' ${ENVF}"
  echo "   mot de passe HTTP : irrecuperable — le refaire avec"
  echo "     bash ${0##*/} --refaire-le-mot-de-passe-http"
fi
