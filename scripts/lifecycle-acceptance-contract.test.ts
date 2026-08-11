import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_PREDICATES,
  buildAcceptanceReceipt,
  digestAcceptanceContract,
  validateAcceptanceContract,
  verifyAcceptanceReceipt,
} from "./lifecycle-acceptance-contract.mjs";

const contractPath = new URL("../config/lifecycle-acceptance.v2.json", import.meta.url);
const digest = `sha256:${"b".repeat(64)}`;

function contract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

function evidence(profile: string, scenario: string, version = "0.1.76-rc.70") {
  return REQUIRED_PREDICATES[profile][scenario].map((id) => ({
    id,
    status: "PASS",
    evidenceDigest: digest,
    summary: id.endsWith("-already-current") ? `Already current: ${version}` : "verified",
  }));
}

describe("lifecycle acceptance contract", () => {
  it("defines identical evidence classes for Local and Hosting", () => {
    const value = contract();
    expect(validateAcceptanceContract(value)).toBe(value);
    expect(digestAcceptanceContract(value)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(value.profiles["protected-local"]).toEqual(value.profiles.hosting);
  });

  it.each([
    ["protected-local", "fresh-install"],
    ["protected-local", "managed-update"],
    ["hosting", "fresh-install"],
    ["hosting", "managed-update"],
  ])("binds %s/%s evidence to exact bytes and capsule policy", (profile, scenario) => {
    const value = contract();
    const capsule = scenario === "managed-update" ? digest : null;
    const receipt = buildAcceptanceReceipt({
      contract: value,
      profile,
      scenario,
      version: "0.1.76-rc.70",
      commit: "a".repeat(40),
      candidateDescriptorDigest: digest,
      predecessorCapsuleDigest: capsule,
      evidence: evidence(profile, scenario),
    });
    expect(
      verifyAcceptanceReceipt({
        contract: value,
        receipt,
        expected: { profile, scenario, predecessorCapsuleDigest: capsule },
      }),
    ).toBe(receipt);
  });

  it("rejects name-only, reordered, and nonliteral idempotence evidence", () => {
    const value = contract();
    const records = evidence("hosting", "fresh-install");
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        evidence: records.map(({ id }) => id),
      }),
    ).toThrow();
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        evidence: records.with(records.length - 1, {
          ...records.at(-1),
          summary: "current",
        }),
      }),
    ).toThrow("literal idempotence result");
  });

  it("wires the v2 contract and capsule verifier into candidate proof", () => {
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../.github/workflows/hosted-runtime-release.yml", import.meta.url),
      "utf8",
    );
    expect(wrapper).toContain("fased-lifecycle-acceptance-v2.json");
    expect(wrapper).toContain("capsule_descriptor_attestation");
    expect(wrapper).toContain("capsule_archive_attestation");
    expect(wrapper).toContain("gh attestation verify");
    expect(workflow).toContain("fased-lifecycle-acceptance-v2.json");
  });
});
