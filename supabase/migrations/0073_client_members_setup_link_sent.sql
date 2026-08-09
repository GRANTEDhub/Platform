-- ── Existing-client setup-link email: remember WHEN we last emailed a member their
--    setup link, so onboarding a roster one client at a time is legible.
--
--    Before this there was no record of it at all: "Add login" provisioned the auth
--    account SILENTLY and staff told the client to sign in by hand, so nothing in the
--    UI distinguished "invited, waiting on them" from "provisioned and never told."
--    Working a roster of existing clients without that state means double-sending or
--    losing track of who was actually contacted.
--
--    Distinct from the two timestamps already on the row, which answer other questions:
--      invited_at    -- when the membership row was created (always set)
--      activated_at  -- when they first successfully logged in
--      setup_link_sent_at (new) -- when we last EMAILED them a working setup link
--
--    Nullable with no default on purpose: null means "never emailed," which is the
--    correct reading for every row that predates this column. ──
begin;

alter table client_members add column if not exists setup_link_sent_at timestamptz;

comment on column client_members.setup_link_sent_at is
  'When staff last emailed this member a portal setup link (null = never emailed).';

insert into schema_migrations (version) values ('0073_client_members_setup_link_sent') on conflict do nothing;

commit;
