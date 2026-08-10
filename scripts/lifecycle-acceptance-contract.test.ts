import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SCENARIOS,
  buildAcceptanceReceipt,
  digestAcceptanceContract,
  validateAcceptanceContract,
  verifyAcceptanceReceipt,
} from "./lifecycle-acceptance-contract.mjs";

const contractPath = new URL("../config/lifecycle-acceptance.v1.json", import.meta.url);

function contract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

function receipt(scenario: keyof typeof REQUIRED_SCENARIOS = "fresh-install") {
  const value = contract();
  return buildAcceptanceReceipt({
    contract: value,
    scenario,
    version: "0.1.76-rc.70",
    commit: "a".repeat(40),
    candidateDescriptorDigest: `sha256:${"b".repeat(64)}`,
    passedPredicates: [...REQUIRED_SCENARIOS[scenario]],
  });
}

describe("lifecycle acceptance contract", () => {
  it("defines the complete Local operator portfolio for branch proof and candidate P1", () => {
    const value = contract();
    expect(validateAcceptanceContract(value)).toBe(value);
    expect(digestAcceptanceContract(value)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    for (const predicates of Object.values(value.scenarios)) {
      expect(predicates).toEqual(
        expect.arrayContaining([
          "four-services-active",
          "wallet-status",
          "wallet-signer-doctor",
          "mining-status",
          "network-status",
          "plugin-doctor",
          "restart-health",
          "state-preservation",
          "already-current",
        ]),
      );
    }
  });

  it("rejects an incomplete branch receipt before candidate allocation", () => {
    const value = contract();
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: `sha256:${"b".repeat(64)}`,
        passedPredicates: REQUIRED_SCENARIOS["fresh-install"].filter(
          (predicate) => predicate !== "wallet-signer-doctor",
        ),
      }),
    ).toThrow("did not pass the exact required predicate sequence");
  });

  it("binds receipts to the exact contract and candidate descriptor", () => {
    const value = contract();
    const valid = receipt("managed-update");
    expect(
      verifyAcceptanceReceipt({
        contract: value,
        receipt: valid,
        expected: { candidateDescriptorDigest: `sha256:${"b".repeat(64)}` },
      }),
    ).toBe(valid);
    expect(() =>
      verifyAcceptanceReceipt({
        contract: value,
        receipt: valid,
        expected: { candidateDescriptorDigest: `sha256:${"c".repeat(64)}` },
      }),
    ).toThrow("receipt candidateDescriptorDigest mismatch");
  });

  it("uses the same artifact-bound contract in branch proof and candidate P1", () => {
    const runner = readFileSync(
      new URL("./docker/protected-local-systemd/run.sh", import.meta.url),
      "utf8",
    );
    const wrapper = readFileSync(
      new URL("./test-protected-local-systemd-container.sh", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../.github/workflows/hosted-runtime-release.yml", import.meta.url),
      "utf8",
    );

    expect(runner).toContain("acceptance_contract=/artifacts/fased-lifecycle-acceptance-v1.json");
    expect(runner).toContain("wallet status --json");
    expect(runner).toContain("wallet signer doctor --json");
    expect(runner).toContain("mining status");
    expect(runner).toContain("federation status --json");
    expect(runner).toContain("plugins doctor");
    expect(runner).toContain('"fased-local-controller-worker-$instance.service"');
    for (const predicates of Object.values(REQUIRED_SCENARIOS)) {
      for (const predicate of predicates) {
        expect(runner).toContain(`acceptance_mark ${predicate}`);
      }
    }
    expect(wrapper).toContain('"$ROOT_DIR/config/lifecycle-acceptance.v1.json"');
    expect(wrapper).toContain('lifecycle-release-compatibility.mjs" build');
    expect(wrapper).toContain('lifecycle-acceptance-contract.mjs" verify-receipt');
    expect(workflow).toContain(".artifacts/hosted-runtime/fased-lifecycle-acceptance-v1.json");
    expect(workflow).toContain(
      ".artifacts/hosted-runtime/fased-lifecycle-release-compatibility-v1.json",
    );
    expect(workflow).toContain("FASED_SYSTEMD_FIXTURE_RECEIPT_DIR");
    expect(workflow).toContain("fased-lifecycle-acceptance-fresh");
    expect(workflow).toContain("fased-lifecycle-acceptance-update");
  });
});
