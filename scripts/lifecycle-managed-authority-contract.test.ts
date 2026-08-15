import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  __testing,
  loadManagedAuthorityContract,
  validateManagedAuthorityContract,
} from "./lifecycle-managed-authority-contract.mjs";

function contract() {
  return JSON.parse(readFileSync(__testing.DEFAULT_CONTRACT, "utf8"));
}

describe("managed lifecycle authority contract", () => {
  it("separates privileged lifecycle mutation from application and plugin logic", () => {
    const result = loadManagedAuthorityContract();
    expect(result.profileCount).toBe(4);
    expect(result.capabilityCount).toBeGreaterThan(20);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "hosting-tailscale-install-auth-and-identity",
        "hosting-provider-access-handoff",
        "darwin-principals-services-and-peer-auth",
        "managed-repair",
        "managed-uninstall",
      ]),
    );
  });

  it("fails release verification while any managed capability is partial or missing", () => {
    expect(() => loadManagedAuthorityContract(undefined, { release: true })).toThrow(
      "release blockers",
    );
  });

  it("rejects an implemented claim without exact code and evidence paths", () => {
    const value = contract();
    const capability = value.capabilities.find(
      ({ id }: { id: string }) => id === "managed-uninstall",
    );
    capability.status = "implemented";
    capability.implementation = [];
    capability.evidence = [];
    expect(() => validateManagedAuthorityContract(value)).toThrow("lacks code or evidence");
  });

  it("rejects unknown retained profile claims", () => {
    const value = contract();
    value.capabilities[0].profiles = ["windows-native"];
    expect(() => validateManagedAuthorityContract(value)).toThrow("unknown profile");
  });
});
