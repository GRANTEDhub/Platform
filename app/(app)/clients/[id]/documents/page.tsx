import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { buildProposals } from "@/lib/documents/proposal";
import AssimilationReview from "./review-client";
import type { Client, ClientDocument, ClientProfileChange } from "@/types/database";

export const dynamic = "force-dynamic";

// The staff review surface for document assimilation (step (iii)).
//
// STAFF FIRST, by decision: whoever is testing extraction quality against real documents
// needs this before clients do, and the client-facing surface follows once the shredder is
// trusted. Both can already COMMIT -- canAssimilateFor allows a client member -- so this is
// the first of two front-ends onto the same routes, not a staff-only capability.
//
// requireUser, not requireAdmin: 0077 settled that is_admin() guards money and nothing else,
// and `clients_update` has been is_staff() since 0066, so any staffer who can already edit a
// client profile by typing can review a document that proposes the same edits. Nothing
// reachable here is financial -- PROPOSABLE_FIELDS excludes ein and annual_budget.
export default async function ClientDocumentsPage({ params }: { params: { id: string } }) {
  await requireUser();

  // The documents themselves come from the CALLER's RLS, so what a staffer sees here is what
  // the policies allow: an admin sees the client's rows under 0030, and a contractor sees
  // only draft-level ones under 0077's pursuit policy. Deliberately not service-role -- the
  // page should not be able to show more than the database would.
  const rls = createClient();
  // The client row is read service-role because computing "current vs proposed" needs the
  // profile columns, and this page has already established the caller is staff. Only the
  // proposable fields are handed to the browser -- see below.
  const svc = createServiceClient();

  // CONCURRENT, because none of the three depends on another's result -- all key only off
  // params.id. Sequential awaits made the page cost the SUM of three Supabase round trips
  // instead of the slowest one, on every navigation (force-dynamic). Review finding on #340.
  //
  // The notFound() check moves below as a consequence: a request for a nonexistent client now
  // runs the history query too. One wasted query on an error path, in exchange for a third of
  // the latency on every real load.
  const [{ data: docRows }, { data: client }, { data: history }] = await Promise.all([
    rls
      .from("client_documents")
      .select("id, kind, title, content_type, created_at, intellengine_draft_id, extraction_status, extracted, extracted_at, extraction_error, review_note")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false }),
    svc.from("clients").select("*").eq("id", params.id).maybeSingle<Client>(),
    rls
      .from("client_profile_changes")
      .select("*")
      .eq("client_id", params.id)
      .order("committed_at", { ascending: false })
      .limit(50),
  ]);
  if (!client) notFound();

  type DocRow = Pick<
    ClientDocument,
    | "id" | "kind" | "title" | "content_type" | "created_at" | "intellengine_draft_id"
    | "extraction_status" | "extracted" | "extracted_at" | "extraction_error" | "review_note"
  >;
  const docs = (docRows ?? []) as DocRow[];

  // PROPOSALS ARE COMPUTED SERVER-SIDE, from the same pure function the commit route
  // validates against. That keeps the screen and the write in agreement by construction --
  // and it means the browser is handed only the fields actually being proposed plus their
  // current values, never the whole client row.
  const reviews = docs.map((d) => ({
    doc: {
      id: d.id,
      title: d.title,
      kind: d.kind,
      createdAt: d.created_at,
      isOrgLevel: d.intellengine_draft_id === null,
      status: d.extraction_status,
      extractedAt: d.extracted_at,
      error: d.extraction_error,
      reviewNote: d.review_note,
      // Display-only extras from the extraction. The DOCUMENT DATE is shown as a claim, never
      // written anywhere by this page.
      docType: typeof d.extracted?.docType === "string" ? d.extracted.docType : null,
      docDate: typeof d.extracted?.docDate === "string" ? d.extracted.docDate : null,
      synopsis: typeof d.extracted?.synopsis === "string" ? d.extracted.synopsis : null,
    },
    proposals: buildProposals(
      (d.extracted?.fields ?? null) as Record<string, unknown> | null,
      client as unknown as Record<string, unknown>,
    ),
  }));

  return (
    <div>
      <PageHeader
        title="Documents"
        description={`Assimilation review for ${client.name}. Extract, review what it proposes, commit what's right.`}
      />
      <div className="p-8">
        <AssimilationReview
          reviews={reviews}
          history={(history ?? []) as ClientProfileChange[]}
        />
      </div>
    </div>
  );
}
