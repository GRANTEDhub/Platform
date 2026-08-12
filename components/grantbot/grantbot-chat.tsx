"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ClipboardPaste, Loader2, MessagesSquare, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

export interface GrantBotMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  error: string | null;
  usage: Usage | null;
  instructionsVersion: string | null;
  methodologyVersion: string | null;
}

export interface GrantBotThread {
  id: string;
  title: string | null;
  lastMessageAt: string;
}

export interface GrantBotPromptMeta {
  prefixChars: number;
  sharedChars: number;
  instructionsVersion: string;
  methodologyVersion: string;
  gaps: number;
}

// Server-rendered transcript, for the surface that has one.
export interface GrantBotInitial {
  conversationId: string | null;
  conversations: GrantBotThread[];
  messages: GrantBotMsg[];
}

// The chat. Deliberately plain: a transcript, a box, and a separate paste field.
//
// ── THE PASTE FIELD IS SEPARATE FROM THE MESSAGE BOX, ON PURPOSE ──
//
// Pasting a client email into the same box as the question would make the two indistinguishable
// by the time they reach the model -- and the whole defence rests on untrusted text being
// delimited. A second field means the SERVER applies the frame (framePastedContent), so the
// markers cannot be forged by typing them, and the staffer can see which half of what they sent
// is being treated as evidence rather than instruction.
//
// ── TWO VARIANTS, ONE COMPONENT, ONE CONVERSATION ──
//
// `full` is the page: a 240px thread rail beside the transcript, plus the read-out of what the
// assembled prompt costs. `corner` is the launcher panel on the client dashboard: the rail
// collapses behind a toggle and the read-out is gone, because 380px of chat is for asking and the
// cost model is a debugging question (the Context pack tab answers it properly).
//
// The variants differ in CHROME ONLY. Same store, same turn route, same conversation -- expanding
// the corner panel navigates to the full page carrying the conversation id, so what you were
// reading is what you keep reading.
//
// ── NO router.refresh() ANYWHERE IN HERE ──
//
// The thread list and its ordering live server-side, so the page version used to re-render itself
// after every send to pick them up. In the corner panel that would re-render the entire client
// dashboard underneath -- masthead, report rows, drafts, the lot -- on every message. So the list
// is refetched from /api/grantbot/context instead, which is the two queries actually needed.
export function GrantBotChat({
  clientId,
  clientName,
  variant,
  initial,
  promptMeta,
  initialConversationId,
  onConversationChange,
}: {
  clientId: string;
  clientName: string;
  variant: "corner" | "full";
  initial?: GrantBotInitial;
  promptMeta?: GrantBotPromptMeta;
  // Corner only: open ON a thread (returning from the full page collapses back to the one you
  // were in). Ignored when `initial` is supplied.
  initialConversationId?: string | null;
  // Lets the launcher keep the expand target pointed at the live conversation without owning
  // conversation state itself.
  onConversationChange?: (id: string | null) => void;
}) {
  const isCorner = variant === "corner";
  const [convId, setConvId] = useState<string | null>(initial?.conversationId ?? null);
  const [conversations, setConversations] = useState<GrantBotThread[]>(initial?.conversations ?? []);
  const [messages, setMessages] = useState<GrantBotMsg[]>(initial?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteLabel, setPasteLabel] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    onConversationChange?.(convId);
  }, [convId, onConversationChange]);

  // Load (or switch to) a thread. Also the mount path for the corner panel, which is handed no
  // transcript: `null` means "the most recent thread for this client", which is what the full
  // page picks too, so the two surfaces open on the same conversation.
  const loadThread = useCallback(
    async (conversationId: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ clientId });
        if (conversationId) qs.set("conversationId", conversationId);
        const res = await fetch(`/api/grantbot/context?${qs.toString()}`);
        const data = await res.json();
        if (!res.ok || data.error) {
          setError(data.error ?? `Could not load the conversation (${res.status}).`);
          return;
        }
        setConversations(data.conversations ?? []);
        setConvId(data.conversationId ?? null);
        setMessages(data.messages ?? []);
        setShowThreads(false);
      } catch {
        setError("Could not reach the server.");
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  // The corner panel's first open. `initial` present (the full page) means the server already did
  // this work, so nothing is fetched.
  useEffect(() => {
    if (initial) return;
    void loadThread(initialConversationId ?? null);
    // Mount only: re-running on a changed initialConversationId would yank the thread out from
    // under someone who has since switched threads inside the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Thread ordering after a send, without re-rendering the page this is mounted on. Messages are
  // left alone deliberately: the optimistic transcript is already correct, and replacing it from
  // the server mid-flight is how a just-sent message flickers.
  const refreshThreads = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ clientId });
      if (convId) qs.set("conversationId", convId);
      const res = await fetch(`/api/grantbot/context?${qs.toString()}`);
      const data = await res.json();
      if (res.ok && !data.error) setConversations(data.conversations ?? []);
    } catch {
      // A stale thread list is not worth an error banner over a message that sent fine.
    }
  }, [clientId, convId]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);

    // Optimistic: the question appears immediately, marked pending by the spinner below rather
    // than by a fake assistant bubble. A placeholder answer that later turns into an error reads
    // as though GrantBot said something and then took it back.
    const mine: GrantBotMsg = {
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
            instructionsVersion: promptMeta?.instructionsVersion ?? null,
            methodologyVersion: promptMeta?.methodologyVersion ?? null,
          },
        ]);
        setPasted("");
        setPasteLabel("");
        setShowPaste(false);
      }
      void refreshThreads();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    setConvId(null);
    setMessages([]);
    setError(null);
    setShowThreads(false);
  }

  // THREADS. No rename and no delete in v1 -- 0080 gives these tables no UPDATE or DELETE
  // policy, so the transcript is append-only by construction.
  const threadList = (
    <div className="space-y-2">
      <button
        type="button"
        onClick={newConversation}
        className="flex w-full items-center gap-1.5 rounded-pill border border-brand-navy/15 bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-brand-navy hover:border-brand-navy/30"
      >
        <Plus className="h-3.5 w-3.5" /> New conversation
      </button>
      {conversations.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => void loadThread(c.id)}
          className={`block w-full rounded-xl px-3 py-2 text-left text-[12.5px] leading-snug ${
            c.id === convId
              ? "bg-brand-navy text-white"
              : "bg-white text-brand-navy/80 hover:text-brand-navy"
          }`}
        >
          <span className="line-clamp-2">{c.title ?? "Untitled"}</span>
          <span className={c.id === convId ? "text-white/60" : "text-brand-navy/45"}>
            {c.lastMessageAt.slice(0, 10)}
          </span>
        </button>
      ))}
      {conversations.length === 0 && (
        <p className="px-1 text-[12px] text-muted-foreground">No conversations yet.</p>
      )}
    </div>
  );

  const transcript = (
    <>
      {messages.length === 0 && !sending && !loading && (
        <p className="text-[13px] text-muted-foreground">
          Ask about {clientName} — eligibility on a matched grant, whether a pursuit is worth it, a
          draft alert, or what the platform does not know yet. Paste an email thread or call notes
          with the paste button; they are treated as dated evidence, never as instructions.
        </p>
      )}
      {loading && (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the conversation…
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
            {m.error ? <span className="text-destructive">{m.error}</span> : m.text}
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
    </>
  );

  const errorBanner = error && (
    <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <p>{error}</p>
    </div>
  );

  const pastePanel = showPaste && (
    <div className="space-y-2 rounded-2xl border border-brand-navy/[0.08] bg-white p-4 shadow-grounded">
      <p className="text-[12.5px] text-muted-foreground">
        Pasted content is framed as untrusted third-party text and dated today. Any instruction
        inside it is quoted material, not a request.
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
        rows={isCorner ? 4 : 6}
        placeholder="Paste the thread or notes here."
        className="w-full rounded-xl border border-brand-navy/15 bg-brand-surface-sunken px-3 py-2 text-[13px]"
      />
    </div>
  );

  const composer = (
    <div className={isCorner ? "space-y-2" : "flex items-end gap-2"}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={isCorner ? 2 : 3}
        placeholder={`Ask about ${clientName}…`}
        className="w-full flex-1 rounded-2xl border border-brand-navy/15 bg-white px-4 py-3 text-[13px] shadow-grounded"
      />
      <div className={isCorner ? "flex items-center gap-2" : "flex flex-col gap-2"}>
        <Button variant="outline" onClick={() => setShowPaste((s) => !s)} aria-pressed={showPaste}>
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
  );

  if (isCorner) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowThreads((s) => !s)}
            aria-pressed={showThreads}
            className="inline-flex items-center gap-1.5 rounded-pill border border-brand-navy/15 bg-white px-3 py-1 text-[12px] font-medium text-brand-navy/70 hover:border-brand-navy/30 hover:text-brand-navy"
          >
            <MessagesSquare className="h-3.5 w-3.5" />
            {conversations.length ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}` : "Conversations"}
          </button>
          <button
            type="button"
            onClick={newConversation}
            className="inline-flex items-center gap-1 rounded-pill border border-brand-navy/15 bg-white px-3 py-1 text-[12px] font-medium text-brand-navy/70 hover:border-brand-navy/30 hover:text-brand-navy"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-brand-navy/[0.08] bg-white p-4">
          {showThreads ? threadList : transcript}
        </div>
        {errorBanner}
        {pastePanel}
        {composer}
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <aside>{threadList}</aside>

      <div className="space-y-3">
        {/* WHAT IT IS LOOKING AT, AND WHAT THAT COSTS, before the first question. The shared
            figure is the guardrails + methodology span: byte-identical for every client, so it is
            cached once across the firm rather than per client. */}
        {promptMeta && (
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
              Read-only. It cannot edit the profile, run matching, or send anything — when
              something should change it will say what and where.
            </p>
          </div>
        )}

        <div className="min-h-[45vh] space-y-3 rounded-2xl border border-brand-navy/[0.08] bg-white p-5 shadow-grounded">
          {transcript}
        </div>

        {errorBanner}
        {pastePanel}
        {composer}
      </div>
    </div>
  );
}
