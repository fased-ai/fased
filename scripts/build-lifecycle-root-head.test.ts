import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLifecycleRootHead } from "./build-lifecycle-root-head.mjs";

const commit = "b".repeat(40);
const issuedAt = "2026-08-14T12:00:00.000Z";

async function fixture(schemaVersion = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fased-root-head-"));
  const root = path.join(directory, "fased-lifecycle-root-v3.json");
  const index = path.join(directory, `fased-release-index-v${schemaVersion}.json`);
  await fs.writeFile(
    root,
    `${JSON.stringify({ signed: { schemaVersion: 1, type: "fased-lifecycle-root", version: 3 } })}\n`,
  );
  await fs.writeFile(
    index,
    `${JSON.stringify({ schemaVersion, type: "fased-release-index", channel: "beta", version: "0.1.76-rc.90", releaseSequence: 90, securityEpoch: 7, commit })}\n`,
  );
  return { directory, root, index };
}

describe("lifecycle root-head builder", () => {
  it("binds the exact root, index, channel, and protected witness", async () => {
    const files = await fixture();
    try {
      const result = await buildLifecycleRootHead({
        root: files.root,
        index: files.index,
        witnessRef: "refs/tags/v0.1.76-rc.90",
        witnessCommit: commit,
        issuedAt,
        expiresAt: "2026-08-16T12:00:00.000Z",
      });
      expect(result).toMatchObject({
        channel: "beta",
        rootVersion: 3,
        releaseVersion: "0.1.76-rc.90",
        releaseSequence: 90,
        securityEpoch: 7,
        witnessCommit: commit,
      });
      expect(result.rootSHA256).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.releaseIndexSHA256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await fs.rm(files.directory, { recursive: true, force: true });
    }
  });

  it("binds the platform-qualified schema-v2 release index", async () => {
    const files = await fixture(2);
    try {
      const result = await buildLifecycleRootHead({
        root: files.root,
        index: files.index,
        witnessRef: "refs/tags/v0.1.76-rc.90",
        witnessCommit: commit,
        issuedAt,
        expiresAt: "2026-08-15T12:00:00.000Z",
      });
      expect(result).toMatchObject({
        releaseVersion: "0.1.76-rc.90",
        witnessCommit: commit,
      });
      expect(result.releaseIndexSHA256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await fs.rm(files.directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale-capable or unauthorized witness", async () => {
    const files = await fixture();
    try {
      await expect(
        buildLifecycleRootHead({
          root: files.root,
          index: files.index,
          witnessRef: "refs/heads/main",
          witnessCommit: commit,
          issuedAt,
          expiresAt: "2026-08-16T12:00:00.001Z",
        }),
      ).rejects.toThrow("48-hour");
      await expect(
        buildLifecycleRootHead({
          root: files.root,
          index: files.index,
          witnessRef: "refs/heads/feature",
          witnessCommit: commit,
          issuedAt,
          expiresAt: "2026-08-15T12:00:00.000Z",
        }),
      ).rejects.toThrow("unauthorized");
    } finally {
      await fs.rm(files.directory, { recursive: true, force: true });
    }
  });
});
