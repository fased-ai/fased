import { describe, expect, it } from "vitest";
import {
  makeMemoryRepairPolicyInputFixture,
  makeMemoryRepairPreviewFixture,
} from "./repair-contract.test-fixtures.js";
import {
  createMemoryRepairPreviewFingerprint,
  evaluateMemoryRepairExecutionPolicy,
} from "./repair-execution-policy.js";

const ROOT = "/tmp/fased-memory-policy";

function makePolicyPreview() {
  return makeMemoryRepairPreviewFixture({
    root: ROOT,
    proposalIds: [
      "create-memory-file",
      "create-memory-dir",
      "rebuild-index",
      "review-backend",
      "redacted-path",
    ],
    validation: { errors: 1, warnings: 2, info: 0 },
  });
}

function makeAdminInput(preview = makePolicyPreview()) {
  return makeMemoryRepairPolicyInputFixture({ root: ROOT, preview });
}

describe("memory repair execution policy", () => {
  it("allows only supported executable proposals when admin gates are satisfied", () => {
    const preview = makePolicyPreview();

    const decision = evaluateMemoryRepairExecutionPolicy(makeAdminInput(preview));

    expect(decision.ok).toBe(false);
    expect(decision.allowed.map((entry) => entry.id)).toEqual([
      "create-memory-file",
      "create-memory-dir",
      "rebuild-index",
    ]);
    expect(decision.blocked.map((entry) => entry.id)).toEqual(["review-backend", "redacted-path"]);
    expect(decision.blocked.find((entry) => entry.id === "review-backend")?.reasons).toContain(
      "backend repair requires a dedicated admin flow",
    );
    expect(decision.blocked.find((entry) => entry.id === "redacted-path")?.reasons).toContain(
      "outside allowed roots",
    );
  });

  it("requires admin scope, explicit confirmation, accepted preview, backup, audit, and recovery plans", () => {
    const preview = makePolicyPreview();

    const decision = evaluateMemoryRepairExecutionPolicy({
      preview,
      acceptedPreviewFingerprint: "stale-preview",
      surface: "cli",
      operatorScope: "operator.write",
      confirmation: "none",
      plan: { backup: "none", audit: "none", rollback: "none" },
      allowedRoots: [],
    });

    expect(decision.allowed).toEqual([]);
    expect(decision.reasons).toEqual([
      "memory repair execution requires operator.admin",
      "memory repair execution requires explicit confirmation",
      "memory repair execution requires a backup plan",
      "memory repair execution requires an audit record plan",
      "memory repair execution requires a rollback or manual recovery plan",
      "memory repair execution requires allowed workspace/state roots",
      "memory repair preview fingerprint was not accepted",
    ]);
    expect(decision.blocked).toHaveLength(preview.proposals.length);
  });

  it("denies channel, chat, and plugin surfaces even when other gates are satisfied", () => {
    const preview = makePolicyPreview();

    for (const surface of ["channel", "chat", "plugin"] as const) {
      const decision = evaluateMemoryRepairExecutionPolicy({
        ...makeAdminInput(preview),
        surface,
        proposalIds: ["create-memory-file"],
      });

      expect(decision.allowed).toEqual([]);
      expect(decision.blocked[0]?.reasons).toContain(
        "memory repair execution is unavailable from this surface",
      );
    }
  });

  it("blocks target paths outside allowed roots even for supported proposal actions", () => {
    const preview = makePolicyPreview();
    preview.proposals[0] = {
      ...preview.proposals[0],
      targetPath: "/etc/fased/MEMORY.md",
    };

    const decision = evaluateMemoryRepairExecutionPolicy({
      ...makeAdminInput(preview),
      acceptedPreviewFingerprint: createMemoryRepairPreviewFingerprint(preview),
      proposalIds: ["create-memory-file"],
    });

    expect(decision.allowed).toEqual([]);
    expect(decision.blocked[0]?.reasons).toContain("proposal target path is outside allowed roots");
  });

  it("selects explicit proposal ids and reports unknown ids without allowing writes", () => {
    const preview = makePolicyPreview();

    const decision = evaluateMemoryRepairExecutionPolicy({
      ...makeAdminInput(preview),
      proposalIds: ["create-memory-dir", "missing-id"],
    });

    expect(decision.ok).toBe(false);
    expect(decision.allowed.map((entry) => entry.id)).toEqual(["create-memory-dir"]);
    expect(decision.blocked).toEqual([
      { id: "missing-id", reasons: ["proposal not found in preview"] },
    ]);
  });
});
