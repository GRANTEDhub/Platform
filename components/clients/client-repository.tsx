import { format, parseISO } from "date-fns";
import { FileText } from "lucide-react";

// Reusable document repository for the internal client dashboard. Renders whatever
// documents are filed against the client (signed contracts today; roadmaps,
// reports, etc. later — driven by the client_documents table's `kind`). Each row
// links to a short-lived signed URL minted server-side; the objects live in a
// private bucket and are never public. Internal-admin only.
export interface RepositoryDoc {
  id: string;
  title: string;
  kind: string;
  createdAt: string;
  url: string | null;
}

const KIND_LABEL: Record<string, string> = {
  signed_contract: "Signed contract",
};

export function ClientRepository({ documents }: { documents: RepositoryDoc[] }) {
  if (documents.length === 0) {
    return <p className="text-sm text-muted-foreground">No documents yet.</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {documents.map((d) => (
        <li key={d.id} className="flex items-start gap-3">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{d.title}</span>
              {d.url ? (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs font-medium text-brand-orange hover:underline"
                >
                  Download ↗
                </a>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">Unavailable</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {KIND_LABEL[d.kind] ?? d.kind.replace(/_/g, " ")} · {format(parseISO(d.createdAt), "MMM d, yyyy")}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
