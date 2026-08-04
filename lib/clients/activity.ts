import type { PipelineStageKey } from "@/lib/clients/pipeline";

// The rail's activity card — what has happened on this client lately.
//
// THE DESIGN ASKS FOR "SINCE YOU WERE LAST HERE" AND THIS IS NOT THAT. A per-visit
// marker needs a `last_viewed_at` per (user, client), and the drawn "Dr. Whitfield opened
// Rural Health Network" needs client-side view events. Neither exists: there is no event
// stream anywhere in the schema and nothing records a portal read. Both are a migration.
//
// What DOES exist is a set of timestamps already written by the paths that do the work —
// when a pair was first carded, when a decision was recorded, when a card was released,
// when a draft last moved. Ordering those gives a real feed with real dates covering most
// of what the mockup draws. So the card ships as a rolling window and says so in its
// header, rather than claiming a last-visit boundary it cannot compute. When the marker
// lands, the header changes and the rows do not.
//
// It is also the column's slack absorber (flex-1 in the rail), which is a second reason
// not to omit it: without this card the rail ends short of the left column, and on a
// gridded ground that ragged edge is visible.

export const ACTIVITY_WINDOW_DAYS = 14;
export const ACTIVITY_ROWS = 4;

export interface ActivityEvent {
  id: string;
  // What happened, in one line. Names the record.
  title: string;
  // Supporting detail plus the date, joined by the caller-facing component.
  detail: string | null;
  at: string; // ISO
  // Which stage colour the timeline dot carries, so a feed row and the pipeline above
  // it agree about what kind of thing moved.
  tone: PipelineStageKey;
}

export interface ActivityInput {
  // First-carded timestamps for this client's grants (from match_attempts), newest last.
  carded: string[];
  // Cards decided in the window.
  decided: { id: string; title: string; decision: "approved" | "passed"; at: string }[];
  // Cards released to the client's portal in the window.
  released: { id: string; title: string; at: string }[];
  // Drafts touched in the window.
  drafts: { id: string; title: string; at: string }[];
  now: number;
}

function within(iso: string, now: number): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t <= ACTIVITY_WINDOW_DAYS * 86_400_000 && t <= now;
}

// WHOSE ACTIVITY THIS IS. Every line here describes the same underlying event from one
// side of the handoff or the other, and the staff wording is wrong on the client's page in
// both directions: "added to unassessed" names OUR queue, and "Released to the client"
// describes something done TO them, in the third person, on their own dashboard. Same
// events, same order, same tones -- one function so a new event kind cannot land on one
// side and not the other.
export type ActivityVoice = "staff" | "client";

export function deriveActivity(input: ActivityInput, voice: ActivityVoice = "staff"): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const forClient = voice === "client";

  // New matches are rolled into ONE row rather than one per grant. Six separate "a grant
  // was matched" lines would fill the card and crowd out the four kinds of event that
  // actually differ from each other.
  const fresh = input.carded.filter((t) => within(t, input.now));
  if (fresh.length > 0) {
    const newest = fresh.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    out.push({
      id: "matched",
      // A client never sees the unassessed queue, and to them a new match IS a new alert
      // -- the thing waiting in their triage list.
      title: forClient
        ? `${fresh.length} new grant ${fresh.length === 1 ? "alert" : "alerts"}`
        : `${fresh.length} new ${fresh.length === 1 ? "match" : "matches"}`,
      detail: forClient ? "waiting in your alerts" : "added to unassessed",
      at: newest,
      tone: "triage",
    });
  }

  // Passes are grouped for the same reason; approvals are not, because an approval is a
  // commitment and which grant it was is the point.
  const passed = input.decided.filter((d) => d.decision === "passed" && within(d.at, input.now));
  if (passed.length > 0) {
    const newest = passed.reduce((a, b) => (Date.parse(a.at) >= Date.parse(b.at) ? a : b));
    out.push({
      id: "passed",
      title: `${forClient ? "You passed on" : "Passed on"} ${passed.length} ${passed.length === 1 ? "grant" : "grants"}`,
      detail: passed.length === 1 ? passed[0].title : null,
      at: newest.at,
      tone: "passed",
    });
  }

  for (const d of input.decided) {
    if (d.decision !== "approved" || !within(d.at, input.now)) continue;
    out.push({
      id: `approved-${d.id}`,
      title: forClient ? "You approved this for pursuit" : "Approved for pursuit",
      detail: d.title,
      at: d.at,
      tone: "pursuit",
    });
  }

  for (const r of input.released) {
    if (!within(r.at, input.now)) continue;
    out.push({
      id: `released-${r.id}`,
      // Same moment, opposite side: we released it, they received it. "Released to the
      // client" on the client's own dashboard reads as a note about somebody else.
      title: forClient ? "Your team sent you this grant" : "Released to the client",
      detail: r.title,
      at: r.at,
      tone: "client",
    });
  }

  for (const d of input.drafts) {
    if (!within(d.at, input.now)) continue;
    out.push({
      id: `draft-${d.id}`,
      title: forClient ? "Your proposal draft moved" : "IntellEngine draft moved",
      detail: d.title,
      at: d.at,
      tone: "approved",
    });
  }

  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, ACTIVITY_ROWS);
}
