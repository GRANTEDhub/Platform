import { cn } from "@/lib/utils";
import {
  inviteClientMember,
  removeClientMember,
  sendClientSetupLink,
  setClientSeats,
} from "@/app/(app)/clients/[id]/portal-actions";

export type PortalMember = {
  id: string;
  email: string;
  role: string;
  activated_at: string | null;
  setup_link_sent_at: string | null;
};

function sentOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Staff control for a client's portal logins: seats used, the member list (with
// per-member "Send setup link" + remove), and an add-login form. All server-action
// driven — no client JS.
//
// Adding provisions the login server-side (open signup is off) but sends NOTHING, so
// each row carries its own send button: that's how an existing client gets a working
// way in without staff hand-writing them the URL. Two independent row states answer
// two different questions —
//   pending                : has the client ever logged in? (activated_at)
//   setup link sent <date> : have we ever told them how? (setup_link_sent_at)
// A row can be provisioned-but-never-emailed indefinitely, which is exactly the
// invisible state this panel used to leave staff guessing about.
export function PortalAccess({
  clientId,
  seatLimit,
  members,
}: {
  clientId: string;
  seatLimit: number;
  members: PortalMember[];
}) {
  const used = members.length;
  const full = used >= seatLimit;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">
          <span className="font-semibold text-brand-navy">{used}</span> of{" "}
          <span className="font-semibold text-brand-navy">{seatLimit}</span> seats used
        </span>
        <form action={setClientSeats} className="flex items-center gap-1.5">
          <input type="hidden" name="client_id" value={clientId} />
          <input
            name="seat_limit"
            type="number"
            min={1}
            max={50}
            defaultValue={seatLimit}
            aria-label="Seat limit"
            className="w-14 rounded-lg border border-brand-navy/15 bg-white px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-navy/20"
          />
          <button
            type="submit"
            className="rounded-lg border border-brand-navy/15 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-brand-navy/30 hover:text-brand-navy"
          >
            Set
          </button>
        </form>
      </div>

      {members.length === 0 ? (
        <p className="text-muted-foreground">No portal logins yet.</p>
      ) : (
        <ul className="divide-y divide-brand-navy/[0.06]">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-brand-navy">{m.email}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  {m.role}
                  {m.activated_at ? "" : " · pending"}
                  {m.setup_link_sent_at && (
                    <span className="normal-case"> · setup link sent {sentOn(m.setup_link_sent_at)}</span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* Resend is always available: these links are one-time and expire, so a
                    client who sat on theirs needs a fresh one, not a support thread. */}
                <form action={sendClientSetupLink}>
                  <input type="hidden" name="client_id" value={clientId} />
                  <input type="hidden" name="member_id" value={m.id} />
                  <button
                    type="submit"
                    className="text-xs font-semibold text-brand-orange transition-colors hover:text-brand-navy"
                  >
                    {m.setup_link_sent_at ? "Resend setup link" : "Send setup link"}
                  </button>
                </form>
                <form action={removeClientMember}>
                  <input type="hidden" name="client_id" value={clientId} />
                  <input type="hidden" name="member_id" value={m.id} />
                  <button
                    type="submit"
                    className="text-xs text-muted-foreground transition-colors hover:text-red-600"
                  >
                    Remove
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form action={inviteClientMember} className="flex gap-2">
        <input type="hidden" name="client_id" value={clientId} />
        <input
          name="email"
          type="email"
          required
          disabled={full}
          placeholder="name@organization.org"
          className={cn(
            "flex-1 rounded-lg border border-brand-navy/15 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-navy/20",
            full && "cursor-not-allowed opacity-50",
          )}
        />
        <button
          type="submit"
          disabled={full}
          className={cn(
            "shrink-0 rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-navyDeep",
            full && "cursor-not-allowed opacity-50",
          )}
        >
          Add login
        </button>
      </form>
      <p className="text-xs text-muted-foreground">
        {full
          ? "All seats used — raise the limit above to add more."
          : "Adding a login doesn’t email anyone — use “Send setup link” on the row to let them in."}
      </p>
    </div>
  );
}
