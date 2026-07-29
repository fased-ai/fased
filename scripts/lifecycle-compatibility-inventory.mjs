#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_INVENTORY_PATH = path.join(
  DEFAULT_REPO_ROOT,
  "config",
  "lifecycle-compatibility.v1.json",
);
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const RUNTIME_SELECTION_FIELDS = Object.freeze([
  "profile",
  "platformAdapter",
  "serviceTopology",
  "updaterProtocol",
  "controllerProtocol",
  "signerProtocol",
  "declaredStateRegistry",
  "stateSchemas",
  "interruptedTransaction",
]);
const RELEASE_EVIDENCE_FIELDS = Object.freeze(["tag", "commit"]);
const REQUIRED_TOPOLOGY_CLASSES = Object.freeze([
  "local-legacy-same-user-v0",
  "local-user-systemd-managed-v1",
  "local-user-systemd-managed-v2",
  "local-darwin-legacy-v0",
  "local-darwin-managed-v1",
  "local-darwin-managed-v2",
  "protected-local-controller-v2",
  "protected-local-controller-v2-interrupted",
  "protected-local-supervisor-v1",
  "hosting-root-gateway-v0",
  "hosting-controller-v2-static",
  "hosting-controller-v2-self-updating",
  "hosting-controller-v2-interrupted",
  "hosting-supervisor-v1",
]);

function fail(message) {
  throw new Error(`lifecycle compatibility inventory: ${message}`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (
    !isRecord(value) ||
    Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .join(",") !== [...keys].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} fields are invalid`);
  }
}

function exactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} is invalid`);
  }
}

function uniqueRecords(records, label) {
  if (!Array.isArray(records) || records.length === 0) {
    fail(`${label} is empty`);
  }
  const byId = new Map();
  for (const record of records) {
    if (!isRecord(record) || typeof record.id !== "string" || !record.id) {
      fail(`${label} contains an invalid ID`);
    }
    if (byId.has(record.id)) {
      fail(`${label} repeats ${record.id}`);
    }
    byId.set(record.id, record);
  }
  return byId;
}

function validateSupportFloor(value, forwardPathIds) {
  exactKeys(value, ["basis", "unknownOrAmbiguousTuple", "local", "hosting"], "support floor");
  if (
    value.basis !== "installed-topology-protocol-and-state-schema" ||
    value.unknownOrAmbiguousTuple !== "unsupported-fail-before-mutation"
  ) {
    fail("support floor is not topology based or fail closed");
  }
  exactKeys(
    value.local,
    ["preHandoff", "managedDarwin", "protectedControllerV2", "supervisorV1"],
    "Local support floor",
  );
  exactKeys(
    value.hosting,
    ["noTrustedForwardAuthority", "staticControllerV2", "selfUpdatingControllerV2", "supervisorV1"],
    "Hosting support floor",
  );
  const supportFloorEntries = [
    { label: "Local support floor", entries: Object.values(value.local) },
    { label: "Hosting support floor", entries: Object.values(value.hosting) },
  ];
  for (const { label, entries } of supportFloorEntries) {
    for (const forwardPath of entries) {
      if (typeof forwardPath !== "string" || !forwardPathIds.has(forwardPath)) {
        fail(`${label} references unknown forward path ${String(forwardPath)}`);
      }
    }
  }
}

export function publishedReleaseAssignments(inventory) {
  return inventory.releaseGroups.flatMap((group) =>
    group.releases.map((release) =>
      Object.freeze({
        ...release,
        groupId: group.id,
        evidence: group.evidence,
        localTopologies: group.localTopologies,
        hostingTopology: group.hostingTopology,
        interruptedLocalTopology: group.interruptedLocalTopology,
        interruptedHostingTopology: group.interruptedHostingTopology,
      }),
    ),
  );
}

export function validateLifecycleCompatibilityInventory(inventory) {
  exactKeys(
    inventory,
    [
      "schemaVersion",
      "role",
      "repository",
      "publishedThrough",
      "publishedReleaseCount",
      "selectionContract",
      "supportFloor",
      "forwardPaths",
      "adapters",
      "topologies",
      "releaseGroups",
    ],
    "top level",
  );
  if (
    inventory.schemaVersion !== 1 ||
    inventory.role !== "fased-lifecycle-compatibility-evidence" ||
    inventory.repository !== "fased-ai/fased" ||
    !Number.isSafeInteger(inventory.publishedReleaseCount) ||
    inventory.publishedReleaseCount < 1
  ) {
    fail("top-level identity is invalid");
  }
  exactKeys(inventory.publishedThrough, ["tag", "commit"], "published-through identity");
  if (
    !TAG_PATTERN.test(inventory.publishedThrough.tag) ||
    !COMMIT_PATTERN.test(inventory.publishedThrough.commit)
  ) {
    fail("published-through identity is invalid");
  }

  exactKeys(
    inventory.selectionContract,
    ["runtimeConsumesReleaseAssignments", "runtimeSelectionFields", "releaseEvidenceFields"],
    "selection contract",
  );
  if (inventory.selectionContract.runtimeConsumesReleaseAssignments !== false) {
    fail("runtime must not consume historical release assignments");
  }
  exactStringArray(
    inventory.selectionContract.runtimeSelectionFields,
    RUNTIME_SELECTION_FIELDS,
    "runtime selection fields",
  );
  exactStringArray(
    inventory.selectionContract.releaseEvidenceFields,
    RELEASE_EVIDENCE_FIELDS,
    "release evidence fields",
  );
  if (
    inventory.selectionContract.runtimeSelectionFields.some((field) =>
      inventory.selectionContract.releaseEvidenceFields.includes(field),
    )
  ) {
    fail("release evidence leaked into runtime selection");
  }

  const forwardPaths = uniqueRecords(inventory.forwardPaths, "forward paths");
  for (const forwardPath of forwardPaths.values()) {
    exactKeys(
      forwardPath,
      ["id", "support", "entryPoint", "authorization"],
      `forward path ${forwardPath.id}`,
    );
    if (
      !["supported", "supported-with-one-bootstrap", "unsupported"].includes(forwardPath.support)
    ) {
      fail(`forward path ${forwardPath.id} has invalid support`);
    }
  }
  validateSupportFloor(inventory.supportFloor, new Set(forwardPaths.keys()));

  const adapters = uniqueRecords(inventory.adapters, "adapters");
  for (const adapter of adapters.values()) {
    exactKeys(
      adapter,
      ["id", "owner", "dimension", "input", "output", "status", "runtimeSelected"],
      `adapter ${adapter.id}`,
    );
    if (
      typeof adapter.owner !== "string" ||
      typeof adapter.dimension !== "string" ||
      adapter.status !== "implemented" ||
      typeof adapter.runtimeSelected !== "boolean"
    ) {
      fail(`adapter ${adapter.id} is not an implemented explicit adapter`);
    }
  }

  const topologies = uniqueRecords(inventory.topologies, "topologies");
  for (const required of REQUIRED_TOPOLOGY_CLASSES) {
    if (!topologies.has(required)) {
      fail(`required topology ${required} is missing`);
    }
  }
  for (const topology of topologies.values()) {
    exactKeys(
      topology,
      [
        "id",
        "baseTopology",
        "profile",
        "platformAdapter",
        "serviceTopology",
        "updaterProtocol",
        "supervisorProtocol",
        "controllerProtocol",
        "controllerCapabilities",
        "signerProtocol",
        "declaredStateRegistry",
        "stateSchemas",
        "interruptedTransaction",
        "forwardPath",
        "adapterIds",
        "published",
      ],
      `topology ${topology.id}`,
    );
    if (
      !["local", "protected-local", "hosting"].includes(topology.profile) ||
      typeof topology.platformAdapter !== "string" ||
      typeof topology.serviceTopology !== "string" ||
      !Array.isArray(topology.controllerCapabilities) ||
      !isRecord(topology.stateSchemas) ||
      typeof topology.interruptedTransaction !== "string" ||
      typeof topology.published !== "boolean"
    ) {
      fail(`topology ${topology.id} is malformed`);
    }
    if (topology.baseTopology !== null && !topologies.has(topology.baseTopology)) {
      fail(`topology ${topology.id} has unknown base ${topology.baseTopology}`);
    }
    if (!forwardPaths.has(topology.forwardPath)) {
      fail(`topology ${topology.id} has unknown forward path ${topology.forwardPath}`);
    }
    if (!Array.isArray(topology.adapterIds)) {
      fail(`topology ${topology.id} adapter list is invalid`);
    }
    for (const adapterId of topology.adapterIds) {
      if (!adapters.has(adapterId)) {
        fail(`topology ${topology.id} references unknown adapter ${adapterId}`);
      }
    }
  }

  const groups = uniqueRecords(inventory.releaseGroups, "release groups");
  const referencedPublishedTopologies = new Set();
  const releases = [];
  const tags = new Set();
  for (const group of groups.values()) {
    exactKeys(
      group,
      [
        "id",
        "evidence",
        "localTopologies",
        "hostingTopology",
        "interruptedLocalTopology",
        "interruptedHostingTopology",
        "releases",
      ],
      `release group ${group.id}`,
    );
    exactKeys(
      group.evidence,
      [
        "managedUpdater",
        "hostedArtifactInstaller",
        "managedInstallSchema",
        "hostController",
        "hostControllerProtocol",
        "hostControllerCanUpdate",
        "protectedLocalBootstrap",
      ],
      `release group ${group.id} evidence`,
    );
    if (!Array.isArray(group.localTopologies) || group.localTopologies.length === 0) {
      fail(`release group ${group.id} has no Local topology`);
    }
    if (
      (group.evidence.hostedArtifactInstaller === true &&
        typeof group.hostingTopology !== "string") ||
      (group.evidence.hostedArtifactInstaller === false && group.hostingTopology !== null)
    ) {
      fail(`release group ${group.id} Hosting topology contradicts its installer evidence`);
    }
    for (const topologyId of [
      ...group.localTopologies,
      group.hostingTopology,
      group.interruptedLocalTopology,
      group.interruptedHostingTopology,
    ].filter(Boolean)) {
      const topology = topologies.get(topologyId);
      if (!topology) {
        fail(`release group ${group.id} references unknown topology ${topologyId}`);
      }
      if (topology.published) {
        referencedPublishedTopologies.add(topologyId);
      }
    }
    if (!Array.isArray(group.releases) || group.releases.length === 0) {
      fail(`release group ${group.id} has no published releases`);
    }
    for (const release of group.releases) {
      exactKeys(release, ["tag", "commit"], `release in group ${group.id}`);
      if (!TAG_PATTERN.test(release.tag) || !COMMIT_PATTERN.test(release.commit)) {
        fail(`release ${release.tag || "<unknown>"} has invalid identity`);
      }
      if (tags.has(release.tag)) {
        fail(`release ${release.tag} is assigned more than once`);
      }
      tags.add(release.tag);
      releases.push(release);
    }
  }
  for (const topology of topologies.values()) {
    if (topology.published && !referencedPublishedTopologies.has(topology.id)) {
      fail(`published topology ${topology.id} has no release evidence`);
    }
  }
  if (releases.length !== inventory.publishedReleaseCount) {
    fail(
      `published release count is ${releases.length}, expected ${inventory.publishedReleaseCount}`,
    );
  }
  const publishedThrough = releases.find(
    (release) => release.tag === inventory.publishedThrough.tag,
  );
  if (!publishedThrough || publishedThrough.commit !== inventory.publishedThrough.commit) {
    fail("published-through release is missing or mismatched");
  }
  const runtimeAdapters = new Set(
    [...adapters.values()]
      .filter((adapter) => adapter.runtimeSelected)
      .map((adapter) => adapter.id),
  );
  const targetAdapterIds = new Set(
    [...topologies.values()]
      .filter((topology) => topology.supervisorProtocol === 1)
      .flatMap((topology) => topology.adapterIds),
  );
  for (const adapterId of runtimeAdapters) {
    if (!targetAdapterIds.has(adapterId)) {
      fail(`runtime adapter ${adapterId} is not bound to a supervisor target topology`);
    }
  }
  return inventory;
}

export function loadLifecycleCompatibilityInventory(filePath = DEFAULT_INVENTORY_PATH) {
  const inventory = JSON.parse(readFileSync(filePath, "utf8"));
  return validateLifecycleCompatibilityInventory(inventory);
}

function gitFileExists(repoRoot, ref, filePath) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${filePath}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function readGitFile(repoRoot, ref, filePath) {
  return execFileSync("git", ["show", `${ref}:${filePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function managedInstallSchemaAt(repoRoot, ref) {
  if (!gitFileExists(repoRoot, ref, "scripts/managed-runtime-layout.mjs")) {
    return null;
  }
  const source = readGitFile(repoRoot, ref, "scripts/managed-runtime-layout.mjs");
  const match = /MANAGED_INSTALL_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(source);
  return match ? Number(match[1]) : null;
}

export function verifyGitReleaseEvidence(inventory, repoRoot = DEFAULT_REPO_ROOT) {
  validateLifecycleCompatibilityInventory(inventory);
  const checkedGroups = new Set();
  for (const assignment of publishedReleaseAssignments(inventory)) {
    const actualCommit = execFileSync("git", ["rev-parse", `${assignment.tag}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (actualCommit !== assignment.commit) {
      fail(`release ${assignment.tag} resolves to ${actualCommit}, expected ${assignment.commit}`);
    }
    if (checkedGroups.has(assignment.groupId)) {
      continue;
    }
    checkedGroups.add(assignment.groupId);
    const evidence = assignment.evidence;
    const checks = [
      [
        "managed updater",
        gitFileExists(repoRoot, assignment.tag, "scripts/fased-managed-updater.mjs"),
        evidence.managedUpdater,
      ],
      [
        "hosted artifact installer",
        gitFileExists(repoRoot, assignment.tag, "scripts/install-hosted-runtime.sh"),
        evidence.hostedArtifactInstaller,
      ],
      [
        "host controller",
        gitFileExists(repoRoot, assignment.tag, "scripts/fased-host-updater.mjs"),
        evidence.hostController,
      ],
      [
        "Protected Local bootstrap",
        gitFileExists(repoRoot, assignment.tag, "scripts/protected-local-bootstrap.mjs"),
        evidence.protectedLocalBootstrap,
      ],
    ];
    for (const [label, actual, expected] of checks) {
      if (actual !== expected) {
        fail(`${assignment.groupId} ${label} evidence is ${actual}, expected ${expected}`);
      }
    }
    const managedInstallSchema = managedInstallSchemaAt(repoRoot, assignment.tag);
    if (managedInstallSchema !== evidence.managedInstallSchema) {
      fail(
        `${assignment.groupId} managed install schema is ${managedInstallSchema}, expected ${evidence.managedInstallSchema}`,
      );
    }
    if (evidence.hostController) {
      const source = readGitFile(repoRoot, assignment.tag, "scripts/fased-host-updater.mjs");
      const protocolMatch = /PROTOCOL_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(source);
      const protocol = protocolMatch ? Number(protocolMatch[1]) : null;
      if (protocol !== evidence.hostControllerProtocol) {
        fail(
          `${assignment.groupId} host controller protocol is ${protocol}, expected ${evidence.hostControllerProtocol}`,
        );
      }
      const canUpdate = /["']updateController["']/u.test(source);
      if (canUpdate !== evidence.hostControllerCanUpdate) {
        fail(
          `${assignment.groupId} updateController evidence is ${canUpdate}, expected ${evidence.hostControllerCanUpdate}`,
        );
      }
    } else if (
      evidence.hostControllerProtocol !== null ||
      evidence.hostControllerCanUpdate !== false
    ) {
      fail(`${assignment.groupId} declares capabilities for an absent host controller`);
    }
  }
  return Object.freeze({
    repository: inventory.repository,
    releaseCount: inventory.publishedReleaseCount,
    releaseGroupCount: inventory.releaseGroups.length,
    publishedThrough: inventory.publishedThrough,
  });
}

function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--verify-git") {
      fail(`unsupported argument ${arg}`);
    }
  }
  const inventory = loadLifecycleCompatibilityInventory();
  const evidence = args.has("--verify-git")
    ? verifyGitReleaseEvidence(inventory)
    : {
        repository: inventory.repository,
        releaseCount: inventory.publishedReleaseCount,
        releaseGroupCount: inventory.releaseGroups.length,
        publishedThrough: inventory.publishedThrough,
      };
  process.stdout.write(`${JSON.stringify({ ok: true, ...evidence })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export const __testing = Object.freeze({
  DEFAULT_INVENTORY_PATH,
  RELEASE_EVIDENCE_FIELDS,
  REQUIRED_TOPOLOGY_CLASSES,
  RUNTIME_SELECTION_FIELDS,
});
