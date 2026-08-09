#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { buildLifecycleGeneration } from "./build-lifecycle-generation.mjs";

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) {
      throw new Error("lifecycle generation assembler requires named option/value pairs");
    }
    values.set(argv[index], argv[index + 1]);
  }
  for (const required of [
    "--runtime-archive",
    "--dependency-archive",
    "--release-manifest",
    "--signer",
    "--lifecycled",
    "--output-dir",
    "--version",
    "--commit",
    "--tree",
    "--architecture",
  ]) {
    if (!values.has(required)) {
      throw new Error(`missing ${required}`);
    }
  }
  return Object.fromEntries([...values].map(([key, value]) => [key.slice(2), value]));
}

async function sha256(file) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

export async function assembleLifecycleGeneration(argv = process.argv.slice(2)) {
  const value = args(argv);
  const outputDir = path.resolve(value["output-dir"]);
  const workspace = await fs.mkdtemp(path.join(outputDir, ".generation-"));
  try {
    const extracted = path.join(workspace, "runtime");
    const generation = path.join(workspace, "generation");
    const runtimeArchive = path.resolve(value["runtime-archive"]);
    const dependencyArchive = path.resolve(value["dependency-archive"]);
    const releaseManifest = path.resolve(value["release-manifest"]);
    const release = JSON.parse(await fs.readFile(releaseManifest, "utf8"));
    const selected = release?.application?.linux?.[value.architecture];
    if (
      release?.schemaVersion !== 2 ||
      release?.release?.version !== value.version ||
      release?.release?.commit !== value.commit ||
      selected?.artifact?.asset !== path.basename(runtimeArchive) ||
      selected?.dependencies?.asset !== path.basename(dependencyArchive) ||
      selected.artifact.sha256 !== (await sha256(runtimeArchive)) ||
      selected.dependencies.sha256 !== (await sha256(dependencyArchive))
    ) {
      throw new Error("application or dependency archive does not match the release manifest");
    }
    await fs.mkdir(extracted, { recursive: true });
    await tar.x({ file: runtimeArchive, cwd: extracted, strict: true });
    const runtimeRoot = path.join(extracted, "package");
    await buildLifecycleGeneration([
      "--runtime",
      runtimeRoot,
      "--release-manifest",
      releaseManifest,
      "--signer",
      path.resolve(value.signer),
      "--lifecycled",
      path.resolve(value.lifecycled),
      "--output",
      generation,
      "--version",
      value.version,
      "--commit",
      value.commit,
      "--tree",
      value.tree,
      "--dependency-hash",
      selected.dependencies.dependencyHash,
      "--dependency-asset",
      selected.dependencies.asset,
      "--dependency-archive-sha256",
      `sha256:${selected.dependencies.sha256}`,
    ]);
    const name = `fased-generation-linux-${value.architecture}-v${value.version}.tar.gz`;
    const destination = path.join(outputDir, name);
    await tar.c({ cwd: workspace, file: destination, gzip: true, portable: true }, ["generation"]);
    return destination;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assembleLifecycleGeneration().catch((error) => {
    process.stderr.write(
      `assemble-lifecycle-generation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
