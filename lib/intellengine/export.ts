import type { ApplicationRequirements } from "@/lib/grants/requirements";
import { REQUIREMENT_FIELDS, REQUIREMENT_FIELD_LABELS, hasAnyRequirement } from "@/lib/grants/requirements";
import { PROPOSAL_SECTIONS } from "@/lib/intellengine/sections";
import type { DraftContent } from "@/lib/intellengine/content";

// Step 6 (export MVP): assemble a completed pursuit into ONE filable narrative document. Pure and
// I/O-free -- the route resolves the draft/grant/client/attachments and hands them here, so the
// composition (the net-new work) is unit-tested without a DB, a model, or Chromium.
//
// HONESTY: assemble what exists, flag every gap. A human takes this to Grants.gov, so a package that
// looks complete when it is not is the failure mode. Missing sections render as flagged headings
// (never silently dropped), the manifest marks each component present/missing, and requirements that
// were never derived point back to the Compliance step (the same dependency step 5 enforces).
//
// SANITIZE-SAFE BY CONSTRUCTION: only semantic tags the DOCUMENT profile whitelists (h1-h3, p, ul/li,
// table, blockquote, hr, strong/em) -- no class/style/script/img, so sanitizeDocument in the route
// passes it through unchanged and ARTIFACT_DOCUMENT_CSS / html-to-docx style it by tag.

// Attachment metadata for the document listing. The route resolves the signed download URLs
// separately (they belong in the UI panel, not baked into a PDF where they would expire).
export interface ExportAttachment {
  id: string;
  title: string;
  contentType: string | null;
  sizeBytes: number | null;
  // 'draft' = this pursuit's own upload (intellengine_draft_id set); 'org' = a reusable firm record.
  scope: "draft" | "org";
}

export interface AssembleInput {
  clientName: string;
  grantTitle: string | null;
  grantFunder: string | null;
  content: DraftContent;
  requirements: ApplicationRequirements | null;
  attachments: ExportAttachment[];
  // Passed in (not read from the clock here) so the assembly stays pure and testable.
  generatedAt: string;
}

export interface ManifestRow {
  label: string;
  present: boolean;
}

export interface SubmissionManifest {
  rows: ManifestRow[];
  // Human-readable labels of everything not ready, for the "before you file" block and the UI panel.
  missing: string[];
  // The truly-empty case: no scope and not one drafted section. The route refuses this rather than
  // rendering an empty package.
  empty: boolean;
}

function sectionPresent(content: DraftContent, id: string): boolean {
  const s = content.sections.find((x) => x.id === id);
  return !!s && s.draft.trim().length > 0;
}

export function buildManifest(
  content: DraftContent,
  requirements: ApplicationRequirements | null,
  attachments: ExportAttachment[],
): SubmissionManifest {
  const rows: ManifestRow[] = [];
  const missing: string[] = [];

  const scopePresent = content.scope.scope.trim().length > 0;
  rows.push({ label: "Scope of work", present: scopePresent });
  if (!scopePresent) missing.push("Scope of work");

  let anySection = false;
  for (const spec of PROPOSAL_SECTIONS) {
    const present = sectionPresent(content, spec.id);
    if (present) anySection = true;
    rows.push({ label: spec.title, present });
    if (!present) missing.push(spec.title);
  }

  const reqDerived = !!requirements && hasAnyRequirement(requirements);
  rows.push({ label: "Application requirements (from the NOFO)", present: reqDerived });
  if (!reqDerived) missing.push("Application requirements not derived");

  rows.push({ label: `Attachments (${attachments.length})`, present: attachments.length > 0 });

  return { rows, missing, empty: !scopePresent && !anySection };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Split authored text into paragraphs on blank lines, escape, wrap each in <p>. A single run with no
// blank lines is one paragraph. Empty -> a flagged "not yet drafted" line.
function paragraphs(text: string): string {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return "<p><strong>⚠ Not yet drafted.</strong></p>";
  return blocks.map((b) => `<p>${escapeHtml(b).replace(/\n/g, "<br />")}</p>`).join("\n");
}

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Assemble the narrative body HTML (the .gb-doc inner content). Sanitised + rendered by the route.
export function assembleSubmissionHtml(input: AssembleInput): string {
  const { content, requirements, attachments } = input;
  const manifest = buildManifest(content, requirements, attachments);
  const out: string[] = [];

  // ── Cover + completeness manifest ───────────────────────────────────────────────────────────
  out.push(`<h1>Submission package</h1>`);
  const who = [input.grantTitle, input.grantFunder].filter((x): x is string => !!x).map(escapeHtml).join(" — ");
  out.push(`<p>${escapeHtml(input.clientName)}${who ? ` · ${who}` : ""}</p>`);
  out.push(`<p>Prepared ${escapeHtml(input.generatedAt)}</p>`);

  out.push(`<h2>Completeness</h2>`);
  out.push(
    `<table><thead><tr><th>Component</th><th>Status</th></tr></thead><tbody>${manifest.rows
      .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.present ? "Included" : "Missing"}</td></tr>`)
      .join("")}</tbody></table>`,
  );
  if (manifest.missing.length > 0) {
    out.push(
      `<blockquote><strong>⚠ Before you file:</strong> ${manifest.missing.map(escapeHtml).join("; ")}.</blockquote>`,
    );
  }

  // ── Scope of work ───────────────────────────────────────────────────────────────────────────
  out.push(`<hr />`);
  out.push(`<h2>Scope of work</h2>`);
  out.push(content.scope.scope.trim() ? paragraphs(content.scope.scope) : "<p><strong>⚠ Not provided.</strong></p>");
  const scopeMeta: string[] = [`Applicant role: ${escapeHtml(content.scope.role)}`];
  if (content.scope.budget.trim()) scopeMeta.push(`Budget: ${escapeHtml(content.scope.budget.trim())}`);
  out.push(`<p>${scopeMeta.join(" · ")}</p>`);
  if (content.scope.partners.length > 0) {
    out.push(
      `<p><strong>Partners</strong></p><ul>${content.scope.partners
        .map((p) => `<li>${[p.name, p.role, p.description].filter((x) => x && x.trim()).map(escapeHtml).join(" — ")}</li>`)
        .join("")}</ul>`,
    );
  }

  // ── The 9 narrative sections, in PROPOSAL_SECTIONS order ─────────────────────────────────────
  for (const spec of PROPOSAL_SECTIONS) {
    const section = content.sections.find((s) => s.id === spec.id);
    out.push(`<hr />`);
    out.push(`<h2>${escapeHtml(spec.title)}</h2>`);
    out.push(paragraphs((section?.draft ?? "").trim()));
  }

  // ── Application-requirements appendix (the step-4 artifact) ──────────────────────────────────
  out.push(`<hr />`);
  out.push(`<h2>Application requirements (from the NOFO)</h2>`);
  if (requirements && hasAnyRequirement(requirements)) {
    for (const field of REQUIREMENT_FIELDS) {
      const items = requirements[field];
      if (items.length === 0) continue;
      out.push(`<h3>${escapeHtml(REQUIREMENT_FIELD_LABELS[field])}</h3>`);
      out.push(`<ul>${items.map((i) => `<li>${escapeHtml(i.text)}</li>`).join("")}</ul>`);
    }
  } else {
    out.push(
      `<p><strong>⚠ Requirements not derived.</strong> Open the Compliance step to derive them from the NOFO before filing.</p>`,
    );
  }

  // ── Attachments (listed here for reference; downloaded separately from the panel) ────────────
  out.push(`<hr />`);
  out.push(`<h2>Attachments</h2>`);
  if (attachments.length > 0) {
    out.push(
      `<ul>${attachments
        .map((a) => {
          const meta = [a.contentType ?? "", formatBytes(a.sizeBytes)].filter(Boolean).join(", ");
          const tag = a.scope === "org" ? " (firm record)" : "";
          return `<li>${escapeHtml(a.title)}${tag}${meta ? ` — ${escapeHtml(meta)}` : ""}</li>`;
        })
        .join("")}</ul>`,
    );
    out.push(`<p>Each attachment is filed as its own upload — download them from the submission panel.</p>`);
  } else {
    out.push(`<p>No attachments uploaded for this pursuit.</p>`);
  }

  return out.join("\n");
}

// The download filename for the rendered narrative. Slugified from the grant title; falls back to a
// generic name so an untitled draft still exports.
export function submissionFilename(grantTitle: string | null, format: "pdf" | "docx"): string {
  const base = (grantTitle ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "submission"}-package.${format}`;
}
