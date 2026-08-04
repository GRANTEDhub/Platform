import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveToken, recordPipelineEvent } from "@/lib/tokens";
import { DECISION_ACTION, decisionTokenHash } from "@/lib/alerts/decide-links";
import { appBaseUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

// Public (unauthenticated) landing for the alert email's one-click decision links.
// Records the client's answer against their review card and says what it recorded.
//
// THE PAGE OWNS THE STATE, NOT THE EMAIL. An email cannot show what you clicked, so
// every path here ends on a sentence naming the outcome plus the reverse in one click.
// That is also the mis-tap remedy: a wrong answer is one link away from being fixed,
// which is the only honest way to ship a decision control into an inbox.
//
// GET MUTATES FOR "INTERESTED", NOT FOR "PASS", and the asymmetry is deliberate. Link
// scanners (Outlook Safe Links among them) fetch URLs out of mail, and phones mis-tap.
// An accidental "interested" costs a row in their Grant Report they can pass later. An
// accidental "pass" silently removes a grant from their queue and nobody finds out. So
// interested acts on arrival; pass shows what it is about to do and needs a real POST.
//
// Runs service-role because the visitor is not logged in -- and the write goes through
// record_card_decision_by_token (migration 0068), the only thing that can satisfy
// guard_card_approval for an unauthenticated caller.

const ACTIONS = new Set(["interested", "pass"]);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-page px-6 text-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-card">
        <p className="font-serif text-xl font-semibold tracking-tight text-brand-navy">GRANTED</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function Dead({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <h1 className="font-serif text-2xl font-semibold text-brand-navy">{title}</h1>
      <p className="mt-3 text-sm text-neutral-600">{body}</p>
      <p className="mt-4 text-sm text-neutral-600">
        You can always sign in at{" "}
        <a href={`${appBaseUrl()}/portal`} className="font-medium text-brand-orangeDeep hover:underline">
          your portal
        </a>{" "}
        to review this grant, or reply to the alert email and we&apos;ll sort it out.
      </p>
    </Shell>
  );
}

type Rpc = {
  ok: boolean;
  error?: string;
  action?: string;
  card_id?: string;
  grant_title?: string | null;
};

// One sentence per failure mode. An expired link and a deleted card need different
// answers, and a generic "something went wrong" would send them to support for a
// question the page already knows the answer to.
const DEAD_COPY: Record<string, { title: string; body: string }> = {
  invalid_token: {
    title: "This link isn't valid",
    body: "It may have been mistyped or replaced by a newer alert for the same grant.",
  },
  expired: {
    title: "This link has expired",
    body: "Decision links stop working once the grant's deadline passes, so this one is no longer live.",
  },
  card_not_found: {
    title: "We couldn't find that grant",
    body: "It looks like this match was removed from your record after the alert went out.",
  },
  unknown_action: { title: "This link isn't valid", body: "The link appears to be incomplete." },
};

export default async function DecidePage({
  params,
  searchParams,
}: {
  params: { token: string; action: string };
  searchParams: { done?: string };
}) {
  if (!ACTIONS.has(params.action)) notFound();
  const db = createServiceClient();

  const token = await resolveToken(db, params.token, DECISION_ACTION);
  if (!token) {
    // Expired vs unknown are indistinguishable from resolveToken (it returns null for
    // both), and expiry is by far the likelier one for a link that was valid when sent.
    return <Dead {...DEAD_COPY.expired} />;
  }

  const other = params.action === "interested" ? "pass" : "interested";
  const otherHref = `${appBaseUrl()}/decide/${params.token}/${other}`;

  // ── PASS, first visit: confirm before acting. Nothing is written yet. ──
  if (params.action === "pass" && searchParams.done !== "1") {
    let title: string | null = null;
    if (token.grant_id) {
      const { data } = await db.from("grants").select("title").eq("id", token.grant_id).maybeSingle();
      title = (data as { title: string | null } | null)?.title ?? null;
    }
    return (
      <Shell>
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">Pass on this grant?</h1>
        <p className="mt-3 text-sm text-neutral-600">
          {title ? `"${title}"` : "This grant"} will be marked as not a fit and moved out of your queue. You can
          undo it afterwards.
        </p>
        <form action={`/api/decide/${params.token}`} method="post" className="mt-6">
          <input type="hidden" name="action" value="pass" />
          <button
            type="submit"
            className="inline-block rounded-full bg-brand-navy px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Yes, pass on it
          </button>
        </form>
        <p className="mt-4 text-sm text-neutral-600">
          <a href={otherHref} className="font-medium text-brand-orangeDeep hover:underline">
            Actually, I&apos;m interested
          </a>
        </p>
      </Shell>
    );
  }

  // ── Record it. Idempotent, so a refresh or a second click is harmless. ──
  const { data, error } = await db.rpc("record_card_decision_by_token", {
    p_token_hash: decisionTokenHash(params.token),
    p_action: params.action,
  });
  const res = (data ?? null) as Rpc | null;
  if (error || !res?.ok) {
    if (error) console.error("[decide] rpc failed:", error);
    return <Dead {...(DEAD_COPY[res?.error ?? ""] ?? DEAD_COPY.invalid_token)} />;
  }

  // The click is also a signal worth keeping: deduped in the helper so a scanner's
  // prefetch and the human's click count once.
  const h = headers();
  await recordPipelineEvent(db, {
    token,
    eventType: params.action === "interested" ? "client_alert_interested" : "client_alert_passed",
    subjectSnapshot: { grant_title: res.grant_title ?? null },
    metadata: { user_agent: h.get("user-agent"), ip: h.get("x-forwarded-for"), referer: h.get("referer") },
  });

  const interested = params.action === "interested";
  const grantHref = res.card_id ? `${appBaseUrl()}/portal/grants/${res.card_id}` : `${appBaseUrl()}/portal`;

  return (
    <Shell>
      <h1 className="font-serif text-2xl font-semibold text-brand-navy">
        {interested ? "Got it — it's in your Grant Report" : "Noted — we'll set it aside"}
      </h1>
      <p className="mt-3 text-sm text-neutral-600">
        {res.grant_title ? `"${res.grant_title}"` : "This grant"}{" "}
        {interested
          ? "is now in your Grant Report, waiting on how you want to pursue it. Nothing is committed yet."
          : "is marked as not a fit. It stays on your record, so nothing is lost if you change your mind."}
      </p>
      <a
        href={grantHref}
        className="mt-6 inline-block rounded-full bg-brand-orangeFill px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-orangeFillHover"
      >
        {interested ? "Open it in your portal →" : "See it in your portal →"}
      </a>
      {/* The reverse, always. This is what makes a one-click decision from an inbox
          safe: a mis-tap is one link from being undone, and both directions are the
          client's own call either way. */}
      <p className="mt-4 text-sm text-neutral-600">
        Changed your mind?{" "}
        <a href={otherHref} className="font-medium text-brand-orangeDeep hover:underline">
          {interested ? "Mark it not for us" : "Move it into my Grant Report"}
        </a>
      </p>
    </Shell>
  );
}
