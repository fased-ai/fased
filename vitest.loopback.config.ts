import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: [
      "src/browser/server.auth-token-gates-http.test.ts",
      "src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts",
      "src/canvas-host/server.test.ts",
      "src/infra/ports.test.ts",
      "src/media/server.test.ts",
      "src/wallet/local-socket-signer-broker.test.ts",
    ],
    exclude: exclude.filter((pattern) => pattern !== "ui/**"),
    setupFiles: ["test/setup-loopback.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
});
