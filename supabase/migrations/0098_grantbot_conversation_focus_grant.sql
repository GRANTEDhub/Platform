-- 0098 — grant-scoped GrantBot conversations ("Ask GrantBot" from a grant's IntellEngine tile).
--
-- A per-client GrantBot conversation can now be ANCHORED to one grant: the staffer opens a thread
-- from a specific grant's card, and every turn in it is grounded on that grant + client so they can
-- just ask ("is the deadline realistic?") without re-establishing which grant they mean. The anchor
-- is a nullable FK to grants; NULL = an ordinary general thread (every existing row, and every thread
-- not opened from a grant card). ON DELETE SET NULL so removing a grant never orphans a conversation.
--
-- SAFE-BEFORE-MIGRATION: the feature is flag-gated (GRANTBOT_ASK_FROM_REVIEW_ENABLED), and NO query
-- references focus_grant_id unless the flag is on — the shared conversation reads/writes are unchanged
-- and the one narrow read (getFocusGrantId) fails soft to null. So applying this ahead of the code is a
-- pure no-op (the column sits null), and the live per-client GrantBot is never coupled to it.
begin;

alter table grantbot_conversations
  add column if not exists focus_grant_id uuid references grants(id) on delete set null;

comment on column grantbot_conversations.focus_grant_id is
  'The grant this conversation is anchored to (Ask GrantBot from a grant card). NULL = general thread.';

insert into schema_migrations (version) values ('0098_grantbot_conversation_focus_grant') on conflict do nothing;

commit;
