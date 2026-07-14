import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { constructIdealApplicantProfile } from "@/lib/grants/engine";
import type { Grant, IdealApplicantProfile } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only: regenerate ONE grant's ideal_applicant_profile from its ALREADY
// STORED raw_text, using the current Stage-A builder (IDEAL_PROFILE_SYSTEM_PROMPT).
// The one-grant tool for a builder-prompt change -- it does the MINIMUM: no
// re-fetch, no re-shred, no re-score.
//
//   GET /api/grants/<grantId>/regenerate-ideal-profile
//
// vs. the rematch route (?reshred=true), which re-fetches the NOFO AND re-scores
// the whole roster (writes cards + match_attempts). This route writes exactly ONE
// column (ideal_applicant_profile) and nothing else:
//   - status is NOT touched -> no cron/drain picks it up (drain processes 'queued')
//   - runMatching is NOT called -> no cards, no match_attempts, no lifecycle churn
// So nothing auto-re-scores the roster. Overwrite-idempotent (one column, no
// accumulation). Fully reversible by pasting the pre-change snapshot back:
//   update grants set ideal_applicant_profile = '<snapshot json>'::jsonb where id = '<id>';
//
// The response enumerates the seat menu with the SAME id scheme buildSeatMenu uses
// (P{i} prime, S{i}_{j} supporting, 0-based) so the new labels are eyeball-able
// immediately -- reading them back via SQL (jsonb) is equally valid.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const db = createServiceClient();
  const { data: grant } = await db
    .from("grants")
    .select("id, title, raw_text, ideal_applicant_profile")
    .eq("id", params.id)
    .single();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const rawText = (grant as Pick<Grant, "raw_text">).raw_text;
  if (!rawText || !rawText.trim()) {
    return NextResponse.json(
      { error: "Grant has no stored raw_text to regenerate from (re-shred first if needed)" },
      { status: 400 },
    );
  }

  let idealProfile: IdealApplicantProfile;
  try {
    idealProfile = await constructIdealApplicantProfile(rawText);
  } catch (e) {
    return NextResponse.json(
      { error: `Ideal-profile construction failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` },
      { status: 502 },
    );
  }

  // Write the profile column and clear any recorded Stage-A error (this build
  // succeeded). No status change, no runMatching.
  const { error: updateError } = await db
    .from("grants")
    .update({ ideal_applicant_profile: idealProfile, ideal_profile_error: null })
    .eq("id", params.id);
  if (updateError) {
    return NextResponse.json({ error: `Write failed: ${updateError.message}` }, { status: 500 });
  }

  // Convenience enumeration mirroring buildSeatMenu's id scheme (0-based i/j).
  const seats: { seat_id: string; kind: "PRIME" | "SUPPORTING"; label: string }[] = [];
  (idealProfile.archetypes ?? []).forEach((a, i) => {
    seats.push({ seat_id: `P${i}`, kind: "PRIME", label: `${a.label}: ${a.core_role}` });
    (a.partner_seats ?? []).forEach((s, j) => {
      seats.push({ seat_id: `S${i}_${j}`, kind: "SUPPORTING", label: s });
    });
  });

  return NextResponse.json({
    grantId: params.id,
    title: (grant as Pick<Grant, "title">).title ?? null,
    regenerated: true,
    core_funded_role: idealProfile.core_funded_role ?? null,
    seats,
    new_profile: idealProfile,
  });
}
