-- LUMAR Watches — databaseschema
-- Voer dit bestand één keer volledig uit in Supabase → SQL Editor → New query → Run.
-- Daarna: voeg Luuk en Marijn toe als lid (zie onderaan).

create extension if not exists pgcrypto;

-- ───────────── Leden (wie mag erin) ─────────────
create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- ───────────── Instellingen (één rij per sleutel) ─────────────
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ───────────── Bundelinkopen ─────────────
create table if not exists public.purchase_batches (
  id uuid primary key default gen_random_uuid(),
  purchase_date date not null,
  platform text,
  reference text,
  shipping_costs numeric(12,2) not null default 0,
  buyer_protection numeric(12,2) not null default 0,
  other_costs numeric(12,2) not null default 0,
  allocation_method text not null default 'proportional',
  payment_status text not null default 'paid',   -- paid | pending | private
  paid_by text,                                  -- vennoot bij private
  total_cost numeric(12,2) not null default 0,
  receipt_path text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ───────────── Horloges ─────────────
create table if not exists public.watches (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  model text not null,
  reference text,
  serial text,
  year text,
  condition text,
  box_papers text,                               -- full | box | papers | none
  notes text,
  photo_path text,
  receipt_path text,
  status text not null default 'in_stock',       -- incoming | in_stock | customer_returning | sold | returned | written_off
  -- inkoop
  purchase_date date,
  purchase_platform text,
  seller text,
  purchase_price numeric(12,2) not null default 0,
  extra_costs numeric(12,2) not null default 0,
  total_cost numeric(12,2) not null default 0,
  estimated_value numeric(12,2) not null default 0,
  purchase_payment text not null default 'paid', -- paid | pending | private | batch
  purchase_paid_by text,
  batch_id uuid references public.purchase_batches(id) on delete set null,
  vat_scheme text not null default 'margin',     -- margin | none
  -- verkoop
  sale_date date,
  sale_platform text,
  buyer text,
  sale_price numeric(12,2),
  sale_costs numeric(12,2) not null default 0,
  sale_payment text,                             -- received | pending
  -- retour / afschrijving
  customer_return jsonb,                         -- {date, amount, reason, payment}
  supplier_return jsonb,                         -- {date, refund, payment}
  write_off jsonb,                               -- {date, amount, reason}
  history jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────────── Uitgaven ─────────────
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  amount numeric(12,2) not null,
  category text not null default 'Algemeen',
  payment_status text not null default 'paid',   -- paid | pending | private | offset
  paid_by text,
  watch_id uuid references public.watches(id) on delete set null,
  receipt_path text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ───────────── Bankmutaties ─────────────
create table if not exists public.bank_entries (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  amount numeric(12,2) not null,                 -- + ontvangst, − uitgave
  type text not null,                            -- sale | purchase | expense | owner_deposit | owner_withdrawal | supplier_refund | customer_refund | income | correction
  partner text,                                  -- bij storting/opname
  reference_id text,                             -- bv. sale:<watch id>
  receipt_path text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ───────────── Beveiliging: alleen leden ─────────────
do $$
declare t text;
begin
  foreach t in array array['settings','purchase_batches','watches','expenses','bank_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('drop policy if exists "leden" on public.%I', t);
    execute format('create policy "leden" on public.%I for all to authenticated using (public.is_member()) with check (public.is_member())', t);
  end loop;
end $$;

alter table public.members enable row level security;
revoke all on table public.members from anon;
grant select on table public.members to authenticated;
drop policy if exists "leden zien leden" on public.members;
create policy "leden zien leden" on public.members for select to authenticated using (public.is_member());

-- ───────────── Live bijwerken tussen Luuk en Marijn ─────────────
do $$
declare t text;
begin
  foreach t in array array['settings','purchase_batches','watches','expenses','bank_entries'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ───────────── Bestanden (foto's en bonnen) ─────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lumar-files', 'lumar-files', false, 10485760,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "lumar leden lezen" on storage.objects;
create policy "lumar leden lezen" on storage.objects for select to authenticated
  using (bucket_id = 'lumar-files' and public.is_member());
drop policy if exists "lumar leden uploaden" on storage.objects;
create policy "lumar leden uploaden" on storage.objects for insert to authenticated
  with check (bucket_id = 'lumar-files' and public.is_member());
drop policy if exists "lumar leden wijzigen" on storage.objects;
create policy "lumar leden wijzigen" on storage.objects for update to authenticated
  using (bucket_id = 'lumar-files' and public.is_member());
drop policy if exists "lumar leden verwijderen" on storage.objects;
create policy "lumar leden verwijderen" on storage.objects for delete to authenticated
  using (bucket_id = 'lumar-files' and public.is_member());

-- ───────────── Leden toevoegen ─────────────
-- 1. Maak in Supabase → Authentication → Users twee gebruikers aan (Add user → e-mail + wachtwoord).
-- 2. Vervang de e-mailadressen hieronder en voer alleen dit stukje uit:
--
-- insert into public.members (user_id, display_name)
-- select id, 'Luuk' from auth.users where email = 'luuk@voorbeeld.nl'
-- on conflict (user_id) do nothing;
-- insert into public.members (user_id, display_name)
-- select id, 'Marijn' from auth.users where email = 'marijn@voorbeeld.nl'
-- on conflict (user_id) do nothing;

-- ───────────── Modules: Taken, Ideeën, Wishlist, Marketing, Branding ─────────────
-- (Staat ook los in update-modules.sql voor bestaande installaties.)
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  data jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.items enable row level security;
revoke all on table public.items from anon;
grant select, insert, update, delete on table public.items to authenticated;
drop policy if exists "leden" on public.items;
create policy "leden" on public.items for all to authenticated using (public.is_member()) with check (public.is_member());
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;
update storage.buckets set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml','application/pdf'] where id = 'lumar-files';

-- ───────────── Boekhouding: kosten achteraf en retouren van klanten ─────────────
alter table public.expenses add column if not exists capitalized boolean not null default false;
alter table public.watches add column if not exists customer_returns jsonb not null default '[]'::jsonb;
update storage.buckets set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] where id = 'lumar-files';
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

-- Serverfuncties (Edge Functions) werken met de service role
grant select, insert, update, delete on table
  public.integrations, public.oauth_states, public.sync_log, public.items,
  public.watches, public.purchase_batches, public.expenses, public.bank_entries,
  public.settings, public.members
to service_role;
