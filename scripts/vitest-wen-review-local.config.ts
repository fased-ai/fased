import { defineConfig, type UserConfig } from "vitest/config";
import baseConfig from "../vitest.config.ts";
const base = baseConfig as UserConfig;
export default defineConfig({
  ...base,
  optimizeDeps: { noDiscovery: true, include: [] },
  test: {
    ...base.test,
    pool: "forks",
    include: [
      "src/gateway/server.wen-review.e2e.test.ts",
      "src/gateway/server.wen-campaign.e2e.test.ts",
      "src/gateway/server.wen-funded.e2e.test.ts",
    ],
    exclude: [],
    maxWorkers: 1,
    silent: false,
  },
});
