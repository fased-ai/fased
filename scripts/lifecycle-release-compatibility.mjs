#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  digestAcceptanceContract,
  validateAcceptanceContract,
} from "./lifecycle-acceptance-contract.mjs";

export const RELEASE_COMPATIBILITY_ASSET = "fased-lifecycle-release-compatibility-v1.json";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INVENTORY = path.resolve(SCRIPT_DIR, "../config/lifecycle-compatibility.v1.json");
const DEFAULT_ACCEPTANCE = path.resolve(SCRIPT_DIR, "../config/lifecycle-acceptance.v2.json");
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const PUBLISHED_ACCEPTANCE_CONTRACT_IDS = Object.freeze([
  "public-local-lifecycle-v1",
  "public-lifecycle-v2",
]);

function fail(message) {
  throw new Error(`lifecycle release compatibility: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (
    Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .join(",") !== [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} fields are invalid`);
  }
}

export function buildReleaseCompatibility({
  repository,
  compatibilityGroupId,
  acceptanceContract,
  version,
  commit,
  tree,
}) {
  validateAcceptanceContract(acceptanceContract);
  return parseReleaseCompatibility(
    {
      schemaVersion: 1,
      role: "fased-public-lifecycle-compatibility",
      repository,
      release: { version, tag: `v${version}`, commit, tree },
      compatibilityGroupId,
      selectionBasis: "installed-topology-protocol-and-state-schema",
      runtimeConsumesReleaseIdentity: false,
      acceptanceContract: {
        id: acceptanceContract.contractId,
        digest: digestAcceptanceContract(acceptanceContract),
      },
    },
    { repository, compatibilityGroupIds: [compatibilityGroupId] },
  );
}

export function parseReleaseCompatibility(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "role",
      "repository",
      "release",
      "compatibilityGroupId",
      "selectionBasis",
      "runtimeConsumesReleaseIdentity",
      "acceptanceContract",
    ],
    "manifest",
  );
  exactKeys(value.release, ["version", "tag", "commit", "tree"], "release identity");
  exactKeys(value.acceptanceContract, ["id", "digest"], "acceptance contract identity");
  if (
    value.schemaVersion !== 1 ||
    value.role !== "fased-public-lifecycle-compatibility" ||
    typeof value.repository !== "string" ||
    (expected.repository && value.repository !== expected.repository) ||
    !VERSION_PATTERN.test(value.release.version || "") ||
    value.release.tag !== `v${value.release.version}` ||
    !COMMIT_PATTERN.test(value.release.commit || "") ||
    !COMMIT_PATTERN.test(value.release.tree || "") ||
    !GROUP_PATTERN.test(value.compatibilityGroupId || "") ||
    (expected.compatibilityGroupIds &&
      !expected.compatibilityGroupIds.includes(value.compatibilityGroupId)) ||
    value.selectionBasis !== "installed-topology-protocol-and-state-schema" ||
    value.runtimeConsumesReleaseIdentity !== false ||
    !PUBLISHED_ACCEPTANCE_CONTRACT_IDS.includes(value.acceptanceContract.id) ||
    !DIGEST_PATTERN.test(value.acceptanceContract.digest || "")
  ) {
    fail("manifest identity or selection contract is invalid");
  }
  for (const [key, expectedValue] of Object.entries(expected.release || {})) {
    if (expectedValue !== undefined && value.release[key] !== expectedValue) {
      fail(`release ${key} mismatch`);
    }
  }
  return value;
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "build") {
    const inventory = readJson(values.inventory || DEFAULT_INVENTORY, "inventory");
    const acceptanceContract = readJson(values.acceptance || DEFAULT_ACCEPTANCE, "acceptance");
    const groups = new Set((inventory.releaseGroups || []).map((group) => group?.id));
    if (!groups.has(inventory.currentReleaseGroupId)) {
      fail("current release compatibility group is missing from the inventory");
    }
    const manifest = buildReleaseCompatibility({
      repository: inventory.repository,
      compatibilityGroupId: inventory.currentReleaseGroupId,
      acceptanceContract,
      version: values.version,
      commit: values.commit,
      tree: values.tree,
    });
    writeFileSync(values.output, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    return;
  }
  if (command === "verify") {
    const inventory = readJson(values.inventory || DEFAULT_INVENTORY, "inventory");
    const manifest = parseReleaseCompatibility(readJson(values.manifest, "manifest"), {
      repository: inventory.repository,
      compatibilityGroupIds: (inventory.releaseGroups || []).map((group) => group.id),
      release: {
        version: values.version,
        tag: values.version ? `v${values.version}` : undefined,
        commit: values.commit,
        tree: values.tree,
      },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, release: manifest.release })}\n`);
    return;
  }
  fail(`unsupported command ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
