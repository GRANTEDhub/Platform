"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { BRAND } from "@/lib/brand";
import {
  switcherVisible,
  clientDashboardId,
  SWITCHER_TARGET_KEY,
  type RosterClient,
  type SwitcherTarget,
} from "@/lib/grantbot/switcher";
import { BLANK_CONVERSATION } from "@/lib/grantbot/wire";
import { TargetPicker } from "./target-picker";

// Both chat bodies arrive on first open, not with the layout — the Switcher mounts on EVERY internal
// page and most views never ask GrantBot anything, so opening is what pays for the chat code + the
// transcript fetch. Lazy, like the launcher this subsumes.
const spinner = (
  <p className="flex flex-1 items-center gap-2 p-4 text-[13px] text-muted-foreground">
    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…
  </p>
);
const FirmGrantBotChat = dynamic(() => import("./firm-grantbot-chat").then((m) => m.FirmGrantBotChat), {
  ssr: false,
  loading: () => spinner,
});
const GrantBotChat = dynamic(() => import("./grantbot-chat").then((m) => m.GrantBotChat), {
  ssr: false,
  loading: () => spinner,
});

// Internal target: like SwitcherTarget, but a client's name may be UNRESOLVED (null) until the roster
// loads. The context-aware default and the deep-link set the id first; the resolution effect fills
// the name. The hosted GrantBotChat requires a real name, so it only mounts once name is resolved.
type InternalTarget = { kind: "firm" } | { kind: "client"; id: string; name: string | null };

// The GrantBot Switcher — a bubble in the bottom-right of every internal page, and the panel it
// opens. S2 hosts the FIRM bot AND any CLIENT bot, chosen from the roster picker in the header. It
// OWNS the corner everywhere (the client dashboard mounts the launcher only while this flag is OFF).
//
// ── ONE HOST, TWO BODIES ──
// The picker's target decides which existing chat renders under the shared navy header:
// FirmGrantBotChat (firm) or the per-client GrantBotChat corner (a client) — the SAME components the
// /grantbot page and the launcher use, carrying paste/vision/cross-thread/rename already. Nothing
// about a turn is new; this is a host + a picker over two backends that both exist.
//
// ── WHICH TARGET, BY DEFAULT ──
// Landing on a client dashboard (/clients/<id>) points the target at THAT client (matching the
// launcher it replaces) — re-asserted whenever the dashboard id changes, so a manual pick sticks
// while you stay on one dashboard but the next dashboard shows its own client. Off dashboards, the
// last manual pick (localStorage) or Firm. A "?grantbot=" deep-link (the full page's Collapse to
// corner) auto-opens on that client's conversation.
//
// ── OPENING IS FREE ──
// Nothing is fetched until first open; then the panel stays MOUNTED but hidden, so closing — and
// navigating onto a full-chat page where the Switcher stands down — keeps the draft and place.
export function GrantBotSwitcher({
  isAdmin,
  firmEnabled,
  visionEnabled,
}: {
  isAdmin: boolean;
  firmEnabled: boolean;
  visionEnabled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const visible = switcherVisible(pathname);
  const dashId = clientDashboardId(pathname);
  const showFirm = isAdmin && firmEnabled;

  const [everOpened, setEverOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [openSignal, setOpenSignal] = useState(0);

  const [target, setTarget] = useState<InternalTarget | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  // A deep-link's conversation to hand the client body on its first mount (Collapse to corner).
  const [pendingInitial, setPendingInitial] = useState<{ clientId: string; convId: string | null; blank: boolean } | null>(null);

  const [roster, setRoster] = useState<RosterClient[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // Bumped by retryRoster to re-run the fetch effect. The effect must NOT depend on roster/
  // rosterLoading/rosterError (state it sets itself): `setRosterLoading(true)` would then change the
  // deps, tearing down the running effect (its cleanup sets alive=false) before the fetch resolves —
  // so the result never commits and the roster is stuck loading forever (Claude Code Review #545). An
  // explicit attempt counter is the only dep that re-runs it.
  const [rosterAttempt, setRosterAttempt] = useState(0);
  // Whether the current target was a MANUAL pick (vs auto-assigned from the dashboard). A manual pick
  // persists off-dashboard; an auto target is dropped when you leave the dashboard. A ref, so the
  // dashboard effect (keyed on dashId) reads it without a stale closure or an extra dep.
  const manualPickRef = useRef(false);

  const openPanel = useCallback(() => {
    setEverOpened(true);
    setOpen(true);
    setOpenSignal((n) => n + 1);
  }, []);

  // Transition-in: the panel has to be in the tree at its start position for a frame before animating.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Escape closes the panel (the picker's own Escape stops propagation so it closes only the menu).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Standing down on a full-chat page closes (but does not unmount) the panel, so the draft survives.
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  // Fetch the roster once on first open, and again on each explicit retry. Deps are ONLY
  // [everOpened, rosterAttempt] — never the state this effect sets — so `setRosterLoading(true)` does
  // not re-fire it and cancel its own in-flight fetch (see rosterAttempt above). The guard reads the
  // current roster/rosterLoading from the render closure to avoid a duplicate fetch.
  useEffect(() => {
    if (!everOpened || roster || rosterLoading) return;
    let alive = true;
    setRosterLoading(true);
    setRosterError(null);
    (async () => {
      try {
        const res = await fetch("/api/grantbot/roster");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { clients?: RosterClient[] };
        if (alive) setRoster(data.clients ?? []);
      } catch {
        if (alive) setRosterError("Couldn't load the client list.");
      } finally {
        if (alive) setRosterLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everOpened, rosterAttempt]);

  // Explicit retry after a roster-fetch failure: clear the error and bump the attempt so the fetch
  // effect re-runs (its deps do not include rosterError, so clearing alone would not re-run it).
  const retryRoster = useCallback(() => {
    setRosterError(null);
    setRosterAttempt((n) => n + 1);
  }, []);

  // The off-dashboard default target: the last manual pick (localStorage), else Firm, else null (the
  // open-time effect fills the first accessible client once the roster loads). Shared by the leave-a-
  // dashboard reset and the open-time default.
  const computeDefaultTarget = useCallback((): InternalTarget | null => {
    const stored = readStoredTarget();
    if (stored?.kind === "client") return stored;
    if (showFirm) return { kind: "firm" };
    return null;
  }, [showFirm]);

  // Dashboard follow + deep-link, keyed on navigation (dashId).
  //   • On a client dashboard: point the target at that client (auto, keeping a resolved same-client
  //     target so the name is not re-cleared). A "?grantbot=" param additionally auto-opens on that
  //     conversation and is cleared so a refresh / shared URL does not reopen it; WITHOUT the param,
  //     any stale deep-link from an earlier visit is cleared so it can't re-force an old thread.
  //   • Leaving a dashboard (dashId → null): an AUTO target does not persist off-dashboard — fall back
  //     to the off-dashboard default (last manual pick / Firm). A MANUAL pick stays.
  useEffect(() => {
    if (dashId) {
      const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const gb = params?.get("grantbot") ?? null;
      if (gb !== null) {
        const blank = gb === BLANK_CONVERSATION || gb === "1";
        setPendingInitial({ clientId: dashId, convId: blank ? null : gb, blank });
        openPanel();
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.delete("grantbot");
          window.history.replaceState(window.history.state, "", url.toString());
        }
      } else {
        setPendingInitial(null);
      }
      manualPickRef.current = false;
      setTarget((prev) => (prev?.kind === "client" && prev.id === dashId ? prev : { kind: "client", id: dashId, name: null }));
      setConvId(null);
    } else if (!manualPickRef.current) {
      setTarget(computeDefaultTarget());
      setConvId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashId]);

  // Open-time default when NOT on a client dashboard (the effect above already set a dashboard
  // target). Last manual pick (localStorage), else Firm, else the first accessible client.
  useEffect(() => {
    if (!open || target !== null) return;
    const stored = readStoredTarget();
    if (stored?.kind === "client") {
      setTarget(stored);
      return;
    }
    if (stored?.kind === "firm" && showFirm) {
      setTarget({ kind: "firm" });
      return;
    }
    if (showFirm) {
      setTarget({ kind: "firm" });
      return;
    }
    if (roster && roster[0]) setTarget({ kind: "client", id: roster[0].id, name: roster[0].name });
    // else: no firm, roster still loading or empty → wait / stay null (nothing to host).
  }, [open, target, roster, showFirm]);

  // Resolve a client target's name from the roster; if the id is not in the accessible roster, fall
  // back (firm, else first client, else nothing).
  useEffect(() => {
    if (!roster || target?.kind !== "client" || target.name !== null) return;
    const name = roster.find((c) => c.id === target.id)?.name ?? null;
    if (name) {
      setTarget({ kind: "client", id: target.id, name });
    } else if (showFirm) {
      setTarget({ kind: "firm" });
    } else if (roster[0]) {
      setTarget({ kind: "client", id: roster[0].id, name: roster[0].name });
    } else {
      setTarget(null);
    }
  }, [roster, target, showFirm]);

  const onConversationChange = useCallback((id: string | null) => setConvId(id), []);

  function pick(t: SwitcherTarget) {
    manualPickRef.current = true; // a manual pick persists off-dashboard (vs an auto dashboard target)
    setTarget(t);
    setConvId(null);
    setPendingInitial(null); // a manual switch is not the deep-linked thread
    persistTarget(t);
  }

  // Expand = the full page for the current target, carrying the client conversation (the firm page
  // reads no ?c= yet, so firm just opens /grantbot).
  function expand() {
    if (!target) return;
    setOpen(false);
    if (target.kind === "firm") {
      router.push("/grantbot");
    } else {
      router.push(`/clients/${target.id}/grantbot?c=${convId ?? BLANK_CONVERSATION}`);
    }
  }

  // A fully-resolved target for the header + body (client name known). Null while resolving.
  const resolved: SwitcherTarget | null =
    target === null
      ? null
      : target.kind === "firm"
        ? { kind: "firm" }
        : target.name
          ? { kind: "client", id: target.id, name: target.name }
          : null;

  const ariaTarget = resolved
    ? resolved.kind === "firm"
      ? "Firm"
      : resolved.name
    : "";

  return (
    <>
      {visible && !open && (
        <button
          type="button"
          onClick={openPanel}
          className="fixed bottom-7 right-7 z-40 inline-flex h-11 items-center gap-2 rounded-pill bg-brand-navy px-4 text-[13px] font-medium text-white shadow-overlay transition-colors hover:bg-brand-navyHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          <Sparkles className="h-4 w-4" style={{ color: BRAND.orange }} />
          Ask GrantBot
        </button>
      )}

      {everOpened && (
        <div
          role="dialog"
          aria-label={ariaTarget ? `GrantBot — ${ariaTarget}` : "GrantBot"}
          aria-hidden={!(open && visible)}
          className={`fixed bottom-7 right-7 z-40 flex h-[min(588px,calc(100vh-3.5rem))] w-[min(404px,calc(100vw-3.5rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-floating transition-all duration-[280ms] ease-entrance ${
            open && shown && visible
              ? "visible translate-y-0 scale-100 opacity-100"
              : "invisible translate-y-4 scale-[0.98] opacity-0"
          }`}
        >
          <div className="relative flex-shrink-0 overflow-hidden bg-brand-navy px-[18px] pb-3.5 pt-4">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-[30px] -top-[46px] h-[140px] w-[140px] rounded-full"
              style={{ background: `radial-gradient(circle, ${BRAND.orangeGlow}, transparent 70%)` }}
            />
            <div className="relative flex items-start gap-[11px]">
              <div
                className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-lg"
                style={{ background: BRAND.orangeTileOnInk }}
              >
                <Sparkles className="h-[15px] w-[15px]" style={{ color: BRAND.orange }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-[16px] font-bold text-white">GrantBot</p>
                {resolved ? (
                  <TargetPicker
                    target={resolved}
                    isAdmin={isAdmin}
                    firmEnabled={firmEnabled}
                    roster={roster}
                    loading={rosterLoading}
                    error={rosterError}
                    onPick={pick}
                  />
                ) : (
                  <p className="truncate text-[11.5px] text-white/40">…</p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-0.5 pt-px">
                <button
                  type="button"
                  onClick={expand}
                  title="Open full page"
                  aria-label="Open full page"
                  disabled={!resolved}
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Close"
                  aria-label="Close GrantBot"
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-[15px] w-[15px]" />
                </button>
              </div>
            </div>
          </div>
          <div className="h-0.5 flex-shrink-0 bg-brand-orange" />

          {!resolved ? (
            // Unresolved: normally a brief roster load (spinner). But if the roster FETCH failed while
            // resolving a client target, the picker (which renders the error) is unmounted — so surface
            // the error + a retry HERE, or the user is stranded on a permanent spinner (Vercel #545).
            rosterError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
                <p className="text-[13px] text-muted-foreground">{rosterError}</p>
                <button
                  type="button"
                  onClick={retryRoster}
                  className="inline-flex h-8 items-center rounded-lg bg-brand-navy px-3 text-[12.5px] font-semibold text-white transition-colors hover:bg-brand-navyHover"
                >
                  Retry
                </button>
              </div>
            ) : (
              spinner
            )
          ) : resolved.kind === "firm" ? (
            <FirmGrantBotChat variant="corner" />
          ) : (
            <GrantBotChat
              key={resolved.id}
              clientId={resolved.id}
              clientName={resolved.name}
              variant="corner"
              initialConversationId={
                pendingInitial && pendingInitial.clientId === resolved.id ? pendingInitial.convId : undefined
              }
              initialBlank={
                pendingInitial && pendingInitial.clientId === resolved.id ? pendingInitial.blank : undefined
              }
              onConversationChange={onConversationChange}
              visionEnabled={visionEnabled}
              openSignal={openSignal}
            />
          )}
        </div>
      )}
    </>
  );
}

function readStoredTarget(): InternalTarget | null {
  try {
    const raw = localStorage.getItem(SWITCHER_TARGET_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as { kind?: string; id?: unknown; name?: unknown };
    if (t?.kind === "firm") return { kind: "firm" };
    if (t?.kind === "client" && typeof t.id === "string" && typeof t.name === "string") {
      return { kind: "client", id: t.id, name: t.name };
    }
  } catch {
    /* private mode / cleared storage — no preference */
  }
  return null;
}

function persistTarget(t: SwitcherTarget) {
  try {
    localStorage.setItem(SWITCHER_TARGET_KEY, JSON.stringify(t));
  } catch {
    /* non-fatal — the pick still applies this session */
  }
}
