-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Prospect grant-alert send — contact email + prospect-linked alert record     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Prospects can now receive the SAME grant-alert one-pager clients get (a grant
-- summary + how-to-work-with-us; NOT the paid concept proposal). Two enablers:
--   1) A contact email/name on the prospect (they had none -- the reason the old
--      plain-text Send always errored). Entered on the prospect review card.
--   2) grant_alerts.prospect_id so a prospect's saved alert has a clean record
--      (client_id stays for the lead the prospect is promoted into on send).

-- 1) Prospect contact fields. Nullable: most discovered prospects have no contact
--    until an admin fills one in before sending. Written via the admin service role.
alter table prospects add column if not exists primary_contact_email text;
alter table prospects add column if not exists primary_contact_name  text;

-- 2) Link a saved alert to the prospect it was generated for. Nullable (client
--    alerts leave it null); on delete set null so the alert record survives
--    prospect cleanup. For a prospect alert, client_id is filled at send time
--    with the lead the prospect is promoted into (convert-and-send).
alter table grant_alerts add column if not exists prospect_id uuid
  references prospects(id) on delete set null;

create index if not exists grant_alerts_prospect_idx on grant_alerts (prospect_id);
