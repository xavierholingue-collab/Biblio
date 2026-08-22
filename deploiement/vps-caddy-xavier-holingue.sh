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

# =========================================================================
# LE DOMAINE EST DECLARE ICI, ET NULLE PART AILLEURS — 21/08/2026
#
# « biblio.xavier-holingue.eu » etait ecrit en toutes lettres dans douze
# fichiers : ce script, la chaine de livraison, l'installateur de recette, la
# configuration Playwright, les trois pages, des commentaires. Douze endroits
# a penser le jour d'un demenagement — la cinquieme liste manuelle de la
# semaine, apres celles du deployeur, de test-authentification.mjs, de
# l'assembleur et la mienne.
#
# Ce fichier est la source de verite parce qu'il est ce qui DECIDE : c'est lui
# qui dit a Caddy quels noms servir. tests/test-domaine.mjs lit ces deux
# lignes et refuse que l'ancien nom subsiste ailleurs que dans la redirection.
#
# L'ANCIEN NOM REDIRIGE, il ne disparait pas. Des signets existent, des liens
# ont ete partages, et un lien magique deja parti pointe encore vers lui. Le
# couper ferait echouer des connexions sans rien dire de pourquoi.
# =========================================================================
SITE=${SITE:-lisia.y-factor.fr}
ANCIEN=${ANCIEN:-biblio.xavier-holingue.eu}

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

# LE HEREDOC RESTE LITTERAL, et seuls deux marqueurs sont remplaces.
#
# Un heredoc non protege developperait tout ce qui ressemble a « $ » — or la
# configuration de Caddy en contient. On garde donc les apostrophes autour de
# BLOC, et l'on substitue APRES coup, sur des marqueurs qui ne peuvent pas
# apparaitre par hasard.
sed -e "s/@@SITE@@/${SITE}/g" -e "s/@@ANCIEN@@/${ANCIEN}/g" >> "${CADDYFILE}" <<'BLOC'
# >>> xavier-holingue : gere par vps-caddy-xavier-holingue.sh

# L'ANCIEN NOM, redirige en permanence.
#
# « 308 » ECRIT EN CHIFFRES, et non « permanent ». J'avais d'abord ecrit
# « permanent » en commentant que 308 preserve la methode et le corps — sauf
# que dans Caddy, « permanent » vaut 301, qui transforme un POST en GET. Le
# commentaire affirmait ce que le code ne faisait pas.
#
# La consequence n'aurait rien de theorique : /api/lien et /api/connexion-lien
# sont des POST. Une requete arrivee sur l'ancien nom serait devenue un GET
# sans corps, donc un echec sans cause visible.
@@ANCIEN@@ {
	redir https://@@SITE@@{uri} 308
}

# La bibliotheque.
@@SITE@@ {
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
		
		# La politique de contenu vit dans un fichier a part, recalcule a chaque
		# livraison par calculer-csp.mjs : chaque script en ligne y est autorise
		# par son empreinte sha256, jamais par 'unsafe-inline'.
		#
		# ATTENTION A L'EMPLACEMENT. Le 14/08/2026, cet import avait ete place
		# DANS le bloc header { }. Caddy n'y attend que des noms d'en-tetes : il
		# a donc pose un en-tete nomme « import », et la politique a disparu
		# entierement. Aucune erreur, aucun journal — seulement trois controles
		# Playwright au rouge. L'import doit rester au niveau du handle.
		import /etc/caddy/csp-biblio.conf
		header {
			X-Content-Type-Options "nosniff"
			X-Frame-Options "DENY"
			Referrer-Policy "no-referrer"
			Strict-Transport-Security "max-age=31536000; includeSubDomains"
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
for n in xavier-holingue.eu "${SITE}" "${ANCIEN}" blog.xavier-holingue.eu; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://${n}" 2>/dev/null)
  case "${c}" in
    200) ok "${n} : 200" ;;
    000) echo "  A SUIVRE ${n} : certificat en cours d emission" ;;
    *)   echo "  A VOIR   ${n} : ${c}" ;;
  esac
done
echo
echo "-- La politique de contenu est-elle SERVIE ? --"
#
# Ce controle manquait, et son absence a coute une livraison. Le 14/08/2026,
# l'import avait ete pose dans le bloc header { } : Caddy l'a pris pour un
# nom d'en-tete, la politique a disparu, et le script a conclu « 200, tout
# va bien ». Verifier qu'une page repond ne dit rien de ce qu'elle repond.
# ATTENDRE LE CERTIFICAT AVANT DE CONCLURE — corrigé le 22/08/2026
#
# Ce contrôle interrogeait un nom qui avait toujours son certificat. Le jour
# du déménagement, il a interrogé un nom émis à la ligne précédente : sans
# TLS, « curl -I » ne rend AUCUN en-tête, donc aucune politique de contenu,
# donc « ECHEC aucune politique servie ».
#
# Le diagnostic proposé — « l'import est-il dans le bloc header ? » — envoyait
# chercher un défaut de configuration là où il n'y en avait pas. C'est la
# famille de défaut la plus tenace ici : un contrôle qui accuse la mauvaise
# chose coûte plus cher qu'un contrôle absent, parce qu'on va vérifier ce qui
# marche pendant que le vrai problème attend.
#
# On distingue donc deux états qui n'ont rien à voir : « pas encore de TLS »
# et « TLS mais pas de politique ». Le premier s'attend, le second s'annonce.
entetes=""
for essai in 1 2 3 4 5 6 7 8 9 10; do
  entetes=$(curl -sI --max-time 20 "https://${SITE}/" 2>/dev/null)
  [ -n "${entetes}" ] && break
  [ "${essai}" = 1 ] && printf '  certificat pas encore emis, on attend'
  printf '.'
  sleep 10
done
[ "${essai}" = 1 ] || echo

if [ -z "${entetes}" ]; then
  echo "  ECHEC ${SITE} ne repond toujours pas en HTTPS apres 100 secondes."
  echo "        Ce n'est PAS un probleme de politique de contenu : aucun"
  echo "        en-tete n'a ete recu du tout. Regardez l'emission du"
  echo "        certificat :"
  echo "          journalctl -u caddy -n 40 --no-pager | grep -i 'certificate\|acme\|error'"
  echo "        Causes habituelles : le nom ne resout pas encore vers cette"
  echo "        machine, ou Let's Encrypt limite apres des echecs repetes."
  exit 1
fi

csp=$(printf '%s' "${entetes}" | grep -i '^content-security-policy:' | head -1)

if [ -z "${csp}" ]; then
  echo "  ECHEC aucune politique de contenu servie."
  echo "        L'import est-il au niveau du handle, hors du bloc header ?"
  printf '%s' "${entetes}" | grep -i '^import:' | sed 's/^/        indice : /'
  exit 1
fi

nb=$(printf '%s' "${csp}" | grep -o "sha256-" | wc -l)
if [ "${nb}" -gt 0 ]; then
  ok "politique servie : ${nb} empreinte(s) sha256"
  printf '%s' "${csp}" | grep -q "unsafe-inline'.*script-src\|script-src[^;]*unsafe-inline" \
    && echo "  A VOIR  'unsafe-inline' subsiste dans script-src : les empreintes ne servent alors a rien"
else
  ok "politique servie (repli, sans empreinte — la prochaine livraison la remplacera)"
fi

red=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 25 https://www.xavier-holingue.eu 2>/dev/null)
case "${red}" in
  301*) ok "www redirige : ${red}" ;;
  *)    echo "  A VOIR   www : ${red}" ;;
esac

echo
echo "== FIN =="
echo "   Retour arriere : cp -a ${SAUVE} ${CADDYFILE} && systemctl reload caddy"
