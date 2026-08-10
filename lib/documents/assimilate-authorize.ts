import "server-only";
import type { DocumentActor } from "./authorize";

// May this actor extract from, and commit profile changes for, this organization?
//
// DELIBERATELY NOT the document read/write/delete predicates. Those govern the FILE; this
// governs the ORGANIZATION PROFILE, which is a different asset with an existing owner set:
// `clients_update` has been `is_staff()` since 0066, and confirmClientProfileAction lets a
// client member edit their own org. So the rule here is the union of those two, and adding a
// tighter bar would mean assimilation could not do what the people involved can already do
// by typing.
//
// This is the same discipline as everywhere else in the document layer -- these routes use
// the service role, so this check IS the policy, and it has to match the policy it replaces
// rather than being invented alongside it.
//
// ANY STAFF, including a contractor: profile editing is grant work, and 0077 settled that
// is_admin() guards money and nothing else. Nothing reachable through assimilation is
// financial -- PROPOSABLE_FIELDS deliberately excludes ein and annual_budget.
export function canAssimilateFor(actor: DocumentActor, clientId: string): boolean {
  if (actor.isStaff) return true;
  return actor.clientIds.includes(clientId);
}
