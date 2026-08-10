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
  // A PATCH, not a merged object. 0079 does the merge in the database under a row lock, so
  // this carries only the keys being changed and never the whole column -- see below.
  const intakePatch: Record<string, unknown> = {};

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
      // MERGED IN THE DATABASE (0079), not here. Only the changed key goes into the patch;
      // merge_client_intake takes a row lock, reads the COMMITTED intake_data, and applies
      // `||` to that -- so keys written by the public intake, the staff form and the client's
      // own profile page survive, and a concurrent writer cannot be clobbered.
      //
      // This used to be an application-side read-modify-write, which was a real integrity bug
      // in the one table whose whole value is being truthful: two writers each accepting a
      // DIFFERENT key both read the same original and the second erased the first, while both
      // still inserted audit rows -- so the log asserted a change the profile no longer
      // reflected, permanently, because 0078 gives client_profile_changes no UPDATE or DELETE
      // policy. Review finding on #340 (claude[bot]).
      //
      // Direct columns never had this problem: Postgres applies column-level updates
      // natively, so only these seven shared-column keys ever did.
      intakePatch[field.slice("intake_data.".length)] = value;
    } else {
      update[field] = value;
    }
    changed.push({ field, oldValue: currentValue, newValue: value });
  }

  if (changed.length === 0) {
    return { ok: true, commitId: undefined, changed: [], unchanged, rejected };
  }

  // ── TWO WRITES, AND THE ORDER PUTS THE LIKELY FAILURE ON THE SAFE SIDE ──
  //
  // Direct columns go first because they carry the constraint-checkable values (org_type
  // against its allowlist, contact fields, anything a future check constraint touches), so
  // they are the likelier of the two to be refused. Failing here means intake_data was never
  // touched and no audit row exists -- a clean abort with nothing written.
  //
  // The residual is the mirror case: direct columns land and the intake merge then fails, so
  // part of the commit persists with no audit row. That is reported below rather than
  // swallowed, and it is the same shape as the profile-then-audit split further down, which
  // this file has always had.
  if (Object.keys(update).length > 0) {
    const { error: writeErr } = await admin.from("clients").update(update).eq("id", opts.clientId);
    if (writeErr) return { ok: false, error: `Couldn't save the profile: ${writeErr.message}` };
  }

  if (Object.keys(intakePatch).length > 0) {
    // 0079. Returns intake_data AS IT WAS, read under the same row lock that computes the
    // merge -- which is the second reason that function is plpgsql rather than a one-line
    // `set intake_data = intake_data || $1`. A bare merge statement writes the right value but
    // cannot hand back the before-image, so old_value would still be `client.intake_data` from
    // the read at the top of this request. The change would take and the log would still name
    // the wrong starting point.
    const { data: prevIntake, error: mergeErr } = await admin.rpc("merge_client_intake", {
      p_client_id: opts.clientId,
      p_patch: intakePatch,
    });
    if (mergeErr) {
      const directLanded = Object.keys(update).length > 0;
      return {
        ok: false,
        error: directLanded
          ? `Some fields saved, but the narrative fields didn't: ${mergeErr.message}. Nothing was recorded in the change history — tell your GRANTED contact before making more edits.`
          : `Couldn't save the profile: ${mergeErr.message}`,
      };
    }

    // CORRECT THE BEFORE-IMAGE, then drop what turns out to be a no-op. If another writer
    // moved one of these keys between our read and our lock, the snapshot old_value would
    // describe a transition that did not happen -- the exact class of false row this brick
    // exists to prevent, so it would be absurd to leave it in the row we write ourselves.
    const prev = (prevIntake ?? {}) as Record<string, unknown>;
    for (const c of changed) {
      if (!c.field.startsWith("intake_data.")) continue;
      c.oldValue = prev[c.field.slice("intake_data.".length)] ?? null;
    }
  }

  // A corrected old_value can now equal what we wrote -- the value we proposed had already
  // been set by someone else while this request was in flight. The merge was a no-op, so
  // recording "X -> X" would assert a change that did not occur. Reported as unchanged
  // instead, which is what actually happened, and the same rule valuesEqual already applies
  // before the write.
  //
  // WHAT 0079 DOES NOT MAKE SERIALIZABLE, stated so it is not mistaken for closed: the
  // DECISION to write is still made against the snapshot read at the top of this request. A
  // field the snapshot showed as already equal is skipped above without ever taking the lock,
  // so a concurrent writer can still cause this commit to skip a field it would otherwise
  // have written. That loses a PROPOSAL, not stored data, and writes no audit row -- the
  // reviewer can re-extract and commit again. Strictly smaller than the lost key and the false
  // row this brick removed, and closing it would need the whole read-decide-write cycle inside
  // one transaction, which PostgREST cannot span.
  const recorded = changed.filter((c) => {
    if (!valuesEqual(c.oldValue, c.newValue)) return true;
    unchanged.push(c.field);
    return false;
  });
  if (recorded.length === 0) {
    return { ok: true, commitId: undefined, changed: [], unchanged, rejected };
  }

  // THE LOG IS WRITTEN AFTER THE PROFILE, and a failure here is reported rather than
  // swallowed. The alternative orderings are both worse: logging first would record changes
  // that might not land, and treating a failed log as success would leave an unattributable
  // profile change -- which is the one thing this table exists to prevent. The profile write
  // has already happened, so the caller is told the change saved but the record did not.
  const commitId = randomUUID();
  const { error: logErr } = await admin.from("client_profile_changes").insert(
    recorded.map((c) => ({
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
      changed: recorded.map((c) => c.field),
    };
  }

  return { ok: true, commitId, changed: recorded.map((c) => c.field), unchanged, rejected };
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
