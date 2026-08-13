"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RotateCcw, LifeBuoy, CheckCircle2 } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import { SaveIndicator } from "@/components/intellengine/save-indicator";
import { useDraftSave } from "@/components/intellengine/use-draft-save";
import { PROPOSAL_SECTIONS, type SectionSpec } from "@/lib/intellengine/sections";
import type { DraftSection, SectionSource } from "@/lib/intellengine/content";
import { SubmissionPackagePanel } from "@/components/intellengine/submission-package";
import { SectionAssistThread } from "@/components/intellengine/section-assist";

const SUPPORT = "support@grantedco.com";

// Step 3 of the flow -- the proposal builder. Each section = NOFO-shaped instructions + an
// editable field + three actions:
//   - Edit with GrantBot: a per-proposal chat thread, not built yet (needs the LLM
//     plumbing -- step 5 of the build order).
//   - Regenerate: redraft the section via the LLM with tone options -- same.
//   - Ask the experts: a real, working escalation to the client's GRANTED team. No AI
//     dependency, so no reason to fake this one.
//
// IT SAVES NOW (step 2), and the button gets its label back because it finally earns it.
// Before this, "Save & return to IntellEngine" wrote only status='complete' -- saving none
// of the nine fields while telling the hub the proposal was ready to submit. The fields now
// autosave to intellengine_drafts.content.sections and the button flushes before navigating.
//
// WHAT THE BUTTON MAY AND MAY NOT CLAIM. It reports the WRITE ("Save"). It does not report
// the STATE: whether this proposal is ready is derived from content by draftCompleteness and
// the hub says so on its own. Nothing here claims submitted -- submission is step 6 and does
// not exist yet.
//
// THE EXAMPLE TEXT IS A PLACEHOLDER, NOT A VALUE (lib/intellengine/sections.ts). As an
// initial value it meant a client could save nine paragraphs about a mobile health clinic as
// their own work, and "every section is non-empty" -- which drives "Ready to submit" -- would
// be true for a proposal nobody had written. A placeholder guides and cannot be stored, so a
// saved section is authored by construction.
export default function IntellEngineBuildClient({
  draftId,
  saved,
}: {
  draftId?: string;
  // The client's stored sections (0074). Empty for a new draft or a staff preview.
  saved: DraftSection[];
}) {
  // Keyed by section id, so a section never written opens EMPTY (showing its placeholder)
  // rather than opening with someone else's example.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const byId: Record<string, string> = {};
    for (const spec of PROPOSAL_SECTIONS) byId[spec.id] = "";
    for (const s of saved) if (s.id in byId) byId[s.id] = s.draft;
    return byId;
  });
  // PROVENANCE, tracked per section rather than hardcoded (step 5a). A section drafted by
  // Regenerate is source:"ai"; a section the client types (or edits after an AI draft) is
  // source:"client". The old code sent "client" for every section, which would have re-stamped
  // an untouched AI draft as client-authored on the next autosave -- so "last touched by" would
  // lie. It flips to "client" only on a real edit of THAT section (see updateDraft).
  const [sources, setSources] = useState<Record<string, SectionSource>>(() => {
    const byId: Record<string, SectionSource> = {};
    for (const spec of PROPOSAL_SECTIONS) byId[spec.id] = "client";
    for (const s of saved) if (s.id in byId) byId[s.id] = s.source;
    return byId;
  });
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  // EVERY section is sent, including empty ones, and that is what keeps completeness honest.
  // draftCompleteness requires all stored sections to be non-empty; if a save pruned the
  // blanks, one written section would satisfy "all of them" and the hub would read "Ready to
  // submit" with eight sections missing.
  const payload = useMemo<DraftSection[]>(
    () =>
      PROPOSAL_SECTIONS.map((spec) => ({
        id: spec.id,
        draft: drafts[spec.id] ?? "",
        source: sources[spec.id] ?? "client",
      })),
    [drafts, sources],
  );
  const saver = useDraftSave(draftId, "sections", payload);
  const { touch } = saver;

  // Bump on every successful save so the submission panel below refetches its manifest + signed URLs
  // (a Regenerate persists then touch()es, so this covers AI drafts too). Keyed on the save's
  // timestamp: useDraftSave stamps a fresh Date on each "saved" outcome, so this fires once per save,
  // not per keystroke.
  const [packageReloadKey, setPackageReloadKey] = useState(0);
  const savedAt = saver.state.kind === "saved" ? saver.state.at.getTime() : null;
  useEffect(() => {
    if (savedAt !== null) setPackageReloadKey((k) => k + 1);
  }, [savedAt]);

  const completed = PROPOSAL_SECTIONS.filter((s) => (drafts[s.id] ?? "").trim().length > 0).length;

  function updateDraft(id: string, value: string) {
    setDrafts((prev) => ({ ...prev, [id]: value }));
    // A client edit makes this section client-authored, whatever it was before.
    setSources((prev) => (prev[id] === "client" ? prev : { ...prev, [id]: "client" }));
    touch();
  }

  // 5b: adopt an accepted assist-thread revision. Same write path as a Regenerate accept -- set the
  // section, mark it source:"ai", and touch() so it rides the serialized autosave (durable, and it
  // cannot be clobbered by an in-flight stale save). No server round-trip: the revise route already
  // returned the text; only the accepted result is persisted, through the builder's normal save.
  function acceptRevision(id: string, text: string) {
    setDrafts((prev) => ({ ...prev, [id]: text }));
    setSources((prev) => ({ ...prev, [id]: "ai" }));
    touch();
  }

  // Regenerate: draft this section server-side (grounded in the grant's step-4 requirements) and
  // adopt the result locally, then touch() so the fresh section joins the client's serialized
  // autosave stream. The route already persisted it (durable if the client navigates away now), but
  // an autosave whose payload was built from local state BEFORE this regenerate resolved could
  // otherwise commit AFTER the server write and silently clobber the AI section. touch() folds the
  // fresh text into useDraftSave's save chain, which serialises client saves in fire order -- so the
  // later (fresh) save always wins, closing that reverse race. The redundant write is idempotent.
  // Returns a note to show, or null on success.
  async function regenerateSection(id: string): Promise<string | null> {
    // A staff preview opened on the step URL directly has no draft row to write to.
    if (!draftId) return "Open a real proposal draft to generate — this is a preview.";
    try {
      const res = await fetch(`/api/intellengine/drafts/${draftId}/draft-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: id }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; error?: string; section?: { draft?: string } }
        | null;
      if (res.ok && data?.ok && typeof data.section?.draft === "string") {
        const text = data.section.draft;
        setDrafts((prev) => ({ ...prev, [id]: text }));
        setSources((prev) => ({ ...prev, [id]: "ai" }));
        touch();
        return null;
      }
      // Honest failure messages. no_requirements is the one that ties step 5 back to step 4.
      switch (data?.reason) {
        case "no_requirements":
          return "This grant's application requirements haven't been derived yet — open the Compliance step to derive them, then try again.";
        case "not_retrievable":
          return "This grant's NOFO isn't retrievable, so a grounded draft isn't possible — ask your GRANTED team.";
        case "no_grant":
          return "This draft isn't tied to a matched grant, so there's nothing to ground a draft against.";
        case "too_long":
          return "The draft came back too long — try again.";
        case "conflict":
          // CAS exhaustion: the draft was being saved through every retry. The server crafts the
          // specific message; fall back if it is ever absent.
          return data?.error ?? "Your draft was changing while this generated — try again in a moment.";
        default:
          return "Couldn't draft this section right now — try again in a moment.";
      }
    } catch {
      return "Couldn't reach the server — try again.";
    }
  }

  return (
    <HubShell variant="texture" width="6xl">
      <Link
        href={draftId ? `/intellengine/compliance?draft=${draftId}` : "/intellengine/compliance"}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <IntellEngineProgress percent={75} />

      <div className="mt-6 flex justify-center">
        <IntellEngineLogo size="md" />
      </div>

      <div className="mx-auto mt-8 max-w-3xl space-y-6">
        <div className="rounded-2xl bg-white p-6 shadow-grounded">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-[19px] font-semibold text-brand-navy">Proposal Builder</h2>
            <button
              onClick={() => setTemplateNote("Template switching is coming soon.")}
              className="text-sm font-medium text-brand-orange hover:underline"
            >
              Change Template
            </button>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Write each section of your proposal — your work saves as you type. AI drafting is
            coming soon; the grey text in each box is an example of what the section is asking
            for, not a draft of yours.
          </p>
          {templateNote && <p className="mt-1 text-[12px] text-muted-foreground">{templateNote}</p>}
          <div className="mt-4 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Sections written</span>
            <span>
              {completed} of {PROPOSAL_SECTIONS.length}
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-brand-navy/[0.08]">
            <div
              className="h-2 rounded-full bg-brand-navy transition-all"
              style={{ width: `${(completed / PROPOSAL_SECTIONS.length) * 100}%` }}
            />
          </div>
        </div>

        {PROPOSAL_SECTIONS.map((spec) => (
          <SectionCard
            key={spec.id}
            spec={spec}
            draftId={draftId}
            value={drafts[spec.id] ?? ""}
            source={sources[spec.id] ?? "client"}
            onChange={(v) => updateDraft(spec.id, v)}
            onRegenerate={() => regenerateSection(spec.id)}
            onAcceptRevision={(text) => acceptRevision(spec.id, text)}
          />
        ))}

        {/* Step 6: assemble the filable package. Only with a real draft to export -- a staff preview
            opened on the step URL directly has no draft row and nothing to assemble. */}
        {draftId && <SubmissionPackagePanel draftId={draftId} reloadKey={packageReloadKey} />}

        <div className="flex flex-wrap items-center justify-end gap-4">
          <SaveIndicator saver={saver} />
          {/* No nextStatus: 'complete' is not a screen and is no longer settable (0074).
              beforeNavigate is what makes the word "Save" true. */}
          <ContinueButton
            draftId={draftId}
            nextHref="/intellengine"
            beforeNavigate={saver.flush}
            className="rounded-full bg-brand-navy px-8 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-60"
          >
            Save &amp; return to IntellEngine
          </ContinueButton>
        </div>
      </div>
    </HubShell>
  );
}

function SectionCard({
  spec,
  draftId,
  value,
  source,
  onChange,
  onRegenerate,
  onAcceptRevision,
}: {
  spec: SectionSpec;
  draftId?: string;
  value: string;
  source: SectionSource;
  onChange: (value: string) => void;
  // Returns a note to display, or null on success (the parent updates the text + provenance).
  onRegenerate: () => Promise<string | null>;
  // 5b: adopt an accepted assist revision (parent writes it as source:"ai").
  onAcceptRevision: (text: string) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const written = value.trim().length > 0;

  // Accept the revision, confirming first if it would overwrite CLIENT-authored text (same discipline
  // as Regenerate). An AI draft or empty section needs no confirmation.
  function handleAcceptRevision(text: string) {
    if (written && source === "client" && !window.confirm("Replace your edits with this revision?")) return;
    onAcceptRevision(text);
    setAssistOpen(false);
  }

  async function handleRegenerate() {
    // Confirm before overwriting text the CLIENT wrote (same discipline as the concept-proposal
    // panel). Overwriting an existing AI draft needs no confirmation -- it was not their words.
    if (
      written &&
      source === "client" &&
      !window.confirm("This replaces your edits with a fresh AI draft. Continue?")
    ) {
      return;
    }
    // Close any open assist thread: Regenerate replaces the section from scratch, so the thread's
    // revisions are now based on stale text. Leaving it open would let Accept silently revert the
    // fresh draft to a superseded revision. Reopening starts fresh from the regenerated text.
    setAssistOpen(false);
    setBusy(true);
    setNote(null);
    const msg = await onRegenerate();
    setBusy(false);
    if (msg) setNote(msg);
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-grounded">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-[17px] font-semibold text-brand-navy">{spec.title}</h3>
        {/* Ticks what the CLIENT wrote. It used to tick on the example text being present,
            so all nine sections arrived pre-ticked. */}
        {written && <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-500" />}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{spec.instructions}</p>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={spec.placeholder}
          rows={3}
          className="flex-1 rounded-xl border border-brand-navy/15 bg-white px-3.5 py-3 text-sm outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
        />
        <div className="flex shrink-0 flex-row gap-2 sm:w-44 sm:flex-col">
          {/* 5b: opens the per-section assist thread. A staff preview with no draft row can't revise
              (nothing to ground/persist), so it falls back to the note. */}
          <button
            onClick={() =>
              draftId
                ? setAssistOpen((o) => !o)
                : setNote("Open a real proposal draft to use GrantBot — this is a preview.")
            }
            aria-pressed={assistOpen}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold text-white transition sm:flex-none ${
              assistOpen ? "bg-brand-navyDeep" : "bg-brand-navy hover:bg-brand-navyDeep"
            }`}
          >
            Edit with GrantBot
          </button>
          <button
            onClick={handleRegenerate}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-60 sm:flex-none"
          >
            <RotateCcw className={`h-3.5 w-3.5${busy ? " animate-spin" : ""}`} />
            {busy ? "Drafting…" : "Regenerate"}
          </button>
          <a
            href={`mailto:${SUPPORT}?subject=${encodeURIComponent(`Question on "${spec.title}" — proposal draft`)}`}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep sm:flex-none"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            Ask the experts
          </a>
        </div>
      </div>

      {note && <p className="mt-2 text-[12px] text-muted-foreground">{note}</p>}

      {assistOpen && draftId && (
        <SectionAssistThread
          draftId={draftId}
          sectionId={spec.id}
          sectionTitle={spec.title}
          currentText={value}
          onAccept={handleAcceptRevision}
          onClose={() => setAssistOpen(false)}
        />
      )}
    </div>
  );
}
