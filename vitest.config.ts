import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Minimal Vitest config: just the `@/` path alias so unit tests resolve the same import specifiers
// the app and tsconfig use. No test framework globals, no environment override (node is the
// default) -- the tests import what they exercise explicitly.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
