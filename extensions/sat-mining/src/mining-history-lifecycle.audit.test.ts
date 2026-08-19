import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
  "utf8",
);

function bodyAfter(marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  const end = source.indexOf(nextMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("sat-mining SQLite lifecycle boundary", () => {
  it("uses SQLite as the active runtime and audit writer after import", () => {
    const audit = bodyAfter("const persistAuditArtifacts = async () =>", "const buildAuditDetails");
    const runtime = bodyAfter(
      "const persistRecentActions = async () =>",
      "const resetWalletScopedRuntimeMemory",
    );

    expect(audit).toContain("await miningHistoryStore.replaceAuditArtifacts(artifacts);");
    expect(audit).toContain("await miningHistoryStore.enforceDefaultRetentionIfNeeded();");
    expect(audit).toContain("const retainedArtifacts = miningHistoryStore.readAuditArtifacts()");
    expect(audit).toContain("state.auditArtifacts = new Map(");
    expect(audit).toMatch(
      /replaceAuditArtifacts\(artifacts\);[\s\S]*?state\.auditArtifacts = new Map\([\s\S]*?\);\s*return;/u,
    );
    expect(runtime).toContain("await miningHistoryStore.replaceOperationalState(");
    expect(runtime).toMatch(
      /replaceOperationalState\(buildMiningOperationalState\(\)\);\s*await miningHistoryStore\.enforceDefaultRetentionIfNeeded\(\);\s*return;/u,
    );
  });

  it("stops workers before ingress drain and performs Mining checkpoint only after drain", () => {
    const service = bodyAfter('api.registerService({\n      id: "sat-mining"', "});\n  },\n};");
    const stop = bodyAfter("stop: async (ctx) =>", "checkpointForLifecycle: async () =>");
    const checkpoint = service.slice(service.indexOf("checkpointForLifecycle: async () =>"));

    expect(stop).toContain("await stopSatWorkerServices();");
    expect(stop).toContain("await persistRecentActions();");
    expect(stop).not.toContain("await persistRecentActions().catch");
    expect(stop).not.toContain("miningHistoryStore.close()");
    expect(checkpoint).toContain("await store.checkpointAndCloseForLifecycle();");
  });
});
