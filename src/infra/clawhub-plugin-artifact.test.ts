import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  ClawHubArtifactVerificationError,
  resolveClawHubPluginArtifactToQuarantine,
} from "./clawhub-plugin-artifact.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sri(bytes: Uint8Array, algorithm = "sha256"): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
}

function createClawHubInstallRecord(
  bytes: Uint8Array,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "clawhub",
    clawhubUrl: "https://clawhub.com",
    clawhubArtifactUrl: "https://clawhub.com/artifacts/demo.zip",
    clawhubPackage: "@fased/demo",
    clawhubFamily: "code-plugin",
    clawhubChannel: "official",
    version: "1.0.0",
    integrity: sri(bytes),
    artifactKind: "clawpack",
    artifactFormat: "zip",
    clawpackSha256: sha256Hex(bytes),
    clawpackSpecVersion: 1,
    clawpackManifestSha256: "manifest-sha256",
    clawpackSize: bytes.byteLength,
    ...overrides,
  };
}

function createFetch(bytes: Uint8Array, status = 200) {
  return vi.fn(async () => new Response(Buffer.from(bytes), { status }));
}

describe("resolveClawHubPluginArtifactToQuarantine", () => {
  it("downloads an allowlisted ClawHub artifact into quarantine after verification", async () => {
    const bytes = new TextEncoder().encode("plugin artifact");
    const install = createClawHubInstallRecord(bytes);
    const result = await resolveClawHubPluginArtifactToQuarantine({
      install,
      fetchImpl: createFetch(bytes),
    });

    try {
      expect(result.artifactPath).toContain("clawhub-plugin-quarantine-");
      expect(result.quarantineDir).toContain("clawhub-plugin-quarantine-");
      expect(result.sha256).toBe(sha256Hex(bytes));
      expect(result.integrity).toBe(sri(bytes));
      expect(result.size).toBe(bytes.byteLength);
      await expect(fs.readFile(result.artifactPath)).resolves.toEqual(Buffer.from(bytes));
    } finally {
      await result.cleanup();
    }

    await expect(fs.stat(result.quarantineDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-allowlisted artifact origins before fetching", async () => {
    const bytes = new TextEncoder().encode("plugin artifact");
    const fetchImpl = createFetch(bytes);

    await expect(
      resolveClawHubPluginArtifactToQuarantine({
        install: createClawHubInstallRecord(bytes, {
          clawhubArtifactUrl: "https://example.invalid/artifacts/demo.zip",
        }),
        fetchImpl,
      }),
    ).rejects.toThrow("ClawHub artifact origin is not allowlisted: https://example.invalid");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects artifacts with mismatched hashes", async () => {
    const expectedBytes = new TextEncoder().encode("expected artifact");
    const actualBytes = new TextEncoder().encode("tampered artifact");

    await expect(
      resolveClawHubPluginArtifactToQuarantine({
        install: createClawHubInstallRecord(expectedBytes, {
          integrity: sri(actualBytes),
        }),
        fetchImpl: createFetch(actualBytes),
      }),
    ).rejects.toThrow(ClawHubArtifactVerificationError);
  });

  it("requires exact size metadata when it is present", async () => {
    const bytes = new TextEncoder().encode("plugin artifact");

    await expect(
      resolveClawHubPluginArtifactToQuarantine({
        install: createClawHubInstallRecord(bytes, { clawpackSize: bytes.byteLength + 1 }),
        fetchImpl: createFetch(bytes),
      }),
    ).rejects.toThrow(`ClawHub artifact size mismatch: expected ${bytes.byteLength + 1}`);
  });
});
