import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
  "utf8",
);
const workerSources = [
  "round-watcher.ts",
  "epoch-service.ts",
  "claim-service.ts",
  "recovery-service.ts",
].map((filename) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), filename), "utf8"));

function bodyAfter(marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  const end = source.indexOf(nextMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("sat-mining SQLite lifecycle boundary", () => {
  it("uses SQLite as the active runtime and audit writer after import", () => {
    const audit = bodyAfter("const persistAuditArtifacts = async (", "const buildAuditDetails");
    const runtime = bodyAfter(
      "const persistRecentActions = async (",
      "const resetWalletScopedRuntimeMemory",
    );

    expect(audit).toContain("historyStore = requireInternalMiningHistoryStore()");
    expect(audit).toContain("await historyStore.replaceAuditArtifacts(artifacts);");
    expect(audit).toContain("await historyStore.enforceDefaultRetentionIfNeeded();");
    expect(audit).toContain("const retainedArtifacts = historyStore.readAuditArtifacts()");
    expect(audit).toContain("state.auditArtifacts = new Map(");
    expect(audit).toMatch(
      /replaceAuditArtifacts\(artifacts\);[\s\S]*?state\.auditArtifacts = new Map\([\s\S]*?\);/u,
    );
    expect(runtime).toContain("historyStore = requireInternalMiningHistoryStore()");
    expect(runtime).toContain("await historyStore.replaceOperationalState(");
    expect(runtime).toMatch(
      /replaceOperationalState\(buildMiningOperationalState\(\)\);\s*await historyStore\.enforceDefaultRetentionIfNeeded\(\);/u,
    );
    expect(audit).not.toContain("writeSatAuditArtifacts");
    expect(runtime).not.toContain("writeSatRecentActions");
  });

  it("fails every registered Mining mutation closed unless the SQLite store is active", () => {
    const mutation = bodyAfter(
      "const registerSatMutationMethod = (",
      "const registerSatSubmissionMethod = (",
    );
    const optionalCapacity = bodyAfter(
      "const ensureMiningDiskCapacityForOptionalCommitment = async () =>",
      "const persistRecentActions = async (",
    );

    expect(mutation).toContain("requireMiningHistoryStore();");
    expect(mutation).not.toContain("miningHistoryStartupFailed");
    expect(optionalCapacity).toContain("const historyStore = requireMiningHistoryStore();");
    expect(optionalCapacity).toContain("await historyStore.diskStatus();");
  });

  it("stops workers before ingress drain and performs Mining checkpoint only after drain", () => {
    const service = bodyAfter('api.registerService({\n      id: "sat-mining"', "});\n  },\n};");
    const stop = bodyAfter("stop: async (ctx) =>", "checkpointForLifecycle: async () =>");
    const checkpoint = service.slice(service.indexOf("checkpointForLifecycle: async () =>"));

    expect(stop).toContain("const terminalHistoryFailure = miningHistoryTransitionFailed;");
    expect(stop).toContain("await stopSatWorkerServices(");
    expect(stop).toContain("terminalHistoryFailure ? { persistRuntimeState: false } : undefined");
    expect(stop).toContain("if (!terminalHistoryFailure) {");
    expect(stop).toContain("await persistRecentActions();");
    expect(stop).not.toContain("await persistRecentActions().catch");
    expect(stop).not.toContain("miningHistoryStore.close()");
    expect(checkpoint).toContain("await store.checkpointAndCloseForLifecycle();");
  });

  it("fences and drains every active worker tick before its final persistence", () => {
    for (const workerSource of workerSources) {
      const start = workerSource.indexOf(
        "stop: async (opts?: { persistRuntimeState?: boolean }) =>",
      );
      const end = workerSource.indexOf("if (opts?.persistRuntimeState !== false)", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const stop = workerSource.slice(start, end);
      expect(stop).toContain("stopping = true;");
      expect(stop).toContain("await activeTick;");
      expect(workerSource.slice(end)).toContain("await persistRuntimeState?.();");
    }
  });
});
