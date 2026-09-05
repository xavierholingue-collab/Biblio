/* =========================================================================
   INVITER QUELQU'UN DANS SA BIBLIOTHÈQUE

   La 15 a créé l'appartenance et permis d'en avoir plusieurs. Il manquait
   la seule façon d'en fabriquer une : jusqu'ici, la seule ligne « membres »
   qu'un compte pouvait obtenir était celle que « creer_locataire » pose en
   même temps que la bibliothèque. Autrement dit, on pouvait appartenir à
   plusieurs bibliothèques, mais uniquement en les créant toutes soi-même.

   ---------------------------------------------------------------------------
   L'INVITATION EMPRUNTE LE LIEN MAGIQUE, ET C'EST LE CHOIX STRUCTURANT

   On aurait pu bâtir une table « invitations » à côté : un jeton, une
   adresse, un état, une expiration, une consommation. C'est exactement ce
   que « liens_connexion » fait déjà — et le refaire à côté aurait produit
   deux mécanismes à tenir d'accord sur ce que « périmé », « déjà utilisé »
   et « adresse inconnue » veulent dire. Le dépôt a déjà payé ce genre de
   duplication : deux plafonds, l'un en appels, l'autre en euros, chacun
   juste et leur conjonction fausse.

   Le lien d'invitation est donc UN LIEN DE CONNEXION qui porte, en plus,
   la bibliothèque à rejoindre. Un seul chemin d'expiration, un seul chemin
   de consommation, une seule empreinte stockée.

   ---------------------------------------------------------------------------
   CE QUE LA COLONNE « rejoint » CHANGE À LA CONSOMMATION

   NULL — le lien ordinaire. Adresse connue : on entre. Adresse inconnue :
          on crée une bibliothèque, si les inscriptions sont ouvertes.

   POSÉE — le lien d'invitation. Adresse connue : on ATTACHE le compte à
          cette bibliothèque-là. Adresse inconnue : on crée le compte, et
          ON NE CRÉE PAS DE BIBLIOTHÈQUE — la personne rejoint celle où on
          l'attend.

   Ce dernier point est la raison d'être du champ. Sans lui, inviter
   quelqu'un qui n'a pas encore de compte lui fabriquerait SA PROPRE
   bibliothèque vide, il y arriverait, n'y trouverait rien, et l'invitation
   aurait produit exactement le contraire de ce qu'elle promettait.

   Et une invitation n'est PAS une inscription : elle ne consulte pas
   « INSCRIPTION_OUVERTE » et ne compte pas dans le plafond journalier. Ces
   deux garde-fous protègent contre l'afflux d'inconnus ; ici, quelqu'un qui
   paie déjà répond de la personne qu'il fait entrer.
   ========================================================================= */

/* --------------------------------------------------------------------------
   LA COLONNE

   « on delete cascade » : si la bibliothèque disparaît avant que
   l'invitation soit ouverte, le lien part avec elle. Le laisser derrière
   produirait un lien qui, une fois cliqué, chercherait une bibliothèque
   absente — et la personne lirait un message d'erreur au lieu de comprendre
   qu'on l'a invitée quelque part qui n'existe plus.
   -------------------------------------------------------------------------- */
alter table public.liens_connexion
  add column if not exists rejoint uuid
  references public.tenants(id) on delete cascade;

create index if not exists liens_rejoint on public.liens_connexion (rejoint)
  where rejoint is not null;

/* --------------------------------------------------------------------------
   INVITER — réservé au propriétaire

   « security definer » N'EST PAS CE QUI FAIT LA SÛRETÉ ICI, et il faut le
   dire après la leçon du 05/09 : sous « force row level security », le
   définisseur est soumis aux politiques comme tout le monde. Ce qui borne,
   c'est la vérification de propriété ci-dessous, écrite sur « app.compte_id »
   et « app.tenant_id » que la session signée vient de poser.

   L'EMPREINTE ARRIVE DÉJÀ CALCULÉE. La base ne voit jamais le jeton en
   clair — même règle que « liens_connexion » depuis le premier jour : un vol
   de la base ne doit permettre de se connecter nulle part.

   ON NE DIT PAS SI L'ADRESSE EST DÉJÀ CONNUE. La fonction insère un lien
   portant le courriel, que le compte existe ou non ; c'est la consommation
   qui tranchera. Distinguer ici donnerait au propriétaire un moyen de tester
   des adresses pour savoir qui est client du service.
   -------------------------------------------------------------------------- */
create or replace function public.inviter_membre(
  le_courriel  text,
  l_empreinte  text,
  la_duree     interval default interval '7 days')
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  moi uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  qui uuid := nullif(current_setting('app.compte_id', true), '')::uuid;
begin
  if moi is null or qui is null then
    raise exception 'Contexte incomplet : impossible d''inviter.'
      using errcode = '42501';
  end if;

  /* ÉCHOUER FERMÉ. Sans identité posée, « qui » vaut NULL, la comparaison
     ne trouve rien, et l'on refuse. Un oubli de contexte ferme la porte. */
  if not exists (select 1 from public.membres m
                  where m.tenant_id = moi and m.compte_id = qui
                    and m.role = 'proprietaire') then
    raise exception 'Seul un propriétaire peut inviter dans cette bibliothèque.'
      using errcode = '42501';
  end if;

  insert into public.liens_connexion (empreinte, courriel, expire_le, rejoint)
    values (l_empreinte, lower(btrim(le_courriel)), now() + la_duree, moi);

  return moi;
end $$;

revoke all on function public.inviter_membre(text, text, interval) from public;

/* --------------------------------------------------------------------------
   REJOINDRE — la porte nommée qui pose la ligne d'appartenance

   Elle prend le compte ET la bibliothèque EN PARAMÈTRES, comme
   « bibliotheque_a_ouvrir », et pour la même raison : on rejoint au moment
   de consommer le lien, c'est-à-dire en contexte VISITEUR — ni compte ni
   locataire posés, puisque c'est justement ce qu'on est en train
   d'établir.

   CE QUI LA BORNE N'EST DONC PAS LE CONTEXTE MAIS L'APPELANT : elle n'est
   atteinte qu'après qu'un lien d'invitation valide, non expiré et jamais
   utilisé a été consommé — et c'est ce lien qui a nommé la bibliothèque.

   « membre » ET NON « proprietaire », toujours. Le rôle ne se lit pas dans
   le lien : quelqu'un qui pourrait choisir son rôle en arrivant s'inviterait
   propriétaire. Promouvoir reste un geste séparé, fait par un propriétaire
   déjà en place.

   ---------------------------------------------------------------------------
   « ON CONFLICT DO NOTHING » NE MARCHE PAS ICI, ET LA RAISON MÉRITE D'ÊTRE
   ÉCRITE — 05/09/2026

   La première rédaction disait « on conflict (compte_id, tenant_id) do
   nothing » : être invité deux fois ne devait pas lever. PostgreSQL a
   répondu :

       new row violates row-level security policy for table "membres"

   Message trompeur, parce que la clause WITH CHECK était satisfaite —
   « app.membres » valait bien « en cours ». Ce qui manquait était AILLEURS :
   pour appliquer « ON CONFLICT », le moteur doit REGARDER la ligne en
   conflit, et regarder est soumis aux politiques de LECTURE. En contexte de
   connexion, aucune politique de lecture ne montre cette ligne — ni
   « membres_lecture » (ni compte ni locataire posés), ni
   « membres_connexion » (« app.connexion » n'est pas posé ici). Le moteur ne
   voit rien, et refuse.

   Mesuré, pas supposé : la même fonction sans la clause passe, avec la
   clause échoue, toutes choses égales par ailleurs.

   C'EST LA TROISIÈME FOIS LE MÊME JOUR qu'une vue restreinte est prise pour
   la réalité — « security definer » qui ne franchit pas « force », le
   déclencheur qui comptait les propriétaires qu'on lui montrait, et
   maintenant « on conflict » qui ne voit pas le conflit. La leçon commune :
   sous RLS, toute question posée à la base est en réalité la question « que
   m'en montre-t-on ».

   ON LAISSE DONC LEVER, ET ON RATTRAPE. Le doublon est détecté par l'index
   unique lui-même, qui n'a rien à voir pour faire son travail — et « déjà
   membre » est une réponse, pas une erreur.
   -------------------------------------------------------------------------- */
create or replace function public.rejoindre_locataire(
  le_compte uuid, le_locataire uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare pose boolean := false;
begin
  if le_compte is null or le_locataire is null then
    raise exception 'Invitation incomplète.' using errcode = '22004';
  end if;

  /* La bibliothèque a pu disparaître entre l'envoi et l'ouverture. La
     cascade sur « rejoint » emporte normalement le lien, mais on ne s'appuie
     pas sur un seul rempart. */
  if not exists (select 1 from public.tenants where id = le_locataire) then
    raise exception 'Cette bibliothèque n''existe plus.' using errcode = '42501';
  end if;

  perform set_config('app.membres', 'en cours', true);

  begin
    insert into public.membres (compte_id, tenant_id, role, vu_le)
      values (le_compte, le_locataire, 'membre', now());
    pose := true;
  exception when unique_violation then
    /* Déjà membre : le lien a été ouvert deux fois, ou la personne avait
       déjà été invitée. Ce n'est pas une erreur, et surtout ON NE TOUCHE
       PAS AU RÔLE EXISTANT — un « do update » ferait rétrograder au rang de
       membre un propriétaire qu'on réinviterait par mégarde. */
    pose := false;
  end;

  perform set_config('app.membres', '', true);
  return pose;
end $$;

revoke all on function public.rejoindre_locataire(uuid, uuid) from public;

/* --------------------------------------------------------------------------
   PARTIR — le pendant de rejoindre, et l'export s'est fait avant

   Xavier l'a demandé dès le premier échange sur la version collaborative :
   « si une personne fait partie d'une équipe et veut se retirer, que
   pourrions-nous faire pour qu'elle puisse exporter ses livres ». La réponse
   convenue est qu'on emporte une COPIE — y compris d'un ouvrage qu'on n'a
   pas apporté. Cette porte-ci ne fait que le départ ; la copie est le lot 3.

   ELLE NE PEUT PAS VIDER UNE BIBLIOTHÈQUE DE SON DERNIER PROPRIÉTAIRE : le
   déclencheur « membres_garde_proprietaire » s'en charge, et c'est bien à
   lui de le faire — la règle vaut quel que soit le chemin emprunté.
   -------------------------------------------------------------------------- */
create or replace function public.quitter_locataire()
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  moi  uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  qui  uuid := nullif(current_setting('app.compte_id', true), '')::uuid;
  parti integer;
begin
  if moi is null or qui is null then
    raise exception 'Contexte incomplet : impossible de partir.'
      using errcode = '42501';
  end if;

  perform set_config('app.membres', 'en cours', true);

  delete from public.membres
   where compte_id = qui and tenant_id = moi;
  get diagnostics parti = row_count;

  perform set_config('app.membres', '', true);

  /* ON NE REND PAS UN SUCCÈS POUR UN DÉPART QUI N'A RIEN EFFACÉ — même
     leçon que « supprimer_locataire » : la personne verrait « c'est fait »
     sans que rien ne le soit. */
  if parti = 0 then
    raise exception 'Vous n''êtes pas membre de cette bibliothèque.'
      using errcode = '42501';
  end if;

  return true;
end $$;

revoke all on function public.quitter_locataire() from public;
