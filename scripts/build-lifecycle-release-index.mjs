#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const GIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const architectures = [
  { name: "x64", go: "amd64" },
  { name: "arm64", go: "arm64" },
];

async function asset(directory, name) {
  const file = path.join(directory, name);
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`release-index asset is unsafe: ${name}`);
  }
  return {
    name,
    size: info.size,
    sha256: `sha256:${createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex")}`,
  };
}

async function generationMetadata(directory, version, architecture) {
  const name = `fased-generation-linux-${architecture}-v${version}.tar.gz`;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fased-release-index-"));
  try {
    await tar.x({
      cwd: workspace,
      file: path.join(directory, name),
      filter: (entry) =>
        entry === "generation/inventory.json" || entry === "generation/generation.json",
      preservePaths: false,
      strict: true,
    });
    const inventoryPath = path.join(workspace, "generation/inventory.json");
    const envelopePath = path.join(workspace, "generation/generation.json");
    for (const file of [inventoryPath, envelopePath]) {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
        throw new Error(`release-index generation metadata is unsafe for ${architecture}`);
      }
    }
    const inventoryJSON = await fs.readFile(inventoryPath);
    const inventory = JSON.parse(inventoryJSON.toString("utf8"));
    const envelope = JSON.parse(await fs.readFile(envelopePath, "utf8"));
    const inventoryDigest = createHash("sha256").update(inventoryJSON).digest("hex");
    if (
      envelope?.schemaVersion !== 1 ||
      envelope?.inventorySHA256 !== inventoryDigest ||
      !DIGEST.test(envelope?.generation?.id ?? "") ||
      envelope.generation.id !== envelope.generation.artifactSetDigest
    ) {
      throw new Error(`release-index generation envelope is invalid for ${architecture}`);
    }
    return { asset: await asset(directory, name), generation: envelope.generation, inventory };
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function buildLifecycleReleaseIndex(options) {
  const {
    assetsDir,
    channel,
    commit,
    expiresAt,
    issuedAt,
    releaseSequence,
    securityEpoch,
    tree,
    version,
  } = options;
  if (
    !VERSION.test(version) ||
    !GIT.test(commit) ||
    !GIT.test(tree) ||
    !["beta", "stable"].includes(channel) ||
    !Number.isSafeInteger(releaseSequence) ||
    releaseSequence < 1 ||
    !Number.isSafeInteger(securityEpoch) ||
    securityEpoch < 1
  ) {
    throw new Error("release-index identity is invalid");
  }
  const issued = new Date(issuedAt);
  const expires = new Date(expiresAt);
  if (
    issued.toISOString() !== issuedAt ||
    expires.toISOString() !== expiresAt ||
    expires <= issued
  ) {
    throw new Error("release-index validity is invalid");
  }

  const records = {};
  for (const architecture of architectures) {
    records[architecture.name] = await generationMetadata(assetsDir, version, architecture.name);
    const record = records[architecture.name];
    if (
      record.generation?.version !== version ||
      record.generation?.commit !== commit ||
      record.generation?.tree !== tree ||
      record.inventory?.version !== version ||
      record.inventory?.commit !== commit ||
      record.inventory?.tree !== tree ||
      !DIGEST.test(record.inventory?.pluginLockDigest ?? "") ||
      !record.inventory?.dependency
    ) {
      throw new Error(`release-index generation identity differs for ${architecture.name}`);
    }
  }
  const baseline = records.x64.inventory;
  if (
    !same(baseline.stateSchemas, records.arm64.inventory.stateSchemas) ||
    !same(baseline.capabilities, records.arm64.inventory.capabilities) ||
    baseline.pluginLockDigest !== records.arm64.inventory.pluginLockDigest
  ) {
    throw new Error("release-index architecture contracts disagree");
  }

  const application = {};
  const dependencyLayer = {};
  const lifecycleHost = {};
  const signer = {};
  for (const architecture of architectures) {
    const record = records[architecture.name];
    application[architecture.name] = record.asset;
    dependencyLayer[architecture.name] = await asset(assetsDir, record.inventory.dependency.asset);
    if (dependencyLayer[architecture.name].sha256 !== record.inventory.dependency.archiveSHA256) {
      throw new Error(`release-index dependency digest differs for ${architecture.name}`);
    }
    lifecycleHost[architecture.name] = {
      ...(await asset(assetsDir, `fased-lifecycled-linux-${architecture.go}`)),
      privilegedComponent: "lifecycle-host",
      protocols: {
        manifest: { min: 2, max: 2 },
        journal: { min: 1, max: 1 },
        participant: { min: 1, max: 1 },
        platform: { min: 1, max: 2 },
      },
    };
    signer[architecture.name] = await asset(assetsDir, `fased-signerd-linux-${architecture.go}`);
  }
  const boundAssets = {
    application,
    dependencyLayer,
    lifecycleHost,
    signer,
    stateSchemas: baseline.stateSchemas,
    capabilities: baseline.capabilities,
    pluginLockDigest: baseline.pluginLockDigest,
  };
  const artifactSetDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(boundAssets))
    .digest("hex")}`;
  return {
    schemaVersion: 1,
    type: "fased-release-index",
    channel,
    version,
    releaseSequence,
    securityEpoch,
    commit,
    tree,
    artifactSetDigest,
    ...boundAssets,
    issuedAt,
    expiresAt,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      throw new Error("release-index builder requires named option/value pairs");
    }
    values.set(key, value);
  }
  for (const key of [
    "--assets",
    "--channel",
    "--version",
    "--commit",
    "--tree",
    "--release-sequence",
    "--security-epoch",
    "--issued-at",
    "--expires-at",
    "--output",
  ]) {
    if (!values.has(key)) {
      throw new Error(`missing ${key}`);
    }
  }
  return {
    assetsDir: path.resolve(values.get("--assets")),
    channel: values.get("--channel"),
    version: values.get("--version"),
    commit: values.get("--commit"),
    tree: values.get("--tree"),
    releaseSequence: Number(values.get("--release-sequence")),
    securityEpoch: Number(values.get("--security-epoch")),
    issuedAt: values.get("--issued-at"),
    expiresAt: values.get("--expires-at"),
    output: path.resolve(values.get("--output")),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const index = await buildLifecycleReleaseIndex(options);
  await fs.writeFile(options.output, `${JSON.stringify(index)}\n`, { mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-lifecycle-release-index: ${error.message}\n`);
    process.exitCode = 1;
  });
}
