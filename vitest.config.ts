import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Minimal Vitest config: just the `@/` path alias so unit tests resolve the same import specifiers
// the app and tsconfig use. No test framework globals, no environment override (node is the
// default) -- the tests import what they exercise explicitly.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` throws when imported outside an RSC context; alias it to a no-op so modules
      // that mark themselves server-only can be unit-tested. The real guard still holds in the build.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
});
