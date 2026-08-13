"use client";

import { useCallback, useEffect, useState } from "react";
import { ARTIFACT_DOCUMENT_CSS } from "@/lib/grantbot/artifact-html";

// The in-panel document preview (Brick 1a): lists a client's GrantBot artifacts, renders the selected
// one's current HTML "like a Claude artifact", and offers version history + an HTML download.
//
// Refetch-from-read-route, never router.refresh() (the locked GrantBot rule): the parent bumps
// `reloadKey` after a turn completes, which re-pulls the list; selecting an artifact pulls its detail.
// The rendered HTML is DOCUMENT-sanitised on write AND on read (the route), so dangerouslySetInnerHTML
// here only ever receives whitelisted structural markup -- no style/script/img.

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

  // Pull the list on mount and whenever the parent signals a turn completed.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/grantbot/artifacts?clientId=${encodeURIComponent(clientId)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
        const data = (await res.json()) as { artifacts: ArtifactSummary[] };
        if (!live) return;
        setList(data.artifacts);
        // Auto-select the most recently updated when nothing is selected, so a freshly-drafted
        // document shows immediately after the turn that made it.
        setSelectedId((cur) => cur ?? (data.artifacts[0]?.id ?? null));
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
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/grantbot/artifacts?clientId=${encodeURIComponent(clientId)}&artifactId=${encodeURIComponent(artifactId)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
        const data = (await res.json()) as { artifact: ArtifactDetail };
        setDetail(data.artifact);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the document.");
      } finally {
        setLoading(false);
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
      <div style={{ padding: 16, color: "#6E7683", fontSize: 13 }}>
        {error ? `Documents: ${error}` : "No documents yet. Ask GrantBot to draft one (e.g. “draft a concept proposal for this pursuit”)."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* The shared document stylesheet, scoped to .gb-doc so it cannot leak into the app chrome. */}
      <style dangerouslySetInnerHTML={{ __html: ARTIFACT_DOCUMENT_CSS }} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #e6e2da", flexWrap: "wrap" }}>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value || null)}
          style={{ fontSize: 13, padding: "4px 6px", maxWidth: 260 }}
          aria-label="Select document"
        >
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} — v{a.currentVersion}
            </option>
          ))}
        </select>
        {detail && detail.currentVersion > 0 && (
          <a
            href={`/api/grantbot/artifacts/${detail.id}/html?clientId=${encodeURIComponent(clientId)}`}
            style={{ fontSize: 12, color: "#0b57d0", textDecoration: "none" }}
          >
            Download HTML
          </a>
        )}
        {detail && detail.versions.length > 1 && (
          <span style={{ fontSize: 12, color: "#6E7683" }}>{detail.versions.length} versions</span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", background: "#fff" }}>
        {loading && !detail ? (
          <div style={{ color: "#6E7683", fontSize: 13 }}>Loading…</div>
        ) : detail && detail.html ? (
          <div className="gb-doc" style={{ maxWidth: 760 }} dangerouslySetInnerHTML={{ __html: detail.html }} />
        ) : (
          <div style={{ color: "#6E7683", fontSize: 13 }}>This document has no content yet.</div>
        )}
      </div>
    </div>
  );
}
