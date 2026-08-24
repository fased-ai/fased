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
const platforms = [
  { key: "linux-x64", operatingSystem: "linux", architecture: "x64", go: "amd64" },
  { key: "linux-arm64", operatingSystem: "linux", architecture: "arm64", go: "arm64" },
  { key: "darwin-x64", operatingSystem: "darwin", architecture: "x64", go: "amd64" },
  { key: "darwin-arm64", operatingSystem: "darwin", architecture: "arm64", go: "arm64" },
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

async function generationMetadata(directory, version, platform) {
  const name = `fased-generation-${platform.operatingSystem}-${platform.architecture}-v${version}.tar.gz`;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fased-release-index-"));
  try {
    await tar.x({
      cwd: workspace,
      file: path.join(directory, name),
      filter: (entry) =>
        entry === "generation/inventory.json" ||
        entry === "generation/generation.json" ||
        entry === "generation/payload/runtime/plugin.lock.json",
      preservePaths: false,
      strict: true,
    });
    const inventoryPath = path.join(workspace, "generation/inventory.json");
    const envelopePath = path.join(workspace, "generation/generation.json");
    const pluginLockPath = path.join(workspace, "generation/payload/runtime/plugin.lock.json");
    for (const file of [inventoryPath, envelopePath, pluginLockPath]) {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
        throw new Error(`release-index generation metadata is unsafe for ${platform.key}`);
      }
    }
    const inventoryJSON = await fs.readFile(inventoryPath);
    const inventory = JSON.parse(inventoryJSON.toString("utf8"));
    const envelope = JSON.parse(await fs.readFile(envelopePath, "utf8"));
    const pluginLock = JSON.parse(await fs.readFile(pluginLockPath, "utf8"));
    const pluginLockDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(pluginLock))
      .digest("hex")}`;
    const inventoryDigest = createHash("sha256").update(inventoryJSON).digest("hex");
    if (
      envelope?.schemaVersion !== 1 ||
      envelope?.inventorySHA256 !== inventoryDigest ||
      !DIGEST.test(envelope?.generation?.id ?? "") ||
      envelope.generation.id !== envelope.generation.artifactSetDigest
    ) {
      throw new Error(`release-index generation envelope is invalid for ${platform.key}`);
    }
    if (
      pluginLock?.schemaVersion !== 1 ||
      pluginLock?.type !== "fased-plugin-lock" ||
      !Array.isArray(pluginLock.entries)
    ) {
      throw new Error(`release-index plugin lock is invalid for ${platform.key}`);
    }
    return {
      asset: await asset(directory, name),
      generation: envelope.generation,
      inventory,
      pluginLockDigest,
    };
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
}

async function componentAssets(directory, version) {
  const names = (await fs.readdir(directory))
    .filter(
      (name) => name.startsWith("fased-component-") && name.endsWith(`-v${version}.index.json`),
    )
    .toSorted((left, right) => left.localeCompare(right));
  const components = {};
  for (const name of names) {
    const indexPath = path.join(directory, name);
    const info = await fs.lstat(indexPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
      throw new Error(`release-index component inventory is unsafe: ${name}`);
    }
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (
      index?.schemaVersion !== 1 ||
      index?.type !== "fased-hosted-component-index" ||
      index?.version !== version ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(index?.pack ?? "") ||
      !Array.isArray(index?.components)
    ) {
      throw new Error(`release-index component inventory is invalid: ${name}`);
    }
    for (const component of index.components) {
      if (
        !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(component?.id ?? "") ||
        components[component.id] ||
        !DIGEST.test(component?.catalog?.sha256 ?? "") ||
        !DIGEST.test(component?.archive?.sha256 ?? "")
      ) {
        throw new Error(`release-index component identity is invalid: ${name}`);
      }
      const catalog = await asset(directory, component.catalog.asset);
      const archive = await asset(directory, component.archive.asset);
      if (
        catalog.sha256 !== component.catalog.sha256 ||
        archive.sha256 !== component.archive.sha256
      ) {
        throw new Error(
          `release-index component assets differ from their inventory: ${component.id}`,
        );
      }
      components[component.id] = { catalog, archive };
    }
  }
  return Object.fromEntries(
    Object.entries(components).toSorted(([left], [right]) => left.localeCompare(right)),
  );
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
    schemaVersion = 2,
  } = options;
  if (
    !VERSION.test(version) ||
    !GIT.test(commit) ||
    !GIT.test(tree) ||
    !["beta", "stable"].includes(channel) ||
    ![1, 2].includes(schemaVersion) ||
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

  const selectedPlatforms = platforms.filter((platform) => platform.key === "linux-x64");
  const records = {};
  for (const platform of selectedPlatforms) {
    records[platform.key] = await generationMetadata(assetsDir, version, platform);
    const record = records[platform.key];
    if (
      record.generation?.version !== version ||
      record.generation?.commit !== commit ||
      record.generation?.tree !== tree ||
      record.inventory?.version !== version ||
      record.inventory?.commit !== commit ||
      record.inventory?.tree !== tree ||
      !DIGEST.test(record.pluginLockDigest) ||
      !record.inventory?.dependency
    ) {
      throw new Error(`release-index generation identity differs for ${platform.key}`);
    }
  }
  const baseline = records["linux-x64"].inventory;
  const application = {};
  const dependencyLayer = {};
  const lifecycleHost = {};
  const signer = {};
  for (const platform of selectedPlatforms) {
    const record = records[platform.key];
    const assetKey = schemaVersion === 1 ? platform.architecture : platform.key;
    application[assetKey] = record.asset;
    dependencyLayer[assetKey] = await asset(assetsDir, record.inventory.dependency.asset);
    if (dependencyLayer[assetKey].sha256 !== record.inventory.dependency.archiveSHA256) {
      throw new Error(`release-index dependency digest differs for ${platform.key}`);
    }
    lifecycleHost[assetKey] = {
      ...(await asset(assetsDir, `fased-lifecycled-${platform.operatingSystem}-${platform.go}`)),
      privilegedComponent: "lifecycle-host",
      protocols: {
        manifest: { min: 1, max: 2 },
        journal: { min: 1, max: 1 },
        participant: { min: 1, max: 1 },
        platform: { min: 1, max: 2 },
      },
    };
    signer[assetKey] = await asset(
      assetsDir,
      `fased-signerd-${platform.operatingSystem}-${platform.go}`,
    );
  }
  const components = await componentAssets(assetsDir, version);
  const boundAssets = {
    application,
    dependencyLayer,
    lifecycleHost,
    signer,
    ...(Object.keys(components).length > 0 ? { components } : {}),
    stateSchemas: baseline.stateSchemas,
    capabilities: baseline.capabilities,
    pluginLockDigest: records["linux-x64"].pluginLockDigest,
  };
  const artifactSetDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(boundAssets))
    .digest("hex")}`;
  return {
    schemaVersion,
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
    schemaVersion: Number(values.get("--schema-version") ?? "2"),
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
