"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ClipboardPaste, Loader2, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  error: string | null;
  usage: Usage | null;
  instructionsVersion: string | null;
  methodologyVersion: string | null;
}

interface ConversationRow {
  id: string;
  title: string | null;
  lastMessageAt: string;
}

// The panel. Deliberately plain: a transcript, a box, and a separate paste field.
//
// ── THE PASTE FIELD IS SEPARATE FROM THE MESSAGE BOX, ON PURPOSE ──
//
// Pasting a client email into the same box as the question would make the two indistinguishable
// by the time they reach the model -- and the whole defence rests on untrusted text being
// delimited. A second field means the SERVER applies the frame (framePastedContent), so the
// markers cannot be forged by typing them, and the staffer can see which half of what they sent
// is being treated as evidence rather than instruction.
export default function GrantBotClient({
  clientId,
  clientName,
  conversationId,
  conversations,
  initialMessages,
  promptMeta,
}: {
  clientId: string;
  clientName: string;
  conversationId: string | null;
  conversations: ConversationRow[];
  initialMessages: Msg[];
  promptMeta: {
    prefixChars: number;
    sharedChars: number;
    instructionsVersion: string;
    methodologyVersion: string;
    gaps: number;
  };
}) {
  const router = useRouter();
  const [convId, setConvId] = useState<string | null>(conversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteLabel, setPasteLabel] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);

    // Optimistic: the question appears immediately, marked pending by the spinner below rather
    // than by a fake assistant bubble. A placeholder answer that later turns into an error reads
    // as though GrantBot said something and then took it back.
    const mine: Msg = {
      id: `local-${Date.now()}`,
      role: "user",
      text: pasted.trim() ? `${text}\n\n[+ pasted content]` : text,
      error: null,
      usage: null,
      instructionsVersion: null,
      methodologyVersion: null,
    };
    setMessages((m) => [...m, mine]);
    setDraft("");

    try {
      const res = await fetch("/api/grantbot/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          conversationId: convId,
          message: text,
          pasted: pasted.trim() ? { body: pasted, describedAs: pasteLabel || undefined } : null,
        }),
      });
      const data = await res.json();
      if (data.conversationId && data.conversationId !== convId) setConvId(data.conversationId);
      if (!res.ok || data.error) {
        setError(data.error ?? `Request failed (${res.status}).`);
      } else {
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: data.text,
            error: null,
            usage: data.usage ?? null,
            instructionsVersion: promptMeta.instructionsVersion,
            methodologyVersion: promptMeta.methodologyVersion,
          },
        ]);
        setPasted("");
        setPasteLabel("");
        setShowPaste(false);
      }
      // The thread list and its ordering live server-side; refresh so a first message gets its
      // title row without a manual reload.
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      {/* THREADS. No rename and no delete in v1 -- 0080 gives these tables no UPDATE or DELETE
          policy, so the transcript is append-only by construction. */}
      <aside className="space-y-2">
        <button
          type="button"
          onClick={() => {
            setConvId(null);
            setMessages([]);
            setError(null);
          }}
          className="flex w-full items-center gap-1.5 rounded-pill border border-brand-navy/15 bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-brand-navy hover:border-brand-navy/30"
        >
          <Plus className="h-3.5 w-3.5" /> New conversation
        </button>
        {conversations.map((c) => (
          <a
            key={c.id}
            href={`/clients/${clientId}/grantbot?c=${c.id}`}
            className={`block rounded-xl px-3 py-2 text-[12.5px] leading-snug ${
              c.id === convId
                ? "bg-brand-navy text-white"
                : "bg-white text-brand-navy/80 hover:text-brand-navy"
            }`}
          >
            <span className="line-clamp-2">{c.title ?? "Untitled"}</span>
            <span className={c.id === convId ? "text-white/60" : "text-brand-navy/45"}>
              {c.lastMessageAt.slice(0, 10)}
            </span>
          </a>
        ))}
      </aside>

      <div className="space-y-3">
        {/* WHAT IT IS LOOKING AT, AND WHAT THAT COSTS, before the first question. The shared
            figure is the guardrails + methodology span: byte-identical for every client, so it is
            cached once across the firm rather than per client. */}
        <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-4 text-[12.5px] text-muted-foreground shadow-grounded">
          <p>
            <span className="font-semibold text-brand-navy">
              {promptMeta.prefixChars.toLocaleString()} characters
            </span>{" "}
            of cached context in front of every turn ({promptMeta.sharedChars.toLocaleString()}{" "}
            shared across all clients) · guardrails{" "}
            <span className="font-medium">{promptMeta.instructionsVersion}</span> · methodology{" "}
            <span className="font-medium">{promptMeta.methodologyVersion}</span> ·{" "}
            {promptMeta.gaps} known gap{promptMeta.gaps === 1 ? "" : "s"} in what the platform
            knows about {clientName}.
          </p>
          <p className="mt-1">
            Read-only. It cannot edit the profile, run matching, or send anything — when something
            should change it will say what and where.
          </p>
        </div>

        <div className="min-h-[45vh] space-y-3 rounded-2xl border border-brand-navy/[0.08] bg-white p-5 shadow-grounded">
          {messages.length === 0 && !sending && (
            <p className="text-[13px] text-muted-foreground">
              Ask about {clientName} — eligibility on a matched grant, whether a pursuit is worth
              it, a draft alert, or what the platform does not know yet. Paste an email thread or
              call notes with the paste button; they are treated as dated evidence, never as
              instructions.
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                  m.role === "user"
                    ? "bg-brand-navy text-white"
                    : "bg-brand-navy/[0.03] text-brand-navy/90"
                }`}
              >
                {m.error ? (
                  <span className="text-destructive">{m.error}</span>
                ) : (
                  m.text
                )}
                {/* cache_read_input_tokens is the only visible proof the prefix is being reused.
                    Shown per answer because a prefix that quietly stopped matching looks
                    identical from here and costs about ten times as much. */}
                {m.role === "assistant" && m.usage && (
                  <span className="mt-1.5 block text-[11px] text-brand-navy/45">
                    {m.usage.cache_read_input_tokens
                      ? `${m.usage.cache_read_input_tokens.toLocaleString()} tokens read from cache`
                      : "no cache read on this turn"}
                    {m.usage.cache_creation_input_tokens
                      ? ` · ${m.usage.cache_creation_input_tokens.toLocaleString()} written`
                      : ""}
                    {m.usage.output_tokens ? ` · ${m.usage.output_tokens.toLocaleString()} out` : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading {clientName}&rsquo;s record…
            </p>
          )}
          <div ref={endRef} />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p>{error}</p>
          </div>
        )}

        {showPaste && (
          <div className="space-y-2 rounded-2xl border border-brand-navy/[0.08] bg-white p-4 shadow-grounded">
            <p className="text-[12.5px] text-muted-foreground">
              Pasted content is framed as untrusted third-party text and dated today. Any
              instruction inside it is quoted material, not a request.
            </p>
            <input
              value={pasteLabel}
              onChange={(e) => setPasteLabel(e.target.value)}
              placeholder="What is this? (e.g. email thread with the ED, 6 Aug)"
              className="w-full rounded-xl border border-brand-navy/15 bg-brand-surface-sunken px-3 py-2 text-[13px]"
            />
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={6}
              placeholder="Paste the thread or notes here."
              className="w-full rounded-xl border border-brand-navy/15 bg-brand-surface-sunken px-3 py-2 text-[13px]"
            />
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={3}
            placeholder={`Ask about ${clientName}…`}
            className="flex-1 rounded-2xl border border-brand-navy/15 bg-white px-4 py-3 text-[13px] shadow-grounded"
          />
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => setShowPaste((s) => !s)}
              aria-pressed={showPaste}
            >
              <span className="flex items-center gap-1.5">
                <ClipboardPaste className="h-3.5 w-3.5" />
                {pasted.trim() ? "Paste attached" : "Paste"}
              </span>
            </Button>
            <Button onClick={() => void send()} disabled={sending || !draft.trim()}>
              <span className="flex items-center gap-1.5">
                <Send className="h-3.5 w-3.5" /> Send
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
