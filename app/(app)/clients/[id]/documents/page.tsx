import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { buildProposals } from "@/lib/documents/proposal";
import AssimilationReview from "./review-client";
import UploadPanel from "./upload-panel";
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
  // The profile is kept (it used to be discarded) purely for the upload control's audience:
  // org-level filing stayed admin-only in 0077, so a contractor is shown an explanation
  // instead of a button that would 403 on click.
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";

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
      // Per-field quotes from the extraction, rendered under each proposed value. The point is
      // the wrong-entity failure: a contact block read off a 990's paid-preparer section is a
      // valid name and a valid email belonging to the wrong organization, and the quote is the
      // only thing on this screen that shows it without opening the PDF.
      (d.extracted?.evidence ?? null) as Record<string, unknown> | null,
    ),
  }));

  return (
    <div>
      <PageHeader
        title="Documents"
        description={`Assimilation review for ${client.name}. Extract, review what it proposes, commit what's right.`}
      />
      <div className="space-y-8 p-8">
        {/* ABOVE the list on purpose: the empty state points up at it, and a control that only
            appears once you already have documents is no front door at all. */}
        <UploadPanel clientId={params.id} isAdmin={isAdmin} />
        <AssimilationReview
          reviews={reviews}
          history={(history ?? []) as ClientProfileChange[]}
          canUpload={isAdmin}
        />
      </div>
    </div>
  );
}
