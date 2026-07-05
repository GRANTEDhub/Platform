-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Sales-pipeline reshape — step B (CONTRACT): tighten CHECK to new vocab only   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Apply ONLY AFTER the new-vocab code is deployed and 0031's row remap is done.
-- Removes the transitional old stage values, leaving the finalized stored vocab:
--   discovery_pending (entry), rejected, archived, converted (terminal).
-- The contract_* and invoice_paid stages are DERIVED, never stored, so they are
-- intentionally absent here. Security boundary ('converted') unchanged.

alter table clients drop constraint if exists clients_pipeline_stage_chk;
alter table clients add constraint clients_pipeline_stage_chk
  check (pipeline_stage is null or pipeline_stage in (
    'discovery_pending','rejected','archived','converted'
  ));
