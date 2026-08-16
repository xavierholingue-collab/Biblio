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
# CE QUE CE DISPOSITIF NE PROTEGE PAS, ET QU'IL FAUT SAVOIR
#
# Le cliche part en CLAIR vers le poste. Il contient la bibliotheque
# entiere, sphere personnelle comprise. Quiconque accede au poste, ou au
# OneDrive qui le synchronise, la lit. C'est le prix de l'option choisie :
# une copie chez soi plutot que chez un tiers.
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
MOTIF='^biblio-[0-9]{8}-[0-9]{6}\.sql\.gz$'

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
        # Nom et taille, rien de plus. Le poste s'en sert pour savoir ce
        # qui lui manque, et ne redemande que cela.
        cd "${DOSSIER}" 2>/dev/null || { echo "aucune sauvegarde" >&2; exit 1; }
        for f in biblio-*.sql.gz; do
          [ -f "${f}" ] || continue
          printf '%s %s\n' "$(stat -c %s "${f}")" "${f}"
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

if ! sudo -u postgres pg_dump -d "${BASE}" | gzip -9 > "${cible}" 2>/dev/null; then
  rm -f "${cible}"
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
copie=$(gunzip -c "${cible}" | awk '
  $0 ~ /^COPY public\.possessions / { f=1; next }
  f && $0 == "\\."                  { f=0; next }
  f                                  { n++ }
  END { print n+0 }')

if [ "${copie}" != "${attendu}" ]; then
  rm -f "${cible}"
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
if ! gunzip -c "${cible}" | tail -5 | grep -q 'PostgreSQL database dump complete'; then
  rm -f "${cible}"
  tracer "ECHEC dump non termine"
  echo "  ECHEC la sauvegarde ne porte pas la marque de fin de pg_dump :" >&2
  echo "        elle a ete interrompue. Fichier supprime." >&2
  exit 1
fi

chmod 600 "${cible}"
taille=$(du -h "${cible}" | cut -f1)
tracer "OK ${cible} (${taille}, ${copie} possessions)"
echo "  OK      ${cible} — ${taille}, ${copie} possessions verifiees"

# --- Le menage -------------------------------------------------------------
#
# Quatorze jours : c'est ce qui laisse au poste le temps d'etre rallume. On
# n'efface JAMAIS le dernier cliche, quel que soit son age — une machine
# arretee un mois ne doit pas se reveiller sans rien.
restants=$(find "${DOSSIER}" -name 'biblio-*.sql.gz' | wc -l)
if [ "${restants}" -gt 1 ]; then
  find "${DOSSIER}" -name 'biblio-*.sql.gz' -mtime "+${RETENTION_JOURS}" \
    -printf '%p\n' | head -n $((restants - 1)) | while read -r vieux; do
      rm -f "${vieux}"; tracer "efface ${vieux}"
    done
fi
echo "  $(find "${DOSSIER}" -name 'biblio-*.sql.gz' | wc -l) sauvegarde(s) conservee(s)"
