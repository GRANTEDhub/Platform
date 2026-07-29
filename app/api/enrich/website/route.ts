import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnthropicClient, CHEAP_MODEL } from "@/lib/anthropic";

// Draft a client/prospect's "what they do / what they're looking to fund" narrative
// FROM their website, for grant-prospecting. Staff-only. Fetches the page (bounded +
// a basic SSRF guard), strips it to text, and asks the cheap model for a short
// {mission, funding_need} draft. The caller drops the result into the (still fully
// editable) narrative field -- nothing is saved here, and it only runs on an
// explicit click, so it never auto-populates or auto-commits.
export const runtime = "nodejs";
export const maxDuration = 30;

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
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content:
            `Draft a short INTERNAL profile of a U.S. organization for grant-prospecting, from the text of their website. ` +
            `Return ONLY a JSON object: {"mission": "...", "funding_need": "..."}\n` +
            `- "mission": 2-3 sentences on what the organization does and who it serves.\n` +
            `- "funding_need": 1-2 sentences on the kinds of projects/programs they might seek grant funding for. ` +
            `Infer conservatively from what they do; do NOT invent specific dollar figures, deadlines, or programs not supported by the text. ` +
            `If the text is too thin to tell, say so plainly rather than guessing.\n\n` +
            `WEBSITE TEXT:\n${text}`,
        },
      ],
    });
    const raw = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    let out: { mission?: unknown; funding_need?: unknown } = {};
    if (jsonMatch) {
      try {
        out = JSON.parse(jsonMatch[0]);
      } catch {
        out = {};
      }
    }
    const mission = typeof out.mission === "string" ? out.mission.trim().slice(0, 2000) : "";
    const funding_need = typeof out.funding_need === "string" ? out.funding_need.trim().slice(0, 2000) : "";
    if (!mission && !funding_need) {
      return NextResponse.json({ error: "Couldn't draft from that site — try filling it in manually." }, { status: 502 });
    }
    return NextResponse.json({ mission, funding_need });
  } catch (err) {
    return NextResponse.json(
      { error: `Draft failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
