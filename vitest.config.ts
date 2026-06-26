import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against package *source* (no build needed) via these aliases.
export default defineConfig({
  resolve: {
    alias: {
      "@elio/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@elio/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    passWithNoTests: true,
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
  },
});
