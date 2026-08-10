import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

describe("lifecycle compatibility inventory", () => {
  it("accounts for every published release and material topology class", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const assignments = publishedReleaseAssignments(inventory);
    expect(assignments).toHaveLength(inventory.publishedReleaseCount);
    expect(new Set(assignments.map(({ tag }) => tag)).size).toBe(assignments.length);
    expect(inventory.topologies.map(({ id }) => id)).toEqual(
      expect.arrayContaining(__testing.REQUIRED_TOPOLOGY_CLASSES),
    );
    expect(assignments.at(-1)).toMatchObject(inventory.publishedThrough);
  });

  it("requires exact public GitHub release coverage", () => {
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
  });

  it("derives packaged proof from topology classes rather than every release", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    expect(candidateP1Scenarios(inventory, "0.1.75")).toEqual(["install"]);
    expect(candidateP1Scenarios(inventory, "0.1.76-rc.35")).toEqual(["managed-update"]);
    expect(() => candidateP1Scenarios(inventory, "9.9.9")).toThrow(
      "has no compatibility assignment",
    );
  });

  it("keeps release names out of runtime compatibility selection", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    expect(inventory.selectionContract.runtimeConsumesReleaseAssignments).toBe(false);
    expect(inventory.selectionContract.runtimeSelectionFields).toEqual(
      __testing.RUNTIME_SELECTION_FIELDS,
    );
    expect(inventory.selectionContract.runtimeSelectionFields).not.toEqual(
      expect.arrayContaining(__testing.RELEASE_EVIDENCE_FIELDS),
    );
  });

  it("rejects inventory references to unknown adapters", () => {
    const inventory = cloneInventory();
    inventory.topologies
      .find(({ id }) => id === "hosting-supervisor-v1")
      .adapterIds.push("release-name-special-case");
    expect(() => validateLifecycleCompatibilityInventory(inventory)).toThrow(
      "unknown adapter release-name-special-case",
    );
  });
});
