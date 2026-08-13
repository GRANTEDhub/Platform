import { describe, it, expect } from "vitest";
import { sanitizeDocument, sanitizeRichText } from "./html";

describe("sanitizeDocument (GrantBot artifacts profile)", () => {
  it("keeps the document structure a proposal needs", () => {
    const html = [
      "<h1>Concept Proposal</h1>",
      "<h2>Budget</h2>",
      "<p>A <strong>bold</strong> and <em>italic</em> line.</p>",
      "<ul><li>one</li><li>two</li></ul>",
      "<blockquote>quoted</blockquote>",
      "<table><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody><tr><td>Staff</td><td>$10</td></tr></tbody></table>",
      '<p><a href="https://grants.gov/x">source</a></p>',
      "<hr>",
    ].join("");
    const out = sanitizeDocument(html);
    for (const frag of ["<h1>", "<h2>", "<strong>", "<em>", "<ul>", "<li>", "<blockquote>", "<table>", "<thead>", "<th>", "<td>", "<hr", 'href="https://grants.gov/x"']) {
      expect(out).toContain(frag);
    }
    expect(out).toContain("Concept Proposal");
    expect(out).toContain("$10");
  });

  it("strips styling and scripting but keeps the text content", () => {
    const html =
      '<style>.x{color:red}</style>' +
      '<p style="color:red" onclick="steal()">hello</p>' +
      '<script>alert(1)</script>' +
      '<img src="x" onerror="steal()">' +
      '<p class="lead">world</p>';
    const out = sanitizeDocument(html);
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/onclick|onerror|style=/i);
    // text content of stripped tags is kept, and `class` is dropped -- the fixed stylesheet targets
    // tags, so a surviving utility class (e.g. `fixed inset-0 z-50`) would only be attack surface
    // once the page's global Tailwind matched it. See the DOCUMENT profile comment.
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toMatch(/class=/i);
  });

  it("drops a javascript: link scheme but keeps http(s)/mailto", () => {
    const out = sanitizeDocument('<a href="javascript:steal()">x</a><a href="mailto:a@b.org">mail</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('href="mailto:a@b.org"');
  });

  it("returns empty for empty input", () => {
    expect(sanitizeDocument("")).toBe("");
    expect(sanitizeDocument(null)).toBe("");
    expect(sanitizeDocument(undefined)).toBe("");
  });

  it("is strictly wider than the inline RICH profile (which drops headings/tables)", () => {
    const html = "<h1>Title</h1><table><tr><td>x</td></tr></table>";
    expect(sanitizeRichText(html)).not.toContain("<h1>"); // RICH strips headings
    expect(sanitizeDocument(html)).toContain("<h1>"); // DOCUMENT keeps them
  });
});
