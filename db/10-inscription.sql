/* ===========================================================================
   S'INSCRIRE SOI-MÊME — ET NE RIEN CRÉER AVANT D'AVOIR LA PREUVE

   ---------------------------------------------------------------------------
   LA DÉCISION QUI COMMANDE TOUT LE RESTE

   Un lien magique EST la preuve qu'on contrôle une adresse. Vérification du
   courriel et connexion sont donc le MÊME GESTE, et il n'y a aucune raison
   d'en faire deux.

   Conséquence : on ne crée NI locataire NI compte au moment de la demande.
   L'adresse voyage dans le lien lui-même, et le locataire naît à la
   PREMIÈRE UTILISATION du lien.

   Ce que cela évite, dans l'ordre d'importance :

     — quelqu'un qui bombarde mille adresses crée zéro ligne et zéro coût.
       Un locataire « en attente de vérification » aurait été mille lignes à
       nettoyer, et un identifiant d'URL réservé pour rien.

     — aucun ÉTAT « non vérifié » n'existe nulle part. Ni dans les politiques
       de cloisonnement, ni dans les quotas, ni dans les vues, ni dans les
       sauvegardes. Le reste du code ne connaît que des comptes vérifiés, et
       n'a donc aucune occasion d'oublier de tester ce drapeau — l'oubli le
       plus banal qui soit.

     — la règle « aucun appel au modèle avant vérification » n'a pas besoin
       d'être écrite : sans compte, il n'y a pas de session, donc pas d'appel.
       Une règle qu'on ne peut pas contourner vaut mieux qu'une règle qu'on
       applique bien.

   ---------------------------------------------------------------------------
   LE MUR QU'IL FAUT FRANCHIR, ET COMMENT

   04-reglages.sql dit, noir sur blanc :

     « Pas de politique d'insertion ni de suppression : sous force, leur
       absence vaut refus. Créer ou supprimer un locataire passe par une
       migration, jamais par l'application. »

   C'était une décision délibérée. L'auto-inscription la franchit, et il
   serait malhonnête de le faire en silence.

   On ouvre donc une porte NOMMÉE plutôt que d'abattre le mur : une politique
   d'insertion qui n'accepte que si la transaction a explicitement DIT qu'elle
   inscrivait quelqu'un, et seulement pour un locataire privé au quota borné.

   CE QUE CETTE PORTE EST, ET CE QU'ELLE N'EST PAS. Ce n'est pas un rempart
   contre un attaquant qui exécuterait du SQL arbitraire sous le compte de
   l'application : celui-là poserait le drapeau lui-même. C'est un rempart
   contre l'ACCIDENT — un « insert into tenants » écrit un jour de fatigue
   dans une autre route — et un limiteur de DÉGÂTS : même par une porte
   dérobée, on ne peut fabriquer ni bibliothèque publique, ni quota généreux.

   La différence tient en une phrase : le mur d'origine refusait tout, cette
   porte refuse tout SAUF ce qu'on a nommé.

   ---------------------------------------------------------------------------
   UN SEUL COMPTE PAR LOCATAIRE, ET C'EST UNE PROTECTION

   « comptes » n'a aucune politique de cloisonnement — l'authentification la
   lit AVANT qu'un locataire soit posé, c'est elle qui l'établit. Tant que
   seul le code d'authentification y touchait, cela n'avait pas de portée.

   Avec l'inscription ouverte, elle en prend une : une écriture fautive qui
   rattacherait l'adresse d'un inconnu au locataire de quelqu'un d'autre
   serait une PRISE DE CONTRÔLE de sa bibliothèque. L'index unique ci-dessous
   la rend impossible — le locataire visé a déjà son compte.

   Il dit aussi le modèle : une bibliothèque, une personne. Le partage
   familial, s'il vient un jour, sera une décision explicite qui devra lever
   cet index, et non une possibilité qui existait sans qu'on l'ait voulue.

   ---------------------------------------------------------------------------
   L'IDENTIFIANT D'URL NE VIENT PAS DU COURRIEL

   La tentation était « xavier.holingue@… » → « /u/xavier-holingue ». C'eût
   été plus joli, et cela aurait publié la partie locale d'une adresse le jour
   où la personne rend sa bibliothèque publique — une donnée qu'elle n'a pas
   choisi de publier.

   On tire donc au sort. « /u/a3f9c2e1b7 » n'est pas beau ; il ne révèle rien,
   et personne ne le voit tant que la bibliothèque est privée — ce qu'elle est
   par défaut. Choisir une belle adresse est une décision qui appartient au
   moment où l'on décide de publier.
   =========================================================================== */

/* ------------------------------------------------- Le lien porte l'adresse

   « compte_id » devient facultatif, et un « courriel » prend sa place quand
   le compte n'existe pas encore. La contrainte dit L'UN OU L'AUTRE, jamais
   les deux ni aucun : un lien sans cible ne mènerait nulle part, et un lien
   à deux cibles poserait la question de laquelle gagne — question dont la
   réponse serait devinée le jour où quelqu'un la lira. */
alter table public.liens_connexion alter column compte_id drop not null;
alter table public.liens_connexion add column if not exists courriel text;

alter table public.liens_connexion drop constraint if exists liens_une_seule_cible;
alter table public.liens_connexion add constraint liens_une_seule_cible
  check ((compte_id is not null) <> (courriel is not null));

/* ------------------------------------------ Une bibliothèque, une personne */
create unique index if not exists comptes_un_par_locataire
  on public.comptes (tenant_id);

/* ---------------------------------------------------------- La porte nommée

   « app.inscription » est posé pour la TRANSACTION seulement (troisième
   argument de set_config à « true »). Une connexion réutilisée par le pool
   ne le porte donc jamais d'une requête à l'autre — le défaut classique des
   réglages de session, et celui qui rendrait cette porte grande ouverte.

   Les deux autres conditions ne dépendent d'aucun drapeau : quoi qu'il
   arrive, un locataire créé par l'application est PRIVÉ et son quota est
   borné. C'est ce qui limite les dégâts d'un chemin qu'on n'aurait pas vu. */
drop policy if exists tenants_inscription on public.tenants;
create policy tenants_inscription on public.tenants for insert
  with check (
    coalesce(nullif(current_setting('app.inscription', true), ''), '') = 'en cours'
    and visibilite = 'privee'
    and quota_ia_mois between 0 and 50
  );

/* ---------------------------------------------------------------------------
   CRÉER UN LOCATAIRE : UN SEUL ENDROIT, ET IL EST NOMMÉ

   PAS « security definer », et c'est important de dire pourquoi plutôt que
   de laisser croire à un oubli. Sous « force row level security », le
   propriétaire des tables est soumis aux politiques comme tout le monde :
   « security definer » ne donnerait donc RIEN ici. Il donnerait seulement
   l'illusion d'un privilège, ce qui est pire que pas de privilège du tout.

   La fonction ne tire pas sa légitimité d'un droit particulier, mais du fait
   qu'elle est le seul endroit qui pose le drapeau — donc le seul endroit à
   relire quand on se demande qui peut créer un locataire.

   « set search_path » n'est pas décoratif : sans lui, un schéma placé devant
   « public » par l'appelant ferait exécuter d'autres tables que celles-ci.
   --------------------------------------------------------------------------- */
create or replace function public.creer_locataire(
  le_courriel text,
  le_quota    integer default 10)
returns table (compte uuid, locataire uuid, adresse text)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  ident   text;
  t_id    uuid;
  c_id    uuid;
  essais  integer := 0;
begin
  le_courriel := lower(btrim(le_courriel));

  /* LES BORNES SONT ICI, PAS SEULEMENT DANS LA POLITIQUE. La politique
     protège la base d'un appelant fautif ; ces contrôles-ci donnent un
     message qui dit ce qui ne va pas. Un refus muet de PostgreSQL — « new
     row violates row-level security policy » — n'apprend rien à personne. */
  if position('@' in le_courriel) < 2 or le_courriel ~ '\s' then
    raise exception 'Adresse de courriel invalide : %', le_courriel
      using errcode = '22023';
  end if;
  if le_quota is null or le_quota < 0 or le_quota > 50 then
    raise exception 'Quota hors bornes pour une inscription : %', le_quota
      using errcode = '22023';
  end if;

  perform set_config('app.inscription', 'en cours', true);

  /* L'identifiant est tiré au sort, donc peut entrer en collision. Cinq
     essais : la probabilité d'échouer cinq fois sur dix chiffres hexadécimaux
     est de l'ordre de 10⁻⁵⁰ pour un service de cette taille. On boucle quand
     même, parce qu'« improbable » et « impossible » ne sont pas la même
     chose, et que la différence se paie un jour à trois heures du matin. */
  loop
    essais := essais + 1;
    ident := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    begin
      insert into public.tenants (identifiant, nom, visibilite, langue, quota_ia_mois)
      values (ident, 'Ma bibliothèque', 'privee', 'fr', le_quota)
      returning id into t_id;
      exit;
    exception when unique_violation then
      if essais >= 5 then raise; end if;
    end;
  end loop;

  /* Si l'adresse existe déjà, l'index unique de « comptes » lève, et la
     transaction entière est annulée — le locataire créé juste au-dessus
     disparaît avec elle. C'est le comportement voulu : une inscription à
     moitié faite laisserait une bibliothèque sans personne pour y entrer. */
  insert into public.comptes (tenant_id, courriel)
  values (t_id, le_courriel)
  returning id into c_id;

  perform set_config('app.inscription', '', true);
  return query select c_id, t_id, le_courriel;
end $$;

/* La fonction n'est utile qu'à l'application. On ne la laisse pas au tout
   venant d'une connexion SQL — c'est cosmétique tant que l'application EST le
   propriétaire, et cela cessera de l'être le jour où un rôle de lecture seule
   existera. Écrit maintenant pour n'avoir pas à y penser ce jour-là. */
revoke all on function public.creer_locataire(text, integer) from public;
