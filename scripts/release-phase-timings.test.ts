import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finishReleasePhase, startReleasePhase } from "./release-phase-timings.mjs";

describe("release phase timings", () => {
  it("records exact bounded phase durations in one receipt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-release-timings-"));
    const file = path.join(root, "timings.json");
    try {
      await startReleasePhase(file, "nodeBuild", 1_000);
      await finishReleasePhase(file, "nodeBuild", 4_250);
      const receipt = JSON.parse(await fs.readFile(file, "utf8"));
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        phases: { nodeBuild: { durationMillis: 3_250 } },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown or unfinished phases", async () => {
    const file = path.join(os.tmpdir(), `fased-release-timings-${process.pid}.json`);
    await expect(startReleasePhase(file, "unknown", 1)).rejects.toThrow("unknown release phase");
    await expect(finishReleasePhase(file, "goBuild", 2)).rejects.toThrow("was not started");
  });
});
