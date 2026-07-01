// v1 read-only stub. Two buckets (us / client). The "for us" bucket is seeded
// from the client's existing next_step; the "for client" bucket is a placeholder
// until the pursuit lifecycle (and its own action-items store) ships. Editable,
// two-way action items are a deferred follow-up (they need a new table).
export function ClientActionItems({ forUs }: { forUs: string | null }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-orange">For us</p>
        {forUs ? (
          <p className="mt-1 text-sm">{forUs}</p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">No open action items.</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">From the engagement&apos;s next step.</p>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-orange">For the client</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Tracked once the pursuit lifecycle ships.
        </p>
      </div>
    </div>
  );
}
