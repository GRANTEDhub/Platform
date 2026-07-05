import type { EffectiveStage } from "@/lib/leads/stage";

// Presentational 4-segment progress bar for the ordered sales pipeline. Completed
// stages filled navy, current stage accented orange, future stages muted. Side
// states (rejected/archived/converted) render a single terminal chip instead.
const ORDER: { key: EffectiveStage; label: string }[] = [
  { key: "discovery_pending", label: "Discovery" },
  { key: "contract_pending", label: "Contract" },
  { key: "contract_signed", label: "Signed" },
  { key: "invoice_paid", label: "Paid" },
];

const RANK: Record<string, number> = {
  discovery_pending: 0,
  contract_pending: 1,
  contract_signed: 2,
  invoice_paid: 3,
};

export function StageProgress({ eff }: { eff: EffectiveStage | null }) {
  if (eff === "converted") {
    return <TerminalChip label="Converted to client" className="bg-emerald-100 text-emerald-800" />;
  }
  if (eff === "rejected") return <TerminalChip label="Rejected" className="bg-red-100 text-red-800" />;
  if (eff === "archived") return <TerminalChip label="Archived" className="bg-neutral-200 text-neutral-700" />;

  const current = eff ? RANK[eff] ?? 0 : 0;
  return (
    <div className="flex items-center gap-2">
      {ORDER.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "future";
        return (
          <div key={s.key} className="flex-1">
            <div
              className={`h-1.5 rounded-full ${
                state === "done" ? "bg-brand-navy" : state === "current" ? "bg-brand-orange" : "bg-brand-navy/10"
              }`}
            />
            <p
              className={`mt-1.5 text-[11px] ${
                state === "current" ? "font-medium text-brand-orange" : state === "done" ? "text-brand-navy" : "text-muted-foreground"
              }`}
            >
              {s.label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function TerminalChip({ label, className }: { label: string; className: string }) {
  return <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${className}`}>{label}</span>;
}
