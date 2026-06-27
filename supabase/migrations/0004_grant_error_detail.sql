-- Surface ingest/analysis failures instead of a generic "something went wrong".
-- When a grant's pipeline throws, the reason is stored here and shown in the UI.
alter table grants add column if not exists error_detail text;
