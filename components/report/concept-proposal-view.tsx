import { Tag } from "./primitives";
import type { ConceptProposal, ConceptProposalPartner } from "@/types/database";

// Presentational, read-only rendering of a concept proposal's contents (scope,
// role, amounts, term, partners). Server-compatible (no client hooks) so it
// renders on BOTH the staff panel (a client component) and the client portal
// grant detail (a server component). Actions/states live in the callers.
//
// showSourceTags: the per-partner provenance tags ("From client", "Suggested --
// verify", "Added by you") are for the account manager's review. They're hidden
// on the client-facing view, where the proposal is already the team's finalized
// version and the provenance would just be noise (or, for "Added by you",
// misread -- "you" is the AM, not the client).

const SOURCE_TAG: Record<ConceptProposalPartner["source"], { label: string; suggested: boolean }> = {
  client_cited: { label: "From client", suggested: false },
  prospect: { label: "GRANTED network", suggested: false },
  suggested: { label: "Suggested — verify", suggested: true },
  manual: { label: "Added by you", suggested: false },
};

export function ConceptProposalView({
  proposal,
  showSourceTags = true,
}: {
  proposal: ConceptProposal;
  showSourceTags?: boolean;
}) {
  const roleLabel = proposal.role === "prime" ? "Prime applicant" : "Partner / sub";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag>{roleLabel}</Tag>
      </div>

      {proposal.scope && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Project scope</p>
          <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-foreground">{proposal.scope}</p>
        </div>
      )}

      <div className="grid gap-x-8 gap-y-4 border-t border-brand-navy/[0.06] pt-4 sm:grid-cols-3">
        {proposal.total_project_amount && (
          <Amount label="Total project (est.)" value={proposal.total_project_amount} />
        )}
        <Amount label="Estimated match" value={proposal.estimated_match ?? "None required"} />
        {proposal.project_term && <Amount label="Project term" value={proposal.project_term} />}
      </div>

      {proposal.partners.length > 0 && (
        <div className="border-t border-brand-navy/[0.06] pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Recommended partners
          </p>
          <ul className="mt-3 space-y-3">
            {proposal.partners.map((p, i) => (
              <PartnerRow key={i} partner={p} showSourceTag={showSourceTags} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Amount({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-brand-navy">{value}</p>
    </div>
  );
}

function PartnerRow({ partner, showSourceTag }: { partner: ConceptProposalPartner; showSourceTag: boolean }) {
  const identity = partner.name || partner.org_type_label || "Partner";
  const tag = SOURCE_TAG[partner.source];
  return (
    <li className="rounded-xl border border-brand-navy/[0.06] bg-white p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-brand-navy">{identity}</span>
        {partner.role && <span className="text-[12.5px] text-muted-foreground">&middot; {partner.role}</span>}
        {showSourceTag && (
          <span
            className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              tag.suggested ? "bg-amber-100 text-amber-800" : "bg-brand-navy/[0.06] text-brand-navy"
            }`}
          >
            {tag.label}
          </span>
        )}
      </div>
      {partner.description && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground">{partner.description}</p>
      )}
    </li>
  );
}
