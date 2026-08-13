import { describe, it, expect, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  grantbotArtifactsEnabled,
  executeArtifactTool,
  ARTIFACT_INSTRUCTION_BLOCK,
  CREATE_ARTIFACT_TOOL,
  EDIT_ARTIFACT_TOOL,
} from "./artifacts";

// A minimal fake of the supabase client for the create/edit chains the store uses. Captures the rows
// written so a test can assert the html was sanitised before it reached storage.
function fakeDb(capture: { rows: Record<string, unknown>[]; updates: Record<string, unknown>[]; current?: number }): SupabaseClient {
  const ok = { error: null };
  const from = () => ({
    insert: (row: Record<string, unknown>) => {
      capture.rows.push(row);
      return {
        select: () => ({ single: async () => ({ data: { id: "art_1" }, error: null }) }),
        then: (resolve: (v: typeof ok) => void) => resolve(ok), // awaitable -> {error:null}
      };
    },
    update: (row: Record<string, unknown>) => {
      capture.updates.push(row);
      return { eq: async () => ok };
    },
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { id: "art_1", client_id: "c1", current_version: capture.current ?? 1 }, error: null }),
      }),
    }),
  });
  return { from } as unknown as SupabaseClient;
}

const CTX = { clientId: "c1", originConversationId: "conv1", createdBy: null };

describe("grantbotArtifactsEnabled", () => {
  const prev = process.env.GRANTBOT_ARTIFACTS_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_ARTIFACTS_ENABLED;
    else process.env.GRANTBOT_ARTIFACTS_ENABLED = prev;
  });
  it("is off by default and off for anything but the literal 'true'", () => {
    delete process.env.GRANTBOT_ARTIFACTS_ENABLED;
    expect(grantbotArtifactsEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_ARTIFACTS_ENABLED = v;
      expect(grantbotArtifactsEnabled()).toBe(false);
    }
    process.env.GRANTBOT_ARTIFACTS_ENABLED = "true";
    expect(grantbotArtifactsEnabled()).toBe(true);
  });
});

describe("ARTIFACT_INSTRUCTION_BLOCK", () => {
  it("is non-cacheable and names the write tools + the not-sending rule", () => {
    expect(ARTIFACT_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(ARTIFACT_INSTRUCTION_BLOCK.kind).toBe("artifacts");
    expect(ARTIFACT_INSTRUCTION_BLOCK.text).toContain(CREATE_ARTIFACT_TOOL.name);
    expect(ARTIFACT_INSTRUCTION_BLOCK.text).toContain(EDIT_ARTIFACT_TOOL.name);
    expect(ARTIFACT_INSTRUCTION_BLOCK.text).toMatch(/not sending|never sent|semantic html/i);
  });
});

describe("executeArtifactTool", () => {
  it("creates an artifact and SANITISES the html before storage", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
    const db = fakeDb(cap);
    const { resultText, audit } = await executeArtifactTool(
      { name: CREATE_ARTIFACT_TOOL.name, input: { title: "Concept", kind: "concept_proposal", html: "<h1>Hi</h1><script>evil()</script><p>body</p>" } },
      { db, ...CTX },
    );
    expect(audit).toMatchObject({ action: "create", ok: true, version: 1, kind: "concept_proposal", title: "Concept" });
    expect(resultText).toContain("Concept");
    // The version row (second insert) holds sanitised html: heading + paragraph kept, script gone.
    const versionRow = cap.rows[1];
    expect(String(versionRow.html)).toContain("<h1>Hi</h1>");
    expect(String(versionRow.html)).toContain("<p>body</p>");
    expect(String(versionRow.html)).not.toMatch(/<script/i);
  });

  it("defaults an unknown kind to html_document", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
    const { audit } = await executeArtifactTool(
      { name: CREATE_ARTIFACT_TOOL.name, input: { title: "T", kind: "made_up", html: "<p>x</p>" } },
      { db: fakeDb(cap), ...CTX },
    );
    expect(audit.kind).toBe("html_document");
  });

  it("returns a typed failure (no write) when title or html is missing", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
    const { audit, resultText } = await executeArtifactTool(
      { name: CREATE_ARTIFACT_TOOL.name, input: { title: "", html: "<p>x</p>" } },
      { db: fakeDb(cap), ...CTX },
    );
    expect(audit).toEqual({ action: "create", ok: false, reason: "missing_title_or_html" });
    expect(resultText).toMatch(/nothing was saved/i);
    expect(cap.rows).toHaveLength(0);
  });

  it("returns a typed failure when the html sanitises to nothing", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
    const { audit } = await executeArtifactTool(
      { name: CREATE_ARTIFACT_TOOL.name, input: { title: "T", html: "<script>only()</script>" } },
      { db: fakeDb(cap), ...CTX },
    );
    expect(audit).toMatchObject({ action: "create", ok: false, reason: "empty_after_sanitize" });
    expect(cap.rows).toHaveLength(0);
  });

  it("edits an existing artifact to a new version", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[], current: 2 };
    const { audit, resultText } = await executeArtifactTool(
      { name: EDIT_ARTIFACT_TOOL.name, input: { artifact_id: "art_1", html: "<p>revised</p>", summary: "tightened" } },
      { db: fakeDb(cap), ...CTX },
    );
    expect(audit).toMatchObject({ action: "edit", ok: true, artifactId: "art_1", version: 3 });
    expect(resultText).toMatch(/version 3/);
  });

  it("rejects an edit missing artifact_id or html", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
    const { audit } = await executeArtifactTool(
      { name: EDIT_ARTIFACT_TOOL.name, input: { html: "<p>x</p>" } },
      { db: fakeDb(cap), ...CTX },
    );
    expect(audit).toMatchObject({ action: "edit", ok: false, reason: "missing_id_or_html" });
  });

  it("reports an unknown tool without doing anything", async () => {
    const cap = { rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
    const { audit } = await executeArtifactTool({ name: "delete_everything", input: {} }, { db: fakeDb(cap), ...CTX });
    expect(audit.ok).toBe(false);
    expect(audit.reason).toBe("unknown_tool");
  });
});
