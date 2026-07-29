import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { __testing as updaterTesting } from "./fased-host-updater.mjs";
import {
  __testing,
  loadLifecycleCompatibilityInventory,
  publishedReleaseAssignments,
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

    expect(inventory.publishedReleaseCount).toBe(82);
    expect(inventory.releaseGroups).toHaveLength(6);
    expect(assignments).toHaveLength(82);
    expect(new Set(assignments.map(({ tag }) => tag)).size).toBe(82);
    expect(inventory.topologies.map(({ id }) => id)).toEqual(
      expect.arrayContaining(__testing.REQUIRED_TOPOLOGY_CLASSES),
    );
    expect(assignments.at(-1)).toMatchObject(inventory.publishedThrough);
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
  });
});
