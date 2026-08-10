import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digestAcceptanceContract } from "./lifecycle-acceptance-contract.mjs";
import {
  buildReleaseCompatibility,
  parseReleaseCompatibility,
} from "./lifecycle-release-compatibility.mjs";

const acceptance = JSON.parse(
  readFileSync(new URL("../config/lifecycle-acceptance.v1.json", import.meta.url), "utf8"),
);

describe("immutable public lifecycle compatibility", () => {
  it("binds release identity to one topology group without making versions policy inputs", () => {
    const manifest = buildReleaseCompatibility({
      repository: "fased-ai/fased",
      compatibilityGroupId: "supervised-lifecycle-v1",
      acceptanceContract: acceptance,
      version: "0.1.76-rc.71",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    });
    expect(manifest).toMatchObject({
      release: { version: "0.1.76-rc.71", tag: "v0.1.76-rc.71" },
      compatibilityGroupId: "supervised-lifecycle-v1",
      selectionBasis: "installed-topology-protocol-and-state-schema",
      runtimeConsumesReleaseIdentity: false,
      acceptanceContract: { digest: digestAcceptanceContract(acceptance) },
    });
  });

  it("rejects unknown groups and identity rebinding", () => {
    const manifest = buildReleaseCompatibility({
      repository: "fased-ai/fased",
      compatibilityGroupId: "supervised-lifecycle-v1",
      acceptanceContract: acceptance,
      version: "0.1.76-rc.71",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    });
    expect(() =>
      parseReleaseCompatibility(manifest, {
        repository: "fased-ai/fased",
        compatibilityGroupIds: ["other-group"],
      }),
    ).toThrow("manifest identity or selection contract is invalid");
    expect(() =>
      parseReleaseCompatibility(manifest, {
        repository: "fased-ai/fased",
        compatibilityGroupIds: ["supervised-lifecycle-v1"],
        release: { commit: "c".repeat(40) },
      }),
    ).toThrow("release commit mismatch");
  });
});
