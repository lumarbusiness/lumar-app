-- LUMAR update: koppelingen (OneDrive, Gmail)
-- Voer dit één keer uit in Supabase → SQL Editor → New query → Run.

create table if not exists public.integrations (
  provider text primary key,
  account text,
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  secret_hash text,
  connected_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.integrations enable row level security;
revoke all on table public.integrations from anon, authenticated;

create table if not exists public.oauth_states (
  nonce text primary key,
  provider text not null,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
revoke all on table public.oauth_states from anon, authenticated;

create table if not exists public.sync_log (
  path text not null,
  provider text not null,
  remote_path text,
  remote_id text,
  synced_at timestamptz not null default now(),
  primary key (path, provider)
);
alter table public.sync_log enable row level security;
revoke all on table public.sync_log from anon;
grant select on table public.sync_log to authenticated;
drop policy if exists "leden lezen" on public.sync_log;
create policy "leden lezen" on public.sync_log for select to authenticated using (public.is_member());

create or replace function public.integration_status()
returns table(provider text, account text, connected boolean, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.provider, i.account, (i.refresh_token is not null or i.secret_hash is not null), i.updated_at
  from public.integrations i where public.is_member();
$$;
revoke execute on function public.integration_status() from public, anon;
grant execute on function public.integration_status() to authenticated;

update storage.buckets set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml','application/pdf','text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] where id = 'lumar-files';
