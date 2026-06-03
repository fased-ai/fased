import { describe, expect, it } from "vitest";
import { type DoctorMemoryInventoryPayload, previewMemoryInventoryRepair } from "./inventory.js";

const SECRET_TRANSCRIPT_BODY =
  "SECRET_TRANSCRIPT_BODY: customer said the seed phrase is never logged";

describe("doctor.memory.repair.preview redaction regression", () => {
  it("does not copy transcript or backend body text into dry-run proposals", () => {
    const payload = previewMemoryInventoryRepair(makeSensitiveInventoryFixture());
    const serialized = JSON.stringify(payload);

    expect(payload.dryRun).toBe(true);
    expect(payload.proposals.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(SECRET_TRANSCRIPT_BODY);
    expect(serialized).not.toContain("seed phrase");
    for (const proposal of payload.proposals) {
      expect(proposal.description).not.toContain(SECRET_TRANSCRIPT_BODY);
      expect(proposal.blockReason ?? "").not.toContain(SECRET_TRANSCRIPT_BODY);
      expect(proposal.description).not.toMatch(/transcript body|message body|seed phrase/i);
    }
  });
});

function makeSensitiveInventoryFixture(): DoctorMemoryInventoryPayload {
  return {
    agentId: "main",
    workspace: {
      path: "/private/fased/workspaces/customer-alpha",
      exists: true,
      memoryRoots: [
        {
          id: "MEMORY.md",
          path: "/private/fased/workspaces/customer-alpha/MEMORY.md",
          exists: false,
          kind: "missing",
        },
        {
          id: "memory.md",
          path: "/private/fased/workspaces/customer-alpha/memory.md",
          exists: false,
          kind: "missing",
        },
        {
          id: "memory-dir",
          path: "/private/fased/workspaces/customer-alpha/memory",
          exists: false,
          kind: "missing",
        },
      ],
    },
    backend: {
      configured: "qmd",
      citations: "auto",
      error: SECRET_TRANSCRIPT_BODY,
    },
    qmd: {
      enabled: true,
      index: {
        path: "/private/fased/state/customer-alpha/qmd/index.sqlite",
        exists: false,
        kind: "missing",
      },
      collections: [
        {
          name: "customer-alpha",
          pattern: "**/*.md",
          collectionKind: "sessions",
          path: "/private/fased/state/customer-alpha/qmd/customer-alpha",
          exists: false,
          kind: "missing",
        },
      ],
      sessions: {
        enabled: true,
        exportDir: {
          path: "/private/fased/state/customer-alpha/qmd/sessions",
          exists: false,
          kind: "missing",
        },
      },
    },
    sessionMemory: {
      hookConfigured: true,
      enabled: true,
      memoryDir: {
        path: "/private/fased/workspaces/customer-alpha/session-memory",
        exists: false,
        kind: "missing",
      },
    },
    memoryPlugin: {
      configuredSlot: "memory-core",
      enabled: false,
      registryLoaded: true,
      reason: "memory-core plugin unavailable",
    },
  };
}
