-- Records WHY a grant that reached a FULL NOFO shred failed to build its ideal
-- applicant profile (Stage A / constructIdealApplicantProfile threw). Until now the
-- exception was caught and logged to console only (pipeline.ts), so the grant
-- completed with a null profile and NO durable record -- a silent, invisible
-- failure that a future real error would hide entirely. This makes it queryable and
-- powers the Ledger's "Profile gap" tier.
--   null      -> Stage A did not fail: it succeeded, OR was not attempted (the
--                grant is willScore=false, or shred_depth='summary' so Stage A
--                never ran). Same meaning as today for every existing row -> no
--                backfill needed.
--   <message> -> the thrown error from the most recent profiling attempt; cleared
--                on a later successful (re)build so the flag never goes stale.
-- The RESOLVER-gap failure (no full NOFO reachable at all) keeps living in
-- shred_reason, where it already is and is already displayed; this column is ONLY
-- the Stage-A (full-shred) profiling failure. The two failures stay in their
-- natural, distinct homes.

begin;

alter table grants
  add column if not exists ideal_profile_error text;

insert into schema_migrations (version) values ('0048_grants_ideal_profile_error') on conflict do nothing;

commit;
