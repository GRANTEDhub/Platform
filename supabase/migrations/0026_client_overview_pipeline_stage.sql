-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Expose pipeline_stage on client_overview so the dashboard can exclude leads  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The dashboard reads client_overview (not clients directly). The view predates
-- the lead model (0025), so it can't be filtered on pipeline_stage yet. Append
-- the column (create-or-replace only allows additions at the END) so the
-- dashboard can apply the same NON_LEAD_OR_FILTER predicate as the roster and the
-- matcher. security_invoker preserved -- RLS still applies to the querying user.
create or replace view client_overview
with (security_invoker = on) as
select
  c.id,
  c.name,
  c.org_type,
  c.status,
  c.engagement_tier,
  c.contract_end,
  c.next_step,
  c.retainer_hours,
  coalesce((select sum(t.hours) from time_entries t
            where t.client_id = c.id and t.billable), 0)            as hours_logged,
  c.retainer_hours
    - coalesce((select sum(t.hours) from time_entries t
                where t.client_id = c.id and t.billable), 0)        as hours_remaining,
  coalesce((select sum(i.amount_cents) from invoices i
            where i.client_id = c.id and i.status = 'sent'), 0)     as owed_cents,
  (select min(g.deadline) from review_cards r
     join grants g on g.id = r.grant_id
    where r.client_id = c.id and r.decision = 'approved'
      and g.deadline >= current_date)                              as next_deadline,
  c.pipeline_stage
from clients c;
