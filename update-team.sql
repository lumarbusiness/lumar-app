-- Team-overzicht voor Instellingen: wie zijn de leden, e-mail en laatste login.
create or replace function public.team_overview()
returns table (user_id uuid, display_name text, email text, last_sign_in_at timestamptz, joined_at timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select m.user_id, m.display_name, u.email::text, u.last_sign_in_at, m.created_at
  from public.members m join auth.users u on u.id = m.user_id
  where public.is_member()
  order by m.created_at;
$$;
revoke execute on function public.team_overview() from public, anon;
grant execute on function public.team_overview() to authenticated;
