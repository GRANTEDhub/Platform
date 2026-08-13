// Test stub: the `server-only` package throws when imported outside an RSC context, which blocks
// unit-testing modules that (correctly) mark themselves server-only. Vitest aliases the package to
// this no-op so those modules load under node; the real guard still applies in the app build.
export {};
