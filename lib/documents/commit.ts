import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import {
  isProposableField,
  readCurrentValue,
  rejectValue,
  valuesEqual,
  type CommitIntent,
} from "./proposal";
import type { DocumentActor } from "./authorize";

// Committing reviewed profile changes, and the audit trail that makes it reversible.
//
// BOTH CLIENTS AND STAFF COMMIT -- no approval bottleneck, by decision. What makes that
// safe is not a gate, it is the record: every committed field is attributable and
// reversible, and the log cannot be edited (0078 gives client_profile_changes no UPDATE or
// DELETE policy at all).
//
// NOTHING REACHES THE PROFILE THAT A HUMAN HAS NOT SEEN. This function is the only writer,
// it accepts only fields the caller explicitly listed, and it re-validates every one of
// them against PROPOSABLE_FIELDS -- so a crafted request cannot reach a field the review
// screen would never have shown. A route that trusted the body would make the allowlist
// decorative.

export interface CommitResult {
  ok: boolean;
  error?: string;
  commitId?: string;
  changed?: string[];
  // Fields the caller asked for that were skipped because the value already matched. Not
  // an error -- reported so the caller can say "already up to date" rather than implying a
  // write that did not happen.
  unchanged?: string[];
  // Fields REFUSED by a per-field rule (rejectValue): an empty value for an additive-only
  // field, or an org_type outside ORG_TYPES. Reported rather than silently dropped, and
  // rather than failing the whole commit -- one bad field must not discard the reviewer's
  // other decisions, but they have to be told which one did not land.
  rejected?: { field: string; reason: string }[];
}

// One accepted field from the review screen. `value` is what the reviewer accepted, which
// is the extraction's proposal possibly edited by hand -- the review step is allowed to
// correct the shredder, and what they settled on is what gets written and logged.
export interface AcceptedField {
  field: string;
  value: unknown;
}

export async function commitProfileChanges(opts: {
  clientId: string;
  documentId: string | null;
  actor: DocumentActor;
  actorEmail: string | null;
  accepted: AcceptedField[];
  note: string | null;
  // "rollback" relaxes the per-field rules -- see rejectValue. Defaults to the strict case so
  // a new caller cannot get the permissive one by forgetting to think about it.
  intent?: CommitIntent;
}): Promise<CommitResult> {
  // LAST WRITE WINS, PER FIELD, BEFORE ANYTHING IS COMPUTED.
  //
  // Review finding on #340 (claude[bot]), and it is a real integrity bug in the one table
  // whose entire value is being truthful. The client row is read ONCE, so with the same field
  // twice -- [{website:'a'}, {website:'b'}] -- both iterations would compare against the same
  // untouched current value, both would land in `changed`, and the audit would get a row for
  // `orig -> 'a'`. Only 'b' ever reaches the profile (a plain key assignment clobbers), so
  // that first row describes a transition THAT NEVER HAPPENED -- and because 0078 gives this
  // table no UPDATE or DELETE policy, the fabricated row is permanent.
  //
  // The legitimate UI cannot produce it (buildProposals emits at most one proposal per field),
  // so it takes a crafted body. Fixed anyway: an append-only log that can be made to record a
  // value that never persisted is not an audit trail, and "only reachable by hand" is not a
  // property worth relying on in the thing I am asking Shannon to trust for rollback.
  const byField = new Map<string, unknown>();
  for (const a of opts.accepted) {
    if (isProposableField(a.field)) byField.set(a.field, a.value);
  }
  const fields = [...byField].map(([field, value]) => ({ field, value }));
  if (fields.length === 0) {
    return { ok: false, error: "No recognised fields to save." };
  }

  const admin = createServiceClient();

  // Read the CURRENT row first, and inside the same request that writes -- the audit's
  // old_value has to be what was actually there at commit time, not what the review screen
  // rendered minutes ago. If someone else edited the profile in between, this records the
  // truth rather than a stale before-image.
  const { data: client, error: readErr } = await admin
    .from("clients")
    .select("*")
    .eq("id", opts.clientId)
    .maybeSingle<Record<string, unknown>>();
  if (readErr || !client) return { ok: false, error: "Couldn't load the organization profile." };

  const update: Record<string, unknown> = {};
  const intake: Record<string, unknown> = {
    ...((client.intake_data as Record<string, unknown> | null) ?? {}),
  };
  let touchesIntake = false;

  const changed: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  const unchanged: string[] = [];
  const rejected: { field: string; reason: string }[] = [];

  for (const { field, value } of fields) {
    // PER-FIELD RULES, RE-APPLIED AT THE WRITER. Review finding on #340: the allowlist was
    // being checked twice but the two fields carrying EXTRA rules -- org_type and
    // primary_funding_needs, additive-only and (for org_type) ORG_TYPES-validated by
    // confirmClientProfileAction -- were validated only in buildProposals, the display path.
    // A crafted POST skipped that entirely and could clear org_type or set it to free text,
    // which is exactly the invariant this feature claimed to extend. Enforced here because
    // this is the only writer, and a rule that lives only in the renderer is a rule a request
    // can walk around.
    const refusal = rejectValue(field, value, opts.intent ?? "proposal");
    if (refusal) {
      rejected.push({ field, reason: refusal });
      continue;
    }
    const currentValue = readCurrentValue(field, client);
    if (valuesEqual(currentValue, value)) {
      unchanged.push(field);
      continue;
    }
    if (field.startsWith("intake_data.")) {
      // MERGED, never replaced. intake_data also carries keys written by the public intake
      // and the staff form that no review screen renders; replacing the object would drop
      // them silently.
      //
      // ⚠ KNOWN GAP, NOT FIXED HERE: this merge happens in APPLICATION code, so the whole
      // jsonb column is read once and written back whole. Two concurrent commits on the same
      // client, each accepting a DIFFERENT intake_data key, both read the same original and
      // the second write clobbers the first -- and each still inserts its own audit row, so
      // the log ends up asserting a change the profile no longer reflects. Since 0078 gives
      // client_profile_changes no UPDATE or DELETE policy, that row cannot be corrected.
      // Review finding on #340 (claude[bot]).
      //
      // Direct columns are unaffected: Postgres applies column-level updates natively, so
      // only the seven intake_data.* keys share this hazard.
      //
      // Closing it properly needs the merge to happen in the DATABASE (`intake_data =
      // intake_data || $1`, or an RPC doing jsonb_set per key), which means a migration --
      // so it is its own brick rather than something bolted onto this PR. It is recorded here
      // rather than left implicit because a half-fix that narrows the window (re-read just
      // before writing) would look like a fix and still lose data.
      //
      // Not reachable through the shipped UI today: the stub extractor proposes nothing, so
      // no commit happens through the review screen at all. It becomes reachable the moment
      // (iv) lands a real extractor -- which is why the fix belongs BEFORE (iv), not after.
      intake[field.slice("intake_data.".length)] = value;
      touchesIntake = true;
    } else {
      update[field] = value;
    }
    changed.push({ field, oldValue: currentValue, newValue: value });
  }

  if (changed.length === 0) {
    return { ok: true, commitId: undefined, changed: [], unchanged, rejected };
  }
  if (touchesIntake) update.intake_data = intake;

  const { error: writeErr } = await admin.from("clients").update(update).eq("id", opts.clientId);
  if (writeErr) return { ok: false, error: `Couldn't save the profile: ${writeErr.message}` };

  // THE LOG IS WRITTEN AFTER THE PROFILE, and a failure here is reported rather than
  // swallowed. The alternative orderings are both worse: logging first would record changes
  // that might not land, and treating a failed log as success would leave an unattributable
  // profile change -- which is the one thing this table exists to prevent. The profile write
  // has already happened, so the caller is told the change saved but the record did not.
  const commitId = randomUUID();
  const { error: logErr } = await admin.from("client_profile_changes").insert(
    changed.map((c) => ({
      commit_id: commitId,
      client_id: opts.clientId,
      document_id: opts.documentId,
      field: c.field,
      old_value: c.oldValue ?? null,
      new_value: c.newValue ?? null,
      // Auth user id, NOT a profiles id: a client member has no profiles row (0078).
      committed_by: opts.actor.userId,
      committed_by_email: opts.actorEmail,
      committed_by_kind: opts.actor.isStaff ? "staff" : "client",
      note: opts.note,
    })),
  );
  if (logErr) {
    console.error("[assimilation] audit insert failed:", logErr.message);
    return {
      ok: false,
      error:
        "Your changes were saved, but we couldn't record them in the change history. Tell your GRANTED contact before making more edits.",
      commitId,
      changed: changed.map((c) => c.field),
    };
  }

  return { ok: true, commitId, changed: changed.map((c) => c.field), unchanged, rejected };
}

// ── ROLLBACK IS A FORWARD COMMIT ──
//
// Re-applying the old values writes NEW audit rows rather than deleting the originals, so
// "was this rolled back, and by whom" stays answerable. An erasing rollback would make the
// log lie by omission -- the profile would be back to its old value with no trace that it
// had ever moved.
export async function rollbackCommit(opts: {
  commitId: string;
  actor: DocumentActor;
  actorEmail: string | null;
}): Promise<CommitResult> {
  const admin = createServiceClient();
  const { data: rows, error } = await admin
    .from("client_profile_changes")
    .select("client_id, document_id, field, old_value")
    .eq("commit_id", opts.commitId);
  if (error) return { ok: false, error: "Couldn't load that change." };
  if (!rows || rows.length === 0) return { ok: false, error: "That change no longer exists." };

  const typed = rows as { client_id: string; document_id: string | null; field: string; old_value: unknown }[];
  const clientId = typed[0].client_id;
  // A commit is per-client by construction; refuse rather than write across orgs if that
  // ever stops being true.
  if (typed.some((r) => r.client_id !== clientId)) {
    return { ok: false, error: "That change spans multiple organizations and can't be rolled back automatically." };
  }

  return commitProfileChanges({
    clientId,
    documentId: typed[0].document_id,
    actor: opts.actor,
    actorEmail: opts.actorEmail,
    // old_value null means the field was EMPTY before, so rolling back clears it. That is
    // the one place a commit is allowed to write an empty value -- restoring a blank a human
    // is explicitly asking to restore, rather than an extraction proposing to erase.
    accepted: typed.map((r) => ({ field: r.field, value: r.old_value ?? null })),
    note: `Rolled back commit ${opts.commitId}`,
    // Restoring history, not proposing content. Without this an undo of a commit that FILLED
    // org_type or primary_funding_needs would refuse to write the blank back and report
    // success having done nothing.
    intent: "rollback",
  });
}
