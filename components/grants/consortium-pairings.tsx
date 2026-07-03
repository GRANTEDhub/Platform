import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConsortiumPairing, SeatedClient } from "@/lib/grants/consortium";

// Read-only surfacing of complementary-seat client pairings on a grant (Feature
// A). Advisory: the actual GO/NO decision still happens per-client on the Matches
// card -- this only points out that two roster clients could pursue jointly.
// Renders nothing when there are no pairings.

function names(clients: SeatedClient[]): string {
  return clients.map((c) => c.clientName ?? "Unknown").join(", ") || "—";
}

export function ConsortiumPairings({ pairings }: { pairings: ConsortiumPairing[] }) {
  if (pairings.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Consortium pairings ({pairings.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Roster clients occupying complementary seats on this grant — one could prime while another
          supports. Advisory only; decide each match on its own card in Matches.
        </p>
        {pairings.map((p) => (
          <div key={p.archetypeIndex} className="rounded-lg border border-input p-4">
            {p.archetypeLabel && (
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {p.archetypeLabel}
              </p>
            )}
            <div className="space-y-1">
              <div>
                <span className="font-medium">Prime:</span> {names(p.primes)}
              </div>
              <div>
                <span className="font-medium">Supporting:</span> {names(p.supporting)}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
