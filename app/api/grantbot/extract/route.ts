import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { extractFileText } from "@/lib/grantbot/extract-file";

// Extract text from an uploaded binary document (PDF / .docx) for GrantBot's "Attach a file" action.
// STAFF ONLY, like the context / rename / turn routes it sits beside. The parsers (pdf-parse, mammoth)
// are node-only, so this runs on the node runtime; the parse work is bounded by extractFileText's byte
// cap and the route budget.
//
// The bytes are read, extracted, and discarded — nothing is stored. The extracted TEXT is returned to
// the client, which drops it into the same paste-attachment channel every attachment uses, so it rides
// the untrusted framePastedContent frame at turn time exactly like pasted or client-read text. The
// response is a typed result: { ok:true, text, truncated, kind } or { ok:false, reason } — the client
// maps a failure to the "couldn't read that file" banner and never shows a guessed body.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // getProfile returns the STAFF profile or null; a portal member has no profiles row. Same gate as
  // the context/turn/rename routes, and not requireUser (which redirects — an auth failure on a fetch
  // would become opaque HTML the panel cannot report).
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_request" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, reason: "no_file" }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await extractFileText(bytes, file.name, { mime: file.type });
  // 200 either way — the typed result carries ok:false; the client reads `reason`, not the HTTP status,
  // so a parse failure reads the same whether it comes back as a body or (defensively) as a status.
  return NextResponse.json(result);
}
