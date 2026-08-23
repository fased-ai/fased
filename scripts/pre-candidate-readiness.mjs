#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`pre-candidate readiness: ${message}`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function validateHostingStagingReadiness(staging, expected) {
  if (
    staging?.schemaVersion !== 1 ||
    staging?.role !== "fased-hosting-staging-vps-acceptance" ||
    staging?.status !== "PASS" ||
    staging?.evidenceClass !== "PASS" ||
    staging?.environmentClass !== "hosting-staging-vps" ||
    staging?.source?.commit !== expected.commit ||
    staging?.source?.tree !== expected.tree ||
    !digestPattern.test(staging?.artifact?.descriptorDigest || "") ||
    !digestPattern.test(staging?.artifact?.acceptanceContractDigest || "") ||
    staging?.literalPublicInstall?.status !== "PASS" ||
    !digestPattern.test(staging?.literalPublicInstall?.evidenceDigest || "") ||
    staging?.identicalRetry?.status !== "PASS" ||
    staging?.identicalRetry?.outcome !== "ALREADY_CURRENT" ||
    !digestPattern.test(staging?.identicalRetry?.evidenceDigest || "") ||
    staging?.resources?.memoryLimitBytes !== 2147483648 ||
    staging?.resources?.swapLimitBytes !== 2147483648 ||
    staging?.resources?.initialSystemSwapBytes !== 0 ||
    !Number.isSafeInteger(staging?.resources?.finalSystemSwapBytes) ||
    staging.resources.finalSystemSwapBytes < 2147483648 ||
    staging?.resources?.managedSwapActive !== true ||
    staging?.resources?.managedSwapPersistent !== true ||
    staging?.resources?.oomKill !== 0 ||
    !Number.isSafeInteger(staging?.resources?.memoryPeakBytes) ||
    staging.resources.memoryPeakBytes <= 0
  ) {
    fail("exact unpublished Hosting staging-VPS acceptance is missing or invalid");
  }
  return Object.freeze({
    commit: expected.commit,
    tree: expected.tree,
    descriptorDigest: staging.artifact.descriptorDigest,
    acceptanceContractDigest: staging.artifact.acceptanceContractDigest,
  });
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("arguments must be unique --name value pairs");
    }
    values.set(key, value);
  }
  for (const key of [
    "--predecessor-version",
    "--managed-predecessor-version",
    "--hosting-staging-receipt",
  ]) {
    if (!values.has(key)) {
      fail(`${key} is required`);
    }
  }
  return values;
}

function git(...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (git("status", "--porcelain=v1", "--untracked-files=normal")) {
    fail("source worktree is not clean");
  }
  const commit = git("rev-parse", "HEAD^{commit}");
  const tree = git("rev-parse", "HEAD^{tree}");
  const stagingBytes = readFileSync(path.resolve(args.get("--hosting-staging-receipt")));
  const evidence = validateHostingStagingReadiness(JSON.parse(stagingBytes.toString("utf8")), {
    commit,
    tree,
  });
  const predecessorVersion = args.get("--predecessor-version");
  const managedPredecessorVersion = args.get("--managed-predecessor-version");
  execFileSync(
    process.execPath,
    [path.join(scriptDir, "lifecycle-compatibility-inventory.mjs"), "--verify-git"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  for (const version of [predecessorVersion, managedPredecessorVersion]) {
    execFileSync(
      process.execPath,
      [path.join(scriptDir, "lifecycle-compatibility-inventory.mjs"), "--verify-release", version],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      role: "fased-pre-candidate-readiness",
      ...evidence,
      hostingStagingReceiptSha256: sha256(stagingBytes),
      predecessorVersion,
      managedPredecessorVersion,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
