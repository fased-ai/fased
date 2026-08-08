import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { __testing as updaterTesting } from "./fased-host-updater.mjs";
import {
  __testing,
  candidateP1Scenarios,
  loadLifecycleCompatibilityInventory,
  publishedReleaseAssignments,
  verifyPublicReleaseCoverage,
  validateLifecycleCompatibilityInventory,
} from "./lifecycle-compatibility-inventory.mjs";

function cloneInventory() {
  return JSON.parse(readFileSync(__testing.DEFAULT_INVENTORY_PATH, "utf8"));
}

function nestedKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => nestedKeys(entry));
  }
  return Object.entries(value).flatMap(([key, entry]) => [key, ...nestedKeys(entry)]);
}

function currentProtectedTopology() {
  return {
    schemaVersion: 1,
    profile: "protected-local",
    managedApplication: true,
    capabilities: {
      lifecycleControllerProtocol: 2,
      signerProtocol: { current: 2, min: 2, max: 2 },
      declaredStateRegistry: 1,
    },
    stateSchemas: {
      managedInstall: 2,
      walletRegistry: 1,
      signer: 2,
      mining: 1,
      federation: 2,
    },
  };
}

describe("lifecycle compatibility inventory", () => {
  it("accounts for every published release and every material topology class", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const assignments = publishedReleaseAssignments(inventory);

    expect(inventory.publishedReleaseCount).toBe(110);
    expect(inventory.releaseGroups).toHaveLength(7);
    expect(assignments).toHaveLength(110);
    expect(new Set(assignments.map(({ tag }) => tag)).size).toBe(110);
    expect(inventory.topologies.map(({ id }) => id)).toEqual(
      expect.arrayContaining(__testing.REQUIRED_TOPOLOGY_CLASSES),
    );
    expect(assignments.at(-1)).toMatchObject(inventory.publishedThrough);
  });

  it("requires every public GitHub release in the compatibility inventory", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const releases = publishedReleaseAssignments(inventory).map(({ tag }, index) => ({
      tag_name: tag,
      draft: false,
      published_at: new Date(index * 1000).toISOString(),
    }));
    expect(verifyPublicReleaseCoverage(inventory, releases)).toMatchObject({
      releaseCount: inventory.publishedReleaseCount,
      publishedThrough: inventory.publishedThrough,
    });

    expect(() => verifyPublicReleaseCoverage(inventory, releases.slice(0, -1))).toThrow(
      "inventory-only public releases",
    );
    expect(() =>
      verifyPublicReleaseCoverage(inventory, [
        ...releases,
        {
          tag_name: "v9.9.9",
          draft: false,
          published_at: new Date(releases.length * 1000).toISOString(),
        },
      ]),
    ).toThrow("unassigned public GitHub releases");
  });

  it("derives packaged P1 scenarios from the predecessor topology", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    expect(candidateP1Scenarios(inventory, "0.1.75")).toEqual(["install"]);
    expect(candidateP1Scenarios(inventory, "0.1.76-rc.35")).toEqual(["managed-update"]);
    expect(() => candidateP1Scenarios(inventory, "9.9.9")).toThrow(
      "has no compatibility assignment",
    );
  });

  it("keeps release evidence out of runtime migration selection", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const managedV2 = inventory.releaseGroups.find(
      ({ id }) => id === "managed-v2-static-host-controller",
    );
    const [first, second] = [managedV2.releases[0], managedV2.releases.at(-1)];

    expect(first.tag).not.toBe(second.tag);
    expect(managedV2.localTopologies).toEqual([
      "local-user-systemd-managed-v2",
      "local-darwin-managed-v2",
    ]);
    expect(managedV2.hostingTopology).toBe("hosting-controller-v2-static");
    expect(inventory.selectionContract.runtimeConsumesReleaseAssignments).toBe(false);
    expect(inventory.selectionContract.runtimeSelectionFields).toEqual(
      __testing.RUNTIME_SELECTION_FIELDS,
    );
    expect(inventory.selectionContract.runtimeSelectionFields).not.toEqual(
      expect.arrayContaining(__testing.RELEASE_EVIDENCE_FIELDS),
    );

    const selection = updaterTesting.selectLifecycleMigration(currentProtectedTopology(), 2);
    expect(nestedKeys(selection)).not.toEqual(
      expect.arrayContaining(["release", "tag", "commit", "targetRelease", "targetVersion"]),
    );
  });

  it("binds every runtime-selected inventory adapter to the updater catalog", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const inventoryAdapters = inventory.adapters
      .filter(({ runtimeSelected }) => runtimeSelected)
      .map(({ id }) => id)
      .toSorted();
    const updaterAdapters = Object.values(updaterTesting.LIFECYCLE_COMPATIBILITY_ADAPTERS)
      .flatMap((catalog) => Object.values(catalog))
      .toSorted();

    expect(inventoryAdapters).toEqual(updaterAdapters);
    const selection = updaterTesting.selectLifecycleMigration(currentProtectedTopology(), 2);
    expect(
      Object.values(selection.adapters).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(
      [
        "managed-install-v2",
        "controller-protocol-v2",
        "signer-schema-v2",
        "wallet-registry-v1",
        "mining-schema-v1",
        "federation-schema-v2",
        "declared-state-registry-v1",
        "protected-local-system-v1",
      ].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("rejects an unknown adapter or unsupported runtime tuple before selection", () => {
    const inventory = cloneInventory();
    inventory.topologies
      .find(({ id }) => id === "hosting-supervisor-v1")
      .adapterIds.push("release-name-special-case");
    expect(() => validateLifecycleCompatibilityInventory(inventory)).toThrow(
      "unknown adapter release-name-special-case",
    );

    const unsupported = currentProtectedTopology();
    unsupported.stateSchemas.signer = 1;
    expect(() => updaterTesting.selectLifecycleMigration(unsupported, 2)).toThrow(
      "state schemas are unsupported",
    );

    const newerUnknown = currentProtectedTopology();
    newerUnknown.stateSchemas.managedInstall = 3;
    const before = JSON.stringify(newerUnknown);
    expect(() => updaterTesting.selectLifecycleMigration(newerUnknown, 2)).toThrow(
      "state schemas are unsupported",
    );
    expect(JSON.stringify(newerUnknown)).toBe(before);
  });
});
