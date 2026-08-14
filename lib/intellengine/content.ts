// What a Pursuit draft actually contains, and whether each step is genuinely done
// (migration 0074).
//
// PURE -- no I/O, no server-only -- so the server pages, the client editors, and the
// dashboard card all read the same shape through the same functions and cannot drift.
//
// ── Why completeness is DERIVED and stored nowhere ────────────────────────────────
//
// `intellengine_drafts.status` used to carry two meanings at once, and that was the bug.
// It was advanced by clicking Continue, so three clicks through empty screens set it to
// 'complete', which the hub rendered as "Ready to submit" on a draft holding nothing.
// A client could be told their proposal was ready to submit having typed one character.
//
// The two meanings are now split:
//   status      -- a pure RESUME POINTER: the furthest screen opened. A navigation fact,
//                  legitimately click-driven, and all resumeStep() ever needed it for.
//   completeness -- derived from `content` by this module. Nothing stores it.
//
// That is the same reasoning draftProgress already carried ("there is no stored progress
// column, on purpose") extended one step further: a stored completeness flag is a second
// source of truth that can contradict the content, with nothing to reconcile them. Derived,
// it cannot be faked by navigating, and it cannot go stale.

export type SectionSource = "client" | "ai";

export interface DraftSection {
  // Matches the section ids the builder renders ("problem", "population", ...).
  id: string;
  draft: string;
  // Where the text came from. Never "template": template text is a UI placeholder and is
  // never stored (see below), so a stored section is always authored.
  source: SectionSource;
  updatedAt?: string;
}

export interface DraftScope {
  scope: string;
  role: "prime" | "partner";
  budget: string;
  partners: { name: string; role: string; description: string }[];
  notes: string;
  // Stamped SERVER-SIDE on every scope write, and its PRESENCE is load-bearing.
  //
  // It is what lets a stored empty string beat the concept-proposal seed. Without it,
  // "the client cleared this box" and "this draft has never been saved" both look like
  // scope: "", so re-seeding would put back words the client deliberately deleted. Absent
  // means seed from the concept; present means the stored values win, empty or not.
  //
  // The mirror of the don't-clear-on-empty guard in app/portal/profile/actions.ts: there
  // absent had to mean leave-alone, here present-and-empty has to mean cleared. Both are
  // only wrong when the two cases cannot be told apart.
  savedAt?: string;
}

export interface DraftContent {
  scope: DraftScope;
  sections: DraftSection[];
}

// NOT part of DraftContent, deliberately: uploaded files. Keeping a filename here would
// recreate the precise lie the client gate went up to stop -- a file row that looks
// received when nothing was stored. Files arrive with a bucket behind them (step 3).

export const EMPTY_SCOPE: DraftScope = {
  scope: "",
  role: "prime",
  budget: "",
  partners: [],
  notes: "",
};

// ── Write bounds ──────────────────────────────────────────────────────────────────
//
// Enforced server-side, because the editors are the only thing between a client and this
// column and RLS lets them write their own row directly (see the route's note).
//
// Not tidiness: five surfaces now SELECT content -- the hub, the portal dashboard, the
// staff console panel, portal search, and the all-clients roster, which pulls it for every
// client's drafts to compute one percentage. While content is '{}' that is free; once it
// holds narrative, the bound on one draft is the bound on that query.
export const SCOPE_MAX_CHARS = 6_000; // ~500 words, the limit the editor already marks
export const NOTES_MAX_CHARS = 4_000;
export const SECTION_MAX_CHARS = 12_000;
export const MAX_PARTNERS = 20;
export const CONTENT_MAX_BYTES = 262_144; // 256KB for the whole merged column

export const EMPTY_CONTENT: DraftContent = { scope: EMPTY_SCOPE, sections: [] };

// Bound the WHOLE merged column, not just the field that arrived: five list surfaces select this
// column (the roster pulls it for every client's drafts), so one draft's ceiling is that query's
// ceiling. Checked post-merge because that is the value being stored. Returns a typed result the
// two draft-write routes map to 413, so they cannot drift on the ceiling or the message.
export function checkContentSize(merged: DraftContent): { ok: true } | { ok: false; error: string } {
  if (JSON.stringify(merged).length > CONTENT_MAX_BYTES) {
    return { ok: false, error: "This draft is too large to save. Shorten a section and try again." };
  }
  return { ok: true };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// TOLERANT BY DESIGN, same posture as readAllowableUses. jsonb is schemaless and this
// column will outlive its current shape, so anything unrecognised reads as empty rather
// than throwing inside a page render. It also means an UNAPPLIED 0074 behaves identically
// to an empty column: the select returns undefined, and every draft reads as
// nothing-captured instead of 500ing the portal.
export function readDraftContent(value: unknown): DraftContent {
  if (!value || typeof value !== "object") return EMPTY_CONTENT;
  const v = value as { scope?: unknown; sections?: unknown };

  const rawScope = (v.scope && typeof v.scope === "object" ? v.scope : {}) as Record<string, unknown>;
  const scope: DraftScope = {
    savedAt: typeof rawScope.savedAt === "string" ? rawScope.savedAt : undefined,
    scope: str(rawScope.scope),
    // Anything other than the literal "partner" reads as prime -- the default the editor
    // opens on, so a corrupt value degrades to the common case rather than to nothing.
    role: rawScope.role === "partner" ? "partner" : "prime",
    budget: str(rawScope.budget),
    partners: Array.isArray(rawScope.partners)
      ? rawScope.partners
          .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
          .map((p) => ({ name: str(p.name), role: str(p.role), description: str(p.description) }))
      : [],
    notes: str(rawScope.notes),
  };

  const sections: DraftSection[] = Array.isArray(v.sections)
    ? v.sections
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          id: str(s.id),
          draft: str(s.draft),
          source: s.source === "ai" ? ("ai" as const) : ("client" as const),
          updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : undefined,
        }))
        // A section with no id cannot be matched back to a rendered field, so it is not a
        // section -- dropping it is the tolerant read, not data loss we could act on.
        .filter((s) => s.id !== "")
    : [];

  return { scope, sections };
}

// ── Completeness ──────────────────────────────────────────────────────────────────
//
// Three states, and the third one matters as much as the other two:
//   done     the step's content is genuinely there
//   todo     it is not
//   unknown  it CANNOT BE ASSESSED yet, and we will not guess
//
// `unknown` exists for compliance, and the REASON changed even though the value did not.
// It used to be "the document list is hardcoded"; that list is now gone, and the real reason
// is more durable: assessing compliance needs to know what THIS GRANT REQUIRES, which is read
// out of the NOFO in step 4. Knowing which documents a client holds -- which document
// assimilation will tell us -- still is not knowing whether they satisfy this program, so
// even a fully populated profile does not make this `done`.
//
// Returning `done` would put a green check exactly where the fabricated one was removed. It
// renders as an em dash, is excluded from the percentage, and does not block "ready to submit".
export type StepState = "done" | "todo" | "unknown";

export interface DraftCompleteness {
  scope: StepState;
  compliance: StepState;
  build: StepState;
  // Scope AND build. Compliance is excluded on purpose: eligibility is advisory and never
  // blocks the flow (see lib/intellengine/eligibility.ts), so treating an unassessable
  // document check as a submission blocker would contradict that posture.
  readyToSubmit: boolean;
}

function nonEmpty(s: string): boolean {
  return s.trim().length > 0;
}

export function draftCompleteness(content: DraftContent): DraftCompleteness {
  // The scope of work is the one field the whole drafting step depends on -- role and
  // budget have defaults and partners are legitimately empty for a solo applicant, so
  // requiring them would report "not started" on a scope that is genuinely finished.
  const scope: StepState = nonEmpty(content.scope.scope) ? "done" : "todo";

  // EVERY section, not "at least one". This drives "Ready to submit", and a proposal
  // missing its evaluation plan is not ready to submit. Zero sections is `todo`, never
  // vacuously done -- an empty array must not satisfy an "all" predicate.
  const build: StepState =
    content.sections.length > 0 && content.sections.every((s) => nonEmpty(s.draft)) ? "done" : "todo";

  return { scope, compliance: "unknown", build, readyToSubmit: scope === "done" && build === "done" };
}

// How a draft reads in a list, from its content rather than from where it was last opened.
export function completenessLabel(c: DraftCompleteness): string {
  if (c.readyToSubmit) return "Ready to submit";
  if (c.build === "done") return "Narrative drafted";
  if (c.scope === "done") return "Scope captured";
  return "Not started";
}

// Whether the scope step has ever been written. See DraftScope.savedAt for why this is a
// separate question from "is the scope non-empty".
export function hasSavedScope(content: DraftContent): boolean {
  return !!content.scope.savedAt;
}

// ── Write-side normalization ──────────────────────────────────────────────────────
//
// WHAT THIS IS AND IS NOT. It is data hygiene, not a privilege boundary. 0062's RLS grants
// a client member `for all` on their own draft row, so a determined client can PATCH
// arbitrary jsonb straight through PostgREST with their anon key and skip this entirely.
// What actually contains that is readDraftContent above being tolerant: junk reads as
// empty rather than breaking a render. This stops accidents and bounds size; it is not
// what stops an attacker, and pretending otherwise would misplace the trust.
//
// Returns a discriminated result rather than throwing, so the route can map a breach to a
// specific status code and message instead of a 500.
export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function normalizeScopeForSave(value: unknown, savedAt: string): NormalizeResult<DraftScope> {
  // Read it through the SAME tolerant reader the display path uses, so a save can never
  // store a shape the reader would then discard.
  const parsed = readDraftContent({ scope: value }).scope;

  if (parsed.scope.length > SCOPE_MAX_CHARS) {
    return { ok: false, error: `The scope of work is too long (limit ${SCOPE_MAX_CHARS} characters).` };
  }
  if (parsed.notes.length > NOTES_MAX_CHARS) {
    return { ok: false, error: `Additional notes are too long (limit ${NOTES_MAX_CHARS} characters).` };
  }
  if (parsed.partners.length > MAX_PARTNERS) {
    return { ok: false, error: `Too many partners (limit ${MAX_PARTNERS}).` };
  }

  // savedAt comes from the server, never from the request body: it decides whether stored
  // values beat the concept seed, so a client must not be able to set or clear it.
  return { ok: true, value: { ...parsed, savedAt } };
}

export function normalizeSectionsForSave(value: unknown, updatedAt: string): NormalizeResult<DraftSection[]> {
  const parsed = readDraftContent({ sections: value }).sections;

  for (const s of parsed) {
    if (s.draft.length > SECTION_MAX_CHARS) {
      return { ok: false, error: `Section "${s.id}" is too long (limit ${SECTION_MAX_CHARS} characters).` };
    }
  }

  // Two ids for one section would make "every section is non-empty" ambiguous -- one copy
  // filled and one blank is neither done nor not.
  const seen = new Set<string>();
  for (const s of parsed) {
    if (seen.has(s.id)) return { ok: false, error: `Duplicate section "${s.id}".` };
    seen.add(s.id);
  }

  // Stamped per section so a later regenerate (step 5) can say when a line was last
  // touched. Server-set for the same reason as savedAt.
  return { ok: true, value: parsed.map((s) => ({ ...s, updatedAt })) };
}
