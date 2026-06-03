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
      "src/browser/cdp.test.ts",
      "src/browser/server-context*.test.ts",
      "src/browser/server-lifecycle.test.ts",
      "src/browser/server.agent-contract*.test.ts",
      "src/browser/server.evaluate-disabled-does-not-block-storage.test.ts",
    ],
    exclude: exclude.filter((pattern) => pattern !== "ui/**"),
    pool: "forks",
    maxWorkers: 1,
  },
});
