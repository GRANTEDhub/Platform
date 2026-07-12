-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Client refinement layer: the distilled, match-optimized client profile      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The symmetric half of grant Stage A. A grant gets an LLM-constructed
-- ideal_applicant_profile from its NOFO; a client has had only thin raw fields,
-- while the rich strategic intake (mission, programs, target demographics,
-- partnerships) sat stranded in intake_data / notes, unseen by the matcher.
-- constructClientProfile (lib/clients/profile.ts) distills that intake into a
-- shape-validated ClientProfile stored here -- mission/programs/demographics-
-- centered, with prime_capacity / supporting_roles / geographic scale carrying
-- the prime-vs-partner distinction, and inferred[] / gaps[] for honesty.
--
-- Stage 1 is standalone: this column is written by NOTHING yet (population is a
-- later stage) and read by the matcher in a later GATED stage. Additive jsonb --
-- safe to apply ahead of the code. The isolation-test preview route
-- (/api/clients/[id]/profile-preview) constructs and returns a profile WITHOUT
-- writing it, so it does not depend on this column existing.

alter table clients add column if not exists client_profile jsonb;
