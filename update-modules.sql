-- LUMAR update: Taken, Ideeën, Wishlist, Marketing en Branding
-- Voer dit één keer uit in Supabase → SQL Editor → New query → Run.

-- ───────────── Modules: Taken, Ideeën, Wishlist, Marketing, Branding ─────────────
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
