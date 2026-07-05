-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Sales-pipeline reshape — step A (EXPAND): new vocab + flag columns + remap    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Reshapes the lead stage model to the finalized 4-stage sales pipeline:
--   discovery_pending -> contract_pending -> contract_signed -> invoice_paid
--   then CONVERT (unchanged: status='active' + pipeline_stage='converted').
-- Side states: rejected (we declined), archived (dormant/spam/no-response).
--
-- Stored stages are now ONLY: discovery_pending (entry), rejected, archived, and
-- the terminal converted. The contract_* and invoice_paid positions are DERIVED
-- at read time (contract_* from the contracts table; invoice_paid from payment,
-- dark until P5) and are NEVER stored -- so they are NOT added to the CHECK.
--
-- Intake becomes a FLAG, not a stage: a badge (not sent / sent / received) derived
-- from intake_data + intake_sent_at. Discovery scheduling is also a flag
-- (discovery_booked_at) so the leads LIST can show "call booked" cheaply without
-- loading pipeline_events per row.
--
-- SECURITY BOUNDARY UNTOUCHED: 'converted' stays the terminal value;
-- isUnconvertedLead / NON_LEAD_OR_FILTER / clients RLS / status='lead'->'active'
-- are not modified. discovery_pending and rejected are non-null and != 'converted',
-- so they remain un-converted leads (excluded from the matcher/roster) exactly
-- like the old forward stages.
--
-- EXPAND/CONTRACT: this migration allows OLD + NEW vocab simultaneously and remaps
-- existing rows, so it can be applied BEFORE the new code deploys without a
-- read/write mismatch. Migration 0032 tightens the CHECK to new-only AFTER deploy.

-- Flag columns (additive, nullable).
alter table clients add column if not exists discovery_booked_at timestamptz; -- set when a discovery call is booked (badge; does not gate stage)
alter table clients add column if not exists intake_sent_at      timestamptz; -- set when an intake form is sent (badge input; producer arrives with the intake-send feature)

-- Expand the CHECK to permit OLD (transitional) + NEW stored vocab.
alter table clients drop constraint if exists clients_pipeline_stage_chk;
alter table clients add constraint clients_pipeline_stage_chk
  check (pipeline_stage is null or pipeline_stage in (
    -- old vocab (transitional; removed in 0032)
    'outbound_new','new','contacted','quoted','pending',
    -- new stored vocab
    'discovery_pending','rejected',
    -- unchanged terminal / side state
    'archived','converted'
  ));

-- Remap existing rows: every forward CRM stage collapses to the entry stage
-- (discovery_pending). A lead that had a contract/payment will re-derive its
-- contract_* / invoice_paid position at read time from the contracts table.
-- archived and converted are left untouched.
update clients set pipeline_stage = 'discovery_pending'
  where pipeline_stage in ('outbound_new','new','contacted','quoted','pending');
