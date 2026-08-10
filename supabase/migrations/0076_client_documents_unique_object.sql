-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ One row per stored object — closes a duplicate-confirm hole (Pursuit 3b)     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Review finding on #330. The confirm route (POST /api/client-documents) inserts a
-- row after checking the object exists, but nothing stopped the SAME minted path
-- being confirmed twice -- an ordinary retry after a timeout, or a double-submit.
-- Both calls pass the ownership check and both find the object, so both insert, and
-- the client ends up with two documents for one file.
--
-- WHY THAT IS WORSE THAN COSMETIC. Deleting either duplicate removes the shared
-- object (the delete route removes the row, then the object it points at). The
-- surviving row then names a file that no longer exists -- a document that appears
-- present with nothing behind it, which is precisely the "row pointing at nothing"
-- failure the delete ordering was designed to avoid. It came back through an
-- unguarded insert instead of through the ordering.
--
-- ONE OBJECT, ONE ROW, enforced by the database rather than by the route being
-- careful. The route also handles the conflict gracefully (a retried confirm now
-- returns the existing document instead of erroring), but a check in application
-- code cannot make this an invariant -- two concurrent confirms would both pass it.
-- This can.
--
-- SAFETY PROPERTIES:
--   1. A unique index only. No column, policy, trigger or existing row is modified,
--      and no behaviour changes for any current reader.
--   2. It constrains (storage_bucket, storage_path) rather than storage_path alone,
--      because the same path in two different buckets is two different objects.
--   3. IF THIS FAILS TO APPLY, it means the table already holds two rows pointing at
--      one object -- which is exactly the state this prevents. That is worth knowing
--      about rather than working around: reconcile the duplicates, then re-run.
--      Existing rows are contract PDFs written one-per-contract, so a conflict is
--      not expected.

begin;

create unique index if not exists client_documents_object_uniq
  on client_documents (storage_bucket, storage_path);

insert into schema_migrations (version) values ('0076_client_documents_unique_object') on conflict do nothing;
commit;
