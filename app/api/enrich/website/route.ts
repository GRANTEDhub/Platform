import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnthropicClient, CHEAP_MODEL } from "@/lib/anthropic";
import { ORG_TYPES } from "@/lib/clients/org-types";
import { fetchWebsite } from "@/lib/net/fetch-website";

// Craft a client/prospect profile FROM their website, for grant-prospecting.
// Staff-only. Fetches the page behind the shared SSRF guard (resolve-verdict per
// hop, manual redirect loop -- lib/net/fetch-website), strips it to text,
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
      programs: {
        type: "array",
        description: "Programs/services the site describes. [] if the site does not describe any.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string", description: "One sentence on what the program does." },
            serves: { type: "string", description: "Who it serves, if stated, else \"\"." },
            status: {
              type: "string",
              enum: ["existing", "prospective"],
              description: "\"existing\" if it is running now; \"prospective\" only if the site describes it as planned/upcoming.",
            },
          },
          required: ["name", "description", "serves", "status"],
        },
      },
      partners: {
        type: "array",
        description: "Named partner organizations the site credits. [] if none are named.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Partner organization's name." },
            role: { type: "string", description: "What the partnership provides, if stated, else \"\"." },
          },
          required: ["name", "role"],
        },
      },
      service_area: {
        type: "array",
        description:
          "Counties/regions/cities the org states it SERVES (e.g. \"serving Pulaski and Faulkner counties\"). Bare names, no the word County. [] if not stated.",
        items: { type: "string" },
      },
    },
    required: [
      "name",
      "org_type",
      "address",
      "city",
      "county",
      "state",
      "zip",
      "mission",
      "funding_need",
      "programs",
      "partners",
      "service_area",
    ],
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
- programs: only programs the site actually describes, named as the site names them. Mark "prospective" ONLY when the site says it is planned/upcoming; otherwise "existing". Do not invent a program from a mission statement.
- partners: only organizations the site NAMES as partners/collaborators/funders-in-partnership. Do not list an org merely mentioned in passing. "" for role when the relationship is unstated.
- service_area: only places the org states it SERVES. Do not infer from where it is located.

Return everything through the submit_org_profile tool.`;

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

  // Fetch the page behind the shared SSRF guard: every hop is DNS-resolved and must resolve only to
  // public addresses (hostResolvesPublic), and redirects are followed manually so the guard re-runs
  // on each target (issue #359). Bounded by a timeout + redirect cap (5) + char cap inside fetchWebsite.
  const fetched = await fetchWebsite(target.toString());
  if (!fetched.ok) {
    // A blocked address, or a redirect off to a non-web scheme, reads as "unreachable" (400, same as
    // the old guard). Everything else is a fetch/HTTP failure (502). User-facing messages unchanged.
    if (fetched.reason === "blocked_host" || fetched.reason === "bad_scheme") {
      return NextResponse.json({ error: "That address isn't reachable." }, { status: 400 });
    }
    if (fetched.reason === "http_error" && typeof fetched.status === "number") {
      return NextResponse.json({ error: `Couldn't reach that site (HTTP ${fetched.status}).` }, { status: 502 });
    }
    return NextResponse.json({ error: "Couldn't reach that site — check the URL." }, { status: 502 });
  }
  const html = fetched.html;

  const text = stripHtml(html).slice(0, 12_000);
  if (text.length < 40) {
    return NextResponse.json({ error: "That page had no readable text to summarize." }, { status: 422 });
  }

  try {
    const client = getAnthropicClient();
    const msg = await client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 3000, // headroom for the programs + partners lists
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
      // Structured lists, defensively normalized: a malformed entry is dropped
      // rather than trusted, and each list is bounded.
      programs: (Array.isArray(out.programs) ? out.programs : [])
        .slice(0, 20)
        .map((p) => {
          const r = (p ?? {}) as Record<string, unknown>;
          const str = (k: string, max: number) =>
            typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "";
          return {
            name: str("name", 200),
            description: str("description", 1000),
            serves: str("serves", 300),
            status: r.status === "prospective" ? ("prospective" as const) : ("existing" as const),
          };
        })
        .filter((p) => p.name || p.description),
      partners: (Array.isArray(out.partners) ? out.partners : [])
        .slice(0, 20)
        .map((p) => {
          const r = (p ?? {}) as Record<string, unknown>;
          const str = (k: string, max: number) =>
            typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "";
          return { name: str("name", 200), role: str("role", 1000) };
        })
        .filter((p) => p.name),
      service_area: (Array.isArray(out.service_area) ? out.service_area : [])
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim().replace(/\s+County$/i, "").slice(0, 120))
        .slice(0, 30),
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
