// GrantBot's document-artifact tools: create_artifact / edit_artifact, and the flag that gates them.
//
// This is GrantBot's first WRITE capability. Unlike web-fetch (which reaches OUTWARD, hence the SSRF
// guards), these tools write only to our OWN Postgres + private bucket, staff-only, append-only and
// versioned -- so the external reach is nil and the blast radius is a staffer's own client's draft
// deliverable, fully reversible (rollback is a forward write). The invariant discipline is the same
// as web-fetch even though the surface is smaller:
//   1. The tool set is a server-side constant (these exports), never assembled from the request body.
//   2. HTML is sanitised on write (sanitizeDocument, the locked sanitize-html engine) before it ever
//      touches the store, so the stored source -- what the panel renders and the exports consume -- is
//      already safe.
//   3. Behind GRANTBOT_ARTIFACTS_ENABLED, default OFF; "off" is byte-identical to today (no tools
//      attached, no instruction block, toolMode "off" -> no tool keys), same guarantee as web-fetch.
//
// Every outcome is a TYPED result the model relays, never invents: a save that fails comes back as
// "could not save", not a pretend success -- same discipline as web-fetch's "could not retrieve".

import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeDocument } from "@/lib/sanitize/html";
import { createArtifact, editArtifact } from "@/lib/grantbot/artifacts-store";
import type { PromptBlock } from "@/lib/grantbot/prompt";

// Off unless exactly "true". Read SERVER-SIDE, never NEXT_PUBLIC_. Default-off is the instant-revert
// guarantee: off == today. Same shape as grantbotWebFetchEnabled().
export function grantbotArtifactsEnabled(): boolean {
  return process.env.GRANTBOT_ARTIFACTS_ENABLED === "true";
}

export const ARTIFACT_KINDS = ["concept_proposal", "report", "letter", "html_document"] as const;

export const CREATE_ARTIFACT_TOOL = {
  name: "create_artifact",
  description:
    "Create a new HTML document deliverable for THIS client (e.g. a concept proposal, report, or letter), drafted from the conversation. It appears in the panel and can be edited later with edit_artifact. Provide the full document body as clean semantic HTML (headings, paragraphs, lists, tables) -- no <style>, no inline CSS, no scripts; the panel styles it. Returns the artifact id and version.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ARTIFACT_KINDS as unknown as string[], description: "The document type. Defaults to html_document if unsure." },
      title: { type: "string", description: "A short human title for the document." },
      html: { type: "string", description: "The full document as semantic HTML (headings/paragraphs/lists/tables). No <style>/CSS/scripts." },
    },
    required: ["title", "html"],
  },
} as const;

export const EDIT_ARTIFACT_TOOL = {
  name: "edit_artifact",
  description:
    "Replace the contents of an existing artifact with a new full version, on the staffer's instruction. Provide the COMPLETE new HTML document (not a diff); the prior version is retained for rollback. Returns the new version number.",
  input_schema: {
    type: "object" as const,
    properties: {
      artifact_id: { type: "string", description: "The id of the artifact to edit (from a previous create/edit, or shown in the panel)." },
      html: { type: "string", description: "The COMPLETE new document as semantic HTML. No <style>/CSS/scripts." },
      summary: { type: "string", description: "A one-line note of what changed in this edit." },
    },
    required: ["artifact_id", "html"],
  },
} as const;

// Flag-gated instruction block. Appended AFTER the cache breakpoint (cacheable:false) and only when
// enabled -- so it never enters the shared cached prefix and the flag-off system prompt is unchanged,
// exactly like FETCH_INSTRUCTION_BLOCK.
export const ARTIFACT_INSTRUCTION_BLOCK: PromptBlock = {
  kind: "artifacts",
  source: "lib/grantbot/artifacts.ts",
  version: "2026-08-13.1",
  cacheable: false,
  text: [
    "DOCUMENT ARTIFACTS — YOUR WRITE TOOLS",
    "You can produce a document deliverable for this client with create_artifact, and revise it with edit_artifact. These write ONLY to this client's private draft store — staff-only, versioned, never sent anywhere and never shown to the client. Creating or editing an artifact is not sending it; delivery is always a separate human act.",
    "",
    "Draft the document as clean SEMANTIC HTML — headings, paragraphs, lists, tables, blockquotes. Do NOT include <style>, inline CSS, colours, fonts, or <script>: the panel applies a fixed document style, and anything styling-related is stripped on save. Plain, well-structured content is the goal (house-brand styling is a separate future capability).",
    "",
    "Only create or edit an artifact when the staffer asks for a document (\"draft a concept proposal\", \"write this up\", \"turn this into a report\", \"revise the third section\"). For a normal question, just answer — do not create an artifact idly. When editing, send the COMPLETE new document, not a fragment; the old version is kept so a rollback is always possible.",
    "",
    "If a save fails, the tool returns a typed failure — relay it plainly and do not pretend the document was written.",
  ].join("\n"),
};

export interface ArtifactAuditRecord {
  action: "create" | "edit";
  ok: boolean;
  artifactId?: string;
  version?: number;
  title?: string;
  kind?: string;
  reason?: string; // present when !ok
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Execute a create/edit tool_use: validate input, sanitise the HTML, persist a new version, and
// return (a) the tool_result text the model sees and (b) the audit record stored on the assistant
// message. A bad input or a store error is a TYPED failure, never a silent success.
export async function executeArtifactTool(
  toolUse: { name: string; input: unknown },
  ctx: { db: SupabaseClient; clientId: string; originConversationId: string | null; createdBy?: string | null },
): Promise<{ resultText: string; audit: ArtifactAuditRecord }> {
  const input = (toolUse.input ?? {}) as Record<string, unknown>;

  if (toolUse.name === CREATE_ARTIFACT_TOOL.name) {
    const title = str(input.title);
    const rawHtml = str(input.html);
    const kindIn = str(input.kind);
    const kind = (ARTIFACT_KINDS as readonly string[]).includes(kindIn) ? kindIn : "html_document";
    if (!title || !rawHtml) {
      return {
        resultText: "Could not create the document: a title and HTML body are both required. Nothing was saved.",
        audit: { action: "create", ok: false, reason: "missing_title_or_html" },
      };
    }
    const html = sanitizeDocument(rawHtml);
    if (!html.trim()) {
      return {
        resultText: "Could not create the document: after removing styling/scripts there was no document content left. Provide semantic HTML (headings, paragraphs, lists). Nothing was saved.",
        audit: { action: "create", ok: false, reason: "empty_after_sanitize" },
      };
    }
    try {
      const { artifactId, version } = await createArtifact(ctx.db, {
        clientId: ctx.clientId,
        originConversationId: ctx.originConversationId,
        kind,
        title,
        html,
        createdBy: ctx.createdBy ?? null,
      });
      return {
        resultText: `Created the document "${title}" (${kind}, version ${version}). It is now shown in the panel and can be revised with edit_artifact using artifact_id ${artifactId}.`,
        audit: { action: "create", ok: true, artifactId, version, title, kind },
      };
    } catch (err) {
      return {
        resultText: `Could not save the document (${err instanceof Error ? err.message : "storage error"}). Nothing was saved; tell the staffer and do not claim it was created.`,
        audit: { action: "create", ok: false, reason: err instanceof Error ? err.message : "store_error" },
      };
    }
  }

  if (toolUse.name === EDIT_ARTIFACT_TOOL.name) {
    const artifactId = str(input.artifact_id);
    const rawHtml = str(input.html);
    const summary = str(input.summary) || null;
    if (!artifactId || !rawHtml) {
      return {
        resultText: "Could not edit the document: an artifact_id and the complete new HTML are both required. Nothing was saved.",
        audit: { action: "edit", ok: false, reason: "missing_id_or_html" },
      };
    }
    const html = sanitizeDocument(rawHtml);
    if (!html.trim()) {
      return {
        resultText: "Could not edit the document: after removing styling/scripts there was no content left. Provide semantic HTML. Nothing was saved.",
        audit: { action: "edit", ok: false, reason: "empty_after_sanitize" },
      };
    }
    try {
      const { version } = await editArtifact(ctx.db, {
        artifactId,
        clientId: ctx.clientId,
        html,
        summary,
        createdBy: ctx.createdBy ?? null,
      });
      return {
        resultText: `Saved a new version (version ${version}) of the document. The prior version is retained for rollback. The panel now shows the update.`,
        audit: { action: "edit", ok: true, artifactId, version },
      };
    } catch (err) {
      return {
        resultText: `Could not save the edit (${err instanceof Error ? err.message : "storage error"}). Nothing was changed; tell the staffer and do not claim it was saved.`,
        audit: { action: "edit", ok: false, artifactId, reason: err instanceof Error ? err.message : "store_error" },
      };
    }
  }

  return {
    resultText: `Unknown artifact tool "${toolUse.name}". Nothing was done.`,
    audit: { action: "create", ok: false, reason: "unknown_tool" },
  };
}
