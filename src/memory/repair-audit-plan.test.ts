import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemoryRepairAuditPlan,
  createMemoryRepairAuditPlanFingerprint,
} from "./repair-audit-plan.js";
import {
  MEMORY_REPAIR_FIXTURE_CREATED_AT,
  makeMemoryRepairPolicyInputFixture,
  makeMemoryRepairPreviewFixture,
} from "./repair-contract.test-fixtures.js";
import { evaluateMemoryRepairExecutionPolicy } from "./repair-execution-policy.js";

const ROOT = "/tmp/fased-memory-audit-plan";

function makePreview() {
  return makeMemoryRepairPreviewFixture({
    root: ROOT,
    proposalIds: ["create-memory-file", "rebuild-index", "review-backend"],
    validation: { errors: 1, warnings: 2, info: 0 },
  });
}

function makePolicyInput(preview = makePreview()) {
  return makeMemoryRepairPolicyInputFixture({ root: ROOT, preview });
}

describe("memory repair audit plan", () => {
  it("creates a dry-run backup, audit, and rollback record plan for an admitted policy decision", () => {
    const preview = makePreview();
    const policyInput = makePolicyInput(preview);
    const policyDecision = evaluateMemoryRepairExecutionPolicy({
      ...policyInput,
      proposalIds: ["create-memory-file"],
    });

    const result = createMemoryRepairAuditPlan({
      executionId: "repair-main-0001",
      createdAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
      policyInput,
      policyDecision,
      backupRoot: path.join(ROOT, ".state", "memory-repair-backups"),
      auditRoot: path.join(ROOT, ".state", "memory-repair-audit"),
    });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    const plan = result.plan;
    expect(plan).toBeDefined();
    if (!plan) {
      throw new Error("expected memory repair audit plan");
    }
    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: "doctor.memory.repair.execution.audit-plan",
      executionId: "repair-main-0001",
      createdAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
      agentId: "main",
      dryRun: true,
      noWritePerformed: true,
      transcriptAccess: "none",
      bodyAccess: "none",
      selectedProposalIds: ["create-memory-file"],
      backup: { required: true },
      audit: { required: true, event: "planned" },
      rollback: { required: true, mode: "manual" },
    });
    expect(plan.backup.entries).toEqual([
      {
        proposalId: "create-memory-file",
        action: "create_file",
        targetPath: path.join(ROOT, "MEMORY.md"),
        snapshotPath: path.join(
          ROOT,
          ".state",
          "memory-repair-backups",
          "repair-main-0001-create-memory-file.snapshot",
        ),
        strategy: "snapshot-target-before-write",
      },
    ]);
    expect(plan.rollback.entries[0]).toMatchObject({
      proposalId: "create-memory-file",
      action: "create_file",
      strategy: "restore-or-remove-to-prewrite-state",
    });
    expect(result.fingerprint).toBe(createMemoryRepairAuditPlanFingerprint(plan));
  });

  it("requires an admitted policy decision and does not plan around blocked proposals", () => {
    const preview = makePreview();
    const policyInput = makePolicyInput(preview);
    const policyDecision = evaluateMemoryRepairExecutionPolicy(policyInput);

    const result = createMemoryRepairAuditPlan({
      executionId: "repair-main-0002",
      createdAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
      policyInput,
      policyDecision,
      backupRoot: path.join(ROOT, ".state", "memory-repair-backups"),
      auditRoot: path.join(ROOT, ".state", "memory-repair-audit"),
    });

    expect(policyDecision.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.reasons).toContain(
      "memory repair audit plan requires an admitted execution policy decision",
    );
    expect(result.reasons).toContain("memory repair audit plan cannot include blocked proposals");
  });

  it("rejects unsafe execution ids, timestamps, roots, and stale preview fingerprints", () => {
    const preview = makePreview();
    const policyInput = makePolicyInput(preview);
    const policyDecision = evaluateMemoryRepairExecutionPolicy({
      ...policyInput,
      proposalIds: ["create-memory-file"],
    });

    const result = createMemoryRepairAuditPlan({
      executionId: "../bad id",
      createdAt: "May 1",
      policyInput: {
        ...policyInput,
        acceptedPreviewFingerprint: "stale",
      },
      policyDecision,
      backupRoot: "/var/tmp/fased-memory-repair-backups",
      auditRoot: "[redacted:memory]",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      "memory repair audit plan requires a safe execution id",
      "memory repair audit plan requires an ISO createdAt timestamp",
      "memory repair audit plan requires the accepted preview fingerprint",
      "memory repair backup root must stay inside allowed roots",
      "memory repair audit root must stay inside allowed roots",
    ]);
  });

  it("rejects admitted decisions whose target paths no longer stay inside allowed roots", () => {
    const preview = makePreview();
    const policyInput = makePolicyInput(preview);
    const policyDecision = evaluateMemoryRepairExecutionPolicy({
      ...policyInput,
      proposalIds: ["create-memory-file"],
    });
    const allowedProposal = policyDecision.allowed[0];
    expect(allowedProposal).toBeDefined();
    if (!allowedProposal) {
      throw new Error("expected admitted memory repair proposal");
    }
    policyDecision.allowed[0] = {
      ...allowedProposal,
      targetPath: "/etc/fased/MEMORY.md",
    };

    const result = createMemoryRepairAuditPlan({
      executionId: "repair-main-0003",
      createdAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
      policyInput,
      policyDecision,
      backupRoot: path.join(ROOT, ".state", "memory-repair-backups"),
      auditRoot: path.join(ROOT, ".state", "memory-repair-audit"),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      "memory repair proposal create-memory-file target path must stay inside allowed roots",
    ]);
  });
});
