// Shared outreach copy, in a client-SAFE module (no "server-only", no heavy imports)
// so the single-send cold body (lib/alerts/data.ts) and the batch cold composer
// (lib/alerts/compose-batch.ts) use ONE definition -- the credential block reads
// byte-identically on every cold-outreach surface, no drift across the client/server
// boundary. VERBATIM and identical for every sender; never LLM-generated.
export const PROSPECT_CREDENTIAL =
  "GRANTED is a grant solutions company based in Northwest Arkansas. We work with nonprofit organizations, local governments, and institutions on grant strategy and proposal development.";
