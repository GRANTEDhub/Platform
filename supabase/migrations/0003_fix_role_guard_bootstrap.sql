-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fix: role-change guard blocked admin bootstrap                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- guard_role_change() called is_admin(), which keys off auth.uid(). In the SQL
-- editor / service-role context auth.uid() is null, so the very first admin
-- could never be created. The guard's real job is to stop a signed-in, non-admin
-- *app user* from escalating their own role — not trusted server/SQL contexts.
-- Only enforce the check when there is an authenticated end user.

create or replace function public.guard_role_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only admins can change a user role';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
