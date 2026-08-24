#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { trustMetadataDigest } from "./lifecycle-trust-policy.mjs";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MAX_LIFETIME_MS = 48 * 60 * 60 * 1000;

async function regularJSON(file, label) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`${label} is not a safe non-empty regular file`);
  }
  const raw = await fs.readFile(file);
  return { raw, value: JSON.parse(raw.toString("utf8")) };
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} is not canonical UTC ISO-8601`);
  }
  return parsed;
}

export async function buildLifecycleRootHead(options) {
  const root = await regularJSON(path.resolve(options.root), "lifecycle root");
  const index = await regularJSON(path.resolve(options.index), "release index");
  const issued = instant(options.issuedAt, "issuedAt");
  const expires = instant(options.expiresAt, "expiresAt");
  if (expires <= issued || expires - issued > MAX_LIFETIME_MS) {
    throw new Error("root-head validity exceeds the 48-hour freshness bound");
  }
  const release = index.value;
  const rootVersion = root.value?.signed?.version;
  if (
    root.value?.signed?.schemaVersion !== 1 ||
    root.value?.signed?.type !== "fased-lifecycle-root" ||
    !Number.isSafeInteger(rootVersion) ||
    rootVersion < 1 ||
    ![1, 2].includes(release?.schemaVersion) ||
    release?.type !== "fased-release-index" ||
    !["stable", "beta"].includes(release.channel) ||
    !VERSION.test(release.version ?? "") ||
    !Number.isSafeInteger(release.releaseSequence) ||
    release.releaseSequence < 1 ||
    !Number.isSafeInteger(release.securityEpoch) ||
    release.securityEpoch < 1 ||
    !COMMIT.test(release.commit ?? "") ||
    !COMMIT.test(options.witnessCommit ?? "")
  ) {
    throw new Error("root-head input identity is malformed");
  }
  if (
    (release.channel === "stable" && release.version.includes("-")) ||
    (release.channel === "beta" && !release.version.includes("-"))
  ) {
    throw new Error("root-head channel and release version disagree");
  }
  const tagRef = `refs/tags/v${release.version}`;
  if (!["refs/heads/main", tagRef].includes(options.witnessRef)) {
    throw new Error("root-head witness ref is unauthorized");
  }
  if (options.witnessRef === tagRef && options.witnessCommit !== release.commit) {
    throw new Error("tag root-head witness commit differs from the release index");
  }
  return {
    schemaVersion: 1,
    type: "fased-lifecycle-root-head",
    channel: release.channel,
    rootVersion,
    rootSHA256: trustMetadataDigest(root.value),
    releaseIndexSHA256: createHash("sha256").update(index.raw).digest("hex"),
    releaseVersion: release.version,
    releaseSequence: release.releaseSequence,
    securityEpoch: release.securityEpoch,
    indexCommit: release.commit,
    witnessRef: options.witnessRef,
    witnessCommit: options.witnessCommit,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      throw new Error("root-head builder requires unique named option/value pairs");
    }
    values.set(key, value);
  }
  for (const key of [
    "--root",
    "--index",
    "--witness-ref",
    "--witness-commit",
    "--issued-at",
    "--expires-at",
    "--output",
  ]) {
    if (!values.has(key)) {
      throw new Error(`missing ${key}`);
    }
  }
  return {
    root: values.get("--root"),
    index: values.get("--index"),
    witnessRef: values.get("--witness-ref"),
    witnessCommit: values.get("--witness-commit"),
    issuedAt: values.get("--issued-at"),
    expiresAt: values.get("--expires-at"),
    output: path.resolve(values.get("--output")),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const head = await buildLifecycleRootHead(options);
  await fs.writeFile(options.output, `${JSON.stringify(head)}\n`, { mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-lifecycle-root-head: ${error.message}\n`);
    process.exitCode = 1;
  });
}
