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

export const EMPTY_CONTENT: DraftContent = { scope: EMPTY_SCOPE, sections: [] };

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
// `unknown` exists for compliance. Its document list is hardcoded until step 4
// (app/intellengine/compliance/compliance-client.tsx:21), so there is no honest predicate
// to run -- and returning `done` for it would put a green check exactly where the gate
// removed one. It renders as an em dash, is excluded from the percentage, and does not
// block "ready to submit".
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
