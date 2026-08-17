#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  digestPublishedAcceptanceContract,
  validatePublishedAcceptanceContract,
} from "./lifecycle-acceptance-contract.mjs";
import {
  RELEASE_COMPATIBILITY_ASSET,
  parseReleaseCompatibility,
} from "./lifecycle-release-compatibility.mjs";
import { parseCandidateDescriptor } from "./release-artifact-set.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_INVENTORY_PATH = path.join(
  DEFAULT_REPO_ROOT,
  "config",
  "lifecycle-compatibility.v1.json",
);
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const ACCEPTANCE_ASSET_PATTERN = /^fased-lifecycle-acceptance-v\d+\.json$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const PUBLIC_RELEASE_LIST_LIMIT = 1000;
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

function releaseAssignmentFromManifest(inventory, evidence) {
  const group = inventory.releaseGroups.find(({ id }) => id === evidence.groupId);
  if (!group) {
    fail(`release ${evidence.tag} references unknown compatibility group ${evidence.groupId}`);
  }
  return Object.freeze({
    tag: evidence.tag,
    commit: evidence.commit,
    groupId: group.id,
    evidence: group.evidence,
    localTopologies: group.localTopologies,
    hostingTopology: group.hostingTopology,
    interruptedLocalTopology: group.interruptedLocalTopology,
    interruptedHostingTopology: group.interruptedHostingTopology,
  });
}

export function candidateP1Scenarios(inventory, version, manifestedReleases = []) {
  validateLifecycleCompatibilityInventory(inventory);
  const normalized = String(version || "").replace(/^v/u, "");
  const tag = `v${normalized}`;
  const assignment =
    publishedReleaseAssignments(inventory).find((release) => release.tag === tag) ||
    manifestedReleases
      .filter((release) => release?.tag === tag)
      .map((release) => releaseAssignmentFromManifest(inventory, release))[0];
  if (!assignment) {
    fail(`predecessor v${normalized} has no compatibility assignment`);
  }
  const topologies = new Map(inventory.topologies.map((topology) => [topology.id, topology]));
  const scenarios = new Set();
  for (const topologyId of assignment.localTopologies) {
    const topology = topologies.get(topologyId);
    if (!topology || !String(topology.platformAdapter).startsWith("linux-")) {
      continue;
    }
    if (
      topology.forwardPath === "standard-local-bootstrap-once" ||
      topology.forwardPath === "ordinary-update"
    ) {
      scenarios.add("managed-update");
    } else {
      fail(
        `predecessor ${assignment.tag} has unsupported Local forward path ${topology.forwardPath}`,
      );
    }
  }
  if (scenarios.size === 0) {
    fail(`predecessor ${assignment.tag} has no supported Linux Local P1 topology`);
  }
  return [...scenarios].toSorted((left, right) => left.localeCompare(right));
}

export function verifyPublicReleaseCoverage(inventory, releases, manifestedReleases = []) {
  validateLifecycleCompatibilityInventory(inventory);
  if (!Array.isArray(releases)) {
    fail("public GitHub release response is invalid");
  }
  const publicReleases = releases.filter(
    (release) => release?.draft === false && TAG_PATTERN.test(release?.tag_name || ""),
  );
  const publicTags = new Set(publicReleases.map((release) => release.tag_name));
  if (publicTags.size !== publicReleases.length) {
    fail("public GitHub releases contain duplicate tags");
  }
  const sourceAssignments = publishedReleaseAssignments(inventory);
  const manifestedByTag = new Map();
  for (const evidence of manifestedReleases) {
    if (
      !evidence ||
      !TAG_PATTERN.test(evidence.tag || "") ||
      !COMMIT_PATTERN.test(evidence.commit || "") ||
      typeof evidence.groupId !== "string"
    ) {
      fail("public release manifest assignment is invalid");
    }
    releaseAssignmentFromManifest(inventory, evidence);
    if (manifestedByTag.has(evidence.tag)) {
      fail(`public release manifest repeats ${evidence.tag}`);
    }
    manifestedByTag.set(evidence.tag, evidence);
  }
  const sourceByTag = new Map(sourceAssignments.map((assignment) => [assignment.tag, assignment]));
  for (const [tag, evidence] of manifestedByTag) {
    const source = sourceByTag.get(tag);
    if (source && (source.commit !== evidence.commit || source.groupId !== evidence.groupId)) {
      fail(`public release manifest contradicts source evidence for ${tag}`);
    }
  }
  const assignedTags = new Set([...sourceByTag.keys(), ...manifestedByTag.keys()]);
  const unassigned = [...publicTags]
    .filter((tag) => !assignedTags.has(tag))
    .toSorted((left, right) => left.localeCompare(right));
  if (unassigned.length > 0) {
    fail(`unassigned public GitHub releases: ${unassigned.join(", ")}`);
  }
  const inventoryOnly = [...sourceByTag.keys()]
    .filter((tag) => !publicTags.has(tag))
    .toSorted((left, right) => left.localeCompare(right));
  if (inventoryOnly.length > 0) {
    fail(`inventory-only public releases: ${inventoryOnly.join(", ")}`);
  }
  const manifestedOnly = [...manifestedByTag.keys()]
    .filter((tag) => !publicTags.has(tag))
    .toSorted((left, right) => left.localeCompare(right));
  if (manifestedOnly.length > 0) {
    fail(`manifest-only public releases: ${manifestedOnly.join(", ")}`);
  }
  const ordered = publicReleases.toSorted((left, right) =>
    String(left.published_at || "").localeCompare(String(right.published_at || "")),
  );
  const latest = ordered.at(-1);
  if (!latest?.published_at) {
    fail("latest public GitHub release is missing");
  }
  const latestAssignment = sourceByTag.get(latest.tag_name) || manifestedByTag.get(latest.tag_name);
  if (!latestAssignment) {
    fail(`latest public GitHub release ${latest.tag_name} has no verified compatibility evidence`);
  }
  return Object.freeze({
    repository: inventory.repository,
    releaseCount: publicReleases.length,
    publishedThrough: Object.freeze({
      tag: latestAssignment.tag,
      commit: latestAssignment.commit,
    }),
  });
}

export function validateLifecycleCompatibilityInventory(inventory) {
  exactKeys(
    inventory,
    [
      "schemaVersion",
      "role",
      "repository",
      "currentReleaseGroupId",
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
  if (
    typeof inventory.currentReleaseGroupId !== "string" ||
    !groups.has(inventory.currentReleaseGroupId)
  ) {
    fail("current release compatibility group is missing");
  }
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

function readPublicGitHubReleases(repository, commandRunner = execFileSync) {
  const response = commandRunner(
    "gh",
    [
      "release",
      "list",
      "--repo",
      repository,
      "--limit",
      String(PUBLIC_RELEASE_LIST_LIMIT),
      "--json",
      "tagName,isDraft,publishedAt",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  let releases;
  try {
    releases = JSON.parse(response);
  } catch {
    fail("public GitHub release list response is invalid");
  }
  if (!Array.isArray(releases)) {
    fail("public GitHub release list response is invalid");
  }
  if (releases.length >= PUBLIC_RELEASE_LIST_LIMIT) {
    fail(`public GitHub release list reached ${PUBLIC_RELEASE_LIST_LIMIT}-result bound`);
  }
  return releases.map((release) => {
    exactKeys(release, ["tagName", "isDraft", "publishedAt"], "public GitHub release");
    if (
      typeof release.tagName !== "string" ||
      typeof release.isDraft !== "boolean" ||
      (release.publishedAt !== null &&
        (typeof release.publishedAt !== "string" ||
          !Number.isFinite(Date.parse(release.publishedAt)))) ||
      (!release.isDraft && release.publishedAt === null)
    ) {
      fail("public GitHub release metadata is invalid");
    }
    return {
      tag_name: release.tagName,
      draft: release.isDraft,
      published_at: release.publishedAt,
    };
  });
}

export function readDirectPublicGitHubRelease(repository, tag, commandRunner = execFileSync) {
  if (!TAG_PATTERN.test(tag || "")) {
    fail("cannot load compatibility evidence for an invalid public tag");
  }
  const response = commandRunner(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "tagName,isDraft,publishedAt"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  let metadata;
  try {
    metadata = JSON.parse(response);
  } catch {
    fail(`public GitHub release ${tag} response is invalid`);
  }
  exactKeys(metadata, ["tagName", "isDraft", "publishedAt"], `public GitHub release ${tag}`);
  if (metadata.tagName !== tag) {
    fail(`public GitHub release lookup returned ${String(metadata.tagName)}, expected ${tag}`);
  }
  if (metadata.isDraft !== false) {
    fail(`public GitHub release ${tag} is not a published release`);
  }
  if (
    typeof metadata.publishedAt !== "string" ||
    metadata.publishedAt.length === 0 ||
    !Number.isFinite(Date.parse(metadata.publishedAt))
  ) {
    fail(`public GitHub release ${tag} has invalid publication metadata`);
  }
  return Object.freeze({
    tag_name: metadata.tagName,
    draft: metadata.isDraft,
    published_at: metadata.publishedAt,
  });
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function readManifestedPublicRelease(inventory, release) {
  const tag = release?.tag_name;
  if (!TAG_PATTERN.test(tag || "")) {
    fail("cannot load compatibility evidence for an invalid public tag");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "fased-public-compatibility-"));
  const descriptorName = "fased-hosting-candidate.json";
  const descriptorAttestationName = `${descriptorName}.attestation.json`;
  try {
    const downloadArgs = [
      "release",
      "download",
      tag,
      "--repo",
      inventory.repository,
      "--dir",
      directory,
    ];
    for (const name of [
      descriptorName,
      descriptorAttestationName,
      RELEASE_COMPATIBILITY_ASSET,
      "fased-lifecycle-acceptance-v*.json",
    ]) {
      downloadArgs.push("--pattern", name);
    }
    execFileSync("gh", downloadArgs, { stdio: ["ignore", "ignore", "pipe"] });
    const descriptorPath = path.join(directory, descriptorName);
    const descriptorAttestationPath = path.join(directory, descriptorAttestationName);
    execFileSync(
      "gh",
      [
        "attestation",
        "verify",
        descriptorPath,
        "--repo",
        inventory.repository,
        "--bundle",
        descriptorAttestationPath,
        "--signer-workflow",
        "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
        "--source-ref",
        `refs/tags/${tag}`,
        "--deny-self-hosted-runners",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const descriptor = parseCandidateDescriptor(JSON.parse(readFileSync(descriptorPath, "utf8")), {
      version: tag.slice(1),
      sourceRef: `refs/tags/${tag}`,
    });
    const tagCommit = execFileSync(
      "gh",
      ["api", `repos/${inventory.repository}/git/ref/tags/${tag}`, "--jq", ".object.sha"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (tagCommit !== descriptor.commit) {
      fail(`public release tag ${tag} does not point at its candidate commit`);
    }
    const compatibilityIdentity = descriptor.artifacts.find(
      ({ name }) => name === RELEASE_COMPATIBILITY_ASSET,
    );
    const compatibilityPath = path.join(directory, RELEASE_COMPATIBILITY_ASSET);
    if (
      !compatibilityIdentity ||
      statSync(compatibilityPath).size !== compatibilityIdentity.size ||
      sha256File(compatibilityPath) !== compatibilityIdentity.sha256
    ) {
      fail(`public release ${tag} has unbound ${RELEASE_COMPATIBILITY_ASSET}`);
    }
    const compatibility = parseReleaseCompatibility(
      JSON.parse(readFileSync(compatibilityPath, "utf8")),
      {
        repository: inventory.repository,
        compatibilityGroupIds: inventory.releaseGroups.map((group) => group.id),
        release: {
          version: descriptor.version,
          tag,
          commit: descriptor.commit,
          tree: descriptor.tree,
        },
      },
    );
    const acceptanceArtifacts = descriptor.artifacts.filter(({ name }) =>
      ACCEPTANCE_ASSET_PATTERN.test(name),
    );
    if (acceptanceArtifacts.length !== 1) {
      fail(`public release ${tag} must bind exactly one acceptance contract`);
    }
    const acceptanceIdentity = acceptanceArtifacts[0];
    const acceptancePath = path.join(directory, acceptanceIdentity.name);
    if (
      statSync(acceptancePath).size !== acceptanceIdentity.size ||
      sha256File(acceptancePath) !== acceptanceIdentity.sha256
    ) {
      fail(`public release ${tag} has an unbound acceptance contract`);
    }
    const acceptanceContract = validatePublishedAcceptanceContract(
      JSON.parse(readFileSync(acceptancePath, "utf8")),
    );
    if (
      compatibility.acceptanceContract.id !== acceptanceContract.contractId ||
      compatibility.acceptanceContract.digest !==
        digestPublishedAcceptanceContract(acceptanceContract)
    ) {
      fail(`public release ${tag} compatibility evidence has the wrong acceptance contract`);
    }
    return Object.freeze({
      tag,
      commit: descriptor.commit,
      groupId: compatibility.compatibilityGroupId,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readManifestedPublicReleases(inventory, releases) {
  const sourceTags = new Set(publishedReleaseAssignments(inventory).map(({ tag }) => tag));
  return releases
    .filter(
      (release) =>
        release?.draft === false &&
        TAG_PATTERN.test(release?.tag_name || "") &&
        !sourceTags.has(release.tag_name),
    )
    .map((release) => readManifestedPublicRelease(inventory, release));
}

function main() {
  const args = process.argv.slice(2);
  const inventory = loadLifecycleCompatibilityInventory();
  let evidence;
  if (args.length === 0) {
    evidence = {
      repository: inventory.repository,
      releaseCount: inventory.publishedReleaseCount,
      releaseGroupCount: inventory.releaseGroups.length,
      publishedThrough: inventory.publishedThrough,
    };
  } else if (args.length === 1 && args[0] === "--verify-git") {
    evidence = verifyGitReleaseEvidence(inventory);
  } else if (args.length === 1 && args[0] === "--verify-public-github") {
    const releases = readPublicGitHubReleases(inventory.repository);
    evidence = verifyPublicReleaseCoverage(
      inventory,
      releases,
      readManifestedPublicReleases(inventory, releases),
    );
  } else if (args.length === 2 && args[0] === "--p1-scenarios") {
    const tag = `v${String(args[1]).replace(/^v/u, "")}`;
    const sourceAssigned = publishedReleaseAssignments(inventory).some(
      (release) => release.tag === tag,
    );
    let manifestedReleases = [];
    if (!sourceAssigned) {
      manifestedReleases = readManifestedPublicReleases(inventory, [
        readDirectPublicGitHubRelease(inventory.repository, tag),
      ]);
    }
    process.stdout.write(
      `${candidateP1Scenarios(inventory, args[1], manifestedReleases).join(",")}\n`,
    );
    return;
  } else {
    fail(`unsupported arguments ${args.join(" ")}`);
  }
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
  readDirectPublicGitHubRelease,
  readPublicGitHubReleases,
});
