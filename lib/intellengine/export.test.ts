import { describe, it, expect } from "vitest";
import { buildManifest, assembleSubmissionHtml, submissionFilename, type ExportAttachment } from "./export";
import { EMPTY_REQUIREMENTS, type ApplicationRequirements } from "@/lib/grants/requirements";
import { PROPOSAL_SECTIONS } from "@/lib/intellengine/sections";
import { EMPTY_SCOPE, type DraftContent } from "@/lib/intellengine/content";
import { sanitizeDocument } from "@/lib/sanitize/html";

// Step 6 assembly. Pure -- no DB, no Chromium. The composition is the net-new work, so these pin the
// order, the honesty (gaps flagged, never dropped), and that the emitted HTML survives the locked
// DOCUMENT sanitizer unchanged.

function content(partial?: Partial<DraftContent>): DraftContent {
  return { scope: { ...EMPTY_SCOPE }, sections: [], ...partial };
}

function reqWithItems(): ApplicationRequirements {
  return {
    ...EMPTY_REQUIREMENTS,
    required_sections: [{ text: "A project narrative of at most 10 pages", quote: "" }],
  };
}

const NO_ATTACH: ExportAttachment[] = [];

describe("buildManifest", () => {
  it("marks scope, every section, and requirements present/missing", () => {
    const c = content({
      scope: { ...EMPTY_SCOPE, scope: "A mobile clinic" },
      sections: [{ id: "problem", draft: "There is a gap.", source: "ai" }],
    });
    const m = buildManifest(c, reqWithItems(), NO_ATTACH);
    const byLabel = Object.fromEntries(m.rows.map((r) => [r.label, r.present]));
    expect(byLabel["Scope of work"]).toBe(true);
    expect(byLabel["Problem Statement"]).toBe(true);
    expect(byLabel["Target Population"]).toBe(false); // not drafted
    expect(byLabel["Application requirements (from the NOFO)"]).toBe(true);
    expect(m.missing).toContain("Target Population");
    expect(m.missing).not.toContain("Problem Statement");
  });

  it("flags requirements-not-derived and counts attachments", () => {
    const m = buildManifest(content(), null, [
      { id: "a", title: "Budget.xlsx", contentType: null, sizeBytes: 100, scope: "draft" },
    ]);
    expect(m.missing).toContain("Application requirements not derived");
    expect(m.rows.find((r) => r.label === "Attachments (1)")?.present).toBe(true);
  });

  it("is empty only when there is no scope AND not one drafted section", () => {
    expect(buildManifest(content(), null, NO_ATTACH).empty).toBe(true);
    expect(buildManifest(content({ scope: { ...EMPTY_SCOPE, scope: "x" } }), null, NO_ATTACH).empty).toBe(false);
    expect(
      buildManifest(content({ sections: [{ id: "problem", draft: "y", source: "client" }] }), null, NO_ATTACH).empty,
    ).toBe(false);
    // A whitespace-only section does not count as drafted.
    expect(
      buildManifest(content({ sections: [{ id: "problem", draft: "   ", source: "client" }] }), null, NO_ATTACH).empty,
    ).toBe(true);
  });
});

describe("assembleSubmissionHtml", () => {
  const full = content({
    scope: { ...EMPTY_SCOPE, scope: "A mobile dental clinic", role: "prime" },
    sections: [
      { id: "problem", draft: "Rivertown lacks providers.\n\nA second paragraph.", source: "ai" },
      { id: "strategy", draft: "Deploy a mobile unit.", source: "client" },
    ],
  });

  it("renders all 9 sections in PROPOSAL_SECTIONS order, present or flagged", () => {
    const html = assembleSubmissionHtml({
      clientName: "Rivertown Community Health",
      grantTitle: "Rural Health Access Program",
      grantFunder: "HRSA",
      content: full,
      requirements: reqWithItems(),
      attachments: NO_ATTACH,
      generatedAt: "2026-08-13",
    });
    // Order: each section title appears, in the spec order. Titles are HTML-escaped in the doc
    // (e.g. "Goals & Objectives" -> "&amp;"), so search the escaped form.
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const positions = PROPOSAL_SECTIONS.map((s) => html.indexOf(`<h2>${esc(s.title)}</h2>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
    // Drafted content present; a multi-paragraph draft splits into <p> blocks.
    expect(html).toContain("Rivertown lacks providers.");
    expect(html).toContain("A second paragraph.");
    // An un-drafted section is FLAGGED, never silently dropped.
    expect(html).toContain("⚠ Not yet drafted.");
  });

  it("includes the requirements appendix when derived, and points to Compliance when not", () => {
    const withReq = assembleSubmissionHtml({
      clientName: "C",
      grantTitle: null,
      grantFunder: null,
      content: full,
      requirements: reqWithItems(),
      attachments: NO_ATTACH,
      generatedAt: "2026-08-13",
    });
    expect(withReq).toContain("A project narrative of at most 10 pages");

    const noReq = assembleSubmissionHtml({
      clientName: "C",
      grantTitle: null,
      grantFunder: null,
      content: full,
      requirements: null,
      attachments: NO_ATTACH,
      generatedAt: "2026-08-13",
    });
    expect(noReq).toMatch(/Requirements not derived/);
    expect(noReq).toMatch(/Compliance step/);
  });

  it("lists attachments with a firm-record tag for org-level ones", () => {
    const html = assembleSubmissionHtml({
      clientName: "C",
      grantTitle: null,
      grantFunder: null,
      content: full,
      requirements: reqWithItems(),
      attachments: [
        { id: "a", title: "Project budget.xlsx", contentType: "application/vnd.ms-excel", sizeBytes: 2048, scope: "draft" },
        { id: "b", title: "IRS 990.pdf", contentType: "application/pdf", sizeBytes: 1048576, scope: "org" },
      ],
      generatedAt: "2026-08-13",
    });
    expect(html).toContain("Project budget.xlsx");
    expect(html).toContain("IRS 990.pdf");
    expect(html).toContain("firm record");
  });

  it("escapes dynamic text and survives the DOCUMENT sanitizer unchanged in structure", () => {
    const html = assembleSubmissionHtml({
      clientName: "Acme <script>alert(1)</script> Org",
      grantTitle: "Grant & Co",
      grantFunder: null,
      content: content({ scope: { ...EMPTY_SCOPE, scope: "Do <b>things</b> & more" } }),
      requirements: reqWithItems(),
      attachments: NO_ATTACH,
      generatedAt: "2026-08-13",
    });
    // No raw script survives assembly (escaped), and the sanitizer keeps the whitelisted structure.
    expect(html).not.toContain("<script>");
    const clean = sanitizeDocument(html);
    expect(clean).not.toContain("<script>");
    expect(clean).toContain("<h1>");
    expect(clean).toContain("<table>");
  });
});

describe("submissionFilename", () => {
  it("slugifies the grant title and falls back for an untitled draft", () => {
    expect(submissionFilename("Rural Health Access Program!", "pdf")).toBe("rural-health-access-program-package.pdf");
    expect(submissionFilename(null, "docx")).toBe("submission-package.docx");
    expect(submissionFilename("   ", "pdf")).toBe("submission-package.pdf");
  });
});
