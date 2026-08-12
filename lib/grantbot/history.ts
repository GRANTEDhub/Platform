// Conversation-history budgeting. PURE, and separated from turn.ts for the reason every other
// pure/server-only split in this codebase exists (extract-shape.ts, context-pack.ts): the rules
// worth asserting are asserted offline against the compiled module, and turn.ts imports
// `server-only`, which makes it unloadable in a test harness.
//
// ── WHY THE BUDGET IS IN CHARACTERS AND NOT TURNS ──
//
// The system prefix is cached; the history is not, and it grows on every message. Trimming by
// TURN COUNT would be wildly unpredictable, because one pasted email thread can outweigh thirty
// short questions. Characters are a rough proxy for tokens and a good one for this purpose --
// this module stays free of model specifics on purpose, the same way prompt.ts does.
//
// ── THE DROP IS REPORTED, NEVER SILENT ──
//
// An answer built on a truncated conversation should know it is truncated. `dropped` is returned
// so the caller can tell the model, in its own turn rather than smuggled into the staffer's
// words -- the truncation is a fact about the conversation, not something the staffer said.

export const MAX_HISTORY_CHARS = 60_000;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: { type: "text"; text: string }[];
  error: string | null;
}

export interface BudgetedHistory {
  messages: { role: "user" | "assistant"; content: string }[];
  dropped: number;
}

export function budgetHistory(
  history: HistoryTurn[],
  nextUserText: string,
  maxChars: number = MAX_HISTORY_CHARS,
): BudgetedHistory {
  const rendered = history
    // A FAILED ASSISTANT TURN IS STORED BUT NOT REPLAYED. Sending an empty assistant message back
    // to the API is invalid, and sending the error text would make the model treat its own outage
    // as something it said.
    .filter((m) => !(m.role === "assistant" && (m.error || m.content.length === 0)))
    .map((m) => ({
      role: m.role,
      content: m.content.map((c) => c.text).join("\n"),
    }))
    .filter((m) => m.content.trim().length > 0);

  const budget = maxChars - nextUserText.length;
  const kept: { role: "user" | "assistant"; content: string }[] = [];
  let used = 0;
  // NEWEST FIRST, so what survives a squeeze is the part of the conversation still being talked
  // about. `kept.length > 0` keeps at least one turn even when a single huge paste exceeds the
  // whole budget -- dropping everything would silently turn a follow-up into a cold question.
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = rendered[i].content.length;
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(rendered[i]);
    used += cost;
  }

  // The API requires the first message to be a user turn. Dropping from the front can leave an
  // assistant message leading, which is a 400 rather than a degraded answer.
  while (kept.length && kept[0].role === "assistant") kept.shift();

  return {
    messages: [...kept, { role: "user" as const, content: nextUserText }],
    dropped: rendered.length - kept.length,
  };
}
