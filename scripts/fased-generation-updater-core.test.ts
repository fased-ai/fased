import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { __testing } from "./fased-generation-updater-core.mjs";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

async function dependencyFixture({
  archiveBound = true,
  markerArchive,
}: {
  archiveBound?: boolean;
  markerArchive?: string;
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-active-dependency-"));
  temporary.push(root);
  const installRoot = path.join(root, "install");
  const currentRoot = path.join(installRoot, "generations", "target");
  const hash = "a".repeat(64);
  const archiveSHA256 = `sha256:${"b".repeat(64)}`;
  const asset = `fased-hosted-deps-linux-x64-${hash}.tar.gz`;
  const layerName = archiveBound ? `${hash}-${archiveSHA256.slice(7)}` : hash;
  const layerRoot = path.join(installRoot, "dependencies", layerName);
  const dependencyRoot = path.join(layerRoot, "node_modules");
  await fsp.mkdir(dependencyRoot, { recursive: true });
  await fsp.mkdir(currentRoot, { recursive: true });
  await fsp.symlink(
    path.relative(currentRoot, dependencyRoot),
    path.join(currentRoot, "node_modules"),
  );
  await fsp.writeFile(
    path.join(layerRoot, ".fased-dependency-layer.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      hash,
      asset,
      archiveSHA256: markerArchive ?? archiveSHA256,
    })}\n`,
  );
  return { installRoot, currentRoot, dependencyRoot, dependency: { hash, asset, archiveSHA256 } };
}

describe("generation updater command ownership", () => {
  it("ships the generation core in the public package", () => {
    expect(packageMetadata.files).toContain("scripts/fased-generation-updater-core.mjs");
  });

  it("keeps normal managed updates on the generation engine", () => {
    expect(__testing.parseArgs(["update", "--channel", "beta", "--tag", "v1.2.3"])).toMatchObject({
      mode: "generation",
      options: { channel: "beta", channelExplicit: true, tag: "v1.2.3" },
    });
    expect(__testing.parseArgs(["update", "status", "--json"])).toMatchObject({
      mode: "generation",
      options: { status: true, json: true },
    });
    expect(__testing.parseArgs(["update", "--dry-run"])).toMatchObject({
      mode: "generation",
      options: { dryRun: true },
    });
  });

  it("lazy-loads compatibility only for development and internal commands", () => {
    expect(__testing.parseArgs(["update", "--channel", "dev"])).toMatchObject({
      mode: "legacy",
    });
    expect(__testing.parseArgs(["hosted-transaction", "recover"])).toMatchObject({
      mode: "legacy",
    });
  });

  it("rejects updates that skip mandatory restart verification", () => {
    expect(() => __testing.parseArgs(["update", "--no-restart"])).toThrow(
      "require restart and health verification",
    );
  });

  it("has no secondary lifecycle owner selector", () => {
    expect(__testing.ownerFor).toBeUndefined();
    expect(__testing.configuredChannel({ channelExplicit: false })).toBe("stable");
    expect(__testing.configuredChannel({ channelExplicit: true, channel: "beta" })).toBe("beta");
  });

  it.each([true, false])(
    "resolves the generation-bound dependency layer (archive-bound=%s)",
    async (archiveBound) => {
      const value = await dependencyFixture({ archiveBound });
      await expect(__testing.resolveGenerationDependencyRoot(value)).resolves.toBe(
        value.dependencyRoot,
      );
    },
  );

  it("rejects a dependency layer whose archive identity differs from the generation", async () => {
    const value = await dependencyFixture({ markerArchive: `sha256:${"c".repeat(64)}` });
    await expect(__testing.resolveGenerationDependencyRoot(value)).rejects.toThrow(
      "differs from the active generation",
    );
  });

  it("rejects a generation dependency binding outside the immutable store", async () => {
    const value = await dependencyFixture();
    await fsp.unlink(path.join(value.currentRoot, "node_modules"));
    const escaped = path.join(path.dirname(value.installRoot), "escaped", "node_modules");
    await fsp.mkdir(escaped, { recursive: true });
    await fsp.symlink(
      path.relative(value.currentRoot, escaped),
      path.join(value.currentRoot, "node_modules"),
    );
    await expect(__testing.resolveGenerationDependencyRoot(value)).rejects.toThrow(
      "escaped its immutable store",
    );
  });
});
