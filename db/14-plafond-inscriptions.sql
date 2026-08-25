/* ===========================================================================
   COMBIEN DE BIBLIOTHÈQUES PEUVENT NAÎTRE EN UN JOUR

   ---------------------------------------------------------------------------
   POURQUOI, ET POURQUOI SEULEMENT MAINTENANT

   Le 25/08/2026, les inscriptions ont été ouvertes. La question de la
   règle 3 — « qu'est-ce qu'un inconnu peut faire après, qu'il ne pouvait pas
   avant ? » — a reçu sa vraie réponse, et une seconde lecture a montré ceci :

     server.js:2101   if (tropDeDemandesLien(ip, courriel))   ← seule occurrence

   Le limiteur ne protégeait que « /api/lien ». « /api/oidc/retour », qui crée
   un locataire pour tout compte Google inconnu, n'en avait AUCUN.

   Même forme que le défaut du matin : une protection posée sur une porte,
   et une seconde porte à côté.

   ---------------------------------------------------------------------------
   CE QUE CELA VAUT VRAIMENT

   S'inscrire par Google exige un compte Google à l'adresse vérifiée : la
   friction est réelle. Mais qui possède un domaine Google Workspace fabrique
   autant d'adresses vérifiées qu'il veut, sur son propre domaine, et peut
   les scripter. À 0,50 $ le compte, mille comptes font 500 $ par mois.

   Rien ne bornait le NOMBRE de locataires créés par jour.

   ---------------------------------------------------------------------------
   LE PLAFOND EST À LA PORTE, PAS SUR LES ROUTES

   Poser un limiteur sur « /api/oidc/retour » aurait été rejouer la faute :
   un garde-fou par porte, et la porte suivante l'oublierait.

   Il est donc ici, dans la base, sur l'INSERT de « tenants ». Les trois
   chemins d'inscription y passent — lien magique, Google, et celui qui
   n'existe pas encore. C'est le même raisonnement que « creerLocataire » :
   une seule porte, et le contrôle est dessus.

   ---------------------------------------------------------------------------
   IL NE GARDE QUE L'INSCRIPTION EN LIBRE-SERVICE

   Le déclencheur ne se déclenche que si « app.inscription » vaut « en
   cours » — le drapeau transaction-local que « creer_locataire » pose
   lui-même. Créer un locataire à la main, en superutilisateur, n'est donc
   pas bridé : c'est un geste d'administration, et brider celui qui a déjà
   tous les droits sur la base serait du théâtre.

   Même déduction que « tenants_garde_tarification », écrit le 22/08 : ce
   qu'on protège est le chemin par lequel un INCONNU crée un compte.

   ---------------------------------------------------------------------------
   ON COMPTE CE QU'ON PROTÈGE

   Le compteur ne vit pas en mémoire : il lit « tenants » et compte les
   lignes du jour. Un compteur en mémoire repartirait de zéro à chaque
   redémarrage — il suffirait d'attendre un déploiement pour repartir. Et il
   compterait des passages là où l'on veut compter des bibliothèques.

   ---------------------------------------------------------------------------
   CINQUANTE, ET LE CHIFFRE EST À VOUS

   Cinquante inscriptions par jour laissent respirer un lancement, et bornent
   le pire cas à 25 $ par mois de comptes nouveaux. Il se change dans
   « plafond_inscriptions_jour() », en une ligne, et part au déploiement
   suivant — la valeur reste ainsi versionnée et relisible.
   =========================================================================== */

/* Un seul endroit dit le chiffre. Deux copies divergeraient le jour où l'une
   est modifiée, et c'est toujours celle qu'on ne relit pas qui décide. */
create or replace function public.plafond_inscriptions_jour()
returns integer
language sql immutable
as $$ select 50 $$;

create or replace function public.inscriptions_du_jour()
returns integer
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.tenants
   where cree_le >= date_trunc('day', now())
$$;

/* Consultée par « demanderLien » AVANT d'envoyer quoi que ce soit : sans
   cela, on expédierait un courriel dont le lien échouerait à l'ouverture.
   Recevoir un lien qui ne marche pas est pire que ne rien recevoir. */
create or replace function public.inscriptions_possibles()
returns boolean
language sql stable
set search_path = public, pg_temp
as $$
  select public.inscriptions_du_jour() < public.plafond_inscriptions_jour()
$$;

/* --------------------------------------------------------------------------
   LE DÉCLENCHEUR

   « 53400 » — configuration_limit_exceeded — le même code que le quota
   mensuel d'appels. C'est la même famille : une limite atteinte, pas une
   panne. server.js le traduit en un refus lisible.
   -------------------------------------------------------------------------- */
create or replace function public.tenants_plafond_inscriptions()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
  p integer;
begin
  if coalesce(nullif(current_setting('app.inscription', true), ''), '') <> 'en cours' then
    return new;                    -- geste d'administration : non bridé
  end if;

  n := public.inscriptions_du_jour();
  p := public.plafond_inscriptions_jour();

  if n >= p then
    raise exception
      'Plafond journalier d''inscriptions atteint : % sur %.', n, p
      using errcode = '53400';
  end if;

  return new;
end $$;

drop trigger if exists tenants_plafond_inscriptions on public.tenants;
create trigger tenants_plafond_inscriptions
  before insert on public.tenants
  for each row execute function public.tenants_plafond_inscriptions();

revoke all on function public.plafond_inscriptions_jour()  from public;
revoke all on function public.inscriptions_du_jour()       from public;
revoke all on function public.inscriptions_possibles()     from public;
