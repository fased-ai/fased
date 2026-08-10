#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CANDIDATE_DESCRIPTOR = "fased-hosting-candidate.json";
export const CANDIDATE_ATTESTATION = `${CANDIDATE_DESCRIPTOR}.attestation.json`;

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value)
    .toSorted((left, right) => left.localeCompare(right))
    .join(",");
  const wanted = [...expected].toSorted((left, right) => left.localeCompare(right)).join(",");
  if (actual !== wanted) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function digestValue(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

async function safeDirectoryFiles(directory) {
  const directoryInfo = await fsp.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    fail("candidate artifact root is not a real directory");
  }
  const files = [];
  for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!SAFE_NAME_PATTERN.test(entry.name)) {
      fail(`unsafe candidate artifact name: ${entry.name}`);
    }
    const file = path.join(directory, entry.name);
    const info = await fsp.lstat(file);
    if (!entry.isFile() || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail(`candidate artifact is not a regular single-link file: ${entry.name}`);
    }
    if (info.size === 0) {
      fail(`candidate artifact is empty: ${entry.name}`);
    }
    files.push({ name: entry.name, file, size: info.size });
  }
  return files;
}

function validateIdentity({
  version,
  commit,
  tree,
  lockfileDigest,
  sourceRef,
  workflowRunId,
  workflowRunAttempt,
}) {
  if (!VERSION_PATTERN.test(version || "")) {
    fail("candidate version is invalid");
  }
  if (!COMMIT_PATTERN.test(commit || "")) {
    fail("candidate commit is invalid");
  }
  if (!COMMIT_PATTERN.test(tree || "")) {
    fail("candidate tree is invalid");
  }
  if (!DIGEST_PATTERN.test(lockfileDigest || "")) {
    fail("candidate lockfile digest is invalid");
  }
  if (sourceRef !== `refs/tags/v${version}`) {
    fail("candidate source ref must be the exact immutable release tag");
  }
  if (!/^[1-9][0-9]*$/u.test(String(workflowRunId || ""))) {
    fail("candidate workflow run ID is invalid");
  }
  if (!/^[1-9][0-9]*$/u.test(String(workflowRunAttempt || ""))) {
    fail("candidate workflow run attempt is invalid");
  }
}

export async function buildCandidateDescriptor({
  directory,
  version,
  commit,
  tree,
  lockfileDigest,
  sourceRef,
  workflowRunId,
  workflowRunAttempt,
}) {
  validateIdentity({
    version,
    commit,
    tree,
    lockfileDigest,
    sourceRef,
    workflowRunId,
    workflowRunAttempt,
  });
  const files = await safeDirectoryFiles(directory);
  if (files.some(({ name }) => name === CANDIDATE_DESCRIPTOR || name === CANDIDATE_ATTESTATION)) {
    fail("candidate descriptor output already exists");
  }
  if (files.length === 0) {
    fail("candidate artifact set is empty");
  }
  const artifacts = [];
  for (const { name, file, size } of files) {
    artifacts.push({ name, sha256: await sha256File(file), size });
  }
  const descriptor = {
    schemaVersion: 3,
    version,
    commit,
    tree,
    lockfileDigest,
    sourceRef,
    workflowRunId: String(workflowRunId),
    workflowRunAttempt: String(workflowRunAttempt),
    artifacts,
    artifactSetDigest: digestValue(artifacts),
  };
  const output = path.join(directory, CANDIDATE_DESCRIPTOR);
  await fsp.writeFile(output, `${JSON.stringify(descriptor, null, 2)}\n`, {
    mode: 0o644,
    flag: "wx",
  });
  return { descriptor, output, descriptorDigest: await sha256File(output) };
}

export function parseCandidateDescriptor(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "version",
      "commit",
      "tree",
      "lockfileDigest",
      "sourceRef",
      "workflowRunId",
      "workflowRunAttempt",
      "artifacts",
      "artifactSetDigest",
    ],
    "candidate descriptor",
  );
  if (value.schemaVersion !== 3) {
    fail("candidate descriptor schema is unsupported");
  }
  validateIdentity(value);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && expectedValue !== null && value[key] !== expectedValue) {
      fail(`candidate descriptor ${key} mismatch`);
    }
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    fail("candidate descriptor artifacts are empty");
  }
  const names = [];
  for (const artifact of value.artifacts) {
    exactKeys(artifact, ["name", "sha256", "size"], "candidate artifact identity");
    if (
      !SAFE_NAME_PATTERN.test(artifact.name || "") ||
      artifact.name === CANDIDATE_DESCRIPTOR ||
      artifact.name === CANDIDATE_ATTESTATION ||
      !DIGEST_PATTERN.test(artifact.sha256 || "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0
    ) {
      fail("candidate artifact identity is invalid");
    }
    names.push(artifact.name);
  }
  const sorted = [...new Set(names)].toSorted((left, right) => left.localeCompare(right));
  if (sorted.length !== names.length || sorted.some((name, index) => name !== names[index])) {
    fail("candidate artifacts must have sorted unique names");
  }
  if (value.artifactSetDigest !== digestValue(value.artifacts)) {
    fail("candidate artifact-set digest mismatch");
  }
  return value;
}

export async function verifyCandidateDirectory({ directory, expected = {} }) {
  const files = await safeDirectoryFiles(directory);
  const byName = new Map(files.map((entry) => [entry.name, entry]));
  const descriptorEntry = byName.get(CANDIDATE_DESCRIPTOR);
  const attestationEntry = byName.get(CANDIDATE_ATTESTATION);
  if (!descriptorEntry || !attestationEntry) {
    fail("candidate descriptor or its attestation bundle is missing");
  }
  const descriptor = parseCandidateDescriptor(
    JSON.parse(await fsp.readFile(descriptorEntry.file, "utf8")),
    expected,
  );
  const expectedNames = new Set([
    ...descriptor.artifacts.map(({ name }) => name),
    CANDIDATE_DESCRIPTOR,
    CANDIDATE_ATTESTATION,
  ]);
  if (
    expectedNames.size !== byName.size ||
    [...byName.keys()].some((name) => !expectedNames.has(name))
  ) {
    fail("candidate directory does not exactly match the promoted artifact set");
  }
  for (const artifact of descriptor.artifacts) {
    const entry = byName.get(artifact.name);
    if (
      !entry ||
      entry.size !== artifact.size ||
      (await sha256File(entry.file)) !== artifact.sha256
    ) {
      fail(`candidate artifact content mismatch: ${artifact.name}`);
    }
  }
  const promotionArtifacts = await buildPromotionArtifacts(directory);
  return {
    descriptor,
    descriptorDigest: await sha256File(descriptorEntry.file),
    attestationDigest: await sha256File(attestationEntry.file),
    promotionArtifacts,
    promotionArtifactSetDigest: digestValue(promotionArtifacts),
  };
}

export async function buildPromotionArtifacts(directory) {
  const files = await safeDirectoryFiles(directory);
  const artifacts = [];
  for (const { name, file } of files) {
    artifacts.push({ identity: name, digest: await sha256File(file) });
  }
  if (artifacts.length === 0) {
    fail("promotion artifact set is empty");
  }
  return artifacts;
}

export async function verifyPublishedAssets({ directory, assets }) {
  if (!Array.isArray(assets) || assets.length === 0) {
    fail("published release asset inventory is empty");
  }
  const localFiles = await safeDirectoryFiles(directory);
  const local = new Map();
  for (const { name, file, size } of localFiles) {
    local.set(name, { digest: await sha256File(file), size });
  }
  const remote = new Map();
  for (const asset of assets) {
    exactKeys(asset, ["digest", "name", "size"], "published release asset");
    if (
      !SAFE_NAME_PATTERN.test(asset.name || "") ||
      !DIGEST_PATTERN.test(asset.digest || "") ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      remote.has(asset.name)
    ) {
      fail("published release asset identity is invalid");
    }
    remote.set(asset.name, { digest: asset.digest, size: asset.size });
  }
  if (
    local.size !== remote.size ||
    [...local].some(
      ([name, identity]) =>
        !remote.has(name) ||
        remote.get(name).digest !== identity.digest ||
        remote.get(name).size !== identity.size,
    )
  ) {
    fail("published release assets do not exactly match the promoted candidate bytes");
  }
  const promotionArtifacts = await buildPromotionArtifacts(directory);
  return {
    assets: promotionArtifacts,
    promotionArtifactSetDigest: digestValue(promotionArtifacts),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["build", "verify", "verify-assets"].includes(command)) {
    fail("usage: release-artifact-set <build|verify|verify-assets> [options]");
  }
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument: ${key ?? ""}`);
    }
    if (values.has(key)) {
      fail(`duplicate argument: ${key}`);
    }
    values.set(key, value);
  }
  const required =
    command === "verify-assets"
      ? ["--directory", "--assets-json"]
      : [
          "--directory",
          "--version",
          "--commit",
          "--tree",
          "--lockfile-digest",
          "--source-ref",
          "--workflow-run-id",
        ];
  if (command === "build") {
    required.push("--workflow-run-attempt");
  }
  for (const key of required) {
    if (!values.has(key)) {
      fail(`missing ${key}`);
    }
  }
  return {
    command,
    directory: path.resolve(values.get("--directory")),
    version: values.get("--version"),
    commit: values.get("--commit"),
    tree: values.get("--tree"),
    lockfileDigest: values.get("--lockfile-digest"),
    sourceRef: values.get("--source-ref"),
    workflowRunId: values.get("--workflow-run-id"),
    workflowRunAttempt: values.get("--workflow-run-attempt"),
    assetsJson: values.has("--assets-json") ? path.resolve(values.get("--assets-json")) : null,
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const result =
    options.command === "build"
      ? await buildCandidateDescriptor(options)
      : options.command === "verify"
        ? await verifyCandidateDirectory({
            directory: options.directory,
            expected: {
              version: options.version,
              commit: options.commit,
              tree: options.tree,
              lockfileDigest: options.lockfileDigest,
              sourceRef: options.sourceRef,
              workflowRunId: options.workflowRunId,
              workflowRunAttempt: options.workflowRunAttempt,
            },
          })
        : await verifyPublishedAssets({
            directory: options.directory,
            assets: JSON.parse(await fsp.readFile(options.assetsJson, "utf8")),
          });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release-artifact-set: ${error.message}\n`);
    process.exitCode = 1;
  });
}
