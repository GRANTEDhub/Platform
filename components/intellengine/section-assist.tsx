"use client";

import { useState } from "react";
import { Send, Check, X, Sparkles } from "lucide-react";

// Step 5b: the per-section assist thread. A staffer types an instruction ("make this more assertive",
// "tie this to the evaluation criteria", "tighten to the page limit"); the model returns a grounded
// REVISION of THIS section (via the preview-only revise-section route -- nothing is written); they can
// iterate (each turn feeds the latest revision back as the current draft) and, when happy, Accept.
// Accept hands the text up; the parent writes it as source:"ai" through the builder's normal save.
//
// EPHEMERAL: the thread lives in local state only. No conversation is persisted -- the accumulated
// edits live in the section text itself, so each turn only needs the latest revision + the new
// instruction. No new store, no schema.

interface Turn {
  instruction: string;
  revised: string;
}

export function SectionAssistThread({
  draftId,
  sectionId,
  sectionTitle,
  currentText,
  onAccept,
  onClose,
}: {
  draftId: string;
  sectionId: string;
  sectionTitle: string;
  currentText: string;
  onAccept: (text: string) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const latest = turns.length > 0 ? turns[turns.length - 1].revised : null;

  async function send() {
    const instruction = input.trim();
    if (!instruction || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/intellengine/drafts/${draftId}/revise-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId, instruction, currentDraft: latest ?? currentText }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string; draft?: string } | null;
      if (res.ok && data?.ok && typeof data.draft === "string") {
        setTurns((prev) => [...prev, { instruction, revised: data.draft as string }]);
        setInput("");
      } else {
        // Same honest refusals as 5a -- no_requirements is the one that ties back to step 4.
        switch (data?.reason) {
          case "no_requirements":
            setNote("This grant's application requirements haven't been derived yet — open the Compliance step first.");
            break;
          case "not_retrievable":
            setNote("This grant's NOFO isn't retrievable, so a grounded revision isn't possible — ask your GRANTED team.");
            break;
          case "no_grant":
            setNote("This draft isn't tied to a matched grant, so there's nothing to ground a revision against.");
            break;
          case "too_long":
            setNote("The revision came back too long — try a tighter instruction.");
            break;
          default:
            setNote("Couldn't revise this section right now — try again in a moment.");
        }
      }
    } catch {
      setNote("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-brand-navy/15 bg-brand-navy/[0.03] p-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-navy">
          <Sparkles className="h-3.5 w-3.5 text-brand-orange" /> Edit “{sectionTitle}” with GrantBot
        </p>
        <button onClick={onClose} className="text-muted-foreground hover:text-brand-navy" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {turns.length > 0 && (
        <div className="mt-2 space-y-2">
          {turns.map((t, i) => (
            <div key={i} className="space-y-1">
              <p className="text-[12px] font-medium text-brand-navy">You: {t.instruction}</p>
              <div
                className={`rounded-lg border p-2 text-[13px] leading-relaxed whitespace-pre-wrap ${
                  i === turns.length - 1 ? "border-brand-orange/40 bg-white" : "border-brand-navy/10 bg-white/60 text-muted-foreground"
                }`}
              >
                {t.revised}
              </div>
            </div>
          ))}
        </div>
      )}

      {note && <p className="mt-2 text-[12px] text-amber-800">{note}</p>}

      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Two IME guards, same as the GrantBot composer: isComposing, plus keyCode 229 for the
            // Chromium/Windows builds (crbug.com/1211849) where compositionend fires before the
            // confirming Enter and isComposing has already flipped false.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            latest ? "Refine further, or accept below…" : "e.g. tie this to the evaluation criteria and tighten it"
          }
          rows={2}
          className="flex-1 rounded-lg border border-brand-navy/15 bg-white px-3 py-2 text-[13px] outline-none focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-navy px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand-navyDeep disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          {busy ? "…" : "Send"}
        </button>
      </div>

      {latest && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => onAccept(latest)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
          >
            <Check className="h-3.5 w-3.5" /> Accept revision
          </button>
        </div>
      )}
    </div>
  );
}
