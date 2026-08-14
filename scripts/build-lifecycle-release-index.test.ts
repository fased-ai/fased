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
  for (const [architecture, go] of [
    ["x64", "amd64"],
    ["arm64", "arm64"],
  ]) {
    const dependencyName = `fased-hosted-deps-linux-${architecture}-fixture.tar.gz`;
    const dependencyBody = `dependency-${architecture}`;
    await fs.writeFile(path.join(root, dependencyName), dependencyBody);
    await fs.writeFile(path.join(root, `fased-lifecycled-linux-${go}`), `host-${go}`);
    await fs.writeFile(path.join(root, `fased-signerd-linux-${go}`), `signer-${go}`);
    const generationRoot = path.join(root, `generation-${architecture}`, "generation");
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
          id: digest(`generation-${architecture}`),
          version,
          commit,
          tree,
          artifactSetDigest: digest(`generation-${architecture}`),
        },
        inventorySHA256: digest(inventoryJSON).slice("sha256:".length),
      }),
    );
    await tar.c(
      {
        cwd: path.dirname(generationRoot),
        file: path.join(root, `fased-generation-linux-${architecture}-v${version}.tar.gz`),
        gzip: true,
      },
      ["generation"],
    );
  }
  return root;
}

describe("production lifecycle release index", () => {
  it("binds both architectures and the monotonic authority without a private release key", async () => {
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
      schemaVersion: 1,
      type: "fased-release-index",
      version,
      releaseSequence: 1,
      securityEpoch: 1,
      application: {
        x64: { name: `fased-generation-linux-x64-v${version}.tar.gz` },
        arm64: { name: `fased-generation-linux-arm64-v${version}.tar.gz` },
      },
      lifecycleHost: {
        x64: { privilegedComponent: "lifecycle-host" },
        arm64: { privilegedComponent: "lifecycle-host" },
      },
    });
    expect(index.artifactSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(index.pluginLockDigest).toBe(
      digest(JSON.stringify({ schemaVersion: 1, type: "fased-plugin-lock", entries: [] })),
    );
    expect(index).not.toHaveProperty("privateKey");
    expect(index).not.toHaveProperty("delegation");
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
    ).rejects.toThrow("dependency digest differs for x64");
  });

  it("keeps branch trust plugin-lock hashing byte-identical to Go canonical JSON", async () => {
    for (const script of [
      "prepare-candidate-fixture-trust.sh",
      "test-lifecycle-local-acceptance.sh",
    ]) {
      const source = await fs.readFile(path.join(import.meta.dirname, script), "utf8");
      expect(source).toContain(
        "jq -cj '{schemaVersion,type,entries:[.entries[]|{id,origin,digest,apiCapability,required}]}'",
      );
    }
  });
});
