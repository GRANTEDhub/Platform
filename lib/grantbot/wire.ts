import type { Conversation, StoredMessage, TurnUsage } from "@/lib/grantbot/store";

// The shapes GrantBotChat consumes, and the ONE translation from the store's row types into
// them.
//
// ── WHY THIS FILE EXISTS ──
//
// Two surfaces feed the same component: the full page hands it `initial` from a server
// component, and the corner panel fetches `/api/grantbot/context` as JSON. Both were doing
// the same field-for-field `.map()` inline, byte-identical, in two files with nothing
// keeping them in step. The failure mode is not a bug today, it is drift tomorrow: add
// `model` to the page's literal and typecheck still passes, because the wire type does not
// require it -- so the corner panel silently lacks the field and nobody finds out until
// someone compares the two side by side. Routed through these two functions, the same
// change is a compile error until both callers agree.
//
// PURE, and deliberately not in store.ts: that module is `server-only` (it holds the
// service-role reads), while these types are what a "use client" component's props are made
// of. The row types come in as `import type`, which is erased at compile time, so nothing
// server-only follows them into the browser bundle.

// The "open blank, do not fall back to the most recent thread" token, shared by the two
// params that carry a conversation between the corner panel and the full page (`?c=` going
// out, `?grantbot=` coming back). A conversation that has been started but never sent has no
// server id to name, and the absence of an id already means something else -- "no
// preference" -- so the intent needs a word of its own rather than a missing value.
export const BLANK_CONVERSATION = "new";

export interface GrantBotThread {
  id: string;
  title: string | null;
  lastMessageAt: string;
}

export interface GrantBotMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  error: string | null;
  usage: TurnUsage | null;
  instructionsVersion: string | null;
  methodologyVersion: string | null;
}

export function toGrantBotThread(c: Conversation): GrantBotThread {
  return { id: c.id, title: c.title, lastMessageAt: c.lastMessageAt };
}

export function toGrantBotMsg(m: StoredMessage): GrantBotMsg {
  return {
    id: m.id,
    role: m.role,
    // The content blocks collapse to one string for display. Text-only today; when a block
    // stops being text this is the single place that has to decide what to render.
    text: m.content.map((c) => c.text).join("\n"),
    error: m.error,
    usage: m.usage,
    instructionsVersion: m.instructionsVersion,
    methodologyVersion: m.methodologyVersion,
  };
}
