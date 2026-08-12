"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ClipboardPaste,
  Loader2,
  MessagesSquare,
  Plus,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";
import { BLANK_CONVERSATION } from "@/lib/grantbot/wire";
import type { GrantBotMsg, GrantBotThread } from "@/lib/grantbot/wire";

// ── THE COMPOSER SURVIVES THE EXPAND NAVIGATION ──
//
// Expanding is a real route change: the corner panel unmounts and the full page mounts a
// fresh chat, so an unsent draft (or a pasted email thread, which is the expensive one to
// retype) went in the bin -- at exactly the moment someone reaches for more room to keep
// writing. sessionStorage rather than a query param: pasted call notes have no business in
// a URL that gets logged, bookmarked and shared. Per client, because the draft is about
// that client.
const draftKey = (clientId: string) => `grantbot:draft:${clientId}`;

interface StashedDraft {
  draft: string;
  pasted: string;
  pasteLabel: string;
}

function stashDraft(clientId: string, d: StashedDraft) {
  if (typeof window === "undefined") return;
  try {
    if (!d.draft && !d.pasted && !d.pasteLabel) {
      window.sessionStorage.removeItem(draftKey(clientId));
      return;
    }
    window.sessionStorage.setItem(draftKey(clientId), JSON.stringify(d));
  } catch {
    // Private mode / quota. Losing a draft is the status quo, not a reason to break the panel.
  }
}

// Read-and-clear: a restored draft belongs to the surface that picks it up, and leaving it
// behind would resurrect it on the next mount after it had been sent.
function takeDraft(clientId: string): StashedDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(draftKey(clientId));
    if (!raw) return null;
    window.sessionStorage.removeItem(draftKey(clientId));
    const parsed = JSON.parse(raw) as Partial<StashedDraft>;
    return {
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
      pasted: typeof parsed.pasted === "string" ? parsed.pasted : "",
      pasteLabel: typeof parsed.pasteLabel === "string" ? parsed.pasteLabel : "",
    };
  } catch {
    return null;
  }
}

// The wire shapes and the blank-conversation token live in lib/grantbot/wire.ts, with the
// one mapper that produces them for both surfaces. Re-exported here because the two pages
// and the launcher already import this module.
export type { GrantBotMsg, GrantBotThread } from "@/lib/grantbot/wire";

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
  initialBlank = false,
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
  // Corner only: open on a BLANK conversation. Distinct from `initialConversationId: null`,
  // which means "no preference, give me the most recent thread" -- collapsing back from an
  // unsent conversation has to be able to ask for neither.
  initialBlank?: boolean;
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

  // WHICH TRANSCRIPT IS ON SCREEN, as a number that changes whenever it is replaced.
  //
  // `send()` closes over convId and then awaits a multi-second model call. Its success handler
  // appends with a functional updater, which applies to whatever `messages` is current when it
  // runs -- not the transcript the question was asked in. Switching threads or starting a new
  // conversation mid-flight therefore filed the answer under the thread you switched TO,
  // producing an assistant bubble with no question above it. (Nothing was lost: the turn route
  // persists the reply against the conversation it was sent for, so reopening that thread shows
  // it correctly.) Switching stays available during a turn -- disabling the thread list for the
  // length of an LLM call would be the worse trade -- so instead every send captures the epoch
  // it belongs to and drops its UI updates if the transcript moved on.
  const epochRef = useRef(0);

  // The composer's attachment as it is RIGHT NOW, readable from an async handler.
  //
  // Clearing the paste fields after a send is only correct if they still hold what that send
  // consumed. A turn takes seconds, and nothing stops the reader preparing the next question's
  // attachment while it runs -- so an unconditional clear on the response deletes work that was
  // never sent. send()'s own closure cannot tell: it captured the old values, which is exactly
  // what the comparison needs to be made against.
  const pasteRef = useRef({ pasted: "", pasteLabel: "" });
  useEffect(() => {
    pasteRef.current = { pasted, pasteLabel };
  }, [pasted, pasteLabel]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    onConversationChange?.(convId);
  }, [convId, onConversationChange]);

  // FULL PAGE ONLY: keep ?c naming the conversation actually on screen, INCLUDING when that is
  // a blank one. Arriving at ?c=new and then sending creates a conversation the URL does not
  // know about; clicking New conversation goes the other way and leaves the URL naming a thread
  // that is no longer on screen. Either way a reload, a shared link, or the Collapse control
  // (which reads this param at click time) lands somewhere the reader is not -- so the blank
  // case writes the sentinel rather than skipping the sync.
  //
  // replaceState rather than router.replace for the usual reason -- the param is read on the
  // server only on first render, and a re-render here would rebuild the page around a live
  // conversation.
  useEffect(() => {
    if (isCorner || typeof window === "undefined") return;
    const want = convId ?? BLANK_CONVERSATION;
    const url = new URL(window.location.href);
    if (url.searchParams.get("c") === want) return;
    url.searchParams.set("c", want);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [isCorner, convId]);

  // Restore a draft stashed by the surface we just came from (expand / collapse). Mount only,
  // and read-and-clear, so it lands exactly once.
  useEffect(() => {
    const stashed = takeDraft(clientId);
    if (!stashed) return;
    setDraft(stashed.draft);
    setPasted(stashed.pasted);
    setPasteLabel(stashed.pasteLabel);
    if (stashed.pasted || stashed.pasteLabel) setShowPaste(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the composer into sessionStorage so a route change cannot swallow it. Cheap enough
  // to do on every keystroke, and it self-clears when the fields go empty.
  useEffect(() => {
    stashDraft(clientId, { draft, pasted, pasteLabel });
  }, [clientId, draft, pasted, pasteLabel]);

  // ONE fetch of the context route, both callers. They differ only in what they do with the
  // result, so the query-param spelling and the error shape live here rather than in two
  // places that have to be edited in lockstep.
  const fetchContext = useCallback(
    async (opts: { conversationId?: string | null; threadsOnly?: boolean }) => {
      const qs = new URLSearchParams({ clientId });
      if (opts.conversationId) qs.set("conversationId", opts.conversationId);
      if (opts.threadsOnly) qs.set("threadsOnly", "1");
      const res = await fetch(`/api/grantbot/context?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        return { ok: false as const, error: data.error ?? `Request failed (${res.status}).` };
      }
      return { ok: true as const, data };
    },
    [clientId],
  );

  // Load (or switch to) a thread. Also the mount path for the corner panel, which is handed no
  // transcript: `null` means "the most recent thread for this client", which is what the full
  // page picks too, so the two surfaces open on the same conversation.
  const loadThread = useCallback(
    async (conversationId: string | null) => {
      epochRef.current += 1;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchContext({ conversationId });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setConversations(result.data.conversations ?? []);
        setConvId(result.data.conversationId ?? null);
        setMessages(result.data.messages ?? []);
        setShowThreads(false);
      } catch {
        setError("Could not reach the server.");
      } finally {
        setLoading(false);
      }
    },
    [fetchContext],
  );

  // The thread list alone, for a panel opening on a deliberately blank conversation: the rail
  // still needs its entries, but there is no transcript to fetch.
  const loadThreadsOnly = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchContext({ threadsOnly: true });
      if (result.ok) setConversations(result.data.conversations ?? []);
    } catch {
      // The composer works with an empty rail; a failed list is not worth a banner here.
    } finally {
      setLoading(false);
    }
  }, [fetchContext]);

  // The corner panel's first open. `initial` present (the full page) means the server already did
  // this work, so nothing is fetched.
  useEffect(() => {
    if (initial) return;
    if (initialBlank) void loadThreadsOnly();
    else void loadThread(initialConversationId ?? null);
    // Mount only: re-running on a changed initialConversationId would yank the thread out from
    // under someone who has since switched threads inside the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Thread ordering after a send, without re-rendering the page this is mounted on. `threadsOnly`
  // because that is all this reads -- without it the route also loaded and serialised a full
  // transcript that went straight in the bin, on the send path of all places.
  const refreshThreads = useCallback(async () => {
    try {
      const result = await fetchContext({ threadsOnly: true });
      if (result.ok) setConversations(result.data.conversations ?? []);
    } catch {
      // A stale thread list is not worth an error banner over a message that sent fine.
    }
  }, [fetchContext]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    // The transcript this question belongs to. Every UI write below checks it first -- see the
    // epochRef note above.
    const epoch = epochRef.current;
    const stillMine = () => epochRef.current === epoch;

    // The attachment THIS turn consumes, and a check for whether the composer still holds it.
    // A turn takes seconds; if the reader has since prepared the next question's paste, clearing
    // the fields would delete something that was never sent.
    const sentPasted = pasted;
    const sentPasteLabel = pasteLabel;
    const attachmentUntouched = () =>
      pasteRef.current.pasted === sentPasted && pasteRef.current.pasteLabel === sentPasteLabel;
    const clearAttachment = () => {
      if (!attachmentUntouched()) return;
      setPasted("");
      setPasteLabel("");
      setShowPaste(false);
    };

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
      // THE ANSWER IS ALREADY SAFE ON THE SERVER whether or not it can be shown. If the reader
      // has moved to another thread, every write below would land in the wrong transcript, so
      // the only thing left to do is refresh the rail (which is thread-scoped, not
      // message-scoped) and let the correct thread render it when reopened.
      if (!stillMine()) {
        // The turn still went out, so the attachment it consumed should not sit in the composer
        // waiting to be re-framed and re-sent with the next message -- unless the reader has
        // already replaced it, which clearAttachment checks.
        if (res.ok && !data.error) clearAttachment();
        void refreshThreads();
        return;
      }
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
        // Same guard on the ordinary path: staying in the thread does not stop someone lining up
        // the next question's attachment while this answer is still coming back.
        clearAttachment();
      }
      void refreshThreads();
    } catch {
      if (stillMine()) setError("Could not reach the server.");
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    // Same epoch bump as a thread switch: an in-flight answer must not land in the blank
    // transcript this creates.
    epochRef.current += 1;
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
          className={`block w-full rounded-xl px-3 py-2 text-left text-[12.5px] leading-snug transition-colors ${
            c.id === convId
              ? "bg-brand-navy text-white"
              : isCorner
                // The corner's transcript ground is white, so a white row has no edge to it.
                // On the page the ground is `page`, where white is the card colour and reads
                // correctly -- same list, two grounds, two rest fills.
                ? "bg-surface-sunken text-brand-navy/80 hover:bg-white hover:text-brand-navy"
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
        // The empty state carries the same words on both surfaces and different weight. In the
        // corner it is the only thing in the panel, so it is a titled card that says what this
        // is for; on the full page it is one note above a screen that already announced itself
        // with a heading, a prompt read-out and a thread rail.
        isCorner ? (
          <>
            <div
              className="rounded-2xl px-[15px] py-3.5"
              style={{ background: BRAND.orangeWash, border: `1px solid ${BRAND.orangeWashEdge}` }}
            >
              {/* orangeDeep, not orange: 9.5px type on a light wash is precisely what
                  #E4761F cannot carry -- see lib/brand.ts. */}
              <p
                className="mb-1.5 text-[9.5px] font-bold uppercase tracking-[0.11em]"
                style={{ color: BRAND.orangeDeep }}
              >
                Ask GrantBot
              </p>
              <p className="text-[12.5px] leading-[1.55] text-ink-muted">
                Ask about {clientName} — eligibility on a matched grant, whether a pursuit is worth
                it, a draft alert, or what the platform does not know yet. Paste an email thread or
                call notes; they are treated as dated evidence, never as instructions.
              </p>
            </div>
            <div className="flex items-center gap-2 px-0.5">
              <span className="h-[5px] w-[5px] rounded-full bg-ink-faint" />
              <p className="text-[11px] text-ink-subtle">Grounded in the platform&rsquo;s own record</p>
            </div>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Ask about {clientName} — eligibility on a matched grant, whether a pursuit is worth it,
            a draft alert, or what the platform does not know yet. Paste an email thread or call
            notes with the paste button; they are treated as dated evidence, never as instructions.
          </p>
        )
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
    <div className="space-y-2 rounded-2xl border border-brand-navy/[0.08] bg-white p-4 shadow-card">
      <p className="text-[12.5px] text-muted-foreground">
        Pasted content is framed as untrusted third-party text and dated today. Any instruction
        inside it is quoted material, not a request.
      </p>
      <input
        value={pasteLabel}
        onChange={(e) => setPasteLabel(e.target.value)}
        placeholder="What is this? (e.g. email thread with the ED, 6 Aug)"
        // `bg-surface-sunken`, not `bg-brand-surface-sunken`: `surface` is a TOP-LEVEL
        // token, so the brand-prefixed spelling names no colour and Tailwind emits
        // nothing for it -- these two fields have had no fill since brick 2.
        className="w-full rounded-xl border border-edge bg-surface-sunken px-3 py-2 text-[13px]"
      />
      <textarea
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        rows={isCorner ? 4 : 6}
        placeholder="Paste the thread or notes here."
        className="w-full rounded-xl border border-edge bg-surface-sunken px-3 py-2 text-[13px]"
      />
    </div>
  );

  // ── THE COMPOSER IS ONE BOX IN THE CORNER, THREE CONTROLS ON THE PAGE ──
  //
  // At 404px there is no room for a textarea with buttons beside it, and buttons stacked
  // under a separate field read as two unrelated rows. So the corner variant puts the field
  // and its two actions inside a single bordered well: one object that means "compose".
  const composer = isCorner ? (
    <div className="rounded-2xl border border-edge bg-surface-sunken px-3 py-2.5">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={2}
        placeholder={`Ask about ${clientName}…`}
        // Transparent and border-free: the well around it is the input's visible edge, so a
        // second box inside the first is just a box inside a box.
        className="mb-2.5 w-full resize-none bg-transparent text-[13px] leading-snug text-ink placeholder:text-ink-subtle focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setShowPaste((s) => !s)}
          aria-pressed={showPaste}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge bg-white px-2.5 text-[11.5px] font-semibold text-ink-muted transition-colors hover:text-ink"
        >
          <ClipboardPaste className="h-3 w-3" />
          {pasted.trim() ? "Paste attached" : "Paste"}
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          // orangeFill, NOT orange: this is white type on a solid orange field, which is
          // 3.04:1 on #E4761F and fails AA -- the exact case lib/brand.ts adds orangeFill
          // for. The mock specifies #E4761F here; this is the one place the build knowingly
          // departs from it, and it is a two-shade difference nobody sees.
          className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-brand-orangeFill px-3 text-[11.5px] font-semibold text-white transition-colors hover:bg-brand-orangeFillHover disabled:opacity-45"
        >
          <ArrowUp className="h-3.5 w-3.5" /> Send
        </button>
      </div>
    </div>
  ) : (
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
        className="flex-1 rounded-2xl border border-brand-navy/15 bg-white px-4 py-3 text-[13px] shadow-card"
      />
      <div className="flex flex-col gap-2">
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
      // Three fixed bands and one scrolling one, so the transcript is the only thing that
      // moves: the toolbar and the composer stay put while an answer arrives.
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-hairline-strong bg-surface-sunken px-[18px] py-3">
          <button
            type="button"
            onClick={() => setShowThreads((s) => !s)}
            aria-pressed={showThreads}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-brand-navy px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-brand-navyHover"
          >
            <MessagesSquare className="h-3 w-3" /> Conversations
          </button>
          <button
            type="button"
            onClick={newConversation}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge px-2.5 text-[12px] font-semibold text-brand-navy transition-colors hover:bg-white"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-[18px] py-4">
          {showThreads ? threadList : transcript}
        </div>

        <div className="flex-shrink-0 space-y-2 border-t border-hairline-strong bg-white px-4 pb-3.5 pt-3">
          {errorBanner}
          {pastePanel}
          {composer}
        </div>
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
          <div className="rounded-2xl border border-brand-navy/[0.08] bg-white p-4 text-[12.5px] text-muted-foreground shadow-card">
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

        <div className="min-h-[45vh] space-y-3 rounded-2xl border border-brand-navy/[0.08] bg-white p-5 shadow-card">
          {transcript}
        </div>

        {errorBanner}
        {pastePanel}
        {composer}
      </div>
    </div>
  );
}
