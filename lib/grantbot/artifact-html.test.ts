import { describe, it, expect } from "vitest";
import { artifactExportFilename, artifactFilename, artifactPrintHtml, artifactStandaloneHtml } from "./artifact-html";

describe("artifactExportFilename", () => {
  it("slugifies the title and applies the format extension", () => {
    expect(artifactExportFilename("Concept Proposal: NEA Grant!", "pdf")).toBe("concept-proposal-nea-grant.pdf");
    expect(artifactExportFilename("Concept Proposal: NEA Grant!", "docx")).toBe("concept-proposal-nea-grant.docx");
    expect(artifactExportFilename("Concept Proposal: NEA Grant!", "html")).toBe("concept-proposal-nea-grant.html");
  });
  it("never yields an empty slug", () => {
    expect(artifactExportFilename("   ***   ", "pdf")).toBe("document.pdf");
    expect(artifactExportFilename("", "docx")).toBe("document.docx");
  });
  it("artifactFilename is the .html specialisation", () => {
    expect(artifactFilename("My Doc")).toBe("my-doc.html");
  });
});

describe("artifactPrintHtml", () => {
  it("is a letter-page print document, not the on-screen centred column", () => {
    const out = artifactPrintHtml("Title", "<h1>Hi</h1><p>body</p>");
    expect(out).toContain("@page { size: letter; margin: 0.9in 0.85in; }");
    expect(out).toContain(".gb-doc { max-width: none; margin: 0; }"); // print geometry, no 800px column
    expect(out).toContain("break-inside: avoid"); // tables/blockquotes/pre don't split
    expect(out).toContain('<div class="gb-doc"><h1>Hi</h1><p>body</p></div>');
  });
  it("escapes the title but not the already-sanitised body", () => {
    const out = artifactPrintHtml('A <b> & "Q"', "<p>kept</p>");
    expect(out).toContain("<title>A &lt;b&gt; &amp; &quot;Q&quot;</title>");
    expect(out).toContain("<p>kept</p>");
  });
});

describe("artifactStandaloneHtml (unchanged 1a framing)", () => {
  it("still wraps the body in the centred on-screen column", () => {
    const out = artifactStandaloneHtml("T", "<p>x</p>");
    expect(out).toContain(".gb-doc{max-width:800px;margin:40px auto;padding:0 24px;}");
    expect(out).toContain('<div class="gb-doc"><p>x</p></div>');
  });
});
