import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Mock the heavy render deps (Chromium via @/lib/alerts/render, html-to-docx) and storage so the
// scaffold's caching/keying/scoping logic is what's under test -- not the renderers themselves.
const renderPdf = vi.fn(async () => Buffer.from("PDFBYTES"));
const renderDocx = vi.fn(async () => Buffer.from("DOCXBYTES"));
vi.mock("./artifact-render", () => ({
  renderArtifactPdf: (...a: unknown[]) => renderPdf(...(a as [])),
  renderArtifactDocx: (...a: unknown[]) => renderDocx(...(a as [])),
}));

const getObjectInfo = vi.fn();
const uploadObject = vi.fn(async () => undefined);
const signedUrl = vi.fn(async () => "https://signed.example/x");
vi.mock("@/lib/storage", () => ({
  getObjectInfo: (...a: unknown[]) => getObjectInfo(...(a as [])),
  uploadObject: (...a: unknown[]) => uploadObject(...(a as [])),
  signedUrl: (...a: unknown[]) => signedUrl(...(a as [])),
}));

const getArtifactHtmlForClient = vi.fn();
vi.mock("./artifacts-store", () => ({
  getArtifactHtmlForClient: (...a: unknown[]) => getArtifactHtmlForClient(...(a as [])),
}));

import { exportArtifact, isExportFormat, GRANTBOT_ARTIFACTS_BUCKET } from "./artifact-export";

const db = {} as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  signedUrl.mockResolvedValue("https://signed.example/x");
  uploadObject.mockResolvedValue(undefined);
});

describe("isExportFormat", () => {
  it("accepts only pdf/docx", () => {
    expect(isExportFormat("pdf")).toBe(true);
    expect(isExportFormat("docx")).toBe(true);
    expect(isExportFormat("html")).toBe(false);
    expect(isExportFormat("exe")).toBe(false);
  });
});

describe("exportArtifact", () => {
  it("renders on a cache MISS, uploads under a version-keyed path with the right content type", async () => {
    getArtifactHtmlForClient.mockResolvedValue({ title: "Concept Proposal", kind: "html_document", version: 3, html: "<h1>Hi</h1>" });
    getObjectInfo.mockResolvedValue(null); // miss

    const out = await exportArtifact(db, { artifactId: "art_1", clientId: "c1", format: "pdf" });

    expect(renderPdf).toHaveBeenCalledOnce();
    expect(renderDocx).not.toHaveBeenCalled();
    // Version is IN the key -> a new version is a new object (automatic invalidation).
    expect(uploadObject).toHaveBeenCalledWith(
      GRANTBOT_ARTIFACTS_BUCKET,
      "exports/art_1/v3/pdf",
      Buffer.from("PDFBYTES"),
      "application/pdf",
    );
    expect(signedUrl).toHaveBeenCalledWith(GRANTBOT_ARTIFACTS_BUCKET, "exports/art_1/v3/pdf", expect.any(Number), {
      download: "concept-proposal.pdf",
    });
    expect(out).toEqual({ signedUrl: "https://signed.example/x", filename: "concept-proposal.pdf" });
  });

  it("does NOT render on a cache HIT -- just re-signs the existing object", async () => {
    getArtifactHtmlForClient.mockResolvedValue({ title: "Doc", kind: "html_document", version: 2, html: "<p>x</p>" });
    getObjectInfo.mockResolvedValue({ size: 1234, contentType: "application/pdf" }); // hit

    const out = await exportArtifact(db, { artifactId: "art_1", clientId: "c1", format: "pdf" });

    expect(renderPdf).not.toHaveBeenCalled();
    expect(uploadObject).not.toHaveBeenCalled();
    expect(signedUrl).toHaveBeenCalledOnce();
    expect(out?.filename).toBe("doc.pdf");
  });

  it("uses the docx renderer + OOXML content type for format=docx", async () => {
    getArtifactHtmlForClient.mockResolvedValue({ title: "Doc", kind: "html_document", version: 1, html: "<p>x</p>" });
    getObjectInfo.mockResolvedValue(null);

    await exportArtifact(db, { artifactId: "art_1", clientId: "c1", format: "docx" });

    expect(renderDocx).toHaveBeenCalledOnce();
    expect(renderPdf).not.toHaveBeenCalled();
    expect(uploadObject).toHaveBeenCalledWith(
      GRANTBOT_ARTIFACTS_BUCKET,
      "exports/art_1/v1/docx",
      Buffer.from("DOCXBYTES"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("returns null (renders nothing) when the artifact isn't found / isn't this client's", async () => {
    getArtifactHtmlForClient.mockResolvedValue(null); // getArtifactHtmlForClient enforces client scope

    const out = await exportArtifact(db, { artifactId: "art_x", clientId: "c1", format: "pdf" });

    expect(out).toBeNull();
    expect(renderPdf).not.toHaveBeenCalled();
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("passes the requested version through to the store lookup", async () => {
    getArtifactHtmlForClient.mockResolvedValue({ title: "Doc", kind: "html_document", version: 5, html: "<p>x</p>" });
    getObjectInfo.mockResolvedValue(null);

    await exportArtifact(db, { artifactId: "art_1", clientId: "c1", version: 5, format: "pdf" });

    expect(getArtifactHtmlForClient).toHaveBeenCalledWith(db, { artifactId: "art_1", clientId: "c1", version: 5 });
    expect(uploadObject).toHaveBeenCalledWith(GRANTBOT_ARTIFACTS_BUCKET, "exports/art_1/v5/pdf", expect.anything(), "application/pdf");
  });
});
