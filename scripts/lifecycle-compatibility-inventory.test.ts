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

  it("accepts future public releases from immutable manifested compatibility evidence", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const releases = publishedReleaseAssignments(inventory).map(({ tag }, index) => ({
      tag_name: tag,
      draft: false,
      published_at: new Date(index * 1000).toISOString(),
    }));
    releases.push({
      tag_name: "v0.1.76-rc.71",
      draft: false,
      published_at: new Date(releases.length * 1000).toISOString(),
    });
    const evidence = {
      tag: "v0.1.76-rc.71",
      commit: "a".repeat(40),
      groupId: inventory.currentReleaseGroupId,
    };
    expect(verifyPublicReleaseCoverage(inventory, releases, [evidence])).toMatchObject({
      releaseCount: inventory.publishedReleaseCount + 1,
      publishedThrough: { tag: evidence.tag, commit: evidence.commit },
    });
    expect(() => verifyPublicReleaseCoverage(inventory, releases)).toThrow(
      "unassigned public GitHub releases",
    );
  });

  it("derives packaged proof from topology classes rather than every release", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    expect(candidateP1Scenarios(inventory, "0.1.75")).toEqual(["managed-update"]);
    expect(candidateP1Scenarios(inventory, "0.1.76-rc.35")).toEqual(["managed-update"]);
    expect(
      candidateP1Scenarios(inventory, "0.1.76-rc.71", [
        {
          tag: "v0.1.76-rc.71",
          commit: "a".repeat(40),
          groupId: inventory.currentReleaseGroupId,
        },
      ]),
    ).toEqual(["managed-update"]);
    expect(() => candidateP1Scenarios(inventory, "9.9.9")).toThrow(
      "has no compatibility assignment",
    );
  });

  it("uses one exact direct lookup for a non-source P1 predecessor and fails closed", () => {
    const inventory = loadLifecycleCompatibilityInventory();
    const calls = [];
    const release = __testing.readDirectPublicGitHubRelease(
      inventory.repository,
      "v0.1.76-rc.71",
      (command, args, options) => {
        calls.push({ command, args, options });
        expect(command).toBe("gh");
        expect(args).toEqual([
          "release",
          "view",
          "v0.1.76-rc.71",
          "--repo",
          inventory.repository,
          "--json",
          "tagName,isDraft,publishedAt",
        ]);
        expect(options).toEqual({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        expect(args).not.toContain("--paginate");
        return JSON.stringify({
          tagName: "v0.1.76-rc.71",
          isDraft: false,
          publishedAt: "2026-08-17T00:00:00Z",
        });
      },
    );
    expect(calls).toHaveLength(1);
    expect(release).toEqual({
      tag_name: "v0.1.76-rc.71",
      draft: false,
      published_at: "2026-08-17T00:00:00Z",
    });

    for (const metadata of [
      { tagName: "v0.1.76-rc.70", isDraft: false, publishedAt: "2026-08-17T00:00:00Z" },
      { tagName: "v0.1.76-rc.71", isDraft: true, publishedAt: "2026-08-17T00:00:00Z" },
      { tagName: "v0.1.76-rc.71", isDraft: false, publishedAt: null },
    ]) {
      expect(() =>
        __testing.readDirectPublicGitHubRelease(inventory.repository, "v0.1.76-rc.71", () =>
          JSON.stringify(metadata),
        ),
      ).toThrow();
    }
    expect(() =>
      __testing.readDirectPublicGitHubRelease(
        inventory.repository,
        "v0.1.76-rc.71",
        () => "not-json",
      ),
    ).toThrow();
  });

  it("uses one bounded release list for full public coverage and fails closed", () => {
    const repository = "fased-ai/fased";
    const calls = [];
    const releases = __testing.readPublicGitHubReleases(repository, (command, args, options) => {
      calls.push({ command, args, options });
      expect(command).toBe("gh");
      expect(args).toEqual([
        "release",
        "list",
        "--repo",
        repository,
        "--limit",
        "1000",
        "--json",
        "tagName,isDraft,publishedAt",
      ]);
      expect(args).not.toContain("api");
      expect(args).not.toContain("--paginate");
      expect(options).toEqual({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return JSON.stringify([
        {
          tagName: "v0.1.75",
          isDraft: false,
          publishedAt: "2026-08-15T00:00:00Z",
        },
        { tagName: "draft", isDraft: true, publishedAt: null },
      ]);
    });
    expect(calls).toHaveLength(1);
    expect(releases).toEqual([
      {
        tag_name: "v0.1.75",
        draft: false,
        published_at: "2026-08-15T00:00:00Z",
      },
      { tag_name: "draft", draft: true, published_at: null },
    ]);

    for (const [response, message] of [
      ["not-json", "public GitHub release list response is invalid"],
      [JSON.stringify({}), "public GitHub release list response is invalid"],
      [
        JSON.stringify([{ tagName: "v0.1.75", isDraft: false }]),
        "public GitHub release fields are invalid",
      ],
      [
        JSON.stringify([
          { tagName: "v0.1.75", isDraft: "false", publishedAt: "2026-08-15T00:00:00Z" },
        ]),
        "public GitHub release metadata is invalid",
      ],
      [
        JSON.stringify([{ tagName: "v0.1.75", isDraft: false, publishedAt: null }]),
        "public GitHub release metadata is invalid",
      ],
      [
        JSON.stringify(
          Array.from({ length: 1000 }, (_, index) => ({
            tagName: `v0.1.${index}`,
            isDraft: false,
            publishedAt: "2026-08-15T00:00:00Z",
          })),
        ),
        "public GitHub release list reached 1000-result bound",
      ],
    ]) {
      expect(() => __testing.readPublicGitHubReleases(repository, () => response)).toThrow(message);
    }
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
