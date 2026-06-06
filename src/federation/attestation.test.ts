import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAttestation, FEDERATION_ATTESTATION_SCHEMA_URL } from "./attestation.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildAttestation", () => {
  it("uses the Fased Network attestation schema URL by default", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-attestation-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      const attestation = buildAttestation({
        handle: "@agent@ff1.fased.app",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(attestation.schema).toBe(FEDERATION_ATTESTATION_SCHEMA_URL);
    } finally {
      await fs.rm(stateDir, { force: true, recursive: true });
    }
  });
});
