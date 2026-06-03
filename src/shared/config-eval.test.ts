import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearHasBinaryCache, evaluateRuntimeEligibility, hasBinary } from "./config-eval.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  clearHasBinaryCache();
});

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});

describe("hasBinary", () => {
  it("can refresh cached missing binaries after an installer creates one", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-bin-cache-"));
    const binName = `fased-test-bin-${Date.now()}`;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    clearHasBinaryCache();

    expect(hasBinary(binName)).toBe(false);

    const binPath = path.join(binDir, binName);
    await fs.writeFile(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    clearHasBinaryCache();

    expect(hasBinary(binName)).toBe(true);
    await fs.rm(binDir, { recursive: true, force: true });
  });
});
