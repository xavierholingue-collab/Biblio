#!/usr/bin/env bash
# =========================================================================
# LA SAUVEGARDE QUOTIDIENNE, ET SA LECTURE A DISTANCE
#
# Jusqu'au 16/08/2026, la base n'etait sauvegardee qu'AVANT chaque
# migration, c'est-a-dire les jours de livraison. Entre deux, rien. Et les
# archives dormaient sur la machine meme qu'elles protegent.
#
# C'etait le seul point du projet dont la defaillance est IRREVERSIBLE : un
# disque perdu, un compte d'hebergeur suspendu, et il ne reste rien.
#
# ---------------------------------------------------------------------------
# CE SCRIPT A DEUX VIES, ET C'EST VOULU
#
#   1. LANCE PAR LE MINUTEUR (argument « quotidienne ») : il produit le
#      cliche du jour, verifie qu'il est complet, et fait le menage.
#
#   2. LANCE PAR SSH (commande forcee) : il LIT les cliches, sans jamais
#      pouvoir en produire ni en effacer. C'est ce qui permet au poste de
#      les recuperer avec une clef SANS PHRASE DE PASSE — indispensable
#      pour une tache automatique — sans lui donner le serveur.
#
# LA CLEF DE SAUVEGARDE N'EST PAS LA CLEF DE DEPLOIEMENT, et il faut dire
# pourquoi. Celui qui detient la clef de deploiement peut deja tout lire :
# il lui suffit de deployer du code qui lit la base. Y ajouter la lecture
# des sauvegardes ne changerait rien. L'inverse est faux : une clef de
# sauvegarde qui pourrait deployer donnerait le serveur entier a un poste
# de travail, pour le confort d'une tache planifiee. D'ou deux clefs, deux
# commandes forcees, et ce script qui ne sait rien deployer.
#
# ---------------------------------------------------------------------------
# LE CLICHE EST CHIFFRE AVANT DE QUITTER LE SERVEUR — 21/08/2026
#
# Il partait en CLAIR vers le poste, et ce fichier l'assumait : « quiconque
# accede au poste, ou au OneDrive qui le synchronise, lit la bibliotheque.
# C'est le prix de l'option choisie. »
#
# C'etait un arbitrage defendable tant qu'il s'agissait des donnees de celui
# qui le prenait. L'auto-inscription le rend intenable : ce sont desormais les
# bibliotheques privees d'inconnus qui se retrouveraient en clair dans le
# OneDrive de quelqu'un d'autre. Un arbitrage qu'on fait pour soi ne se fait
# pas pour autrui.
#
# CHIFFREMENT A CLEF PUBLIQUE, et c'est le point. Le serveur ne detient que la
# clef PUBLIQUE : il sait ecrire une sauvegarde, il ne sait pas relire les
# quatorze jours d'historique. Une compromission du serveur n'expose donc plus
# les sauvegardes — ce qui ameliore aussi la situation d'avant, ou root les
# lisait toutes.
#
# CE QUE CELA COUTE, ET IL FAUT LE DIRE : la clef privee perdue, les
# sauvegardes sont IRRECUPERABLES. Elle se genere sur le poste — jamais ici,
# sinon le serveur l'aura tenue une fois — et se garde dans un gestionnaire de
# mots de passe ET sur papier. Une restauration complete doit avoir ete
# eprouvee AVANT de compter dessus : un chiffrement dont on n'a jamais verifie
# le dechiffrement est une perte de donnees differee.
#
# PAS DE REPLI EN CLAIR. Si la clef publique manque, ce script echoue. Un repli
# silencieux reproduirait exactement le defaut qu'on corrige, le jour ou
# personne ne regarde.
#
# Et une copie tiree par un poste eteint n'existe pas. La retention de
# QUATORZE JOURS sur le serveur est ce qui rend l'option tenable : le poste
# rallume rattrape tout ce qu'il a manque, tant que l'absence n'a pas
# depasse deux semaines.
#
# USAGE
#   bash vps-sauvegarde-biblio.sh quotidienne     (minuteur, ou a la main)
#   bash vps-sauvegarde-biblio.sh installer       (pose le minuteur systemd)
#   SSH_ORIGINAL_COMMAND="lister"                 (commande forcee)
#   SSH_ORIGINAL_COMMAND="lire <nom>"             (commande forcee)
# =========================================================================

set -uo pipefail
cd / || exit 1

BASE=biblio
DOSSIER=/var/backups/biblio
RETENTION_JOURS=14
JOURNAL=/var/log/biblio-sauvegarde.log
# Le motif accepte les deux formes le temps que les clairs expirent.
MOTIF='^biblio-[0-9]{8}-[0-9]{6}\.sql\.gz(\.age)?$'
CLEF_PUBLIQUE=${CLEF_PUBLIQUE:-/etc/biblio/sauvegarde.pub}

tracer() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "${JOURNAL}" 2>/dev/null; }

# =========================================================================
# LA COMMANDE FORCEE PASSE D'ABORD.
#
# Une connexion SSH portant cette clef arrive ici avec SSH_ORIGINAL_COMMAND
# pose, et le premier argument vide. On traite ce cas AVANT tout le reste :
# rien d'autre ne doit pouvoir etre atteint par ce chemin.
# =========================================================================
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  demande="${SSH_ORIGINAL_COMMAND}"
  tracer "ssh=[${demande}] depuis=${SSH_CLIENT%% *}"

  case "${demande}" in
    "lister")
        # Taille, EMPREINTE, nom. L'empreinte est nouvelle et remplace un
        # controle devenu impossible : le poste verifiait ses telechargements
        # avec « gzip -t », qui relit l'archive. Sur un fichier chiffre il n'y
        # a rien a relire — et lui donner la clef privee pour verifier
        # reviendrait a remettre le dechiffrement sur la machine dont on
        # voulait justement qu'elle ne detienne que de l'opaque.
        #
        # Comparer les empreintes verifie le transfert de bout en bout, ce que
        # « gzip -t » ne faisait pas : il attestait une archive valide, pas une
        # archive IDENTIQUE a celle du serveur.
        cd "${DOSSIER}" 2>/dev/null || { echo "aucune sauvegarde" >&2; exit 1; }
        for f in biblio-*.sql.gz biblio-*.sql.gz.age; do
          [ -f "${f}" ] || continue
          printf '%s %s %s\n' "$(stat -c %s "${f}")" \
                               "$(sha256sum "${f}" | cut -d' ' -f1)" "${f}"
        done
        exit 0 ;;

    "lire "*)
        nom="${demande#lire }"
        # LE MOTIF EST LA SEULE CHOSE QUI SEPARE CETTE COMMANDE D'UN « cat »
        # ARBITRAIRE. Pas de barre oblique, pas de « .. », pas d'espace :
        # un nom de cliche, ou rien. On le verifie avant de toucher au
        # disque, et on ne construit le chemin qu'ensuite.
        if ! printf '%s' "${nom}" | grep -qE "${MOTIF}"; then
          tracer "REFUSE lecture [${nom}]"
          echo "Nom de sauvegarde non conforme." >&2; exit 1
        fi
        fichier="${DOSSIER}/${nom}"
        [ -f "${fichier}" ] || { echo "Sauvegarde inconnue." >&2; exit 1; }
        cat "${fichier}"
        exit 0 ;;

    *)  tracer "REFUSE [${demande}]"
        echo "Commande non autorisee." >&2; exit 1 ;;
  esac
fi

# =========================================================================
# HORS SSH : produire, ou installer le minuteur.
# =========================================================================
case "${1:-}" in
  quotidienne) ;;
  installer)
      # --- CE QUI DOIT ETRE LA AVANT LE MINUTEUR --------------------------
      #
      # Poser un minuteur sans clef publique programmerait un echec quotidien
      # a 3h30 — silencieux, puisque personne ne lit les journaux d'une tache
      # qui a toujours marche. On refuse d'installer plutot que d'installer
      # quelque chose qui ne marchera pas.
      if ! command -v age >/dev/null 2>&1; then
        echo "  ECHEC « age » n'est pas installe." >&2
        echo "        apt install age" >&2
        exit 1
      fi
      if [ ! -s "${CLEF_PUBLIQUE}" ]; then
        echo "  ECHEC clef publique absente : ${CLEF_PUBLIQUE}" >&2
        echo "" >&2
        echo "        SUR VOTRE POSTE, jamais ici :" >&2
        echo "          age-keygen -o biblio-sauvegarde.key" >&2
        echo "" >&2
        echo "        Mettez le fichier obtenu dans votre gestionnaire de mots" >&2
        echo "        de passe ET imprimez-le. Perdu, les sauvegardes sont" >&2
        echo "        irrecuperables — c'est le prix du chiffrement." >&2
        echo "" >&2
        echo "        Puis, sur ce serveur, la SEULE ligne « age1... » :" >&2
        echo "          mkdir -p \$(dirname ${CLEF_PUBLIQUE})" >&2
        echo "          echo 'age1...' > ${CLEF_PUBLIQUE}" >&2
        echo "          chmod 644 ${CLEF_PUBLIQUE}" >&2
        exit 1
      fi

      # --- Le minuteur systemd -------------------------------------------
      install -m 700 "$0" /usr/local/bin/sauvegarde-biblio
      cat > /etc/systemd/system/biblio-sauvegarde.service <<'UNIT'
[Unit]
Description=Sauvegarde quotidienne de Biblio
After=postgresql.service
Wants=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sauvegarde-biblio quotidienne
UNIT
      cat > /etc/systemd/system/biblio-sauvegarde.timer <<'UNIT'
[Unit]
Description=Sauvegarde quotidienne de Biblio

[Timer]
OnCalendar=*-*-* 03:30:00
# Une machine eteinte a 3h30 ne doit pas sauter son tour : le minuteur
# rattrape au demarrage suivant.
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT
      systemctl daemon-reload
      systemctl enable --now biblio-sauvegarde.timer
      echo "  OK      minuteur installe"
      systemctl list-timers biblio-sauvegarde.timer --no-pager | head -3
      echo "  Premiere sauvegarde tout de suite, pour ne pas attendre demain :"
      exec /usr/local/bin/sauvegarde-biblio quotidienne ;;
  *)
      echo "usage : $0 quotidienne | installer" >&2; exit 1 ;;
esac

# --- La sauvegarde ---------------------------------------------------------
install -d -m 700 "${DOSSIER}"
horodatage=$(date +%Y%m%d-%H%M%S)
cible="${DOSSIER}/${BASE}-${horodatage}.sql.gz"

# COMPTE PRIVILEGIE, comme partout ailleurs. Le compte applicatif est soumis
# a « force row level security » : PostgreSQL refuse alors de produire un
# dump qui serait filtre. S'il ne refusait pas, on sauvegarderait un tiers de
# la bibliotheque en la croyant entiere.
attendu=$(sudo -u postgres psql -tAd "${BASE}" -c "select count(*) from possessions" 2>/dev/null)
if [ -z "${attendu}" ]; then
  tracer "ECHEC comptage impossible"
  echo "  ECHEC impossible de compter les possessions de ${BASE}" >&2
  exit 1
fi

# --- LES OUTILS ET LA CLEF, AVANT DE TOUCHER A LA BASE --------------------
#
# On echoue AVANT de produire quoi que ce soit. Verifier apres coup laisserait
# un clair sur le disque en cas d'absence de clef — c'est-a-dire exactement ce
# qu'on veut eviter, produit par le controle cense l'eviter.
command -v age >/dev/null 2>&1 || {
  tracer "ECHEC age absent"
  echo "  ECHEC « age » n'est pas installe : apt install age" >&2; exit 1; }

if [ ! -s "${CLEF_PUBLIQUE}" ]; then
  tracer "ECHEC clef publique absente"
  echo "  ECHEC clef publique absente : ${CLEF_PUBLIQUE}" >&2
  echo "        Generez la paire SUR LE POSTE — jamais ici :" >&2
  echo "          age-keygen -o biblio-sauvegarde.key" >&2
  echo "        puis deposez la seule ligne « age1... » dans ce fichier." >&2
  echo "        AUCUNE sauvegarde en clair ne sera produite en attendant." >&2
  exit 1
fi
# DEUX CONTROLES, ET DEUX MESSAGES DISTINCTS.
#
# Le premier est le plus grave : « age-keygen » ecrit la clef publique EN
# COMMENTAIRE au-dessus de la privee, et copier le fichier entier est le geste
# naturel de qui va vite. Un message unique disant « ne contient pas de clef
# age1 » serait alors faux ET desorientant — le fichier en contient une, bien
# visible, sur la ligne de commentaire.
if grep -q 'AGE-SECRET-KEY' "${CLEF_PUBLIQUE}"; then
  tracer "ECHEC clef PRIVEE deposee"
  echo "  ECHEC ${CLEF_PUBLIQUE} contient une clef PRIVEE (AGE-SECRET-KEY-...)." >&2
  echo "        Ce serveur ne doit JAMAIS la detenir : il pourrait relire les" >&2
  echo "        quatorze jours d'historique, ce que le chiffrement empeche." >&2
  echo "        Ne gardez ici que la ligne « age1... », seule." >&2
  echo "        Et considerez cette clef comme divulguee : regenerez-en une." >&2
  exit 1
fi
grep -qE '^age1[0-9a-z]+$' "${CLEF_PUBLIQUE}" || {
  tracer "ECHEC clef publique non conforme"
  echo "  ECHEC ${CLEF_PUBLIQUE} ne porte aucune ligne « age1... » seule." >&2
  echo "        Attendu : une ligne, la clef publique, rien d'autre." >&2
  exit 1; }

# --- LE CLAIR VIT EN MEMOIRE, JAMAIS SUR LE DISQUE ------------------------
#
# Les verifications qui suivent — compter les possessions, chercher la marque
# de fin — exigent de RELIRE le dump. Un fichier chiffre ne se relit pas : il
# faut donc verifier le clair, puis chiffrer.
#
# Ce clair transitoire va dans /dev/shm, qui est de la memoire vive. Sur le
# disque, il laisserait des traces qu'un « rm » n'efface pas vraiment — et
# c'est precisement ce qu'un chiffrement est cense empecher.
CLAIR=$(mktemp /dev/shm/biblio-clair-XXXXXX.sql.gz) || {
  echo "  ECHEC /dev/shm indisponible" >&2; exit 1; }
trap 'rm -f "${CLAIR}"' EXIT INT TERM

if ! sudo -u postgres pg_dump -d "${BASE}" | gzip -9 > "${CLAIR}" 2>/dev/null; then
  tracer "ECHEC pg_dump"
  echo "  ECHEC pg_dump" >&2
  exit 1
fi

# --- LE CLICHE EST-IL COMPLET ? --------------------------------------------
#
# Un fichier gzip valide et non vide ne prouve rien : un dump interrompu en
# est un aussi. On compte les lignes reellement presentes dans la section
# COPY de « possessions » et on les compare a la base.
#
# Le compteur a ete faux une premiere fois — l'echappement de « \. » a
# travers les couches de shell donnait cinq la ou il y avait trois. D'ou les
# apostrophes simples et le point-barre litteral.
copie=$(gunzip -c "${CLAIR}" | awk '
  $0 ~ /^COPY public\.possessions / { f=1; next }
  f && $0 == "\\."                  { f=0; next }
  f                                  { n++ }
  END { print n+0 }')

if [ "${copie}" != "${attendu}" ]; then
  tracer "ECHEC incomplet : ${copie} lignes au lieu de ${attendu}"
  echo "  ECHEC sauvegarde incomplete : ${copie} lignes au lieu de ${attendu}" >&2
  echo "        le fichier a ete supprime : une sauvegarde partielle est pire" >&2
  echo "        qu'une sauvegarde absente, on croit l'avoir." >&2
  exit 1
fi

# --- ET LE FICHIER VA-T-IL JUSQU'AU BOUT ? ---------------------------------
#
# Le compte ci-dessus ne regarde QUE la section des possessions. Une coupure
# survenue APRES elle — au milieu des resumes, par exemple — laisse ce compte
# juste et la sauvegarde amputee. Or les resumes se paient au modele : en
# perdre un se paie deux fois.
#
# Trouve en eprouvant ce script le 16/08/2026, sur un jeu d'essai que j'avais
# moi-meme mal construit. L'erreur de mon jeu d'essai a revele un vrai trou
# dans la verification.
#
# pg_dump termine toujours par une ligne d'achevement. Sa presence prouve que
# le fichier a ete ecrit jusqu'au dernier octet.
if ! gunzip -c "${CLAIR}" | tail -5 | grep -q 'PostgreSQL database dump complete'; then
  tracer "ECHEC dump non termine"
  echo "  ECHEC la sauvegarde ne porte pas la marque de fin de pg_dump :" >&2
  echo "        elle a ete interrompue. Fichier supprime." >&2
  exit 1
fi

# --- ET SEULEMENT MAINTENANT, LE CHIFFREMENT -----------------------------
#
# Le clair a ete verifie ; ce qui sort d'ici est opaque, y compris pour cette
# machine. « -R » lit la clef publique dans un fichier plutot qu'en argument :
# une clef sur la ligne de commande apparait dans « ps », et une clef publique
# n'est pas secrete, mais l'habitude, si.
cible="${cible}.age"
if ! age -R "${CLEF_PUBLIQUE}" -o "${cible}" "${CLAIR}"; then
  rm -f "${cible}"
  tracer "ECHEC chiffrement"
  echo "  ECHEC le chiffrement a echoue — rien n'a ete conserve." >&2
  exit 1
fi

# Le chiffre est-il credible ? On ne peut pas le dechiffrer ici — c'est le
# but. On verifie ce qui est verifiable : l'entete du format, et une taille
# du meme ordre que le clair. Un fichier de zero octet passerait sinon pour
# une sauvegarde.
if ! head -c 21 "${cible}" | grep -q 'age-encryption.org'; then
  rm -f "${cible}"
  tracer "ECHEC entete age absente"
  echo "  ECHEC le fichier produit ne porte pas l'entete age." >&2
  exit 1
fi
octets_clair=$(stat -c %s "${CLAIR}")
octets_chiffre=$(stat -c %s "${cible}")
if [ "${octets_chiffre}" -lt "$((octets_clair / 2))" ]; then
  rm -f "${cible}"
  tracer "ECHEC chiffre trop court (${octets_chiffre} contre ${octets_clair})"
  echo "  ECHEC le chiffre fait ${octets_chiffre} octets pour ${octets_clair} en clair." >&2
  exit 1
fi

rm -f "${CLAIR}"
chmod 600 "${cible}"
taille=$(du -h "${cible}" | cut -f1)
tracer "OK ${cible} (${taille}, ${copie} possessions, chiffre)"
echo "  OK      ${cible} — ${taille}, ${copie} possessions verifiees, chiffre"

# --- Le menage -------------------------------------------------------------
#
# Quatorze jours : c'est ce qui laisse au poste le temps d'etre rallume. On
# n'efface JAMAIS le dernier cliche, quel que soit son age — une machine
# arretee un mois ne doit pas se reveiller sans rien.
restants=$(find "${DOSSIER}" -name 'biblio-*.sql.gz*' | wc -l)
if [ "${restants}" -gt 1 ]; then
  find "${DOSSIER}" -name 'biblio-*.sql.gz*' -mtime "+${RETENTION_JOURS}" \
    -printf '%p\n' | head -n $((restants - 1)) | while read -r vieux; do
      rm -f "${vieux}"; tracer "efface ${vieux}"
    done
fi
echo "  $(find "${DOSSIER}" -name 'biblio-*.sql.gz*' | wc -l) sauvegarde(s) conservee(s)"

# --- LES CLAIRS D'AVANT NE RESTENT PAS -----------------------------------
#
# Les clichés produits avant ce jour sont en clair sur ce serveur. Les laisser
# expirer d'eux-memes en quatorze jours reviendrait a garder deux semaines de
# bibliotheques lisibles par quiconque prend root — pendant precisement la
# periode ou l'on ouvre les inscriptions.
#
# On les chiffre sur place, et on n'efface le clair QU'APRES avoir verifie que
# le chiffre existe et porte l'entete. Si le chiffrement echoue, le clair
# reste : perdre une sauvegarde serait pire que la garder lisible un jour de
# plus.
for vieux in "${DOSSIER}"/biblio-*.sql.gz; do
  [ -f "${vieux}" ] || continue
  if age -R "${CLEF_PUBLIQUE}" -o "${vieux}.age" "${vieux}" 2>/dev/null \
     && head -c 21 "${vieux}.age" | grep -q 'age-encryption.org'; then
    chmod 600 "${vieux}.age"; rm -f "${vieux}"
    tracer "chiffre a posteriori ${vieux}"
    echo "  chiffre a posteriori : $(basename "${vieux}")"
  else
    rm -f "${vieux}.age"
    echo "  ATTENTION $(basename "${vieux}") n'a pas pu etre chiffre, il reste en clair" >&2
  fi
done
