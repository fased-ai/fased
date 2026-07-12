import { defineConfig } from "vitest/config";

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    include: [
      "src/**/*.node.test.ts",
      "src/ui/app-settings.test.ts",
      "src/ui/controllers/wallet.test.ts",
      "src/ui/controllers/mining.test.ts",
      "src/ui/controllers/skills.test.ts",
      "src/ui/controllers/config-auth-action.test.ts",
      "src/ui/controllers/plugins-marketplace.test.ts",
      "src/ui/views/providers.test.ts",
      "src/ui/views/memory.test.ts",
    ],
    environment: "node",
    setupFiles: ["test/setup-node.ts"],
  },
});
