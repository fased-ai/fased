import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { buildLifecycleReleaseIndex } from "./build-lifecycle-release-index.mjs";

const roots: string[] = [];
const version = "0.1.76-rc.76";
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const digest = (body: string | Buffer) =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-release-index-test-"));
  roots.push(root);
  for (const [operatingSystem, architecture, go] of [
    ["linux", "x64", "amd64"],
    ["linux", "arm64", "arm64"],
    ["darwin", "x64", "amd64"],
    ["darwin", "arm64", "arm64"],
  ]) {
    const platform = `${operatingSystem}-${architecture}`;
    const dependencyName = `fased-hosted-deps-${platform}-fixture.tar.gz`;
    const dependencyBody = `dependency-${platform}`;
    await fs.writeFile(path.join(root, dependencyName), dependencyBody);
    await fs.writeFile(
      path.join(root, `fased-lifecycled-${operatingSystem}-${go}`),
      `host-${platform}`,
    );
    await fs.writeFile(
      path.join(root, `fased-signerd-${operatingSystem}-${go}`),
      `signer-${platform}`,
    );
    const generationRoot = path.join(root, `generation-${platform}`, "generation");
    await fs.mkdir(generationRoot, { recursive: true });
    const pluginLock = {
      schemaVersion: 1,
      type: "fased-plugin-lock",
      entries: [],
    };
    await fs.mkdir(path.join(generationRoot, "payload", "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(generationRoot, "payload", "runtime", "plugin.lock.json"),
      `${JSON.stringify(pluginLock)}\n`,
    );
    const inventoryJSON = JSON.stringify({
      schemaVersion: 3,
      version,
      commit,
      tree,
      stateSchemas: { signer: 2 },
      capabilities: {
        supervisor: { min: 1, max: 1 },
        controller: { min: 1, max: 1 },
        migrator: { min: 1, max: 1 },
        signer: { min: 1, max: 1 },
      },
      dependency: {
        hash: digest(dependencyBody),
        asset: dependencyName,
        archiveSHA256: digest(dependencyBody),
      },
      artifacts: [{ path: "payload/fased.mjs" }],
    });
    await fs.writeFile(path.join(generationRoot, "inventory.json"), inventoryJSON);
    await fs.writeFile(
      path.join(generationRoot, "generation.json"),
      JSON.stringify({
        schemaVersion: 1,
        generation: {
          id: digest(`generation-${platform}`),
          version,
          commit,
          tree,
          artifactSetDigest: digest(`generation-${platform}`),
        },
        inventorySHA256: digest(inventoryJSON).slice("sha256:".length),
      }),
    );
    await tar.c(
      {
        cwd: path.dirname(generationRoot),
        file: path.join(root, `fased-generation-${platform}-v${version}.tar.gz`),
        gzip: true,
      },
      ["generation"],
    );
  }
  return root;
}

describe("production lifecycle release index", () => {
  it("binds optional component catalogs and archives from the exact release inventory", async () => {
    const assetsDir = await fixture();
    const catalogAsset = `fased-component-browser-media-voice-runtime-browser-v${version}.catalog.json`;
    const archiveAsset = `fased-component-browser-media-voice-runtime-browser-v${version}.tar.gz`;
    const catalogBody = "catalog\n";
    const archiveBody = "archive\n";
    await fs.writeFile(path.join(assetsDir, catalogAsset), catalogBody);
    await fs.writeFile(path.join(assetsDir, archiveAsset), archiveBody);
    await fs.writeFile(
      path.join(assetsDir, `fased-component-browser-media-voice-v${version}.index.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        type: "fased-hosted-component-index",
        version,
        pack: "browser-media-voice",
        components: [
          {
            id: "runtime-browser",
            catalog: { asset: catalogAsset, sha256: digest(catalogBody) },
            archive: {
              asset: archiveAsset,
              sha256: digest(archiveBody),
              bytes: archiveBody.length,
            },
          },
        ],
      })}\n`,
    );
    const index = await buildLifecycleReleaseIndex({
      assetsDir,
      channel: "beta",
      commit,
      expiresAt: "2031-07-29T20:37:38.000Z",
      issuedAt: "2026-08-12T20:00:00.000Z",
      releaseSequence: 1,
      securityEpoch: 1,
      tree,
      version,
    });
    expect(index.components).toEqual({
      "runtime-browser": {
        catalog: expect.objectContaining({ name: catalogAsset, sha256: digest(catalogBody) }),
        archive: expect.objectContaining({ name: archiveAsset, sha256: digest(archiveBody) }),
      },
    });
  });

  it("binds Linux and macOS x64 and arm64 without a private release key", async () => {
    const assetsDir = await fixture();
    const index = await buildLifecycleReleaseIndex({
      assetsDir,
      channel: "beta",
      commit,
      expiresAt: "2031-07-29T20:37:38.000Z",
      issuedAt: "2026-08-12T20:00:00.000Z",
      releaseSequence: 1,
      securityEpoch: 1,
      tree,
      version,
    });
    expect(index).toMatchObject({
      schemaVersion: 2,
      type: "fased-release-index",
      version,
      releaseSequence: 1,
      securityEpoch: 1,
      application: {
        "linux-x64": { name: `fased-generation-linux-x64-v${version}.tar.gz` },
        "linux-arm64": { name: `fased-generation-linux-arm64-v${version}.tar.gz` },
        "darwin-x64": { name: `fased-generation-darwin-x64-v${version}.tar.gz` },
        "darwin-arm64": { name: `fased-generation-darwin-arm64-v${version}.tar.gz` },
      },
      lifecycleHost: {
        "linux-x64": { privilegedComponent: "lifecycle-host" },
        "linux-arm64": { privilegedComponent: "lifecycle-host" },
        "darwin-x64": { privilegedComponent: "lifecycle-host" },
        "darwin-arm64": { privilegedComponent: "lifecycle-host" },
      },
    });
    expect(index.artifactSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(index.pluginLockDigest).toBe(
      digest(JSON.stringify({ schemaVersion: 1, type: "fased-plugin-lock", entries: [] })),
    );
    expect(index).not.toHaveProperty("privateKey");
    expect(index).not.toHaveProperty("delegation");
  });

  it("keeps schema 1 Linux-only for predecessor bootstraps", async () => {
    const assetsDir = await fixture();
    const index = await buildLifecycleReleaseIndex({
      assetsDir,
      channel: "beta",
      commit,
      expiresAt: "2031-07-29T20:37:38.000Z",
      issuedAt: "2026-08-12T20:00:00.000Z",
      releaseSequence: 1,
      schemaVersion: 1,
      securityEpoch: 1,
      tree,
      version,
    });
    expect(index.schemaVersion).toBe(1);
    expect(Object.keys(index.application)).toEqual(["x64", "arm64"]);
    expect(Object.keys(index.lifecycleHost)).toEqual(["x64", "arm64"]);
  });

  it("rejects a dependency that differs from the generation inventory", async () => {
    const assetsDir = await fixture();
    await fs.writeFile(
      path.join(assetsDir, "fased-hosted-deps-linux-x64-fixture.tar.gz"),
      "tampered",
    );
    await expect(
      buildLifecycleReleaseIndex({
        assetsDir,
        channel: "beta",
        commit,
        expiresAt: "2031-07-29T20:37:38.000Z",
        issuedAt: "2026-08-12T20:00:00.000Z",
        releaseSequence: 1,
        securityEpoch: 1,
        tree,
        version,
      }),
    ).rejects.toThrow("dependency digest differs for linux-x64");
  });
});
