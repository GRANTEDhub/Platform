import { cn } from "@/lib/utils";
import {
  inviteClientMember,
  removeClientMember,
  setClientSeats,
} from "@/app/(app)/clients/[id]/portal-actions";

export type PortalMember = {
  id: string;
  email: string;
  role: string;
  activated_at: string | null;
};

// Staff control for a client's portal logins: seats used, the member list (with
// remove), and an add-login form. All server-action driven — no client JS. The
// add form provisions the login server-side (open signup is off), so after adding,
// staff just tell the client to sign in at the login page.
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
                </p>
              </div>
              <form action={removeClientMember}>
                <input type="hidden" name="client_id" value={clientId} />
                <input type="hidden" name="member_id" value={m.id} />
                <button
                  type="submit"
                  className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-red-600"
                >
                  Remove
                </button>
              </form>
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
          : "They sign in at the login page with this email — no password needed."}
      </p>
    </div>
  );
}
