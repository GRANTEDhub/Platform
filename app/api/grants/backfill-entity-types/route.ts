import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { extractGrantData } from "@/lib/grants/engine";

export const maxDuration = 300;

// Admin-only ONE-TIME, DATA-ONLY backfill for the mergeDeepShred entity-types
// remediation. Before the fix, mergeDeepShred discarded the NOFO shred's granular
// `eligible_entity_types` whenever the coarse Grants.gov / Simpler export gave us
// ["Other"] -- so ~34 fully-shredded grants stored ["Other"] despite their NOFO
// text spelling out real types.
//
// This route re-derives those types from each grant's ALREADY-STORED `raw_text`
// (which, for shred_depth='full' grants, IS the NOFO text) -- NO NOFO re-fetch,
// NO Simpler API call. It writes ONE column (`eligible_entity_types`) and nothing
// else: no re-score, no roster match, no Stage A rebuild, no other field. The
// roster-wide re-match against corrected data is a separate, deliberate sweep.
//
// Two modes, apply-gated so an accidental hit is a no-op:
//   default (apply=false): LIST -- select candidates, return them + a cost
//     estimate. No LLM calls, no writes.
//   apply=true: RUN -- extractGrantData(raw_text) per candidate, apply the same
//     coarse() precedence mergeDeepShred uses, and UPDATE eligible_entity_types
//     ONLY where the re-derived value is genuinely granular. Returns a full
//     id -> {old,new} snapshot so any row is a one-line revert.
//
// Targets only shred_depth='full' + coarse-stored grants (the 34). Summary-shred
// grants are intentionally excluded: their raw_text is the API JSON, so re-deriving
// can't recover granularity -- those stay honest ["Other"].

const emptyArr = (v: unknown[]) => !v || v.length === 0;
// Same predicate as mergeDeepShred: empty or all-"Other" (case-insensitive).
const coarse = (v: string[]) =>
  emptyArr(v) || v.every((t) => (t ?? "").trim().toLowerCase() === "other");

// Sonnet (MODEL) list price, for the returned estimate only.
const SONNET_IN_PER_MTOK = 3;
const SONNET_OUT_PER_MTOK = 15;
const RUN_CONCURRENCY = 4; // keep the LLM fan-out bounded under maxDuration

type Candidate = {
  id: string;
  fon: string | null;
  title: string | null;
  raw_text: string | null;
  eligible_entity_types: string[];
};

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { apply?: boolean };
  const apply = body.apply === true;

  const db = createServiceClient();

  // Candidate set: fully-shredded grants whose stored eligible_entity_types is
  // coarse. Filter coarse() in JS so the predicate is byte-identical to the merge.
  const { data: rows, error } = await db
    .from("grants")
    .select("id, fon, title, raw_text, eligible_entity_types")
    .eq("shred_depth", "full");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const candidates = (rows ?? []).filter((g) => coarse((g.eligible_entity_types ?? []) as string[])) as Candidate[];

  // ── LIST mode (default): no LLM, no writes. Just show what would run + cost. ──
  if (!apply) {
    const withText = candidates.filter((c) => (c.raw_text ?? "").trim().length > 0);
    const totalChars = withText.reduce((n, c) => n + Math.min((c.raw_text ?? "").length, 120000), 0);
    const estInTok = totalChars / 4; // ~4 chars/token
    const estOutTok = withText.length * 2000; // rubric-free extraction, ~1-3k out
    const estCost =
      (estInTok / 1_000_000) * SONNET_IN_PER_MTOK + (estOutTok / 1_000_000) * SONNET_OUT_PER_MTOK;
    return NextResponse.json({
      mode: "list",
      model: "claude-sonnet-4-6",
      candidates: candidates.length,
      will_process: withText.length,
      skipped_no_raw_text: candidates.length - withText.length,
      estimated_cost_usd: Number(estCost.toFixed(2)),
      sample: candidates.slice(0, 40).map((c) => ({
        id: c.id,
        fon: c.fon,
        title: c.title,
        current: c.eligible_entity_types,
        has_raw_text: (c.raw_text ?? "").trim().length > 0,
      })),
      note: "Dry list only — no LLM calls, no writes. POST { \"apply\": true } to run.",
    });
  }

  // ── APPLY mode: re-derive from stored raw_text, write one column, snapshot. ──
  const changed: { id: string; fon: string | null; old: string[]; new: string[] }[] = [];
  const skipped_no_raw_text: string[] = [];
  const unchanged_still_coarse: string[] = [];
  const errors: { id: string; error: string }[] = [];

  await mapPool(candidates, RUN_CONCURRENCY, async (c) => {
    const raw = (c.raw_text ?? "").trim();
    if (!raw) {
      skipped_no_raw_text.push(c.id);
      return;
    }
    try {
      const extracted = await extractGrantData(raw);
      const derived = (extracted.eligible_entity_types ?? []) as string[];
      // Same precedence as mergeDeepShred: only overwrite a coarse value with a
      // genuinely granular one. If the re-derive is still coarse, leave it honest.
      if (coarse(derived)) {
        unchanged_still_coarse.push(c.id);
        return;
      }
      const { error: upErr } = await db
        .from("grants")
        .update({ eligible_entity_types: derived })
        .eq("id", c.id);
      if (upErr) {
        errors.push({ id: c.id, error: upErr.message });
        return;
      }
      changed.push({ id: c.id, fon: c.fon, old: c.eligible_entity_types, new: derived });
    } catch (err) {
      errors.push({ id: c.id, error: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  });

  // Emit the full old->new snapshot to logs too, so the revert record survives
  // even if the HTTP response is lost.
  console.log("[backfill-entity-types] snapshot", JSON.stringify(changed));

  return NextResponse.json({
    mode: "apply",
    candidates: candidates.length,
    changed_count: changed.length,
    changed, // id -> {old,new} revert record
    skipped_no_raw_text,
    unchanged_still_coarse,
    errors,
  });
}
