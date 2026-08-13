"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ARTIFACT_DOCUMENT_CSS } from "@/lib/grantbot/artifact-html";

// The in-panel document preview (Brick 1a): lists a client's GrantBot artifacts, renders the selected
// one's current HTML "like a Claude artifact", and offers version history + an HTML download.
//
// Refetch-from-read-route, never router.refresh() (the locked GrantBot rule): the parent bumps
// `reloadKey` after a turn completes, which re-pulls the list; selecting an artifact pulls its detail.
// The rendered HTML is DOCUMENT-sanitised on write AND on read (the route), so dangerouslySetInnerHTML
// here only ever receives whitelisted structural markup -- no style/script/img.
//
// Colours come from the brand Tailwind tokens (text-ink-subtle, border-hairline-strong, ...), never
// inline hex -- the single-source-lib/brand.ts rule; a raw #6E7683/#e6e2da here would drift the moment
// a token moved.

interface ArtifactSummary {
  id: string;
  kind: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}
interface ArtifactVersionMeta {
  version: number;
  summary: string | null;
  createdAt: string;
}
interface ArtifactDetail extends ArtifactSummary {
  html: string;
  versions: ArtifactVersionMeta[];
}

export function ArtifactPanel({ clientId, reloadKey = 0 }: { clientId: string; reloadKey?: number }) {
  const [list, setList] = useState<ArtifactSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The ids we have already seen. On a refetch, an id NOT in here is a document the running turn just
  // created -- select it so a freshly-drafted doc shows immediately, even when another doc is already
  // open. Empty on the very first load (everything is "new" then), so first load just default-selects
  // the top instead of hijacking to a fake "new" id.
  const knownIdsRef = useRef<Set<string>>(new Set());
  // Monotonic request token for detail loads: a fast A->B switch would otherwise let A's slower
  // response overwrite B's. Only the latest request is allowed to write state.
  const detailReqRef = useRef(0);

  // Pull the list on mount and whenever the parent signals a turn completed.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/grantbot/artifacts?clientId=${encodeURIComponent(clientId)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
        const data = (await res.json()) as { artifacts: ArtifactSummary[] };
        if (!live) return;
        const known = knownIdsRef.current;
        const firstLoad = known.size === 0;
        // Ordered updated_at desc by the route, so the first id we have not seen is the newest one.
        const freshId = data.artifacts.find((a) => !known.has(a.id))?.id ?? null;
        knownIdsRef.current = new Set(data.artifacts.map((a) => a.id));
        setList(data.artifacts);
        setError(null);
        if (freshId && !firstLoad) {
          setSelectedId(freshId);
        } else {
          setSelectedId((cur) => cur ?? (data.artifacts[0]?.id ?? null));
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Could not load documents.");
      }
    })();
    return () => {
      live = false;
    };
  }, [clientId, reloadKey]);

  const loadDetail = useCallback(
    async (artifactId: string) => {
      const req = ++detailReqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/grantbot/artifacts?clientId=${encodeURIComponent(clientId)}&artifactId=${encodeURIComponent(artifactId)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
        const data = (await res.json()) as { artifact: ArtifactDetail };
        if (detailReqRef.current !== req) return; // superseded by a newer selection
        setDetail(data.artifact);
      } catch (e) {
        if (detailReqRef.current !== req) return;
        setError(e instanceof Error ? e.message : "Could not load the document.");
      } finally {
        if (detailReqRef.current === req) setLoading(false);
      }
    },
    [clientId],
  );

  // Load the selected artifact's detail; re-run on reloadKey so an edit to the OPEN document refreshes.
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail, reloadKey]);

  if (list.length === 0) {
    return (
      <div className="p-4 text-[13px] text-ink-subtle">
        {error ? `Documents: ${error}` : "No documents yet. Ask GrantBot to draft one (e.g. “draft a concept proposal for this pursuit”)."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* The shared document stylesheet, scoped to .gb-doc so it cannot leak into the app chrome. */}
      <style dangerouslySetInnerHTML={{ __html: ARTIFACT_DOCUMENT_CSS }} />

      <div className="flex flex-wrap items-center gap-2 border-b border-hairline-strong px-3 py-2">
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value || null)}
          className="max-w-[260px] px-1.5 py-1 text-[13px]"
          aria-label="Select document"
        >
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} — v{a.currentVersion}
            </option>
          ))}
        </select>
        {detail && detail.currentVersion > 0 && (
          <span className="flex items-center gap-2 text-[12px]">
            <span className="text-ink-subtle">Download</span>
            {/* HTML from the 1a inline route; PDF/.docx from the 1b rendered-export route. Plain
                links, same one-click UX -- the export route 302s to a short-lived signed URL. */}
            <a
              href={`/api/grantbot/artifacts/${detail.id}/html?clientId=${encodeURIComponent(clientId)}`}
              className="font-semibold text-brand-navy underline-offset-2 hover:underline"
            >
              HTML
            </a>
            <a
              href={`/api/grantbot/artifacts/${detail.id}/export?clientId=${encodeURIComponent(clientId)}&format=pdf`}
              className="font-semibold text-brand-navy underline-offset-2 hover:underline"
            >
              PDF
            </a>
            <a
              href={`/api/grantbot/artifacts/${detail.id}/export?clientId=${encodeURIComponent(clientId)}&format=docx`}
              className="font-semibold text-brand-navy underline-offset-2 hover:underline"
            >
              Word
            </a>
          </span>
        )}
        {detail && detail.versions.length > 1 && (
          <span className="text-[12px] text-ink-subtle">{detail.versions.length} versions</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-5 py-4">
        {loading && !detail ? (
          <div className="text-[13px] text-ink-subtle">Loading…</div>
        ) : error && !detail ? (
          <div className="text-[13px] text-brand-orangeDeep">{error}</div>
        ) : detail && detail.html ? (
          <div className="gb-doc" style={{ maxWidth: 760 }} dangerouslySetInnerHTML={{ __html: detail.html }} />
        ) : (
          <div className="text-[13px] text-ink-subtle">This document has no content yet.</div>
        )}
      </div>
    </div>
  );
}
