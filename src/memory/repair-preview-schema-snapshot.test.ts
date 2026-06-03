import { describe, expect, it } from "vitest";
import { type DoctorMemoryInventoryPayload, previewMemoryInventoryRepair } from "./inventory.js";
import { expectNoUnsafeMemoryDoctorFields } from "./memory-doctor-readonly-test-helpers.js";

const ALLOWED_TOP_LEVEL_KEYS = ["agentId", "dryRun", "ok", "proposals", "summary", "validation"];

const ALLOWED_VALIDATION_KEYS = ["errors", "info", "warnings"];
const ALLOWED_SUMMARY_KEYS = ["blocked", "proposals", "supported"];
const ALLOWED_PROPOSAL_KEYS = new Set([
  "action",
  "area",
  "blockReason",
  "description",
  "dryRun",
  "id",
  "requiresOperatorWrite",
  "severity",
  "sourceCode",
  "supported",
  "targetPath",
  "wouldMutate",
]);

describe("doctor.memory.repair.preview schema snapshot", () => {
  it("keeps the repair preview payload shape read-only and non-executable", () => {
    const payload = previewMemoryInventoryRepair(makeInventoryFixture());

    expect(Object.keys(payload).toSorted()).toEqual(ALLOWED_TOP_LEVEL_KEYS);
    expect(Object.keys(payload.validation).toSorted()).toEqual(ALLOWED_VALIDATION_KEYS);
    expect(Object.keys(payload.summary).toSorted()).toEqual(ALLOWED_SUMMARY_KEYS);
    expect(payload).toMatchObject({
      agentId: "main",
      dryRun: true,
      ok: false,
      validation: {
        errors: 1,
        warnings: 6,
        info: 2,
      },
      summary: {
        proposals: 9,
        supported: 6,
        blocked: 3,
      },
    });

    expect(
      payload.proposals.map((proposal) => ({
        keys: Object.keys(proposal).toSorted(),
        action: proposal.action,
        dryRun: proposal.dryRun,
        wouldMutate: proposal.wouldMutate,
        requiresOperatorWrite: proposal.requiresOperatorWrite,
        supported: proposal.supported,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "create_file",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": true,
          "wouldMutate": true,
        },
        {
          "action": "create_directory",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": true,
          "wouldMutate": true,
        },
        {
          "action": "seed_memory",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "blockReason",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": false,
          "wouldMutate": true,
        },
        {
          "action": "review_backend",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "blockReason",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": false,
          "wouldMutate": true,
        },
        {
          "action": "rebuild_index",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": true,
          "wouldMutate": true,
        },
        {
          "action": "create_directory",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": true,
          "wouldMutate": true,
        },
        {
          "action": "create_directory",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": true,
          "wouldMutate": true,
        },
        {
          "action": "create_directory",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "targetPath",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": true,
          "wouldMutate": true,
        },
        {
          "action": "review_plugin",
          "dryRun": true,
          "keys": [
            "action",
            "area",
            "blockReason",
            "description",
            "dryRun",
            "id",
            "requiresOperatorWrite",
            "severity",
            "sourceCode",
            "supported",
            "wouldMutate",
          ],
          "requiresOperatorWrite": true,
          "supported": false,
          "wouldMutate": true,
        },
      ]
    `);

    for (const proposal of payload.proposals) {
      expect(Object.keys(proposal).toSorted()).toEqual(
        expect.arrayContaining(["dryRun", "wouldMutate", "requiresOperatorWrite"]),
      );
      expect(Object.keys(proposal).every((key) => ALLOWED_PROPOSAL_KEYS.has(key))).toBe(true);
      expect(proposal.dryRun).toBe(true);
      expect(proposal.wouldMutate).toBe(true);
      expect(proposal.requiresOperatorWrite).toBe(true);
    }

    expectNoUnsafeMemoryDoctorFields(payload);
    expect(JSON.stringify(payload)).not.toMatch(
      /doctor\.memory\.repair\.execute|execute repair|repair executor|gateway handler/i,
    );
  });
});

function makeInventoryFixture(): DoctorMemoryInventoryPayload {
  return {
    agentId: "main",
    workspace: {
      path: "/workspace/main",
      exists: true,
      memoryRoots: [
        {
          id: "MEMORY.md",
          path: "/workspace/main/MEMORY.md",
          exists: false,
          kind: "missing",
        },
        {
          id: "memory.md",
          path: "/workspace/main/memory.md",
          exists: true,
          kind: "file",
        },
        {
          id: "memory-dir",
          path: "/workspace/main/memory",
          exists: false,
          kind: "missing",
        },
      ],
    },
    backend: {
      configured: "qmd",
      citations: "auto",
      error: "qmd unavailable",
    },
    qmd: {
      enabled: true,
      index: {
        path: "/state/agents/main/qmd/index.sqlite",
        exists: false,
        kind: "missing",
      },
      collections: [
        {
          name: "memory",
          pattern: "**/*.md",
          collectionKind: "memory",
          path: "/state/agents/main/qmd/collections/memory",
          exists: false,
          kind: "missing",
        },
      ],
      sessions: {
        enabled: true,
        exportDir: {
          path: "/state/agents/main/qmd/sessions",
          exists: false,
          kind: "missing",
        },
      },
    },
    sessionMemory: {
      hookConfigured: true,
      enabled: true,
      memoryDir: {
        path: "/workspace/main/session-memory",
        exists: false,
        kind: "missing",
      },
    },
    memoryPlugin: {
      configuredSlot: "memory-core",
      enabled: false,
      registryLoaded: true,
      reason: "memory-core plugin not found",
    },
  };
}
