import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/site-url";

// POST target for the "pass" confirmation on /decide/[token]/pass.
//
// It exists so that passing on a grant is never the side effect of a URL being FETCHED.
// Link scanners follow URLs out of mail and phones mis-tap, and an accidental pass
// silently removes a grant from a client's queue with nobody the wiser -- so the pass
// path needs a real form submission behind it. Interested has no such route: it is
// harmless if prefetched and reversible in one click, so it acts on arrival.
//
// This handler does NOT write. It redirects back to the page with done=1, and the page
// performs the recorded decision through record_card_decision_by_token. One place owns
// the write, one place owns the copy, and the confirmation the client reads is generated
// from the same result that produced it.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const form = await req.formData().catch(() => null);
  const action = form?.get("action");
  if (action !== "pass") {
    return NextResponse.redirect(`${appBaseUrl(req)}/decide/${params.token}/pass`, { status: 303 });
  }
  // 303, not 307: the browser must switch to GET for the redirect target, otherwise it
  // re-POSTs to a page route and the client sees a 405 instead of their confirmation.
  return NextResponse.redirect(`${appBaseUrl(req)}/decide/${params.token}/pass?done=1`, { status: 303 });
}
