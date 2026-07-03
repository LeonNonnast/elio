import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against package *source* (no build needed) via these aliases.
export default defineConfig({
  resolve: {
    alias: {
      "@elio/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@elio/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
      "@elio/migrate": fileURLToPath(new URL("./packages/migrate/src/index.ts", import.meta.url)),
      "@elio/skill-builder": fileURLToPath(
        new URL("./packages/skill-builder/src/index.ts", import.meta.url),
      ),
      "@elio/engine": fileURLToPath(new URL("./packages/engine/src/index.ts", import.meta.url)),
      "@elio/vela-adapter": fileURLToPath(
        new URL("./packages/vela-adapter/src/index.ts", import.meta.url),
      ),
      "@elio/claude-adapter": fileURLToPath(
        new URL("./packages/claude-adapter/src/index.ts", import.meta.url),
      ),
      "@elio/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
      "@elio/studio": fileURLToPath(new URL("./packages/studio/src/index.ts", import.meta.url)),
      elio: fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
    },
  },
  test: {
    passWithNoTests: true,
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
  },
});
