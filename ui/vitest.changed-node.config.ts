import { defineConfig } from "vitest/config";

// CI supplies exact file filters. Keep the include broad enough that ordinary
// UI tests cannot silently disappear merely because they are not in the
// hand-maintained fast-node list used by `test:node`.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.{browser,e2e,live}.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-node.ts"],
  },
});
