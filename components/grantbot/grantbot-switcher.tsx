"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { History, Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { BRAND } from "@/lib/brand";
import {
  switcherVisible,
  clientDashboardId,
  deepLinkNeedsRemount,
  rosterUrl,
  GRANTBOT_OPEN_EVENT,
  SWITCHER_TARGET_KEY,
  type OpenGrantBotDetail,
  type RosterClient,
  type RecentThread,
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
  // One-shot guard: the client id we last force-refetched the roster for because it was missing from
  // the loaded roster (a just-created client not yet in the cached list). Prevents an endless refetch
  // loop for a client that is genuinely absent (archived/rejected, filtered out of the roster).
  const refetchedForRef = useRef<string | null>(null);
  // Request generation for the roster fetch: each fetch run takes the next value and only the LATEST run
  // commits its result, so a superseded in-flight fetch can never leave rosterLoading stuck (see the
  // fetch effect for the wedge this prevents).
  const fetchGenRef = useRef(0);
  // The latest target, mirrored to a ref so the dashId-keyed dashboard effect (whose closure is stale —
  // its only dep is dashId) can read the CURRENT target when deciding whether leaving a dashboard would
  // merely re-derive the same already-resolved client (a no-op) rather than a real target change.
  const targetRef = useRef(target);
  // The latest dashId, mirrored to a ref so the roster fetch effect (deps [everOpened, rosterAttempt]
  // only — never dashId, so it can't tear itself down) can read the CURRENT dashboard id and pass it as
  // the `?include=` param. That way a refetch fired while on an archived/rejected client's dashboard
  // pulls that client into the roster so its name resolves and its bot hosts (the S2 archived-dashboard
  // fix); off a dashboard the param is absent and the roster is the plain filtered list.
  const dashIdRef = useRef(dashId);
  useEffect(() => {
    targetRef.current = target;
    dashIdRef.current = dashId;
  });

  // ── S3: the unified "Recent" view ──
  // A cross-scope list of the actor's recent threads (firm + client). Additive — the picker still
  // starts new threads; Recent is for jumping back into an existing one.
  const [recentOpen, setRecentOpen] = useState(false);
  const [recent, setRecent] = useState<RecentThread[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentAttempt, setRecentAttempt] = useState(0);
  const recentGenRef = useRef(0);
  // A specific FIRM thread to open on the firm chat's next mount (a Recent pick); paired with a
  // bodyNonce bump that forces the remount which consumes it. (Client threads ride pendingInitial.)
  const [firmPending, setFirmPending] = useState<string | null>(null);
  // Bumped on a Recent pick to force the chat body to remount, so a picked thread opens even when it
  // belongs to the target already showing — the corner chats' initial-load is mount-only (like the
  // full page), so a changed key is how a different thread is opened.
  const [bodyNonce, setBodyNonce] = useState(0);

  const openPanel = useCallback(() => {
    setEverOpened(true);
    setOpen(true);
    setOpenSignal((n) => n + 1);
    // Start every open on the chat view, never a stale Recent list. The panel never unmounts
    // (everOpened stays true), and the Recent fetch fires only on the recentOpen false→true
    // transition — so without this, closing with History open and reopening later would re-render the
    // cached `recent` from the earlier open (stale titles/order/times) with no refetch. Resetting
    // recentOpen here lands every reopen on chat and makes the next History click a fresh false→true
    // fetch, honoring the "fresh each time" invariant (Claude Code Review #547).
    setRecentOpen(false);
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

  // In-place open from a grant card's "Ask GrantBot" button. The button dispatches on `window` rather
  // than navigating to the dashboard deep-link (the dashboard-bounce fix): open the corner on this client
  // at a NEW blank thread. The event carries the client's NAME (the grant card knows it), so we set a
  // FULLY-RESOLVED target here and never lean on the roster to resolve it — a grant sub-route's roster
  // fetch carries no `?include=` (dashId is null), so an archived/rejected or not-yet-cached client would
  // otherwise fail to resolve and silently fall back to Firm/another client, dropping the Ask (the
  // resolve-name effect only self-heals when target.id === dashId, never true here). The grant anchor is
  // already stashed under askContextKey; the corner chat consumes it on mount, so the body must (re)mount:
  // it does when the target changes to this client (a new id key), and via a bodyNonce bump when the corner
  // is ALREADY on this client (the deepLinkNeedsRemount case), so the seed can't open blank.
  //
  // manualPickRef=true marks this a DELIBERATE current target (an explicit "open this client's bot"),
  // honest — unlike a manualPickRef=false whose revert relies on a dashId→null transition that never
  // happens from a grant sub-route (dashId is null throughout), so it would pin the target with no reset.
  // We deliberately do NOT persistTarget: an Ask is task-scoped, not a preference change, so it stays
  // sticky for this session (continuity) but never overwrites the staffer's durable default (Firm / last
  // real pick), which correctly returns after the next dashboard visit. Dormant unless the button
  // dispatches, so no existing Switcher behavior changes.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenGrantBotDetail>).detail;
      const clientId = detail?.clientId;
      const clientName = detail?.clientName;
      if (!clientId || !clientName) return;
      manualPickRef.current = true;
      setFirmPending(null);
      setPendingInitial({ clientId, convId: null, blank: true });
      const prevT = targetRef.current;
      const keepSame = prevT?.kind === "client" && prevT.id === clientId;
      setTarget({ kind: "client", id: clientId, name: clientName });
      setConvId(null);
      if (deepLinkNeedsRemount(true, keepSame)) setBodyNonce((n) => n + 1);
      openPanel();
    };
    window.addEventListener(GRANTBOT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(GRANTBOT_OPEN_EVENT, onOpen);
  }, [openPanel]);

  // Fetch the roster on first open, on each explicit retry, and on a stale-cache refetch (a dashboard
  // client missing from the loaded roster — see the resolve-name effect). Deps are ONLY
  // [everOpened, rosterAttempt] — never the state this effect sets. Supersession is handled by a
  // REQUEST-GENERATION ref, NOT a rosterLoading guard: each run takes the next gen and only the LATEST
  // run commits (roster / error / clearing rosterLoading). This is why a second rosterAttempt bump while
  // a fetch is still in flight is safe — the older fetch's commits are dropped by the gen check and the
  // newer fetch resets rosterLoading. A rosterLoading guard here instead wedged the panel: it skipped
  // the new fetch, and the superseded fetch's own cancellation then meant nothing ever reset
  // rosterLoading, so it stuck true forever (Claude Code Review #545). The old roster stays in place
  // until the new one arrives, so a refetch causes no flicker.
  useEffect(() => {
    if (!everOpened) return;
    const gen = ++fetchGenRef.current;
    setRosterLoading(true);
    setRosterError(null);
    (async () => {
      try {
        const res = await fetch(rosterUrl(dashIdRef.current));
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { clients?: RosterClient[] };
        if (fetchGenRef.current === gen) setRoster(data.clients ?? []);
      } catch {
        if (fetchGenRef.current === gen) setRosterError("Couldn't load the client list.");
      } finally {
        if (fetchGenRef.current === gen) setRosterLoading(false);
      }
    })();
    return () => {
      // Supersede a still-in-flight fetch on re-run/unmount by advancing the gen, so its commits are
      // dropped by the gen check above — no alive flag whose cancellation could strand rosterLoading.
      fetchGenRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everOpened, rosterAttempt]);

  // Explicit retry after a roster-fetch failure: clear the error and bump the attempt so the fetch
  // effect re-runs (its deps do not include rosterError, so clearing alone would not re-run it).
  const retryRoster = useCallback(() => {
    setRosterError(null);
    setRosterAttempt((n) => n + 1);
  }, []);

  // Fetch the Recent list whenever the view opens (fresh each time) and on an explicit retry. Same
  // request-generation discipline as the roster fetch: only the latest run commits, and the cleanup
  // advances the gen, so re-opening the view while a fetch is in flight can't wedge recentLoading.
  useEffect(() => {
    if (!recentOpen) return;
    const gen = ++recentGenRef.current;
    setRecentLoading(true);
    setRecentError(null);
    (async () => {
      try {
        const res = await fetch("/api/grantbot/recent");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { threads?: RecentThread[] };
        if (recentGenRef.current === gen) setRecent(data.threads ?? []);
      } catch {
        if (recentGenRef.current === gen) setRecentError("Couldn't load recent conversations.");
      } finally {
        if (recentGenRef.current === gen) setRecentLoading(false);
      }
    })();
    return () => {
      recentGenRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentOpen, recentAttempt]);

  const retryRecent = useCallback(() => {
    setRecentError(null);
    setRecentAttempt((n) => n + 1);
  }, []);

  // The off-dashboard default target: the last manual pick (localStorage), else Firm, else null (the
  // open-time effect fills the first accessible client once the roster loads). Shared by the leave-a-
  // dashboard reset and the open-time default.
  const computeDefaultTarget = useCallback((): InternalTarget | null => {
    const stored = readStoredTarget();
    // Strip the persisted name (name: null) so the resolve-name effect re-validates the id against the
    // LIVE roster before the target is treated as resolved: a client that was renamed shows its current
    // name, and one that was deleted / is no longer accessible falls back (firm, else first client, else
    // nothing) instead of mounting a chat against a dead id or showing a stale name (Claude Code Review
    // #545). Same discipline as the dashboard path, which also sets name: null on purpose.
    if (stored?.kind === "client") return { kind: "client", id: stored.id, name: null };
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
      // A Recent firm-thread pick is a one-off jump, not a sticky pin: clear the firm "open this thread"
      // hint on entering a dashboard (mirrors the pendingInitial null above) so a later return to Firm
      // remounts on the true most-recent thread, not the stale picked id (Claude Code Review #547).
      setFirmPending(null);
      // Keep an already-resolved same-client target mounted, and reset convId ONLY on a real client
      // change (or a deep-link, which targets a specific conversation): re-entering the dashboard of the
      // client the corner is already showing shouldn't drop its tracked conversation and open a blank
      // one on Expand (Claude Code Review #545). Mirrors the leaving-branch sameResolvedClient guard.
      const prevT = targetRef.current;
      const keepSame = prevT?.kind === "client" && prevT.id === dashId;
      setTarget(keepSame ? prevT : { kind: "client", id: dashId, name: null });
      if (gb !== null || !keepSame) setConvId(null);
      // A deep-link that targets the client the corner is ALREADY showing keeps the id key unchanged,
      // so the body won't remount on its own and its mount-only seed/pendingInitial never open. Force
      // the remount for exactly that case (Ask-GrantBot's seed, or a Collapse-to-corner onto the same
      // client); a target change or a plain navigation remounts / must not, so this is the only bump.
      if (deepLinkNeedsRemount(gb !== null, keepSame)) setBodyNonce((n) => n + 1);
    } else if (!manualPickRef.current) {
      const next = computeDefaultTarget();
      const prev = targetRef.current;
      const sameResolvedClient =
        next?.kind === "client" && prev?.kind === "client" && prev.id === next.id && prev.name !== null;
      // Keep an already-resolved same-client target mounted rather than re-deriving it as a fresh
      // {name:null} object (which would unmount/remount the id-keyed GrantBotChat — a spinner flash + a
      // wasted transcript refetch when nothing changed). Only a real change resets convId (Claude Code
      // Review #545).
      if (!sameResolvedClient) {
        setTarget(next);
        setConvId(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashId]);

  // Open-time default when NOT on a client dashboard (the effect above already set a dashboard
  // target). Last manual pick (localStorage), else Firm, else the first accessible client.
  useEffect(() => {
    if (!open || target !== null) return;
    const stored = readStoredTarget();
    if (stored?.kind === "client") {
      // name: null → the resolve-name effect validates the id against the live roster (see
      // computeDefaultTarget); never trust the persisted name (Claude Code Review #545).
      setTarget({ kind: "client", id: stored.id, name: null });
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
      refetchedForRef.current = null; // resolved — clear the one-shot so a later missing id can refetch
      setTarget({ kind: "client", id: target.id, name });
      return;
    }
    // The id is not in the loaded roster. If it is the client whose dashboard we are ON, the roster is
    // STALE, not wrong: the client exists (we are on its RLS-gated page) and was simply created after
    // the session's first roster fetch. Refetch ONCE (the ref one-shots it per id) and re-resolve,
    // rather than silently repointing the bubble at Firm / another client (Claude Code Review #545). A
    // genuinely-absent client — archived/rejected, kept out of the roster by the pipeline_stage filter —
    // is still missing after the refetch, so it falls through to the fallback below instead of looping.
    if (target.id === dashId && refetchedForRef.current !== target.id) {
      refetchedForRef.current = target.id;
      setRosterAttempt((n) => n + 1);
      return;
    }
    // The id resolves against neither the loaded roster nor a refetch — it is genuinely inaccessible
    // (deleted, or archived/rejected and filtered out of the roster). Forget the stored preference if it
    // points at this id, so the open-time-default effect does not re-derive this same dead pick from
    // localStorage on the next null-target render: without this, open-time-default (re-reads storage →
    // {id, name:null}) and this effect (nulls the unresolvable target) ping-pong forever and freeze the
    // tab — the failure mode of the round-3 name-strip revalidation on a stale pick (Claude Code Review
    // #545).
    const stored = readStoredTarget();
    if (stored?.kind === "client" && stored.id === target.id) clearStoredTarget();
    if (showFirm) {
      setTarget({ kind: "firm" });
    } else if (roster[0]) {
      setTarget({ kind: "client", id: roster[0].id, name: roster[0].name });
    } else {
      setTarget(null);
    }
  }, [roster, target, showFirm, dashId]);

  const onConversationChange = useCallback((id: string | null) => setConvId(id), []);

  function pick(t: SwitcherTarget) {
    manualPickRef.current = true; // a manual pick persists off-dashboard (vs an auto dashboard target)
    setTarget(t);
    setConvId(null);
    setPendingInitial(null); // a manual switch is not the deep-linked thread
    setFirmPending(null); // nor a Recent firm-thread open
    setRecentOpen(false); // picking a target from the header lands you in its chat, not the Recent list
    persistTarget(t);
  }

  // A Recent-view pick: jump straight into that past conversation. Set the target and the matching
  // "open this thread" hint (pendingInitial for a client, firmPending for firm), then bump bodyNonce so
  // the chat body remounts and opens it even when it belongs to the target already showing. Persists
  // like a manual pick so it stays the off-dashboard default.
  function pickRecent(t: RecentThread) {
    manualPickRef.current = true;
    if (t.scope === "firm") {
      setFirmPending(t.id);
      setPendingInitial(null);
      setConvId(t.id);
      setTarget({ kind: "firm" });
      persistTarget({ kind: "firm" });
    } else if (t.clientId && t.clientName) {
      setFirmPending(null);
      setPendingInitial({ clientId: t.clientId, convId: t.id, blank: false });
      setConvId(t.id);
      setTarget({ kind: "client", id: t.clientId, name: t.clientName });
      persistTarget({ kind: "client", id: t.clientId, name: t.clientName });
    } else {
      return; // malformed row — leave state as-is
    }
    setBodyNonce((n) => n + 1);
    setRecentOpen(false);
  }

  // Expand = the full page for the current target, carrying the client conversation (the firm page
  // reads no ?c= yet, so firm just opens /grantbot).
  function expand() {
    if (!target) return;
    setOpen(false);
    if (target.kind === "firm") {
      router.push("/grantbot");
    } else {
      // Prefer the switcher's live convId, but right after a "?grantbot=" collapse-to-corner the corner
      // chat may not have reported its conversation yet (convId still null); fall back to the deep-link's
      // own conversation before BLANK, or Expand would open a fresh blank thread instead of the one just
      // collapsed (Claude Code Review #545).
      const conv =
        convId ?? (pendingInitial && pendingInitial.clientId === target.id ? pendingInitial.convId : null);
      router.push(`/clients/${target.id}/grantbot?c=${conv ?? BLANK_CONVERSATION}`);
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
                  onClick={() => setRecentOpen((v) => !v)}
                  title={recentOpen ? "Back to chat" : "Recent conversations"}
                  aria-label={recentOpen ? "Back to chat" : "Recent conversations"}
                  aria-pressed={recentOpen}
                  className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-lg transition-colors hover:bg-white/10 hover:text-white ${
                    recentOpen ? "bg-white/15 text-white" : "text-white/55"
                  }`}
                >
                  <History className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={expand}
                  title="Open full page"
                  aria-label="Open full page"
                  disabled={!resolved || recentOpen}
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

          {recentOpen ? (
            <div className="flex flex-1 flex-col overflow-y-auto p-2">
              {recentLoading && recent === null ? (
                <p className="flex items-center gap-2 p-4 text-[13px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </p>
              ) : recentError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
                  <p className="text-[13px] text-muted-foreground">{recentError}</p>
                  <button
                    type="button"
                    onClick={retryRecent}
                    className="inline-flex h-8 items-center rounded-lg bg-brand-navy px-3 text-[12.5px] font-semibold text-white transition-colors hover:bg-brand-navyHover"
                  >
                    Retry
                  </button>
                </div>
              ) : recent && recent.length === 0 ? (
                <p className="p-6 text-center text-[12.5px] text-muted-foreground">
                  No recent conversations yet.
                </p>
              ) : (
                (recent ?? []).map((t) => (
                  <button
                    key={`${t.scope}:${t.id}`}
                    type="button"
                    onClick={() => pickRecent(t)}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-sunken"
                  >
                    <span className="flex items-center gap-1.5">
                      {t.scope === "firm" ? (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-orange"
                          style={{ background: BRAND.orangeWash }}
                        >
                          Firm
                        </span>
                      ) : (
                        <span className="min-w-0 truncate text-[12px] font-semibold text-brand-navy">
                          {t.clientName}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[10.5px] text-ink-subtle">
                        {relativeTime(t.lastMessageAt)}
                      </span>
                    </span>
                    <span className="truncate text-[12.5px] text-muted-foreground">
                      {t.title || "Untitled conversation"}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : !resolved ? (
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
            ) : roster !== null && roster.length === 0 && !showFirm ? (
              // Nothing to host: the roster loaded EMPTY and this actor has no Firm access (a contractor
              // with no client assignments yet, or a fresh env with no clients). Without this branch the
              // target stays null forever and the panel hangs on the spinner with no error and no retry
              // — worse than the base branch, where such a user never saw the bubble (Claude Code Review
              // #545).
              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
                <p className="text-[13px] font-medium text-foreground">No clients available</p>
                <p className="text-[12px] text-muted-foreground">
                  GrantBot opens once a client is assigned to you.
                </p>
              </div>
            ) : (
              spinner
            )
          ) : resolved.kind === "firm" ? (
            <FirmGrantBotChat key={`firm:${bodyNonce}`} variant="corner" initialConversationId={firmPending} />
          ) : (
            <GrantBotChat
              key={`${resolved.id}:${bodyNonce}`}
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

function clearStoredTarget() {
  try {
    localStorage.removeItem(SWITCHER_TARGET_KEY);
  } catch {
    /* private mode / cleared storage — nothing to forget */
  }
}

// Compact "time since" for a Recent row's last activity. An unparseable/empty timestamp → "" (the row
// still renders; it just carries no time).
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const wks = Math.round(days / 7);
  if (wks < 5) return `${wks}w ago`;
  return new Date(t).toLocaleDateString();
}
