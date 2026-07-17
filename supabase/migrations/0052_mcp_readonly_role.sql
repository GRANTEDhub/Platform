-- Dedicated read-only Postgres role for MCP/tooling connections (e.g. the
-- Supabase MCP connector), so a bug or bad tool call at the app/connector
-- layer can't reach a write even if it slips past .claude/settings.json's
-- deny list. Defense in depth, not a replacement for that deny list.
--
-- BYPASSRLS is required for this role to see anything: every SELECT policy
-- in this schema (profiles, clients, grants, etc., see 0001_init.sql) is
-- gated on `auth.uid() is not null` or `is_admin()`, both of which come from
-- a Supabase JWT context a raw role connection never has. Without BYPASSRLS
-- this role reads zero rows -- same blind visibility as an unauthenticated
-- request, which defeats the point. Read visibility here is therefore
-- equivalent to today's service-role reads; it just cannot write anything.
--
-- time_entries and invoices (the "financial firewall", 0001_init.sql) are
-- explicitly excluded below: BYPASSRLS would otherwise skip their admin-only
-- policy same as every other table's, but Code has no reason to read client
-- financial data, and the org's data-handling rule treats it as sensitive.
--
-- If the "bypassrls" clause below fails with a permissions error: the
-- migration-runner connection doesn't hold BYPASSRLS itself and Supabase is
-- blocking it from granting further than that. In that case, create the
-- role via the Supabase dashboard's Database > Roles UI instead (it has a
-- "Bypass RLS" toggle at creation time) and skip just that one clause here.
--
-- Set the actual login password out-of-band (Supabase dashboard, or
-- `alter role mcp_readonly password '...'` run directly) -- never commit a
-- credential to this file.

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_readonly') then
    create role mcp_readonly login noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to mcp_readonly;
grant select on all tables in schema public to mcp_readonly;
alter default privileges in schema public grant select on tables to mcp_readonly;

revoke select on time_entries from mcp_readonly;
revoke select on invoices from mcp_readonly;

insert into schema_migrations (version) values ('0052_mcp_readonly_role') on conflict do nothing;

commit;
