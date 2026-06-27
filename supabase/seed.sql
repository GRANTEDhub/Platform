-- Sample data for local development. Run AFTER 0001_init.sql.
-- Safe to re-run: uses fixed names you can delete later.

insert into clients (name, org_type, status, engagement_tier, location_city, location_county, location_state, retainer_hours, contract_start, contract_end, next_step, notes)
values
  ('Ozark Community Action', 'nonprofit', 'active', 'Navigate', 'Fayetteville', 'Washington', 'AR', 40, '2026-01-01', '2026-12-31', 'Draft LOI for HRSA rural health grant', 'Strong federal track record.'),
  ('City of Conway', 'local_government', 'active', 'Partner', 'Conway', 'Faulkner', 'AR', 60, '2025-09-01', '2026-08-31', 'Confirm match capacity for BUILD grant', 'Public works lead is the main contact.'),
  ('Delta Workforce Collective', 'nonprofit', 'active', 'Navigate', 'Helena', 'Phillips', 'AR', 25, '2026-03-01', '2027-02-28', 'Identify DOL apprenticeship fit', 'Newer org; partner-only for most federal primes.'),
  ('Pinnacle Transit Authority', 'local_government', 'prospect', null, 'Little Rock', 'Pulaski', 'AR', 0, null, null, 'Send engagement proposal', 'Intro call completed.')
on conflict do nothing;
