import { describe, it, expect } from "vitest";
import { classifyText, docLinksFromHtml } from "./nofo";

// Behaviour lock for the NOFO validator (classifyText) and the agency-page link
// extractor (docLinksFromHtml). These are the two levers that decide whether a real
// program NOFO is accepted (→ full shred → ideal-applicant profile → a fit score that
// can exceed 2) or rejected (→ summary depth → capped at 2). The recall widening here
// must NOT cost precision: a real solicitation's review section is now recognised in
// more of its standard federal phrasings, but application guides / boilerplate / stubs
// still get rejected by the guards that run first.

// ~5 KB of program prose that contains "eligible" (satisfies the eligibility gate) but
// no review-criteria term and no POSITIVE announcement token on its own.
const FILLER =
  "The program provides support to eligible organizations for activities described in this document. ".repeat(
    55,
  );
const body = (...phrases: string[]) => `${FILLER} ${phrases.join(" ")}`;

describe("classifyText — recall (real NOFO review-section phrasings)", () => {
  it("accepts the original vocabulary (behaviour lock)", () => {
    expect(classifyText(body("Review criteria and selection criteria are listed below."))).toBe("nofo");
    expect(classifyText(body("Applications are scored; 100 points total."))).toBe("nofo");
  });

  it('accepts "Evaluation Factors for Award"', () => {
    expect(classifyText(body("E. Application Review Information. Evaluation Factors for Award."))).toBe("nofo");
  });

  it('accepts "Application Review Information" (the 2 CFR / Grants.gov section-E heading)', () => {
    expect(classifyText(body("Section E: Application Review Information describes the process."))).toBe("nofo");
  });

  it('accepts "peer review" / "merit review" (NSF/NIH)', () => {
    expect(classifyText(body("Proposals undergo external peer review by a panel of experts."))).toBe("nofo");
    expect(classifyText(body("Merit review of each application follows agency policy."))).toBe("nofo");
  });

  it('accepts "rating factors" and "award criteria"', () => {
    expect(classifyText(body("The rating factors and award criteria are weighted equally."))).toBe("nofo");
  });
});

describe("classifyText — precision (guards still reject non-NOFOs)", () => {
  it("rejects an application guide by its head, even with a real review section in the body", () => {
    // Head-check fires before the criteria gate: an "Applicant Guide" is never the NOFO.
    const guide = `Applicant Guide for Submitting Proposals\n${body("Evaluation Factors for Award are described.")}`;
    expect(classifyText(guide)).toBe("reject");
  });

  it("rejects a NEGATIVE doc (checklist/worksheet/PAPPG) that carries no POSITIVE token", () => {
    const checklist = body("This checklist and worksheet cover evaluation factors for eligible applicants.");
    // Contains a criteria term + "eligible" but is boilerplate with no announcement token.
    expect(classifyText(checklist)).toBe("reject");
  });

  it("rejects a doc with eligibility but no review/criteria section", () => {
    expect(classifyText(body("Contact the program officer with questions."))).toBe("reject");
  });

  it("rejects a short doc even when it names a criteria section (length gate)", () => {
    expect(classifyText("Evaluation Factors for Award. Eligible applicants only.")).toBe("reject");
  });

  it('treats a short "see the full announcement at …" pointer as a stub to follow', () => {
    expect(classifyText("Please refer to the full announcement available online at https://agency.gov/nofo.")).toBe(
      "stub",
    );
  });
});

describe("docLinksFromHtml", () => {
  const base = "https://agency.gov/funding/program/";

  it("extracts and absolutises .pdf/.docx links and dedups", () => {
    const html =
      '<a href="/files/nofo.pdf">NOFO</a> <a href="rfa.docx">RFA</a> <a href="/files/nofo.pdf">dup</a>';
    expect(docLinksFromHtml(html, base)).toEqual([
      "https://agency.gov/files/nofo.pdf",
      "https://agency.gov/funding/program/rfa.docx",
    ]);
  });

  it("keeps a query string intact (signed/parametrised download links)", () => {
    const html = '<a href="/dl/nofo.pdf?token=abc123">Download</a>';
    expect(docLinksFromHtml(html, base)).toEqual(["https://agency.gov/dl/nofo.pdf?token=abc123"]);
  });

  it("recognises a link with a fragment", () => {
    expect(docLinksFromHtml('<a href="solicitation.pdf#page=3">x</a>', base)).toEqual([
      "https://agency.gov/funding/program/solicitation.pdf#page=3",
    ]);
  });

  it("does not match a non-pdf/docx extension (.pdfx)", () => {
    expect(docLinksFromHtml('<a href="/foo.pdfx">x</a> <a href="/bar.zip">y</a>', base)).toEqual([]);
  });
});
