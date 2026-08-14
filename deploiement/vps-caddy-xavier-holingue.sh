#!/usr/bin/env bash
# =========================================================================
# Blocs Caddy pour xavier-holingue.eu — apex, www, biblio, blog.
#
# S'EXECUTE SUR LE VPS.
#
# Reproduit fidelement le decoupage de nginx.conf de la version locale :
#   • /api/ relaye vers l'API, avec un delai long ;
#   • /test/ et /node_modules/ fermes ;
#   • en-tetes de securite, dont une CSP qui n'autorise que les couvertures
#     d'Open Library et de Google Books ;
#   • pas de cache sur les pages.
#
# NON TOUCHES : supperf.io, y-factor.fr et ses sous-domaines.
# =========================================================================

set -uo pipefail

CADDYFILE=/etc/caddy/Caddyfile
MARQUE_DEBUT='# >>> xavier-holingue : gere par vps-caddy-xavier-holingue.sh'
MARQUE_FIN='# <<< xavier-holingue'
SAUVE="/etc/caddy/Caddyfile.avant-xh-$(date +%Y%m%d-%H%M%S)"

ok()    { printf '  OK      %s\n' "$1"; }
echec() { printf '  ECHEC   %s\n' "$1"; exit 1; }

echo "== Blocs Caddy pour xavier-holingue.eu =="

[ -f "${CADDYFILE}" ] || echec "${CADDYFILE} introuvable"
cp -a "${CADDYFILE}" "${SAUVE}" || echec "sauvegarde impossible"
ok "sauvegarde : ${SAUVE}"

# Etat de reference : ce sont ces reponses qui devront etre identiques.
declare -A avant
for u in https://supperf.io https://y-factor.fr https://api.y-factor.fr/sante https://app.y-factor.fr; do
  avant["$u"]=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u" 2>/dev/null)
done
echo "  avant : supperf=${avant[https://supperf.io]} y-factor=${avant[https://y-factor.fr]} api=${avant[https://api.y-factor.fr/sante]} app=${avant[https://app.y-factor.fr]}"

install -d -m 755 /var/www/biblio /var/www/xavier-holingue /var/www/blog
for r in /var/www/xavier-holingue /var/www/blog /var/www/biblio; do
  [ -f "${r}/index.html" ] || printf '%s\n' \
    '<!doctype html><meta charset="utf-8"><title>xavier-holingue.eu</title><p>En construction.' \
    > "${r}/index.html"
done
chmod -R a+rX /var/www/biblio /var/www/xavier-holingue /var/www/blog
ok "racines web preparees"

# La politique de contenu est importee par le bloc ci-dessous. Si le fichier
# manque, Caddy refuse de demarrer — le serveur entier tomberait, tous sites
# confondus, pour une page qui n'aurait pas encore ete livree.
#
# On pose donc une politique de repli AVANT d'ecrire le bloc. Elle autorise
# les scripts en ligne, ce qui est moins bon, mais un site qui fonctionne
# imparfaitement vaut mieux qu'un serveur arrete. La premiere livraison la
# remplacera par la version a empreintes.
if [ ! -f /etc/caddy/csp-biblio.conf ]; then
  cat > /etc/caddy/csp-biblio.conf <<'REPLI'
# Politique de REPLI, posee par vps-caddy-xavier-holingue.sh.
# Sera remplacee a la premiere livraison par la version a empreintes sha256.
header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://covers.openlibrary.org https://books.google.com https://*.googleusercontent.com; connect-src 'self' https://www.googleapis.com; media-src 'self' blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
REPLI
  ok "politique de repli posee"
else
  ok "politique de contenu deja en place : $(grep -c '^#   ' /etc/caddy/csp-biblio.conf) empreinte(s)"
fi

if grep -qF "${MARQUE_DEBUT}" "${CADDYFILE}"; then
  sed -i "/^${MARQUE_DEBUT}$/,/^${MARQUE_FIN}$/d" "${CADDYFILE}"
  ok "bloc precedent retire"
fi

cat >> "${CADDYFILE}" <<'BLOC'
# >>> xavier-holingue : gere par vps-caddy-xavier-holingue.sh

# La bibliotheque.
biblio.xavier-holingue.eu {
	encode zstd gzip

	# L'API. Le delai est LONG et c'est indispensable : une generation de
	# resume prend une quinzaine de secondes, une recommandation davantage.
	# Un delai court couperait la reponse en cours de route, et le
	# visiteur verrait une erreur sans savoir que le travail a bien eu lieu.
	handle /api/* {
		reverse_proxy 127.0.0.1:3006 {
			transport http {
				read_timeout 180s
				write_timeout 180s
			}
		}
	}

	# Les tests et les dependances n'ont rien a faire en ligne.
	@interdit path /test/* /node_modules/*
	handle @interdit {
		respond 404
	}

	handle {
		root * /var/www/biblio
		file_server
		header {
			X-Content-Type-Options "nosniff"
			X-Frame-Options "DENY"
			Referrer-Policy "no-referrer"
			Strict-Transport-Security "max-age=31536000; includeSubDomains"
			# La politique de contenu vit dans un fichier a part, recalcule a chaque
			# livraison par calculer-csp.mjs : chaque script en ligne y est autorise
			# par son empreinte sha256, jamais par 'unsafe-inline'.
			#
			# Une empreinte depend du contenu exact du script. L'ecrire ici, dans un
			# fichier qu'on ne rejoue qu'a la main, garantirait qu'elle soit perimee
			# des la livraison suivante — et une empreinte perimee bloque le script
			# en silence.
			import /etc/caddy/csp-biblio.conf
			# L'application evolue : pas de version figee en cache.
			Cache-Control "no-cache"
			-Server
		}
	}
}

# Le blog — en attente de son generateur.
blog.xavier-holingue.eu {
	encode zstd gzip
	root * /var/www/blog
	file_server
	header {
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
}

# Le site personnel. www renvoie vers l'apex.
xavier-holingue.eu {
	encode zstd gzip
	root * /var/www/xavier-holingue
	file_server
	header {
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
}

www.xavier-holingue.eu {
	redir https://xavier-holingue.eu{uri} permanent
}
# <<< xavier-holingue
BLOC
ok "bloc ajoute"

if ! sortie=$(caddy validate --config "${CADDYFILE}" --adapter caddyfile 2>&1); then
  echo "  ECHEC validation :"; printf '%s\n' "${sortie}" | tail -8 | sed 's/^/         /'
  cp -a "${SAUVE}" "${CADDYFILE}"; echec "retour arriere effectue"
fi
ok "syntaxe valide"

if ! sortie=$(systemctl reload caddy 2>&1); then
  echo "  ECHEC rechargement :"; printf '%s\n' "${sortie}" | tail -6 | sed 's/^/         /'
  journalctl -u caddy -n 10 --no-pager | sed 's/^/         /'
  cp -a "${SAUVE}" "${CADDYFILE}"; systemctl reload caddy; echec "retour arriere effectue"
fi
ok "caddy recharge"

echo
echo "-- Ce qui tournait avant doit tourner encore --"
sleep 3
degat=0
for u in "${!avant[@]}"; do
  apres=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u" 2>/dev/null)
  [ "${apres}" = "${avant[$u]}" ] && ok "${u} : ${apres}, inchange" \
    || { echo "  ECHEC ${u} : ${avant[$u]} -> ${apres}"; degat=1; }
done
[ "${degat}" -eq 1 ] && { cp -a "${SAUVE}" "${CADDYFILE}"; systemctl reload caddy; echec "un site existant a ete affecte"; }

echo
echo "-- Nouveaux noms (certificat : compter une minute) --"
for n in xavier-holingue.eu biblio.xavier-holingue.eu blog.xavier-holingue.eu; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://${n}" 2>/dev/null)
  case "${c}" in
    200) ok "${n} : 200" ;;
    000) echo "  A SUIVRE ${n} : certificat en cours d emission" ;;
    *)   echo "  A VOIR   ${n} : ${c}" ;;
  esac
done
red=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 25 https://www.xavier-holingue.eu 2>/dev/null)
case "${red}" in
  301*) ok "www redirige : ${red}" ;;
  *)    echo "  A VOIR   www : ${red}" ;;
esac

echo
echo "== FIN =="
echo "   Retour arriere : cp -a ${SAUVE} ${CADDYFILE} && systemctl reload caddy"
