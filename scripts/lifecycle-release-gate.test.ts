import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_RELEASE_GATE_CONTEXT,
  lifecycleReleaseReceiptDigest,
  runLifecycleReleaseGateCli,
  verifyLifecycleReleaseGateReceipt,
} from "./lifecycle-release-gate.mjs";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const version = "1.2.3-rc.4";
const now = "2026-08-02T12:00:00.000Z";

type JsonObject = Record<string, unknown>;

function payload() {
  return {
    kind: "fased-lifecycle-release-gate",
    context: LIFECYCLE_RELEASE_GATE_CONTEXT,
    authorizedActions: ["github-release", "tag"],
    candidate: { version, commit, tree },
    bindings: {
      planDigest: digest("c"),
      artifactDigest: digest("d"),
      topologyDigest: digest("e"),
      runnerDigest: digest("f"),
      evaluationDigest: digest("1"),
    },
    gate: { name: "L1", evidenceTier: "T3", authority: "AUTHORITATIVE" },
    result: {
      status: "PASS",
      releaseFrozen: false,
      manualReviewRequired: false,
      rollback: { required: true, status: "PASS" },
      statePreservation: {
        required: true,
        status: "PASS",
        beforeDigest: digest("2"),
        afterDigest: digest("2"),
      },
      finalIdentity: { version, commit, tree, artifactDigest: digest("d") },
      alreadyCurrent: { required: true, status: "PASS" },
    },
    validity: {
      issuedAt: "2026-08-02T11:30:00.000Z",
      expiresAt: "2026-08-02T12:30:00.000Z",
    },
  };
}

function envelope(selectedPayload = payload()) {
  return {
    schemaVersion: 1,
    receipt: selectedPayload,
    receiptDigest: lifecycleReleaseReceiptDigest(selectedPayload),
  };
}

function expectations(selectedEnvelope = envelope()) {
  return {
    expectedVersion: version,
    expectedCommit: commit,
    expectedTree: tree,
    expectedPlanDigest: digest("c"),
    expectedArtifactDigest: digest("d"),
    expectedTopologyDigest: digest("e"),
    expectedRunnerDigest: digest("f"),
    expectedEvaluationDigest: digest("1"),
    expectedGate: "L1",
    expectedReceiptDigest: selectedEnvelope.receiptDigest,
    expectedAuthorizedActions: ["github-release", "tag"],
    requireAuthoritative: true,
    now,
  };
}

function mutateReceipt(mutator: (receipt: JsonObject) => void) {
  const selected = structuredClone(payload()) as unknown as JsonObject;
  mutator(selected);
  return envelope(selected as ReturnType<typeof payload>);
}

describe("lifecycle release gate receipt", () => {
  it("keeps the public JSON schema aligned with the executable envelope contract", async () => {
    const schema = JSON.parse(
      await fsp.readFile(
        new URL("./lifecycle-release-gate-receipt.v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    const selected = envelope();

    expect(validate(selected), validate.errors ?? []).toBe(true);
    const drifted = structuredClone(selected) as unknown as JsonObject;
    (drifted.receipt as JsonObject).unsupported = true;
    expect(validate(drifted)).toBe(false);
  });

  it("accepts one fresh authoritative receipt bound to the exact candidate and evidence", () => {
    const selected = envelope();
    const result = verifyLifecycleReleaseGateReceipt(selected, expectations(selected));

    expect(result).toEqual({
      ok: true,
      context: "fased/lifecycle-release-gate",
      state: "success",
      candidate: { version, commit, tree },
      gate: "L1",
      evidenceTier: "T3",
      authority: "AUTHORITATIVE",
      authorizedActions: ["github-release", "tag"],
      receiptDigest: selected.receiptDigest,
      releaseEligible: true,
    });
  });

  it("rejects stale or mismatched candidate, plan, artifact, topology, runner, and evaluation bindings", () => {
    const selected = envelope();
    const mismatches = [
      { expectedCommit: "9".repeat(40) },
      { expectedTree: "8".repeat(40) },
      { expectedPlanDigest: digest("3") },
      { expectedArtifactDigest: digest("4") },
      { expectedTopologyDigest: digest("5") },
      { expectedRunnerDigest: digest("6") },
      { expectedEvaluationDigest: digest("7") },
      { expectedGate: "H1" },
      { expectedAuthorizedActions: ["docker", "github-release", "tag"] },
    ];

    for (const mismatch of mismatches) {
      expect(() =>
        verifyLifecycleReleaseGateReceipt(selected, { ...expectations(selected), ...mismatch }),
      ).toThrow(/receipt identity does not match/u);
    }
    expect(() =>
      verifyLifecycleReleaseGateReceipt(selected, {
        ...expectations(selected),
        now: "2026-08-03T11:00:00.000Z",
      }),
    ).toThrow(/receipt is stale/u);

    const overlong = mutateReceipt((receipt) => {
      (receipt.validity as JsonObject).expiresAt = "2026-08-02T12:30:00.001Z";
    });
    expect(() => verifyLifecycleReleaseGateReceipt(overlong, expectations(overlong))).toThrow(
      /one-hour validity window/u,
    );
  });

  it("rejects a tampered receipt digest and a mismatched final identity", () => {
    const selected = envelope();
    selected.receiptDigest = digest("8");
    expect(() =>
      verifyLifecycleReleaseGateReceipt(selected, {
        ...expectations(),
        expectedReceiptDigest: digest("8"),
      }),
    ).toThrow(/receipt digest is invalid/u);

    const wrongFinal = mutateReceipt((receipt) => {
      const result = receipt.result as JsonObject;
      const identity = result.finalIdentity as JsonObject;
      identity.commit = "9".repeat(40);
    });
    expect(() =>
      verifyLifecycleReleaseGateReceipt(wrongFinal, {
        ...expectations(wrongFinal),
        expectedReceiptDigest: wrongFinal.receiptDigest,
      }),
    ).toThrow(/final identity does not match/u);
  });

  it("requires one canonical sorted unique non-npm action set", () => {
    for (const actions of [
      [],
      ["tag", "github-release"],
      ["github-release", "tag", "tag"],
      ["npm"],
    ]) {
      const selected = mutateReceipt((receipt) => {
        receipt.authorizedActions = actions;
      });
      expect(() => verifyLifecycleReleaseGateReceipt(selected, expectations(selected))).toThrow(
        /authorized actions/u,
      );
    }
  });

  it("rejects failed, blocked, frozen, and manual-review results", () => {
    for (const status of ["FAIL", "BLOCKED"]) {
      const selected = mutateReceipt((receipt) => {
        (receipt.result as JsonObject).status = status;
      });
      expect(() => verifyLifecycleReleaseGateReceipt(selected, expectations(selected))).toThrow(
        new RegExp(`gate result is ${status}`, "u"),
      );
    }
    for (const [field, message] of [
      ["releaseFrozen", "release remains frozen"],
      ["manualReviewRequired", "manual review remains required"],
    ]) {
      const selected = mutateReceipt((receipt) => {
        (receipt.result as JsonObject)[field] = true;
      });
      expect(() => verifyLifecycleReleaseGateReceipt(selected, expectations(selected))).toThrow(
        message,
      );
    }
  });

  it("rejects SUPPORTING evidence for authoritative gates and release preflight", () => {
    const mislabeledL1 = mutateReceipt((receipt) => {
      (receipt.gate as JsonObject).authority = "SUPPORTING";
    });
    expect(() =>
      verifyLifecycleReleaseGateReceipt(mislabeledL1, expectations(mislabeledL1)),
    ).toThrow(/L1 requires authoritative T3 evidence/u);

    const supportingT2 = mutateReceipt((receipt) => {
      Object.assign(receipt.gate as JsonObject, {
        name: "T2",
        evidenceTier: "T2",
        authority: "SUPPORTING",
      });
    });
    expect(() =>
      verifyLifecycleReleaseGateReceipt(supportingT2, {
        ...expectations(supportingT2),
        expectedGate: "T2",
      }),
    ).toThrow(/only a known authoritative T3 gate can authorize a release/u);

    const inventedGate = mutateReceipt((receipt) => {
      Object.assign(receipt.gate as JsonObject, {
        name: "INVENTED",
        evidenceTier: "T3",
        authority: "AUTHORITATIVE",
      });
    });
    expect(() =>
      verifyLifecycleReleaseGateReceipt(inventedGate, {
        ...expectations(inventedGate),
        expectedGate: "INVENTED",
      }),
    ).toThrow(/only a known authoritative T3 gate can authorize a release/u);
  });

  it("accepts the explicit pre-RC aggregate closure gate", () => {
    const selected = mutateReceipt((receipt) => {
      Object.assign(receipt.gate as JsonObject, {
        name: "RC0",
        evidenceTier: "T3",
        authority: "AUTHORITATIVE",
      });
    });

    expect(
      verifyLifecycleReleaseGateReceipt(selected, {
        ...expectations(selected),
        expectedGate: "RC0",
      }),
    ).toMatchObject({ ok: true, gate: "RC0", releaseEligible: true });
  });

  it("requires every external binding in authoritative verification mode", () => {
    const selected = envelope();
    expect(() =>
      verifyLifecycleReleaseGateReceipt(selected, {
        expectedCommit: commit,
        expectedReceiptDigest: selected.receiptDigest,
        requireAuthoritative: true,
        now,
      }),
    ).toThrow(/expectedVersion is required for authoritative verification/u);
  });

  it("rejects incomplete rollback, changed state, and a missing final Already current proof", () => {
    const cases: Array<[(receipt: JsonObject) => void, RegExp]> = [
      [
        (receipt) => {
          const result = receipt.result as JsonObject;
          (result.rollback as JsonObject).status = "N/A";
        },
        /rollback requirement and status are inconsistent/u,
      ],
      [
        (receipt) => {
          const result = receipt.result as JsonObject;
          (result.statePreservation as JsonObject).afterDigest = digest("9");
        },
        /critical state preservation is mismatched/u,
      ],
      [
        (receipt) => {
          const result = receipt.result as JsonObject;
          (result.alreadyCurrent as JsonObject).status = "N/A";
        },
        /already current requirement and status are inconsistent/u,
      ],
    ];
    for (const [mutate, message] of cases) {
      const selected = mutateReceipt(mutate);
      expect(() => verifyLifecycleReleaseGateReceipt(selected, expectations(selected))).toThrow(
        message,
      );
    }
  });

  it("allows fresh gates to declare stateful predicates N/A while keeping final identity exact", () => {
    const fresh = mutateReceipt((receipt) => {
      Object.assign(receipt.gate as JsonObject, {
        name: "L0",
        evidenceTier: "T3",
        authority: "AUTHORITATIVE",
      });
      Object.assign((receipt.result as JsonObject).rollback as JsonObject, {
        required: false,
        status: "N/A",
      });
      Object.assign((receipt.result as JsonObject).statePreservation as JsonObject, {
        required: false,
        status: "N/A",
        beforeDigest: null,
        afterDigest: null,
      });
      Object.assign((receipt.result as JsonObject).alreadyCurrent as JsonObject, {
        required: false,
        status: "N/A",
      });
    });

    expect(() =>
      verifyLifecycleReleaseGateReceipt(fresh, {
        ...expectations(fresh),
        expectedGate: "L0",
      }),
    ).not.toThrow();
    expect(() =>
      verifyLifecycleReleaseGateReceipt(fresh, {
        ...expectations(fresh),
        expectedGate: "L0",
        requiredPredicates: ["alreadyCurrent"],
      }),
    ).toThrow(/already current requirement and status are inconsistent/u);
  });

  it("supports the minimal JSON CLI and emits an exact-SHA status result", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-lifecycle-gate-"));
    const receiptPath = path.join(root, "receipt.json");
    const selected = envelope();
    await fsp.writeFile(receiptPath, `${JSON.stringify(selected)}\n`, { mode: 0o600 });

    const result = await runLifecycleReleaseGateCli([
      "verify",
      "--receipt",
      receiptPath,
      "--json",
      "--expected-version",
      version,
      "--expected-commit",
      commit,
      "--expected-tree",
      tree,
      "--expected-plan-digest",
      digest("c"),
      "--expected-artifact-digest",
      digest("d"),
      "--expected-topology-digest",
      digest("e"),
      "--expected-runner-digest",
      digest("f"),
      "--expected-evaluation-digest",
      digest("1"),
      "--expected-gate",
      "L1",
      "--expected-receipt-digest",
      selected.receiptDigest,
      "--expected-authorized-actions",
      "github-release,tag",
      "--require-authoritative",
      "--now",
      now,
    ]);

    expect(result).toMatchObject({
      context: "fased/lifecycle-release-gate",
      state: "success",
      candidate: { commit },
      receiptDigest: selected.receiptDigest,
      releaseEligible: true,
    });
  });
});
