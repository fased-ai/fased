#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(`Hosting staging receipt: ${message}`);
}

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function argsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      fail("arguments must be unique --name value pairs");
    }
    result.set(key, value);
  }
  return result;
}

function parseMemoryEvents(data) {
  const values = new Map();
  for (const line of data.trim().split("\n")) {
    const [key, value, ...trailing] = line.trim().split(/\s+/u);
    if (!key || !/^[0-9]+$/u.test(value || "") || trailing.length !== 0 || values.has(key)) {
      fail("memory.events is malformed");
    }
    values.set(key, Number(value));
  }
  return values;
}

export function issueHostingStagingReceipt({
  descriptor,
  acceptanceContract,
  installOutput,
  retryOutput,
  memoryEvents,
  memoryPeakBytes,
  memoryLimitBytes,
  swapLimitBytes,
  initialSystemSwapBytes,
  finalSystemSwapBytes,
  managedSwapActive,
  managedSwapPersistent,
}) {
  const identity = JSON.parse(descriptor.toString("utf8"));
  const commit = identity.commit;
  const tree = identity.tree;
  const version = identity.version;
  const events = parseMemoryEvents(memoryEvents.toString("utf8"));
  if (
    !commitPattern.test(commit || "") ||
    !commitPattern.test(tree || "") ||
    typeof version !== "string" ||
    !Number.isSafeInteger(memoryPeakBytes) ||
    memoryPeakBytes <= 0 ||
    memoryLimitBytes !== 2147483648 ||
    swapLimitBytes !== 2147483648 ||
    initialSystemSwapBytes !== 0 ||
    !Number.isSafeInteger(finalSystemSwapBytes) ||
    finalSystemSwapBytes < 2147483648 ||
    managedSwapActive !== true ||
    managedSwapPersistent !== true ||
    (events.get("oom_kill") || 0) !== 0 ||
    (events.get("oom") || 0) !== 0
  ) {
    fail("identity or 2 GB no-swap resource evidence is invalid");
  }
  if (!installOutput.toString("utf8").includes(`Updated successfully: ${version}`)) {
    fail("literal unpublished install did not complete");
  }
  if (!retryOutput.toString("utf8").includes(`Already current: ${version}`)) {
    fail("identical staging command did not return Already current");
  }
  return Object.freeze({
    schemaVersion: 1,
    role: "fased-hosting-staging-vps-acceptance",
    status: "PASS",
    evidenceClass: "PASS",
    environmentClass: "hosting-staging-vps",
    source: { commit, tree },
    artifact: {
      descriptorDigest: sha256(descriptor),
      acceptanceContractDigest: sha256(acceptanceContract),
    },
    literalPublicInstall: { status: "PASS", evidenceDigest: sha256(installOutput) },
    identicalRetry: {
      status: "PASS",
      outcome: "ALREADY_CURRENT",
      evidenceDigest: sha256(retryOutput),
    },
    resources: {
      memoryLimitBytes,
      swapLimitBytes,
      memoryPeakBytes,
      oomKill: events.get("oom_kill") || 0,
      memoryEventsDigest: sha256(memoryEvents),
      initialSystemSwapBytes,
      finalSystemSwapBytes,
      managedSwapActive,
      managedSwapPersistent,
    },
  });
}

function main() {
  const args = argsMap(process.argv.slice(2));
  for (const key of [
    "--descriptor",
    "--acceptance-contract",
    "--install-output",
    "--retry-output",
    "--memory-events",
    "--memory-peak-bytes",
    "--memory-limit-bytes",
    "--swap-limit-bytes",
    "--initial-system-swap-bytes",
    "--final-system-swap-bytes",
    "--managed-swap-active",
    "--managed-swap-persistent",
    "--output",
  ]) {
    if (!args.has(key)) {
      fail(`${key} is required`);
    }
  }
  const receipt = issueHostingStagingReceipt({
    descriptor: readFileSync(path.resolve(args.get("--descriptor"))),
    acceptanceContract: readFileSync(path.resolve(args.get("--acceptance-contract"))),
    installOutput: readFileSync(path.resolve(args.get("--install-output"))),
    retryOutput: readFileSync(path.resolve(args.get("--retry-output"))),
    memoryEvents: readFileSync(path.resolve(args.get("--memory-events"))),
    memoryPeakBytes: Number(args.get("--memory-peak-bytes")),
    memoryLimitBytes: Number(args.get("--memory-limit-bytes")),
    swapLimitBytes: Number(args.get("--swap-limit-bytes")),
    initialSystemSwapBytes: Number(args.get("--initial-system-swap-bytes")),
    finalSystemSwapBytes: Number(args.get("--final-system-swap-bytes")),
    managedSwapActive: args.get("--managed-swap-active") === "true",
    managedSwapPersistent: args.get("--managed-swap-persistent") === "true",
  });
  if (!digestPattern.test(receipt.artifact.descriptorDigest)) {
    fail("descriptor digest is invalid");
  }
  writeFileSync(path.resolve(args.get("--output")), `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
