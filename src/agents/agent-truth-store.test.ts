import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFinancialEvent,
  appendPrivateMemory,
  appendResearchEvent,
  createAgentTruthBackup,
  ensureAgentTruthStores,
  listActivePrivateMemories,
  readAgentTruthSnapshot,
  rebuildPublicEvidenceIndex,
  redactPrivateMemory,
  restoreAgentTruthBackup,
} from "./agent-truth-store.js";

const roots: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-truth-"));
  roots.push(root);
  return { FASED_STATE_DIR: root };
}

function storePath(env: NodeJS.ProcessEnv, agentId: string, name: string): string {
  return path.join(env.FASED_STATE_DIR ?? "", "agent-truth", agentId, name);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent four-store financial truth", () => {
  it("creates four physically separate owner-only stores and encrypts private memory", async () => {
    const env = testEnv();
    await ensureAgentTruthStores({
      agentId: "wally",
      source: "creation",
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    await appendPrivateMemory({
      agentId: "wally",
      eventId: "memory-1",
      memoryId: "owner-preference",
      content: "Never disclose this private preference",
      env,
      now: new Date("2026-09-02T12:01:00.000Z"),
    });

    const names = [
      "private-memory.v1.enc.json",
      "research-provenance.v1.json",
      "objective-financial-ledger.v1.json",
      "public-evidence-index.v1.json",
    ];
    for (const name of names) {
      expect(fs.statSync(storePath(env, "wally", name)).mode & 0o777).toBe(0o600);
    }
    const encrypted = fs.readFileSync(
      storePath(env, "wally", "private-memory.v1.enc.json"),
      "utf8",
    );
    expect(encrypted).toContain("aes-256-gcm");
    expect(encrypted).not.toContain("Never disclose");
    expect(readAgentTruthSnapshot({ agentId: "wally", env }).privateMemory.events).toHaveLength(1);
  });

  it("redacts private memory through an append-only tombstone and never indexes it publicly", async () => {
    const env = testEnv();
    await ensureAgentTruthStores({ agentId: "wally", source: "creation", env });
    const memory = await appendPrivateMemory({
      agentId: "wally",
      eventId: "memory-1",
      memoryId: "preference-1",
      content: "private",
      env,
    });
    await redactPrivateMemory({
      agentId: "wally",
      eventId: "redaction-1",
      memoryId: "preference-1",
      redactsDigest: memory.digest,
      env,
    });

    expect(listActivePrivateMemories({ agentId: "wally", env })).toEqual([]);
    const snapshot = readAgentTruthSnapshot({ agentId: "wally", env });
    expect(snapshot.privateMemory.events).toHaveLength(2);
    expect(snapshot.publicEvidence.entries).toEqual([]);
  });

  it("keeps forecasts and learned strategy generations immutable while appending outcomes and corrections", async () => {
    const env = testEnv();
    await ensureAgentTruthStores({ agentId: "wally", source: "creation", env });
    const forecast = await appendResearchEvent({
      agentId: "wally",
      eventId: "forecast-1",
      kind: "forecast",
      statement: "Channel seven will beat the neutral baseline",
      confidenceBps: 6_000,
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    await appendResearchEvent({
      agentId: "wally",
      eventId: "outcome-1",
      kind: "outcome",
      statement: "Channel seven did not beat neutral",
      correctsEventId: "forecast-1",
      env,
      now: new Date("2026-09-03T12:00:00.000Z"),
    });
    await appendResearchEvent({
      agentId: "wally",
      eventId: "strategy-generation-1",
      kind: "strategy-generation",
      statement: "First evaluated mining strategy generation",
      strategyGeneration: {
        generation: 1,
        inputPeriodStart: "2026-08-01T00:00:00.000Z",
        inputPeriodEnd: "2026-09-01T00:00:00.000Z",
        featureSchemaDigest: "1".repeat(64),
        modelConfigDigest: "2".repeat(64),
        evaluationDigest: "3".repeat(64),
      },
      env,
    });

    const events = readAgentTruthSnapshot({ agentId: "wally", env }).research.events;
    expect(events[0]).toEqual(forecast);
    expect(events).toHaveLength(3);
    await expect(
      appendResearchEvent({
        agentId: "wally",
        eventId: "forecast-1",
        kind: "forecast",
        statement: "rewritten later",
        confidenceBps: 9_000,
        env,
      }),
    ).rejects.toThrow("different immutable event");
  });

  it("accepts objective writers, rejects model writers, and never rewrites settled events", async () => {
    const env = testEnv();
    await ensureAgentTruthStores({ agentId: "wally", source: "creation", env });
    const settled = await appendFinancialEvent({
      agentId: "wally",
      eventId: "mining-receipt-1",
      kind: "mining-receipt",
      writer: "canonical-indexer",
      status: "settled",
      asset: "SAT",
      quantityMinor: "1000000",
      canonicalRef: "solana:signature:abc123",
      publicEvidence: {
        schema: "fased.agent.public-evidence.v1",
        canonicalRef: "solana:signature:abc123",
        summary: "Settled one SAT mining receipt",
        observedAt: "2026-09-02T12:00:00.000Z",
      },
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    expect(settled.writer).toBe("canonical-indexer");
    await expect(
      appendFinancialEvent({
        agentId: "wally",
        eventId: "model-write",
        kind: "order",
        writer: "model" as never,
        status: "pending",
        env,
      }),
    ).rejects.toThrow();
    await expect(
      appendFinancialEvent({
        agentId: "wally",
        eventId: "mining-receipt-1",
        kind: "mining-receipt",
        writer: "canonical-indexer",
        status: "settled",
        asset: "SAT",
        quantityMinor: "2000000",
        canonicalRef: "solana:signature:abc123",
        env,
      }),
    ).rejects.toThrow("different immutable event");
  });

  it("rebuilds the public index only from public source events", async () => {
    const env = testEnv();
    await ensureAgentTruthStores({ agentId: "wally", source: "creation", env });
    await appendResearchEvent({
      agentId: "wally",
      eventId: "private-research",
      kind: "claim",
      statement: "Do not publish",
      env,
    });
    await appendResearchEvent({
      agentId: "wally",
      eventId: "public-research",
      kind: "source",
      sourceRef: "https://example.test/source",
      statement: "Public source observation",
      publicEvidence: {
        schema: "fased.agent.public-evidence.v1",
        canonicalRef: "source:sha256:abc123",
        summary: "Public source observation",
        observedAt: "2026-09-02T12:00:00.000Z",
      },
      env,
    });
    const indexPath = storePath(env, "wally", "public-evidence-index.v1.json");
    fs.unlinkSync(indexPath);
    const rebuilt = await rebuildPublicEvidenceIndex({
      agentId: "wally",
      env,
      now: new Date("2026-09-02T13:00:00.000Z"),
    });
    expect(rebuilt.entries).toHaveLength(1);
    expect(rebuilt.entries[0]?.sourceEventId).toBe("public-research");
    expect(readAgentTruthSnapshot({ agentId: "wally", env }).publicEvidence).toEqual(rebuilt);
  });

  it("fails closed after source-ledger tampering", async () => {
    const env = testEnv();
    await ensureAgentTruthStores({ agentId: "wally", source: "creation", env });
    await appendFinancialEvent({
      agentId: "wally",
      eventId: "deposit-1",
      kind: "deposit",
      writer: "reconciler",
      status: "observed",
      asset: "SOL",
      quantityMinor: "1000000000",
      env,
    });
    const filePath = storePath(env, "wally", "objective-financial-ledger.v1.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      events: Array<{ quantityMinor: string }>;
    };
    parsed.events[0].quantityMinor = "9000000000";
    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    expect(() => readAgentTruthSnapshot({ agentId: "wally", env })).toThrow(
      "refusing financial use",
    );
  });

  it("is idempotent across migration and process restart", async () => {
    const env = testEnv();
    const first = await ensureAgentTruthStores({
      agentId: "wally",
      source: "legacy-migration",
      env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    const second = await ensureAgentTruthStores({
      agentId: "wally",
      source: "creation",
      env,
      now: new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(second).toEqual(first);
    expect(readAgentTruthSnapshot({ agentId: "wally", env })).toEqual(first);
  });

  it("backs up and restores all source stores under a new local encryption key", async () => {
    const sourceEnv = testEnv();
    const targetEnv = testEnv();
    await ensureAgentTruthStores({ agentId: "wally", source: "creation", env: sourceEnv });
    await appendPrivateMemory({
      agentId: "wally",
      eventId: "memory-1",
      memoryId: "owner-preference",
      content: "private restored memory",
      env: sourceEnv,
    });
    await appendFinancialEvent({
      agentId: "wally",
      eventId: "claim-1",
      kind: "claim",
      writer: "canonical-indexer",
      status: "reconciled",
      canonicalRef: "solana:signature:claim1",
      env: sourceEnv,
    });
    const backupPath = path.join(sourceEnv.FASED_STATE_DIR ?? "", "backups", "wally.json");
    createAgentTruthBackup({
      agentId: "wally",
      outputPath: backupPath,
      passphrase: "correct horse battery staple",
      env: sourceEnv,
    });
    expect(fs.readFileSync(backupPath, "utf8")).not.toContain("private restored memory");

    const restored = await restoreAgentTruthBackup({
      inputPath: backupPath,
      passphrase: "correct horse battery staple",
      env: targetEnv,
      now: new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(restored.manifest.source).toBe("restore");
    expect(listActivePrivateMemories({ agentId: "wally", env: targetEnv })[0]?.content).toBe(
      "private restored memory",
    );
    expect(restored.financial.events[0]?.eventId).toBe("claim-1");
    await expect(
      restoreAgentTruthBackup({
        inputPath: backupPath,
        passphrase: "wrong password",
        env: testEnv(),
      }),
    ).rejects.toThrow("backup is unreadable");
  });
});
