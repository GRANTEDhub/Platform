"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, Plus, Pencil, MessagesSquare } from "lucide-react";
import { BRAND } from "@/lib/brand";
import type { GrantBotThread, GrantBotMsg } from "@/lib/grantbot/wire";

// The FIRM GrantBot chat. Memory (Brick 2): firm threads PERSIST — a thread rail on the left, the
// active transcript on the right, and a refresh reloads the thread instead of a clean slate. The
// cross-thread + rename brick adds: an inline thread RENAME (a hover/focus pencil → an inline input,
// committing to /api/grantbot/firm-rename), and — server-side, invisible here — the bot's two
// read-only cross-thread tools. Still its own component (not the client GrantBotChat, which is welded
// to a clientId, paste, image and per-client cross-thread); the shared-shell extraction waits for the
// Switcher brick. A rename edits only the conversation TITLE, so the append-only transcript is intact.

interface Turn {
  role: "user" | "assistant";
  text: string;
  // A persisted FAILED assistant turn has empty text + this reason (0080: "a failed turn is still a
  // turn"). Carried through so a reload/thread-switch renders the explanation, not a blank bubble.
  error?: string | null;
}

const toTurns = (msgs: GrantBotMsg[] | undefined): Turn[] =>
  (msgs ?? []).map((m) => ({ role: m.role, text: m.text, error: m.error }));

// `full` is the standalone /grantbot page: a thread rail beside the transcript, with its own header
// band. `corner` is the Switcher panel on every internal page: the Switcher supplies the navy header,
// so the corner body is headerless and the rail collapses behind a toggle — three fixed bands with
// one scroll, mirroring the per-client GrantBotChat corner so the two panels can't drift. Same store,
// same routes, same conversation; the variants differ in CHROME ONLY.
export function FirmGrantBotChat({ variant = "full" }: { variant?: "corner" | "full" }) {
  const isCorner = variant === "corner";
  // Corner-only: the rail slides over the transcript rather than sitting beside it.
  const [showThreads, setShowThreads] = useState(false);
  const [threads, setThreads] = useState<GrantBotThread[]>([]);
  const [messages, setMessages] = useState<Turn[]>([]);
  // null = a blank, unsent thread (no server id yet). A real id names a persisted thread.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // A load belongs to the thread it was asked for: newConversation and each loadThread bump this, and
  // the async result is applied only if the epoch still matches, so a slow load can't overwrite the
  // thread the reader clicked next. (send never races it — busy blocks every thread switch.)
  const epochRef = useRef(0);
  // Inline thread rename. renamingId is the thread whose title is being edited (null = none);
  // renameDraft is the in-progress text. A rename edits only the conversation title (metadata) — never
  // a stored message — so it does not break the append-only transcript. Same epoch-guarded shape as the
  // per-client bot's rename: renameEpoch bumps every time an edit opens or ends, so a commit tells
  // "this attempt" from a later one on the same row (Escape-and-reopen, or a row switch); renameInFlight
  // blocks the Enter-then-blur double-write of the SAME attempt while never blocking a fresh one; and
  // skipBlurCommit lets Escape cancel without a trailing blur re-saving the abandoned draft.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameEpoch = useRef(0);
  const renameInFlight = useRef<number | null>(null);
  const skipBlurCommit = useRef(false);

  // Initial load: most-recent thread + its transcript + the rail. A failure leaves the composer
  // working — the first send just starts a new thread. EPOCH-GUARDED: the composer is live
  // immediately, so a New / send / thread-click can land before this slow fetch returns; those bump
  // the epoch, and a stale initial load must NOT clobber the selected/optimistic state with the
  // most-recent thread (Codex). alive guards unmount; the epoch guards a local action.
  useEffect(() => {
    const epoch = epochRef.current;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/grantbot/firm-context");
        if (!res.ok) return;
        const data = (await res.json()) as { conversationId?: string | null; conversations?: GrantBotThread[]; messages?: GrantBotMsg[] };
        if (!alive || epochRef.current !== epoch) return;
        setThreads(data.conversations ?? []);
        setConversationId(data.conversationId ?? null);
        setMessages(toTurns(data.messages));
      } catch {
        /* leave empty; the composer still works */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, loadingThread]);

  // Re-sort the rail after a send. Cheap (threadsOnly) — no transcript reload.
  const refetchThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/grantbot/firm-context?threadsOnly=1");
      if (!res.ok) return;
      const data = (await res.json()) as { conversations?: GrantBotThread[] };
      setThreads(data.conversations ?? []);
    } catch {
      /* the rail keeps its current order; harmless */
    }
  }, []);

  async function loadThread(id: string) {
    if (busy || id === conversationId) return;
    const epoch = ++epochRef.current;
    setLoadingThread(true);
    setError(null);
    try {
      const res = await fetch(`/api/grantbot/firm-context?conversationId=${encodeURIComponent(id)}`);
      if (!res.ok) {
        // Surface the failure — a swallowed load just stops the spinner with no feedback (Vercel).
        if (epochRef.current === epoch) setError(`Could not load that conversation (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { conversationId?: string | null; messages?: GrantBotMsg[] };
      if (epochRef.current !== epoch) return;
      setConversationId(data.conversationId ?? id);
      setMessages(toTurns(data.messages));
    } catch {
      // Keep the current thread on a failed load, but tell the reader it didn't switch.
      if (epochRef.current === epoch) setError("Network error. Could not load that conversation.");
    } finally {
      if (epochRef.current === epoch) setLoadingThread(false);
    }
  }

  function newConversation() {
    if (busy) return;
    epochRef.current++; // cancel any in-flight loadThread
    setConversationId(null);
    setMessages([]);
    setError(null);
    setInput("");
    setLoadingThread(false);
    taRef.current?.focus();
  }

  function startRename(t: GrantBotThread) {
    skipBlurCommit.current = false;
    renameEpoch.current += 1; // a fresh edit attempt — any in-flight commit is now for an old epoch
    setRenamingId(t.id);
    setRenameDraft(t.title ?? "");
  }
  function cancelRename() {
    renameEpoch.current += 1; // ends this attempt: a commit still in flight can no longer touch state
    setRenamingId(null);
    setRenameDraft("");
  }
  async function commitRename(t: GrantBotThread) {
    const epoch = renameEpoch.current;
    // Re-entrancy guard for THIS attempt (Enter + a trailing blur), keyed to the epoch so a fresh
    // attempt on the same row (Escape then reopen) is never blocked by the stale in-flight one.
    if (renameInFlight.current === epoch) return;
    const title = renameDraft.replace(/\s+/g, " ").trim();
    // No change (or emptied) is a cancel, not a write — an empty title would blank the row.
    if (!title || title === (t.title ?? "")) {
      cancelRename();
      return;
    }
    renameInFlight.current = epoch;
    try {
      const res = await fetch("/api/grantbot/firm-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: t.id, title }),
      });
      if (res.ok) {
        // The server owns the title now; refetch the rail (not a transcript reload) to pick it up.
        await refetchThreads();
      } else {
        setError("Could not rename the conversation.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      // Only clear tracking + close the editor if we are STILL on this attempt: a request that finishes
      // after the user Escaped or switched rows (a newer epoch) must clobber neither the newer editor
      // nor the newer in-flight marker (epochs are monotonic, so the stale marker never re-matches).
      if (renameEpoch.current === epoch) {
        renameInFlight.current = null;
        cancelRename();
      }
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || busy || loadingThread) return;
    // Corner-only: collapse the rail so the send lands in a VISIBLE transcript. The composer band is
    // always rendered, so a send is reachable while the Conversations rail is up — without this the
    // optimistic bubble and the reply would appear behind the thread list with no feedback (Codex
    // #544). No-op on the full page (showThreads is never set there).
    setShowThreads(false);
    // Bump the epoch so an in-flight INITIAL load (which does not set busy) can't resolve later and
    // overwrite this send's optimistic state (Codex). busy then blocks loadThread/newConversation
    // for the rest of the request, so the active thread cannot change under the send after this.
    epochRef.current++;
    const convoAtSend = conversationId;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setError(null);
    setBusy(true);
    const restoreForRetry = () => {
      setMessages((m) => m.slice(0, -1));
      setInput(message);
    };
    try {
      const res = await fetch("/api/grantbot/firm-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId: convoAtSend }),
      });
      const data = (await res.json()) as { text?: string; error?: string; conversationId?: string };
      if (!res.ok) {
        // 4xx/5xx: returned BEFORE anything was persisted (auth / validation / create failure) →
        // restore the bubble + draft for a clean retry.
        setError(data.error ?? `Request failed (${res.status}). Your question is back in the box below.`);
        restoreForRetry();
      } else if (data.text) {
        setMessages((m) => [...m, { role: "assistant", text: data.text as string }]);
        if (data.conversationId) setConversationId(data.conversationId);
        void refetchThreads();
      } else if (data.error) {
        // 200 + error. A conversationId means the turn WAS persisted (user + assistant-error rows), so
        // the optimistic bubble matches the store — KEEP it (restoring would append a duplicate user
        // turn on resend) and adopt the id. No id means nothing persisted → restore.
        if (data.conversationId) {
          setError(data.error);
          setConversationId(data.conversationId);
          void refetchThreads();
        } else {
          setError(data.error);
          restoreForRetry();
        }
      } else {
        setError("The model returned no text. Your question is back in the box below; try again.");
        restoreForRetry();
      }
    } catch {
      // The response was lost (offline / DNS / TLS). The optimistic bubble is the only copy of the
      // question, so restore it for retry — never a silent "refresh to check".
      setError("Network error. Your question is back in the box below; try again.");
      restoreForRetry();
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const empty = messages.length === 0 && !busy && !loadingThread;

  // Shared inline rename field — the full rail and the corner rail commit through the same
  // epoch-guarded commitRename/cancelRename, so the editing affordance is written once.
  const renameField = (t: GrantBotThread) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void commitRename(t);
      }}
      className="px-0.5 py-0.5"
    >
      <input
        autoFocus
        value={renameDraft}
        onChange={(e) => setRenameDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            // Stop the native keydown before it bubbles to the Switcher's window-level Escape
            // listener, which would otherwise close the whole corner panel on a rename-cancel
            // (Codex #544). React's stopPropagation halts the native event at the root container,
            // below window. Harmless on the full page (no such listener there).
            e.stopPropagation();
            // Neutralise the blur that unmounting the input would otherwise fire as a commit.
            skipBlurCommit.current = true;
            cancelRename();
          }
        }}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
            return;
          }
          void commitRename(t);
        }}
        maxLength={80}
        aria-label="Conversation title"
        className="w-full rounded-lg border border-black/10 bg-white px-2.5 py-2 text-[13px] text-brand-navy outline-none focus:border-brand-navy/30"
      />
    </form>
  );

  // Shared bubble list — one source of truth for the transcript on both surfaces.
  const bubbles = (
    <div className="flex flex-col gap-4">
      {messages.map((m, i) => {
        // A persisted failed assistant turn (empty text + error) renders its reason in an error
        // bubble, so a reloaded transcript preserves the explanation. A real answer never carries
        // error, so `m.error` present ⟺ a failed turn.
        const isErr = m.role === "assistant" && !!m.error;
        return (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-brand-navy px-4 py-2.5 text-[13.5px] leading-relaxed text-white"
                  : isErr
                    ? "max-w-[92%] whitespace-pre-wrap rounded-2xl bg-red-50 px-4 py-3 text-[12.5px] leading-relaxed text-red-700"
                    : "max-w-[92%] whitespace-pre-wrap rounded-2xl bg-white px-4 py-3 text-[13.5px] leading-relaxed text-brand-navy shadow-overlay"
              }
            >
              {isErr ? m.error : m.text}
            </div>
          </div>
        );
      })}
      {busy && (
        <div className="flex justify-start">
          <div className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-3 text-[13px] text-muted-foreground shadow-overlay">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
          </div>
        </div>
      )}
    </div>
  );

  // Shared composer — same textarea + Send on both surfaces (taRef is only ever in one tree at a
  // time, since exactly one variant renders).
  const composerNode = (
    <div className="flex items-end gap-2 rounded-2xl border border-black/10 bg-white p-2 shadow-overlay">
      <textarea
        ref={taRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Ask GrantBot…"
        className="max-h-40 min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-[14px] text-brand-navy outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={busy || loadingThread || !input.trim()}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill px-4 text-[13px] font-medium text-white transition-colors disabled:opacity-40"
        style={{ background: BRAND.orangeFill }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send"}
      </button>
    </div>
  );

  // ── CORNER ──
  // The Switcher panel supplies the navy header, so this is headerless: a toolbar (Conversations
  // toggle + New), the scrolling transcript-or-rail, and the composer.
  if (isCorner) {
    return (
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
            onClick={() => {
              setShowThreads(false);
              newConversation();
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge px-2.5 text-[12px] font-semibold text-brand-navy transition-colors hover:bg-white"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-[18px] py-4">
          {showThreads ? (
            <div className="space-y-2">
              {threads.length === 0 ? (
                <p className="px-1 text-[12px] text-muted-foreground">No saved conversations yet.</p>
              ) : (
                threads.map((t) => {
                  const active = t.id === conversationId;
                  return (
                    <div
                      key={t.id}
                      className={`group relative rounded-xl transition-colors ${
                        active
                          ? "bg-brand-navy text-white"
                          : "bg-surface-sunken text-brand-navy/80 hover:bg-white hover:text-brand-navy"
                      }`}
                    >
                      {renamingId === t.id ? (
                        renameField(t)
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setShowThreads(false);
                              void loadThread(t.id);
                            }}
                            className="block w-full px-3 py-2 pr-8 text-left text-[12.5px] leading-snug"
                          >
                            <span className="line-clamp-2">{t.title ?? "Untitled"}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => startRename(t)}
                            aria-label="Rename conversation"
                            title="Rename"
                            className={`absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-lg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
                              active
                                ? "text-white/70 hover:bg-white/15"
                                : "text-muted-foreground hover:bg-black/5 hover:text-brand-navy"
                            }`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <>
              {loadingThread && (
                <div className="mt-8 flex justify-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
              {empty && (
                <div className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                  <p className="mb-1 font-medium text-brand-navy">Your GRANTED copilot.</p>
                  <p>
                    Grants and triage, but also BD, pricing, drafting and strategy. When a task is about
                    client fit it reads every active client&apos;s live profile. Read-only, saved across
                    sessions.
                  </p>
                </div>
              )}
              {bubbles}
            </>
          )}
        </div>

        <div className="flex-shrink-0 space-y-2 border-t border-hairline-strong bg-white px-4 pb-3.5 pt-3">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>}
          {composerNode}
        </div>
      </div>
    );
  }

  return (
    // h-full works because the (app) layout gives <main> a definite height. min-h-0 on every flex
    // ancestor is load-bearing: without it a flex child refuses to shrink below its content and hands
    // the scroll back to the document (the composer scrolls away).
    <div className="flex h-full min-h-0 w-full">
      {/* Thread rail */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-black/5">
        <div className="shrink-0 p-3">
          <button
            type="button"
            onClick={newConversation}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/10 bg-white px-3 py-2 text-[13px] font-medium text-brand-navy transition-colors hover:bg-black/5 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> New conversation
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {threads.length === 0 ? (
            <p className="px-2 py-4 text-[12px] text-muted-foreground">No saved conversations yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {threads.map((t) => {
                const active = t.id === conversationId;
                const editing = renamingId === t.id;
                return (
                  // group + relative so the hover/focus pencil can absolutely position over the row.
                  // A row is a wrapper holding a load button + a rename pencil (SIBLINGS — a button
                  // nested in a button is invalid HTML), or the inline rename input while editing.
                  <li key={t.id} className="group relative">
                    {editing ? (
                      renameField(t)
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void loadThread(t.id)}
                          disabled={busy}
                          className={`w-full truncate rounded-lg py-2 pl-2.5 pr-8 text-left text-[13px] transition-colors disabled:cursor-not-allowed ${
                            active ? "bg-brand-navy/5 font-medium text-brand-navy" : "text-muted-foreground hover:bg-black/5"
                          }`}
                          title={t.title ?? "Untitled"}
                        >
                          {t.title ?? "Untitled"}
                        </button>
                        <button
                          type="button"
                          onClick={() => startRename(t)}
                          aria-label="Rename conversation"
                          title="Rename"
                          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-black/5 hover:text-brand-navy group-hover:opacity-100 group-focus-within:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </aside>

      {/* Conversation */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col px-4">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-black/5 py-4">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: BRAND.orangeTileOnInk }}
          >
            <Sparkles className="h-[18px] w-[18px]" style={{ color: BRAND.orange }} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-serif text-[17px] font-bold text-brand-navy">GrantBot — Firm</p>
            <p className="truncate text-[12px] text-muted-foreground">Firm copilot · read-only · saved across sessions</p>
          </div>
        </div>

        {/* Transcript */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-4">
          {loadingThread && (
            <div className="mt-10 flex justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {empty && (
            <div className="mx-auto mt-10 max-w-md text-center text-[13px] leading-relaxed text-muted-foreground">
              <p className="mb-2 font-medium text-brand-navy">Your GRANTED copilot.</p>
              <p>
                Grants and triage, but also BD and pricing, drafting, meeting prep, and strategy — the
                same work you do in your IntellEngine project. When a task is about client fit, it reads
                every active client&apos;s live profile from the platform. Read-only, and saved across sessions.
              </p>
            </div>
          )}
          {bubbles}
        </div>

        {/* Composer */}
        <div className="shrink-0 pb-4">
          {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>}
          {composerNode}
        </div>
      </div>
    </div>
  );
}
