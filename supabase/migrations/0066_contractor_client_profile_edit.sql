-- Contractor (account-manager) access to VIEW and EDIT client + prospect profiles.
-- Our contractor IS the account manager, so the profile row (contact, org detail,
-- engagement terms, notes) is theirs to manage for every client and prospect.
--
-- What changes:
--   * clients SELECT: widen the staff branch from admin-only to ANY staff, so a
--     contractor sees all clients AND un-converted leads (prospects), not just
--     converted clients. A client member still sees only their own org.
--   * clients UPDATE: add a staff UPDATE policy so a contractor can save profile
--     edits. INSERT/DELETE stay admin-only (clients_write, 0001) -- creating or
--     removing a client is not the AM's job here; permissive policies OR, so UPDATE
--     is allowed for staff via this new policy while create/delete remain admin.
--
-- What does NOT change -- the billing firewall is untouched: invoices, contracts,
-- client_documents, and time_entries keep their is_admin() RLS, so the marked-up
-- amounts we bill clients stay admin-only even though the AM can now edit the
-- profile row itself.
begin;

drop policy if exists clients_select on clients;
create policy clients_select on clients for select
  using (public.is_staff() or public.is_client_member_of(id));

drop policy if exists clients_update on clients;
create policy clients_update on clients for update
  using (public.is_staff()) with check (public.is_staff());

insert into schema_migrations (version) values ('0066_contractor_client_profile_edit') on conflict do nothing;
commit;
