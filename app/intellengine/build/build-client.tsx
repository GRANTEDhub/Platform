"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RotateCcw, LifeBuoy, CheckCircle2 } from "lucide-react";
import { HubShell } from "@/components/layout/hub-background";
import { IntellEngineLogo } from "@/components/intellengine/logo";
import { IntellEngineProgress } from "@/components/intellengine/progress-bar";
import { ContinueButton } from "@/components/intellengine/step-nav";
import { SaveIndicator } from "@/components/intellengine/save-indicator";
import { useDraftSave } from "@/components/intellengine/use-draft-save";
import { PROPOSAL_SECTIONS, type SectionSpec } from "@/lib/intellengine/sections";
import type { DraftSection } from "@/lib/intellengine/content";

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
        source: "client" as const,
      })),
    [drafts],
  );
  const saver = useDraftSave(draftId, "sections", payload);
  const { touch } = saver;

  const completed = PROPOSAL_SECTIONS.filter((s) => (drafts[s.id] ?? "").trim().length > 0).length;

  function updateDraft(id: string, value: string) {
    setDrafts((prev) => ({ ...prev, [id]: value }));
    touch();
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
            value={drafts[spec.id] ?? ""}
            onChange={(v) => updateDraft(spec.id, v)}
          />
        ))}

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
  value,
  onChange,
}: {
  spec: SectionSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const written = value.trim().length > 0;

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
          <button
            onClick={() => setNote("GrantBot chat is coming soon — for now, edit the text directly above.")}
            className="flex-1 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep sm:flex-none"
          >
            Edit with GrantBot
          </button>
          <button
            onClick={() => setNote("Regenerating is coming soon — this will redraft the section from scratch.")}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep sm:flex-none"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Regenerate
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
    </div>
  );
}
