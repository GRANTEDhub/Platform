// ──────────────────────────────────────────────────────────────────────────
// Step 2 — NOFO discovery, parse, and validation for the Simpler.gov API path.
//
// The API summary carries the structured basics (award, deadline, eligibility)
// but never the analytical depth (scoring rubric, delivery/convener model). This
// module finds the REAL program NOFO across all sources, parses it, validates it
// is the program NOFO (not boilerplate or a stub pointer), and returns its text.
//
// Grounded in cross-agency sampling:
//  - Sources unioned: attachments[] + competitions[].competition_instructions[]
//    + summary.additional_info_url (followed). Attachments are often EMPTY
//    (NSF, SAMHSA) so link-following is a primary path, not a fallback.
//  - Ranking: name/desc match on "NOFO"/opp-number = positive; /instructions/
//    path + guide/checklist/PAPPG names = negative; file size IGNORED.
//  - Parse routed on file EXTENSION, not content-type (Simpler mislabels .docx
//    as application/msword; mime-routing would wrongly skip it).
//  - Fails loud: returns no text (depth 'summary' + reason) rather than handing
//    back boilerplate. Never deepens the shred with the wrong document.
// ──────────────────────────────────────────────────────────────────────────

import { fetchGrantTextFromUrl, type ExtractedGrant } from "@/lib/grants/engine";

const FETCH_TIMEOUT_MS = 20000;

export interface NofoResolution {
  text: string | null;
  source: string | null;
  depth: "full" | "summary";
  reason: string;
}

interface DocCandidate {
  url: string;
  name: string;
  desc: string;
  ext: string;
  score: number;
  // Where it came from: a real attachment vs the competition "how to apply"
  // instructions package (always boilerplate; never the program NOFO).
  source: "attachment" | "instructions";
}

const POSITIVE = /\b(nofo|notice of funding|full announcement|funding opportunity|solicitation|foa)\b/i;
const NEGATIVE = /application guide|how to apply|checklist|worksheet|pappg|sf-?424|user guide|terms and conditions/i;

function getExt(nameOrUrl: string): string {
  const m = nameOrUrl.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/g);
  if (!m) return "";
  return m[m.length - 1].replace(/[^a-z0-9]/g, "");
}

// Structured attachments + per-competition instruction files.
function harvestDocCandidates(detail: Record<string, unknown>): DocCandidate[] {
  const out: DocCandidate[] = [];
  const push = (
    source: "attachment" | "instructions",
    url?: unknown,
    name?: unknown,
    desc?: unknown,
  ) => {
    if (typeof url !== "string" || !url) return;
    const nm = typeof name === "string" ? name : "";
    out.push({
      url,
      name: nm,
      desc: typeof desc === "string" ? desc : "",
      ext: getExt(nm || url),
      score: 0,
      source,
    });
  };

  const attachments = (detail.attachments ?? []) as Array<Record<string, unknown>>;
  for (const a of attachments) push("attachment", a.download_path, a.file_name, a.file_description);

  const competitions = (detail.competitions ?? []) as Array<Record<string, unknown>>;
  for (const c of competitions) {
    const instr = (c.competition_instructions ?? []) as Array<Record<string, unknown>>;
    for (const i of instr) push("instructions", i.download_path, i.file_name, i.file_description);
  }
  return out;
}

function rankCandidates(cands: DocCandidate[], oppNumber: string): DocCandidate[] {
  const num = (oppNumber || "").replace(/\s+/g, "").toLowerCase();
  for (const c of cands) {
    const hay = `${c.name} ${c.desc}`.toLowerCase();
    let s = 0;
    if (POSITIVE.test(hay)) s += 4;
    if (num && (c.name.toLowerCase().replace(/\s+/g, "").includes(num) || hay.includes(num))) s += 4;
    if (NEGATIVE.test(hay)) s -= 4;
    if (/\/instructions\//i.test(c.url)) s -= 5; // generic submission package path
    c.score = s;
  }
  // Only parseable doc types; .doc (legacy binary) is kept for ranking but
  // skipped at parse (mammoth handles .docx only).
  return cands
    .filter((c) => ["pdf", "docx", "doc"].includes(c.ext))
    .sort((a, b) => b.score - a.score);
}

async function fetchBuffer(url: string, apiKey: string | undefined): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: apiKey ? { "X-API-Key": apiKey } : {},
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Route on file EXTENSION, never content-type (Simpler mislabels .docx as
// application/msword). Returns null for unsupported types or parse failure.
async function parseDoc(buf: Buffer, ext: string): Promise<string | null> {
  try {
    if (ext === "pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      return (await pdfParse(buf)).text;
    }
    if (ext === "docx") {
      const mammothMod = await import("mammoth");
      const mammoth = mammothMod.default ?? mammothMod;
      return (await mammoth.extractRawText({ buffer: buf })).value;
    }
    return null; // .doc (legacy) and anything else: unsupported
  } catch {
    return null;
  }
}

type DocClass = "nofo" | "stub" | "reject";

// Conservative classifier: only "nofo" is trusted. "stub" is a pointer to
// follow (SAMHSA's instruction doc says "see full text at ..."). Everything
// else is rejected so we never deepen with boilerplate.
function classifyText(text: string): DocClass {
  const t = text.replace(/\s+/g, " ").trim();
  if (
    t.length < 4000 &&
    /(see the full (text|announcement)|available online at|refer to the full|full text of the (request|announcement|nofo))/i.test(t)
  ) {
    return "stub";
  }
  // Procedural application guide (e.g. the NSF Grants.gov Application Guide).
  // Detect it by its TITLE/opening -- a guide announces itself as a "guide",
  // while a real solicitation opens with the program name/number even though it
  // cites PAPPG / Grants.gov / SF-424 later in the body. Counting those
  // citations would false-reject real NSF solicitations, so anchor on the head.
  const head = t.slice(0, 700).toLowerCase();
  if (/(application|applicant|user|submission|proposal preparation)\s+guide|grants\.gov\b.{0,30}\bguide/i.test(head)) {
    return "reject";
  }
  if (NEGATIVE.test(t) && !POSITIVE.test(t)) return "reject";
  const hasEligibility = /eligib/i.test(t);
  const hasCriteria = /(review criteria|evaluation criteria|scoring|selection criteria|merit review|\bpoints\b)/i.test(t);
  if (t.length > 3000 && hasEligibility && hasCriteria) return "nofo";
  return "reject";
}

async function fetchRawHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Argo/1.0; grant research)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function docLinksFromHtml(html: string, base: string): string[] {
  const urls: string[] = [];
  const re = /href=["']([^"']+\.(?:pdf|docx))(?:["'?#])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      urls.push(new URL(m[1], base).toString());
    } catch {
      /* ignore malformed href */
    }
  }
  return Array.from(new Set(urls));
}

/**
 * Resolve the real program NOFO text for a Simpler.gov opportunity.
 * Order: rank attachments/instructions -> parse + validate the top few ->
 * follow additional_info_url (parse a linked doc, else use the page text).
 * Returns depth 'summary' with a reason if nothing validates -- never returns
 * boilerplate as if it were the NOFO.
 */
export async function resolveNofoText(
  detail: Record<string, unknown>,
  oppNumber: string,
): Promise<NofoResolution> {
  const apiKey = process.env.SIMPLER_GOV_API_KEY;
  const ranked = rankCandidates(harvestDocCandidates(detail), oppNumber);

  // The NOFO can only come from a real attachment -- NEVER from the competition
  // "instructions" package (generic how-to-apply boilerplate), a /instructions/
  // path, or an application-guide-named file. Excluding these (rather than just
  // down-ranking them) is what forces NSF/SAMHSA-style empty-attachment grants
  // to fall through to additional_info_url instead of accepting the decoy.
  const nofoCandidates = ranked.filter(
    (c) =>
      c.source === "attachment" &&
      !/\/instructions\//i.test(c.url) &&
      !(NEGATIVE.test(`${c.name} ${c.desc}`) && !POSITIVE.test(`${c.name} ${c.desc}`)),
  );
  const sawBoilerplate = ranked.length > nofoCandidates.length;

  // 1. Real attachments only, best-ranked first.
  for (const c of nofoCandidates.slice(0, 4)) {
    const buf = await fetchBuffer(c.url, apiKey);
    if (!buf) continue;
    const text = await parseDoc(buf, c.ext);
    if (text && classifyText(text) === "nofo") {
      return {
        text,
        source: c.url,
        depth: "full",
        reason: `parsed program NOFO (${c.ext}) from ${c.name || "attachment"}`,
      };
    }
  }

  // 2. Follow the agency additional_info_url (mandatory for SAMHSA/NSF).
  const summary = (detail.summary ?? {}) as Record<string, unknown>;
  const link = typeof summary.additional_info_url === "string" ? summary.additional_info_url : null;
  if (link) {
    const rawHtml = await fetchRawHtml(link);
    if (rawHtml) {
      const linkCands = rankCandidates(
        docLinksFromHtml(rawHtml, link).map((u) => ({
          url: u,
          name: u,
          desc: "",
          ext: getExt(u),
          score: 0,
          source: "attachment" as const,
        })),
        oppNumber,
      );
      for (const c of linkCands.slice(0, 3)) {
        const buf = await fetchBuffer(c.url, undefined);
        if (!buf) continue;
        const text = await parseDoc(buf, c.ext);
        if (text && classifyText(text) === "nofo") {
          return {
            text,
            source: c.url,
            depth: "full",
            reason: "parsed program NOFO linked from additional_info_url",
          };
        }
      }
    }
    const pageText = await fetchGrantTextFromUrl(link).catch(() => "");
    if (pageText && classifyText(pageText) === "nofo") {
      return {
        text: pageText,
        source: link,
        depth: "full",
        reason: "extracted NOFO from additional_info_url page",
      };
    }
  }

  // 3. Fail loud -> keep the summary shred, record why.
  const why = [
    nofoCandidates.length
      ? `${nofoCandidates.length} attachment candidate(s) did not validate as a NOFO`
      : "no real NOFO attachment (attachments empty or only instructions/boilerplate)",
    sawBoilerplate ? "instructions/boilerplate docs excluded" : null,
    link ? "additional_info_url did not yield a NOFO" : "no additional_info_url present",
  ]
    .filter(Boolean)
    .join("; ");
  return { text: null, source: null, depth: "summary", reason: why };
}

/**
 * Merge: the API summary stays authoritative on the structured basics; the deep
 * NOFO extraction overlays only the analytical fields the summary lacks
 * (rubric, criteria, burden, delivery/convener model, program type, etc.).
 */
export function mergeDeepShred(api: ExtractedGrant, deep: ExtractedGrant): ExtractedGrant {
  const emptyStr = (v: string) => !v || v.trim() === "";
  const emptyArr = (v: unknown[]) => !v || v.length === 0;
  // "Coarse" = the Grants.gov / Simpler `applicant_types` export gave us nothing
  // usable: empty, or the catch-all ["Other"] (case-insensitive). When the API is
  // coarse AND the NOFO shred produced granular types, take the shred; otherwise
  // keep the API value. This never overwrites a good API list, and it never
  // replaces ["Other"] with an equally-coarse shred -- an honest ["Other"] stays.
  const coarse = (v: string[]) =>
    emptyArr(v) || v.every((t) => (t ?? "").trim().toLowerCase() === "other");
  return {
    ...api,
    // Entity eligibility: the API export is frequently just ["Other"] while the
    // NOFO spells out real types. Recover the shred's granular value in that case.
    eligible_entity_types:
      coarse(api.eligible_entity_types) && !coarse(deep.eligible_entity_types)
        ? deep.eligible_entity_types
        : api.eligible_entity_types,
    // Analytical depth — take from the NOFO extraction.
    scoring_rubric:
      deep.scoring_rubric && Object.keys(deep.scoring_rubric).length ? deep.scoring_rubric : api.scoring_rubric,
    scoring_criteria_high_value: emptyArr(api.scoring_criteria_high_value)
      ? deep.scoring_criteria_high_value
      : api.scoring_criteria_high_value,
    technical_burden_flags: emptyArr(api.technical_burden_flags)
      ? deep.technical_burden_flags
      : api.technical_burden_flags,
    incumbent_risk: emptyStr(api.incumbent_risk) ? deep.incumbent_risk : api.incumbent_risk,
    subaward_prohibited: deep.subaward_prohibited || api.subaward_prohibited,
    // The convener signal: prefer the NOFO's reading over the API's hardcoded default.
    delivery_model:
      deep.delivery_model && deep.delivery_model !== "direct service" ? deep.delivery_model : api.delivery_model,
    program_type: deep.program_type || api.program_type,
    hard_disqualifiers: emptyArr(api.hard_disqualifiers) ? deep.hard_disqualifiers : api.hard_disqualifiers,
    // Basics — prefer the API (confirmed), fall back to the NOFO only when empty.
    num_awards: emptyStr(api.num_awards) ? deep.num_awards : api.num_awards,
    period_of_performance: emptyStr(api.period_of_performance)
      ? deep.period_of_performance
      : api.period_of_performance,
    ineligible_entities: emptyStr(api.ineligible_entities) ? deep.ineligible_entities : api.ineligible_entities,
  };
}
