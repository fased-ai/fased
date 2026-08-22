#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const readinessGatePaths = new Set([
  "scripts/pre-candidate-readiness.mjs",
  "scripts/pre-candidate-readiness.test.ts",
]);

function fail(message) {
  throw new Error(`pre-candidate readiness: ${message}`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireLiteralUserEvidence(child, profile) {
  if (!child || child.profile !== profile || child.scenario !== "fresh-install") {
    fail(`${profile} fresh-install receipt is missing`);
  }
  const evidence = new Map((child.evidence || []).map((record) => [record.id, record]));
  for (const id of ["updater-already-current"]) {
    const record = evidence.get(id);
    if (!record || record.status !== "PASS" || !digestPattern.test(record.evidenceDigest || "")) {
      fail(`${profile} fresh-install does not prove ${id}`);
    }
  }
}

function requireHostingStagingEvidence(staging, expected) {
  if (
    staging?.schemaVersion !== 1 ||
    staging?.role !== "fased-hosting-staging-vps-acceptance" ||
    staging?.status !== "PASS" ||
    staging?.evidenceClass !== "PASS" ||
    staging?.environmentClass !== "hosting-staging-vps" ||
    staging?.source?.commit !== expected.commit ||
    staging?.source?.tree !== expected.tree ||
    staging?.artifact?.descriptorDigest !== expected.descriptorDigest ||
    staging?.artifact?.acceptanceContractDigest !== expected.acceptanceContractDigest ||
    staging?.literalPublicInstall?.status !== "PASS" ||
    !digestPattern.test(staging?.literalPublicInstall?.evidenceDigest || "") ||
    staging?.identicalRetry?.status !== "PASS" ||
    staging?.identicalRetry?.outcome !== "ALREADY_CURRENT" ||
    !digestPattern.test(staging?.identicalRetry?.evidenceDigest || "") ||
    staging?.resources?.memoryLimitBytes !== 2147483648 ||
    staging?.resources?.swapLimitBytes !== 2147483648 ||
    staging?.resources?.oomKill !== 0 ||
    !Number.isSafeInteger(staging?.resources?.memoryPeakBytes) ||
    staging.resources.memoryPeakBytes <= 0
  ) {
    fail("exact unpublished Hosting staging-VPS acceptance is missing or invalid");
  }
}

export function validateLocal0Readiness(receipt, expected) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.role !== "fased-local0-receipt" ||
    receipt?.status !== "PASS" ||
    receipt?.mode !== "all" ||
    receipt?.phase !== "complete" ||
    receipt?.completeLocal0 !== true ||
    receipt?.failedLane !== null
  ) {
    fail("LOCAL0 receipt is not one complete PASS");
  }
  if (
    !commitPattern.test(receipt.source?.commit || "") ||
    receipt.source?.tree !== expected.receiptCommitTree ||
    (receipt.source.commit === expected.commit && receipt.source.tree !== expected.tree) ||
    expected.unexpectedSourcePaths.length !== 0 ||
    receipt.source?.lockfileDigest !== expected.lockfileDigest
  ) {
    fail("LOCAL0 receipt does not bind the exact source identity");
  }
  if (
    receipt.entrypoints?.local !== expected.localEntrypointDigest ||
    receipt.entrypoints?.hosting !== expected.hostingEntrypointDigest
  ) {
    fail("LOCAL0 receipt does not bind the current literal-user entrypoints");
  }
  if (
    !digestPattern.test(receipt.artifact?.descriptorDigest || "") ||
    !digestPattern.test(receipt.artifact?.acceptanceContractDigest || "")
  ) {
    fail("LOCAL0 receipt does not bind its candidate and acceptance contract");
  }
  if (!Array.isArray(receipt.receipts) || receipt.receipts.length < 5) {
    fail("LOCAL0 receipt set is incomplete");
  }
  const children = receipt.receipts.map((record) => record?.receipt).filter(Boolean);
  for (const child of children) {
    if (child.profile === "hosting") {
      if (child.evidenceClass !== "SUPPORTING") {
        fail("LOCAL0 Hosting container evidence must remain SUPPORTING");
      }
    } else if (child.evidenceClass !== "PASS") {
      fail("LOCAL0 contains a non-passing child receipt");
    }
  }
  requireLiteralUserEvidence(
    children.find(
      (child) => child.profile === "protected-local" && child.scenario === "fresh-install",
    ),
    "protected-local",
  );
  requireLiteralUserEvidence(
    children.find((child) => child.profile === "hosting" && child.scenario === "fresh-install"),
    "hosting",
  );
  requireHostingStagingEvidence(expected.hostingStagingReceipt, {
    commit: expected.commit,
    tree: expected.tree,
    descriptorDigest: receipt.artifact.descriptorDigest,
    acceptanceContractDigest: receipt.artifact.acceptanceContractDigest,
  });
  return Object.freeze({
    commit: expected.commit,
    tree: expected.tree,
    local0SourceCommit: receipt.source.commit,
    local0SourceTree: receipt.source.tree,
    lockfileDigest: expected.lockfileDigest,
    localEntrypointDigest: expected.localEntrypointDigest,
    hostingEntrypointDigest: expected.hostingEntrypointDigest,
    descriptorDigest: receipt.artifact.descriptorDigest,
    acceptanceContractDigest: receipt.artifact.acceptanceContractDigest,
    hostingStagingReceiptDigest: expected.hostingStagingReceiptDigest,
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
    "--local0-receipt",
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
  const receiptPath = path.resolve(args.get("--local0-receipt"));
  const receiptBytes = readFileSync(receiptPath);
  const commit = git("rev-parse", "HEAD^{commit}");
  const tree = git("rev-parse", "HEAD^{tree}");
  const lockfileDigest = sha256(readFileSync(path.join(repoRoot, "pnpm-lock.yaml")));
  const localEntrypointDigest = sha256(
    readFileSync(path.join(scriptDir, "test-lifecycle-local-acceptance.sh")),
  );
  const hostingEntrypointDigest = sha256(
    readFileSync(path.join(scriptDir, "test-lifecycle-hosting-acceptance.sh")),
  );
  const status = git("status", "--porcelain=v1", "--untracked-files=normal");
  if (status) {
    fail("source worktree is not clean");
  }
  const identityKey = `${commit}-${tree}-${lockfileDigest.slice("sha256:".length)}`;
  const cacheRoot =
    process.env.FASED_LOCAL0_CACHE_DIR ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "fased-dev",
      "local0",
    );
  const failureMarker = path.join(cacheRoot, "failures", `${identityKey}.json`);
  if (existsSync(failureMarker)) {
    fail(`unresolved exact-source LOCAL0 failure remains at ${failureMarker}`);
  }
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const hostingStagingReceiptBytes = readFileSync(args.get("--hosting-staging-receipt"));
  const hostingStagingReceipt = JSON.parse(hostingStagingReceiptBytes.toString("utf8"));
  const receiptCommit = receipt.source?.commit;
  if (!commitPattern.test(receiptCommit || "")) {
    fail("LOCAL0 receipt source commit is invalid");
  }
  let receiptCommitTree;
  try {
    receiptCommitTree = git("rev-parse", `${receiptCommit}^{tree}`);
  } catch {
    fail("LOCAL0 receipt source commit is unavailable");
  }
  const unexpectedSourcePaths =
    receiptCommitTree === tree
      ? []
      : git("diff", "--name-only", "--no-renames", receiptCommit, commit)
          .split("\n")
          .filter(Boolean)
          .filter((sourcePath) => !readinessGatePaths.has(sourcePath));
  const evidence = validateLocal0Readiness(receipt, {
    commit,
    tree,
    receiptCommitTree,
    unexpectedSourcePaths,
    lockfileDigest,
    localEntrypointDigest,
    hostingEntrypointDigest,
    hostingStagingReceipt,
    hostingStagingReceiptDigest: sha256(hostingStagingReceiptBytes),
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
      role: "fased-pre-candidate-local-readiness",
      local0ReceiptSha256: sha256(receiptBytes),
      ...evidence,
      predecessorVersion,
      managedPredecessorVersion,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
