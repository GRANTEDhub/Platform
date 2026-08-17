import { describe, it, expect } from "vitest";
import { buildAlertEmailBody } from "./data";
import { normalizeDecisionBlock, bodyCarriesDecisionUrls } from "./decide-links";
import { plainTextToHtml, type DecisionBox } from "@/lib/email/html";
import type { Grant, ReviewCard } from "@/types/database";

// Regression lock for the "raw portal URL instead of the decision box" incident: the alert
// shipped text-only (a bare portal URL) because the previewed body did not carry the
// Interested / Not-for-us lines, so bodyCarriesDecisionUrls was false, so the send route
// passed no box, so sendGrantAlertEmail generated no HTML part at all. These are the pure
// functions that decide whether the box renders; the fix that made the PREVIEW wire the
// block (draft route -> withDecisionLinks) is what puts a body of this shape on the wire.

const grant = { title: "Rural Broadband Expansion", submission_deadline: "2026-09-30" } as unknown as Grant;
const card = { id: "card-123" } as unknown as ReviewCard;
const urls = {
  interested: "https://app.grantedco.com/decide/tok_abc/interested",
  pass: "https://app.grantedco.com/decide/tok_abc/pass",
};
const portalUrl = "https://app.grantedco.com/portal/triage?card=card-123";

function boxFor(): DecisionBox {
  return {
    grantTitle: grant.title!,
    deadline: "September 30, 2026",
    interestedUrl: urls.interested,
    passUrl: urls.pass,
    portalUrl,
  };
}

describe("grant-alert decision box rendering", () => {
  it("a wired body carries the decision URLs and renders the box (open-portal + interested + pass)", () => {
    const wired = normalizeDecisionBlock(buildAlertEmailBody(grant, card, portalUrl), urls);

    // The gate the send route checks before it attaches a box.
    expect(bodyCarriesDecisionUrls(wired, urls)).toBe(true);

    const html = plainTextToHtml(wired, {
      box: boxFor(),
      links: [{ url: portalUrl, label: "Review Rural Broadband in your portal" }],
    });

    // All three actions the client is offered, plus the box chrome.
    expect(html).toContain("Your decision");
    expect(html).toContain(">Interested<");
    expect(html).toContain(">Not for us<");
    expect(html).toContain("Open it in your portal");
    expect(html).toContain(urls.interested);
    expect(html).toContain(urls.pass);
    // The box REPLACES the raw decision lines in place -- the label text must not survive
    // as bare prose next to the rendered buttons.
    expect(html).not.toContain("Interested — move it into your Grant Report:");
  });

  it("an UNWIRED body (the regression) fails the gate — the box must not be forced on", () => {
    // Exactly what the draft preview posted before the fix: the plain body, no block.
    const unwired = buildAlertEmailBody(grant, card, portalUrl);
    expect(bodyCarriesDecisionUrls(unwired, urls)).toBe(false);
  });

  it("deleting the block from the body removes the buttons (the editable affordance)", () => {
    // A sender who strips the lines in the composer means it: the gate goes false again, so
    // the box is not silently re-added by the renderer.
    const wired = normalizeDecisionBlock(buildAlertEmailBody(grant, card, portalUrl), urls);
    const edited = wired
      .split("\n")
      .filter((l) => !l.includes("/decide/") && l.trim() !== "Not for us:" && !l.startsWith("Interested — move"))
      .join("\n");
    expect(bodyCarriesDecisionUrls(edited, urls)).toBe(false);
  });
});
