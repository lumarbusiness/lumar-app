-- LUMAR update: maximaal 2 apparaten per persoon (4 in totaal).
-- Een apparaat bewaart een geheime sleutel; bij elke login koppelt de app de sessie aan dat apparaat.
-- is_member() geeft alleen 'waar' voor sessies op een toegestaan apparaat, dus de database zelf weigert andere apparaten.

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  secret_hash text not null unique,
  name text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create table if not exists public.device_sessions (
  session_id uuid primary key,
  device_id uuid not null references public.devices(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists devices_user_idx on public.devices(user_id);
create index if not exists device_sessions_device_idx on public.device_sessions(device_id);
alter table public.devices enable row level security;
alter table public.device_sessions enable row level security;
-- geen policies: alleen via de functies hieronder

-- Koppel de huidige sessie aan dit apparaat (of registreer het, als er nog plek is)
create or replace function public.claim_device(p_secret text, p_name text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid();
  sid uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  h text;
  d public.devices;
  n int;
  max_per_user constant int := 2;
begin
  if uid is null or sid is null then return json_build_object('ok', false, 'reason', 'niet ingelogd'); end if;
  if not exists (select 1 from public.members where user_id = uid) then return json_build_object('ok', false, 'reason', 'geen lid'); end if;
  if coalesce(length(p_secret), 0) < 32 then return json_build_object('ok', false, 'reason', 'ongeldige sleutel'); end if;
  perform pg_advisory_xact_lock(hashtext('lumar-device-' || uid::text));
  h := encode(digest(p_secret, 'sha256'), 'hex');
  select * into d from public.devices where secret_hash = h;
  if found and d.user_id <> uid then return json_build_object('ok', false, 'reason', 'ander account'); end if;
  if not found then
    select count(*) into n from public.devices where user_id = uid;
    if n >= max_per_user then return json_build_object('ok', false, 'reason', 'limiet', 'max', max_per_user); end if;
    insert into public.devices (user_id, secret_hash, name) values (uid, h, left(coalesce(p_name, 'Apparaat'), 80)) returning * into d;
  else
    update public.devices set last_seen = now(), name = coalesce(left(p_name, 80), name) where id = d.id;
    delete from public.device_sessions where device_id = d.id and session_id not in (select id from auth.sessions);
  end if;
  insert into public.device_sessions (session_id, device_id, user_id) values (sid, d.id, uid)
    on conflict (session_id) do update set device_id = excluded.device_id;
  return json_build_object('ok', true, 'device_id', d.id);
end $$;

-- Alleen leden op een toegestaan apparaat
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid())
     and exists (select 1 from public.device_sessions s
                 where s.session_id = nullif(auth.jwt()->>'session_id', '')::uuid and s.user_id = auth.uid());
$$;

-- Overzicht voor Instellingen → Apparaten
create or replace function public.device_overview()
returns table (id uuid, user_id uuid, display_name text, name text, created_at timestamptz, last_seen timestamptz, current boolean)
language sql stable security definer set search_path = public as $$
  select d.id, d.user_id, m.display_name, d.name, d.created_at, d.last_seen,
         exists (select 1 from public.device_sessions s where s.device_id = d.id and s.session_id = nullif(auth.jwt()->>'session_id', '')::uuid)
  from public.devices d left join public.members m on m.user_id = d.user_id
  where public.is_member()
  order by m.display_name, d.created_at;
$$;

-- Apparaat verwijderen: plek komt vrij en dat apparaat wordt direct uitgelogd
create or replace function public.remove_device(p_id uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_member() then raise exception 'Geen toegang'; end if;
  delete from auth.sessions where id in (select session_id from public.device_sessions where device_id = p_id);
  delete from public.devices where id = p_id;
end $$;

revoke execute on function public.claim_device(text, text), public.device_overview(), public.remove_device(uuid) from public, anon;
grant execute on function public.claim_device(text, text), public.device_overview(), public.remove_device(uuid) to authenticated;
