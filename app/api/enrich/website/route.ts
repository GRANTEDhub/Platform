import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnthropicClient, CHEAP_MODEL } from "@/lib/anthropic";
import { ORG_TYPES } from "@/lib/clients/org-types";

// Craft a client/prospect profile FROM their website, for grant-prospecting.
// Staff-only. Fetches the page (bounded + a basic SSRF guard), strips it to text,
// and asks the cheap model to extract everything the site supports: org identity,
// address, contact, and the narrative (mission / funding need).
//
// This powers the URL-first Add flow: paste a URL, click Craft profile, and the form
// opens PREPOPULATED with whatever the site yielded. Every field stays editable and
// NOTHING is saved here -- it only runs on an explicit click, so it can never
// auto-commit. Anything the site does not support comes back as "" (blank), never
// guessed: a wrong prefilled address is worse than an empty one.
export const runtime = "nodejs";
export const maxDuration = 30;

// Extraction shape IS the validation (forced tool-call, mirroring the pattern used by
// the profile refiner). Every field is optional-by-convention: the model returns ""
// when the site does not support it.
const EXTRACT_TOOL = {
  name: "submit_org_profile",
  description: "Return the organization profile extracted from the website text. Call exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Organization's full display name, or \"\" if unclear." },
      org_type: {
        type: "string",
        enum: ["nonprofit", "local_government", "state_government", "small_business", "higher_education", ""],
        description: "Best-supported applicant type, or \"\" if the text does not make it clear.",
      },
      address: { type: "string", description: "Full single-line street address (street, city, state ZIP), or \"\"." },
      city: { type: "string" },
      county: { type: "string", description: "County name WITHOUT the word County, or \"\"." },
      state: { type: "string", description: "Two-letter US state code, or \"\"." },
      zip: { type: "string" },
      primary_contact_name: { type: "string", description: "A named human contact (director/ED/president), or \"\"." },
      primary_contact_email: { type: "string", description: "A contact email found on the site, or \"\"." },
      primary_contact_phone: { type: "string" },
      ein: { type: "string", description: "9-digit IRS EIN if the site states one, else \"\"." },
      mission: { type: "string", description: "2-3 sentences: what the org does and who it serves." },
      funding_need: { type: "string", description: "1-2 sentences: what they might seek grant funding for." },
    },
    required: ["name", "org_type", "address", "city", "county", "state", "zip", "mission", "funding_need"],
  },
};

const EXTRACT_PROMPT = `You extract a U.S. organization's profile from the text of their own website, for a domestic grant-consulting firm's internal records.

RULES:
- EXTRACT, never invent. Use "" for anything the text does not support. A blank field is CORRECT and expected; a plausible-looking guess is a defect (a wrong address or contact is worse than none).
- Do NOT infer an address from an area code, a service region, or a "serving X County" phrase. Only a stated mailing/physical address counts.
- Only return an email/phone actually printed on the page. Never construct one from a pattern.
- org_type: pick from the allowed list only when the text clearly supports it, else "".
- mission: 2-3 sentences on what the organization does and who it serves.
- funding_need: 1-2 sentences on the kinds of projects/programs they might seek grant funding for, inferred conservatively from what they do. No dollar figures, no deadlines, no programs the text does not support.

Return everything through the submit_org_profile tool.`;

// Block obviously-internal hosts (SSRF): loopback, link-local (incl. cloud
// metadata 169.254.x), and RFC1918 private ranges. Not exhaustive -- a defensive
// baseline for a staff-only tool, matching the "verify, don't trust input" posture.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h === "::1" || h === "0.0.0.0") {
    return true;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || a === 169 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return true;
    }
  }
  return false;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|quot|#39|lt|gt);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "Staff only" }, { status: 403 });

  const { url } = (await req.json().catch(() => ({}))) as { url?: string };
  let target: URL;
  try {
    target = new URL((url ?? "").trim());
  } catch {
    return NextResponse.json({ error: "Enter a valid website URL." }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "Only http(s) URLs are supported." }, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json({ error: "That address isn't reachable." }, { status: 400 });
  }

  // Fetch the page, bounded by a timeout + a size cap.
  let html: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(target.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "GRANTEDbot/1.0 (+profile drafting)" },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      return NextResponse.json({ error: `Couldn't reach that site (HTTP ${res.status}).` }, { status: 502 });
    }
    html = (await res.text()).slice(0, 400_000);
  } catch {
    return NextResponse.json({ error: "Couldn't reach that site — check the URL." }, { status: 502 });
  }

  const text = stripHtml(html).slice(0, 12_000);
  if (text.length < 40) {
    return NextResponse.json({ error: "That page had no readable text to summarize." }, { status: 422 });
  }

  try {
    const client = getAnthropicClient();
    const msg = await client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 1500,
      temperature: 0,
      system: EXTRACT_PROMPT,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "submit_org_profile" },
      messages: [{ role: "user", content: `WEBSITE TEXT:\n${text}` }],
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    const out = (toolUse && toolUse.type === "tool_use" ? toolUse.input : {}) as Record<string, unknown>;
    // Every field is normalized to a trimmed, length-capped string; a non-string or
    // missing value becomes "" so the client always gets the full shape.
    const s = (k: string, max = 300) => {
      const v = out[k];
      return typeof v === "string" ? v.trim().slice(0, max) : "";
    };
    const orgTypeRaw = s("org_type", 40);
    const result = {
      name: s("name", 200),
      // Guard the enum: anything outside the known list becomes "" rather than
      // writing an org_type the dropdown can't represent.
      org_type: (ORG_TYPES as readonly string[]).includes(orgTypeRaw) ? orgTypeRaw : "",
      address: s("address", 300),
      city: s("city", 120),
      county: s("county", 120).replace(/\s+County$/i, ""),
      state: s("state", 2).toUpperCase(),
      zip: s("zip", 10),
      primary_contact_name: s("primary_contact_name", 200),
      primary_contact_email: s("primary_contact_email", 200),
      primary_contact_phone: s("primary_contact_phone", 40),
      // Only surface a well-formed 9-digit EIN; a partial match is dropped.
      ein: (() => {
        const d = s("ein", 20).replace(/\D/g, "");
        return d.length === 9 ? d : "";
      })(),
      mission: s("mission", 2000),
      funding_need: s("funding_need", 2000),
    };
    // A total miss (no identity AND no narrative) is reported as a failure so the UI
    // can tell the admin to fill it in by hand instead of silently opening blank.
    if (!result.mission && !result.funding_need && !result.name) {
      return NextResponse.json({ error: "Couldn't read anything usable from that site — fill it in manually." }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Draft failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
