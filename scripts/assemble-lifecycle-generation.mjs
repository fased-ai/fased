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

async function pluginTreeDigest(root) {
  const entries = [];
  const visit = async (directory, relativeRoot = "") => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = path.posix.join(relativeRoot, entry.name);
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`bundled plugin contains unsupported entry: ${relative}`);
      }
      const record = { path: relative, mode: stat.mode & 0o777 };
      if (stat.isFile()) {
        record.digest = `sha256:${await sha256(absolute)}`;
      }
      entries.push(record);
      if (stat.isDirectory()) {
        await visit(absolute, relative);
      }
    }
  };
  await visit(root);
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

export async function writeBundledPluginLock(runtimeRoot) {
  const extensionsRoot = path.join(runtimeRoot, "extensions");
  const required = new Set(["memory-core", "sat-mining"]);
  const entries = [];
  for (const entry of (await fs.readdir(extensionsRoot, { withFileTypes: true })).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginRoot = path.join(extensionsRoot, entry.name);
    const manifest = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "fased.plugin.json"), "utf8"),
    );
    if (manifest?.id !== entry.name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id)) {
      throw new Error(`bundled plugin identity is invalid: ${entry.name}`);
    }
    entries.push({
      id: manifest.id,
      origin: "bundled",
      digest: await pluginTreeDigest(pluginRoot),
      apiCapability: "fased.plugin.v1",
      required: required.has(manifest.id),
    });
    required.delete(manifest.id);
  }
  if (required.size > 0) {
    throw new Error(`required bundled plugins are missing: ${[...required].join(", ")}`);
  }
  const lock = { schemaVersion: 1, type: "fased-plugin-lock", entries };
  const canonical = JSON.stringify(lock);
  await fs.writeFile(path.join(runtimeRoot, "plugin.lock.json"), `${canonical}\n`, { mode: 0o644 });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
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
    const pluginLockDigest = await writeBundledPluginLock(runtimeRoot);
    await buildLifecycleGeneration([
      "--runtime",
      runtimeRoot,
      "--release-manifest",
      releaseManifest,
      "--signer",
      path.resolve(value.signer),
      "--lifecycled",
      path.resolve(value.lifecycled),
      ...(value["inventory-lifecycled"]
        ? ["--inventory-lifecycled", path.resolve(value["inventory-lifecycled"])]
        : []),
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
      "--plugin-lock-digest",
      pluginLockDigest,
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
