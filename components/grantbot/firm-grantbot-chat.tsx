"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, RotateCcw } from "lucide-react";
import { BRAND } from "@/lib/brand";

// The FIRM GrantBot chat — a THIN, EPHEMERAL surface for the Brick 1 reasoning proof. Deliberately
// NOT GrantBotChat: that component is welded to a clientId, the persisted store, the context route,
// threads, paste, image and rename. This one holds the transcript in React state, posts it back each
// turn, and persists nothing. A refresh is a clean slate. When the firm bot earns persistence (Brick
// 2) and the switcher (Brick 3), the shared-shell extraction happens then — not now, so the live
// per-client component stays untouched.

interface Turn {
  role: "user" | "assistant";
  text: string;
}

export function FirmGrantBotChat() {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setError(null);
    setBusy(true);
    // EPHEMERAL → EVERY failure restores. Nothing is persisted server-side (runFirmTurn writes no
    // row), so ANY failure — an HTTP error (401 session expiry / 403 / 400), a runFirmTurn 200+error,
    // no-text, or a network throw — rolls the optimistic bubble back and puts the draft back for a
    // clean retry. There is no stored turn a resend could duplicate, so unlike the persisted
    // per-client bot there is no keep-on-200+error case. Leaving the bubble would also strand a
    // user-role turn in `history`, sending two consecutive user messages on the next turn.
    const restoreForRetry = () => {
      setMessages((m) => m.slice(0, -1));
      setInput(message);
    };
    try {
      const res = await fetch("/api/grantbot/firm-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `Request failed (${res.status}). Your question is back in the box below.`);
        restoreForRetry();
      } else if (data.text) {
        setMessages((m) => [...m, { role: "assistant", text: data.text as string }]);
      } else {
        setError("The model returned no text. Your question is back in the box below; try again.");
        restoreForRetry();
      }
    } catch {
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

  function reset() {
    if (busy) return;
    setMessages([]);
    setError(null);
    setInput("");
    taRef.current?.focus();
  }

  return (
    // h-full works because the (app) layout gives <main> a definite height (flex-1 of h-screen).
    // min-h-0 on the flex children is load-bearing: without it a flex child refuses to shrink below
    // its content and hands the scroll back to the document (the composer scrolls away).
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
          <p className="truncate text-[12px] text-muted-foreground">
            Firm copilot · read-only · ephemeral (nothing is saved)
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={busy || messages.length === 0}
          title="New conversation"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-black/5 disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" /> New
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-4">
        {messages.length === 0 && !busy && (
          <div className="mx-auto mt-10 max-w-md text-center text-[13px] leading-relaxed text-muted-foreground">
            <p className="mb-2 font-medium text-brand-navy">Your GRANTED copilot.</p>
            <p>
              Grants and triage, but also BD and pricing, drafting, meeting prep, and strategy — the
              same work you do in your IntellEngine project. When a task is about client fit, it reads
              every active client&apos;s live profile from the platform. Read-only, and nothing is saved yet.
            </p>
          </div>
        )}
        <div className="flex flex-col gap-4">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] whitespace-pre-wrap rounded-2xl bg-brand-navy px-4 py-2.5 text-[13.5px] leading-relaxed text-white"
                    : "max-w-[92%] whitespace-pre-wrap rounded-2xl bg-white px-4 py-3 text-[13.5px] leading-relaxed text-brand-navy shadow-overlay"
                }
              >
                {m.text}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-3 text-[13px] text-muted-foreground shadow-overlay">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 pb-4">
        {error && (
          <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>
        )}
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
            disabled={busy || !input.trim()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill px-4 text-[13px] font-medium text-white transition-colors disabled:opacity-40"
            style={{ background: BRAND.orangeFill }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
