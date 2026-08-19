import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SatMiningRecentAction,
  SatPlannerCycleRecord,
  SatPlannerOutcomeMemory,
} from "./audit-store.js";
import {
  resolveSatMiningHistoryDatabasePath,
  SatMiningHistoryStore,
  type SatMiningHistoryScope,
} from "./mining-history-store.js";
import {
  claimSatSubmission,
  readSatSubmission,
  setSatSubmissionLedgerAdapterResolver,
  updateSatSubmission,
} from "./submission-ledger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function scope(walletId = "agent", network = "devnet"): SatMiningHistoryScope {
  return {
    walletId,
    authority: `${walletId}-authority`,
    providerId: "local-signer",
    network,
    genesisHash: `${network}-genesis`,
    programId: "sat-program",
    mintAddress: "sat-mint",
    mintProgramId: "token-program",
    manifestDigest: "manifest",
    protocolVersion: "sat-v2",
  };
}

function action(
  cycleId: number,
  at: string,
  overrides: Partial<SatMiningRecentAction> = {},
): SatMiningRecentAction {
  return {
    action: "claim",
    cycleId,
    txHash: `tx-${cycleId}`,
    status: "success",
    complete: true,
    message: null,
    at,
    ...overrides,
  };
}

function outcome(
  cycleId: number,
  recordedAt: string,
  overrides: Partial<SatPlannerOutcomeMemory> = {},
): SatPlannerOutcomeMemory {
  return {
    cycleId,
    committedLamports: String(cycleId * 100),
    totalSatEarnedRaw: String(cycleId * 10),
    totalRebateLamports: String(cycleId),
    txFeeLamports: "5",
    netLiveCostLamports: "95",
    validParticipation: true,
    recordedAt,
    ...overrides,
  };
}

function plannerCycle(
  cycleId: number,
  recordedAt: string,
  overrides: Partial<SatPlannerCycleRecord> = {},
): SatPlannerCycleRecord {
  return {
    cycleId,
    decidedAt: recordedAt,
    recordedAt,
    regimeKey: "balanced",
    timeWindowKey: "morning",
    committedLamports: "100",
    totalSatEarnedRaw: "10",
    totalRebateLamports: "1",
    txFeeLamports: "5",
    netLiveCostLamports: "95",
    score: "1",
    validParticipation: true,
    counterfactuals: [],
    ...overrides,
  };
}

describe("per-wallet Mining history ledger", () => {
  const tempDirs: string[] = [];
  const stores: SatMiningHistoryStore[] = [];

  async function tempState(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sat-mining-ledger-"));
    tempDirs.push(directory);
    return directory;
  }

  async function openStore(params: {
    stateDir: string;
    walletId?: string;
    network?: string;
    migration?: Parameters<typeof SatMiningHistoryStore.open>[0]["migration"];
  }): Promise<Awaited<ReturnType<typeof SatMiningHistoryStore.open>>> {
    const walletId = params.walletId ?? "agent";
    const result = await SatMiningHistoryStore.open({
      databasePath: resolveSatMiningHistoryDatabasePath(params.stateDir, walletId),
      scope: scope(walletId, params.network),
      migration: params.migration,
    });
    stores.push(result.store);
    return result;
  }

  function removeActivationMarker(databasePath: string): void {
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("DELETE FROM mining_meta WHERE key LIKE 'migration-activation:%'").run();
    } finally {
      db.close();
    }
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    setSatSubmissionLedgerAdapterResolver(null);
    for (const store of stores.splice(0)) {
      store.close();
    }
    await Promise.all(
      tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("owns active signer submissions and their transition audit in one SQLite transaction", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir, walletId: "mining" });
    setSatSubmissionLedgerAdapterResolver((walletId) =>
      walletId === store.walletId ? store : null,
    );
    const env = {
      ...process.env,
      FASED_STATE_DIR: stateDir,
      FASED_SAT_SUBMISSION_LEASE_MS: "5000",
    };
    const intentDigest = `sha256:${"ab".repeat(32)}`;
    const first = await claimSatSubmission({
      walletId: "mining",
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:42",
      intentDigest,
      action: "commitCycle",
      owner: "worker-a",
      env,
    });
    const competing = await claimSatSubmission({
      walletId: "mining",
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:42",
      intentDigest,
      action: "commitCycle",
      owner: "worker-b",
      env,
    });
    expect(first).toMatchObject({ created: true, claimed: true });
    expect(competing).toMatchObject({ created: false, claimed: false });

    await updateSatSubmission({
      walletId: "mining",
      requestId: first.record.requestId,
      intentDigest,
      state: "broadcast",
      signature: "signature-42",
      owner: "worker-a",
      env,
    });
    await updateSatSubmission({
      walletId: "mining",
      requestId: first.record.requestId,
      intentDigest,
      state: "confirmed",
      signature: "signature-42",
      owner: "worker-a",
      releaseLease: true,
      env,
    });

    await expect(
      readSatSubmission({
        walletId: "mining",
        requestId: first.record.requestId,
        env,
      }),
    ).resolves.toMatchObject({
      state: "confirmed",
      signature: "signature-42",
      attempts: 1,
    });
    await expect(
      fs.stat(path.join(stateDir, "sat-mining", "wallets", "mining", "submission-ledger.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const inspection = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      expect(
        Number(
          (
            inspection.prepare("SELECT COUNT(*) AS count FROM submission_record").get() as {
              count: number;
            }
          ).count,
        ),
      ).toBe(1);
      expect(
        inspection
          .prepare(
            `SELECT transition_kind, from_state, to_state
               FROM submission_transition
              ORDER BY sequence ASC`,
          )
          .all(),
      ).toEqual([
        { transition_kind: "claim", from_state: null, to_state: "prepared" },
        { transition_kind: "update", from_state: "prepared", to_state: "broadcast" },
        { transition_kind: "update", from_state: "broadcast", to_state: "confirmed" },
      ]);
    } finally {
      inspection.close();
    }
  });

  it("migrates primary and mirror NDJSON once without deleting legacy files", async () => {
    const stateDir = await tempState();
    const primary = path.join(stateDir, "actions.ndjson");
    const mirror = path.join(stateDir, "actions-mirror.ndjson");
    const first = action(1, new Date(Date.now() - DAY_MS).toISOString());
    const second = action(2, new Date().toISOString());
    const content = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
    await fs.writeFile(primary, `${content}{bad json}\n`, "utf8");
    await fs.writeFile(mirror, content, "utf8");

    const { store, migration } = await openStore({
      stateDir,
      migration: {
        sources: [
          { kind: "action", path: primary, label: "actions-primary" },
          { kind: "action", path: mirror, label: "actions-mirror" },
        ],
        runtimeRecentActions: [second],
      },
    });

    expect(migration).toMatchObject({
      importedActions: 2,
      duplicateActions: 3,
      malformedRecords: 1,
      conflictRecords: 0,
      quarantinedRecords: 1,
      sourceCount: 2,
      integrity: "ok",
    });
    expect(migration?.archiveManifestPath).toMatch(/legacy-archive\/migration-/u);
    const archiveManifest = JSON.parse(
      await fs.readFile(String(migration?.archiveManifestPath), "utf8"),
    ) as { sources: Array<{ sourcePath: string; sha256: string; archiveName: string }> };
    expect(archiveManifest.sources.map((entry) => entry.sourcePath).toSorted()).toEqual(
      [primary, mirror].toSorted(),
    );
    for (const source of archiveManifest.sources) {
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(source.archiveName).toMatch(/^\d{3}-/u);
    }
    expect(store.queryActions({ window: "all" }).totalStoredCount).toBe(2);
    expect(await fs.readFile(primary, "utf8")).toContain("{bad json}");
    expect(await fs.readFile(mirror, "utf8")).toBe(content);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await openStore({
      stateDir,
      migration: {
        sources: [{ kind: "action", path: primary, label: "actions-primary" }],
      },
    });
    expect(reopened.migration).toBeNull();
    expect(reopened.store.queryActions({ window: "all" }).totalStoredCount).toBe(2);

    reopened.store.close();
    stores.splice(stores.indexOf(reopened.store), 1);
    const third = action(3, new Date(Date.now() + 1_000).toISOString());
    await fs.appendFile(primary, `${JSON.stringify(third)}\n`, "utf8");
    const converged = await openStore({
      stateDir,
      migration: {
        sources: [{ kind: "action", path: primary, label: "actions-primary" }],
      },
    });
    expect(converged.migration).toBeNull();
    expect(converged.store.queryActions({ window: "all" }).totalStoredCount).toBe(2);
  });

  it("keeps wallet and network histories isolated and supports keyset pagination", async () => {
    const stateDir = await tempState();
    const agent = (await openStore({ stateDir, walletId: "agent", network: "devnet" })).store;
    const vault = (await openStore({ stateDir, walletId: "vault", network: "mainnet" })).store;
    const base = Date.now();
    await agent.appendActions(
      Array.from({ length: 5 }, (_, index) =>
        action(index + 1, new Date(base - index * 1_000).toISOString()),
      ),
    );
    await vault.appendActions([action(99, new Date(base).toISOString())]);

    const firstPage = agent.queryActions({ limit: 2 });
    const secondPage = agent.queryActions({ limit: 2, cursor: firstPage.nextCursor });
    const thirdPage = agent.queryActions({ limit: 2, cursor: secondPage.nextCursor });

    expect(firstPage.actions.map((entry) => entry.cycleId)).toEqual([1, 2]);
    expect(secondPage.actions.map((entry) => entry.cycleId)).toEqual([3, 4]);
    expect(thirdPage.actions.map((entry) => entry.cycleId)).toEqual([5]);
    expect(new Set([...firstPage.actions, ...secondPage.actions, ...thirdPage.actions]).size).toBe(
      5,
    );
    expect(vault.queryActions().actions.map((entry) => entry.cycleId)).toEqual([99]);
    expect(agent.getScope()).toMatchObject({ walletId: "agent", network: "devnet" });
    expect(vault.getScope()).toMatchObject({ walletId: "vault", network: "mainnet" });
  });

  it("retains years of outcomes while returning bounded windows and latest revisions", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    const now = Date.now();
    await store.appendPlannerOutcome(outcome(1, new Date(now - 400 * DAY_MS).toISOString()));
    await store.appendPlannerOutcome(outcome(2, new Date(now - 8 * DAY_MS).toISOString()));
    await store.appendPlannerOutcome(outcome(3, new Date(now - 3 * DAY_MS).toISOString()));
    await store.appendPlannerOutcome(
      outcome(3, new Date(now - DAY_MS).toISOString(), { totalSatEarnedRaw: "999" }),
    );
    await store.appendPlannerCycle(plannerCycle(3, new Date(now - DAY_MS).toISOString()));

    const week = store.queryOutcomes({ window: "7d" });
    const all = store.queryOutcomes({ window: "all" });
    const series = store.querySeries({ window: "all", maxPoints: 2 });

    expect(week.outcomes).toHaveLength(1);
    expect(week.outcomes[0]).toMatchObject({ cycleId: 3, totalSatEarnedRaw: "999" });
    expect(all.outcomes.map((entry) => entry.cycleId)).toEqual([3, 2, 1]);
    expect(all.totalStoredCount).toBe(3);
    expect(series.outcomes.length).toBeLessThanOrEqual(2);
    expect(series.totalStoredOutcomeCount).toBe(3);
    expect(store.readRecentPlannerCycles()).toHaveLength(1);
  });

  it("clears only history and preserves unrelated operational state", async () => {
    const stateDir = await tempState();
    const runtimePath = path.join(stateDir, "runtime-store.json");
    await fs.writeFile(runtimePath, '{"enabledWanted":true}\n', "utf8");
    const { store } = await openStore({ stateDir });
    const operationalState = {
      pendingPlannerCycles: [{ cycleId: 9, stage: "reveal" }],
      roundExecution: [{ roundKey: "9:0", execution: { commitSubmitted: true } }],
      claimBacklog: [{ cycleId: 8, nextClaimPage: 2 }],
      workers: { recovery: { enabled: true, running: true } },
      runtimeMeta: { enabledWanted: true, lastAction: "commitCycle" },
    };
    await store.replaceOperationalState(operationalState);
    await store.replaceAuditArtifacts([
      { roundKey: "9:0", txHash: "tx-9", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await store.upsertSubmissionRecords([
      {
        requestId: "request-9",
        intentDigest: `sha256:${"a".repeat(64)}`,
        state: "unknown",
      },
    ]);
    await store.appendActions([action(1, new Date().toISOString())]);
    await store.appendPlannerOutcome(outcome(1, new Date().toISOString()));
    await store.appendPlannerCycle(plannerCycle(1, new Date().toISOString()));

    await store.clearHistory();

    expect(store.queryActions().totalStoredCount).toBe(0);
    expect(store.queryOutcomes().totalStoredCount).toBe(0);
    expect(store.readRecentPlannerCycles()).toEqual([]);
    expect(store.readOperationalState()).toMatchObject(operationalState);
    expect(store.readAuditArtifacts()).toEqual([
      { roundKey: "9:0", txHash: "tx-9", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(await fs.readFile(runtimePath, "utf8")).toBe('{"enabledWanted":true}\n');
    expect(store.integrityCheck()).toBe("ok");
  });

  it("isolates unprovable legacy history instead of relabeling it to the active deployment", async () => {
    const stateDir = await tempState();
    const primary = path.join(stateDir, "legacy-actions.ndjson");
    await fs.writeFile(primary, `${JSON.stringify(action(7, new Date().toISOString()))}\n`, "utf8");
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
    const result = await SatMiningHistoryStore.open({
      databasePath,
      scope: {
        ...scope(),
        genesisHash: null,
        programId: null,
        mintAddress: null,
        manifestDigest: null,
      },
      migration: {
        sources: [{ kind: "action", path: primary, label: "legacy-action" }],
      },
    });
    stores.push(result.store);

    expect(result.store.queryActions({ window: "all" }).totalStoredCount).toBe(0);
    const legacy = result.store
      .listScopes()
      .find((entry) => entry.scope.network === "legacy-unknown");
    expect(legacy).toBeDefined();
    expect(
      result.store.queryActions({ window: "all", scopeKey: legacy?.scopeKey }).actions,
    ).toMatchObject([{ cycleId: 7 }]);
  });

  it("upgrades the v1 SQLite ledger transactionally without losing history", async () => {
    const stateDir = await tempState();
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    const at = new Date().toISOString();
    const v1ScopeKey = "1".repeat(64);
    const legacyAction = action(41, at);
    const legacyOutcome = outcome(41, at);
    const legacyCycle = plannerCycle(41, at);
    db.exec(`
      CREATE TABLE mining_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE history_scope (
        id INTEGER PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE, wallet_id TEXT NOT NULL,
        authority TEXT, provider_id TEXT, network TEXT NOT NULL, genesis_hash TEXT,
        program_id TEXT, mint_address TEXT, mint_program_id TEXT, manifest_digest TEXT,
        protocol_version TEXT, created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE mining_event (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        scope_id INTEGER NOT NULL REFERENCES history_scope(id), occurred_at_ms INTEGER NOT NULL,
        action TEXT NOT NULL, cycle_id INTEGER, tx_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('success', 'failure')), complete INTEGER,
        message TEXT, source_label TEXT NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE planner_outcome (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        scope_id INTEGER NOT NULL REFERENCES history_scope(id), cycle_id INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL, source_label TEXT NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE planner_cycle (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        scope_id INTEGER NOT NULL REFERENCES history_scope(id), cycle_id INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL, source_label TEXT NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE migration_source (
        source_label TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_kind TEXT NOT NULL,
        source_size INTEGER NOT NULL, source_mtime_ms INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL, valid_records INTEGER NOT NULL,
        duplicate_records INTEGER NOT NULL, malformed_records INTEGER NOT NULL,
        imported_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE corruption_record (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_label TEXT NOT NULL,
        source_path TEXT NOT NULL, line_number INTEGER, byte_offset INTEGER,
        record_sha256 TEXT NOT NULL, reason TEXT NOT NULL, observed_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    db.prepare("INSERT INTO mining_meta(key, value) VALUES('schema_version', '1')").run();
    db.prepare("INSERT INTO mining_meta(key, value) VALUES('history_revision', '3')").run();
    db.prepare(
      `INSERT INTO history_scope(
         id, scope_key, wallet_id, authority, provider_id, network, genesis_hash,
         program_id, mint_address, mint_program_id, manifest_digest, protocol_version,
         created_at_ms
       ) VALUES(1, ?, 'agent', 'agent-authority', 'local-signer', 'devnet',
                'devnet-genesis', 'sat-program', 'sat-mint', 'token-program',
                'manifest', 'sat-v2', ?)`,
    ).run(v1ScopeKey, Date.parse(at));
    db.prepare(
      `INSERT INTO mining_event(
         event_id, scope_id, occurred_at_ms, action, cycle_id, tx_hash, status,
         complete, message, source_label, payload_json
       ) VALUES(
         'v1-action', 1, :occurredAt, :action, :cycleId, :txHash, :status,
         :complete, :message, 'v1', :payload
       )`,
    ).run({
      occurredAt: Date.parse(at),
      action: legacyAction.action,
      cycleId: legacyAction.cycleId ?? null,
      txHash: legacyAction.txHash,
      status: legacyAction.status,
      complete: legacyAction.complete ? 1 : 0,
      message: legacyAction.message ?? null,
      payload: JSON.stringify(legacyAction),
    });
    db.prepare(
      `INSERT INTO planner_outcome(
         event_id, scope_id, cycle_id, recorded_at_ms, source_label, payload_json
       ) VALUES('v1-outcome', 1, ?, ?, 'v1', ?)`,
    ).run(legacyOutcome.cycleId, Date.parse(at), JSON.stringify(legacyOutcome));
    db.prepare(
      `INSERT INTO planner_cycle(
         event_id, scope_id, cycle_id, recorded_at_ms, source_label, payload_json
       ) VALUES('v1-cycle', 1, ?, ?, 'v1', ?)`,
    ).run(legacyCycle.cycleId, Date.parse(at), JSON.stringify(legacyCycle));
    db.close();

    const opened = await openStore({ stateDir });
    expect(
      opened.store.queryActions({ window: "all", scopeKey: v1ScopeKey }).actions,
    ).toMatchObject([{ cycleId: 41 }]);
    expect(
      opened.store.queryOutcomes({ window: "all", scopeKey: v1ScopeKey }).outcomes,
    ).toMatchObject([{ cycleId: 41 }]);
    expect(opened.store.integrityCheck()).toBe("ok");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      inspection.prepare("SELECT value FROM mining_meta WHERE key='schema_version'").get(),
    ).toMatchObject({ value: "2" });
    expect(
      inspection
        .prepare(
          `SELECT binding_id, chain_scope_id
             FROM history_scope
            WHERE scope_key=?`,
        )
        .get(v1ScopeKey),
    ).toMatchObject({
      binding_id: expect.any(Number),
      chain_scope_id: expect.any(Number),
    });
    expect(
      inspection
        .prepare(
          `SELECT logical_key, event_digest
             FROM mining_event
            WHERE event_id='v1-action'`,
        )
        .get(),
    ).toMatchObject({
      logical_key: expect.stringMatching(/^[a-f0-9]{64}$/u),
      event_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    inspection.close();
  });

  it("preserves conflicting legacy facts and records their provenance", async () => {
    const stateDir = await tempState();
    const primary = path.join(stateDir, "actions.ndjson");
    const at = new Date().toISOString();
    await fs.writeFile(
      primary,
      `${JSON.stringify(action(4, at, { complete: false }))}\n${JSON.stringify(
        action(4, at, { complete: true }),
      )}\n`,
      "utf8",
    );
    const { store, migration } = await openStore({
      stateDir,
      migration: {
        sources: [{ kind: "action", path: primary, label: "conflicting-actions" }],
      },
    });

    expect(migration).toMatchObject({ importedActions: 2, conflictRecords: 1 });
    expect(store.queryActions({ window: "all" }).totalStoredCount).toBe(2);
    const inspection = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      expect(
        Number(
          (
            inspection.prepare("SELECT COUNT(*) AS count FROM migration_conflict").get() as {
              count: number;
            }
          ).count,
        ),
      ).toBe(1);
    } finally {
      inspection.close();
    }
  });

  it("uses indexed keyset queries and reports disk pressure without deleting history", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    await store.appendActions([action(1, new Date().toISOString())]);
    await store.appendPlannerOutcome(outcome(1, new Date().toISOString()));

    const plans = store.queryPlans();
    expect(plans.actions).toContain("mining_event_scope_time");
    expect(plans.outcomes).toContain("planner_outcome_scope_time");
    const inspection = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT event_id
               FROM mining_event
              WHERE scope_id=? AND logical_key=? AND event_id<>?
              LIMIT 1`,
          )
          .all(1, "logical-key", "event-id")
          .map((row) => Object.values(row).join(" "))
          .join("\n"),
      ).toContain("mining_event_scope_logical");
    } finally {
      inspection.close();
    }
    await expect(store.diskStatus()).resolves.toMatchObject({
      warning: expect.stringMatching(/^(?:none|low|critical)$/u),
    });
    expect(store.queryActions({ window: "all" }).totalStoredCount).toBe(1);
  });

  it("supports exact time ranges and read-only history access", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    const base = Date.now();
    await store.appendActions([
      action(1, new Date(base - 3_000).toISOString()),
      action(2, new Date(base - 2_000).toISOString()),
      action(3, new Date(base - 1_000).toISOString()),
    ]);
    const selected = store.queryActions({
      fromAt: new Date(base - 2_500).toISOString(),
      toAt: new Date(base - 1_500).toISOString(),
      limit: 10,
    });
    expect(selected.actions.map((entry) => entry.cycleId)).toEqual([2]);

    await store.flush();
    const readOnly = await SatMiningHistoryStore.openReadOnly({
      databasePath: store.databasePath,
      scopeKey: store.getScopeKey(),
    });
    stores.push(readOnly);
    expect(readOnly.queryActions({ window: "all" }).totalStoredCount).toBe(3);
    await expect(readOnly.appendActions([action(4, new Date(base).toISOString())])).rejects.toThrow(
      /read-only/u,
    );
  });

  it("fences late writes, drains prior writes, checkpoints and closes for lifecycle capture", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    await store.appendActions([action(1, new Date().toISOString())]);
    await store.checkpointAndCloseForLifecycle();

    await expect(store.flush()).resolves.toBeUndefined();
    await expect(store.appendActions([action(2, new Date().toISOString())])).rejects.toThrow(
      /fenced for lifecycle checkpoint/u,
    );

    const inspection = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM mining_event").get()).toMatchObject({
        count: 1,
      });
    } finally {
      inspection.close();
    }
  });

  it("retains a contiguous chain prefix only and stops at an active recovery cycle", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    const now = Date.now();
    await store.appendActions([
      action(1, new Date(now - 3_000).toISOString()),
      action(2, new Date(now - 2_000).toISOString()),
      action(3, new Date(now - 1_000).toISOString()),
      action(4, new Date(now).toISOString()),
    ]);
    await store.replaceOperationalState({ pendingPlannerCycles: [{ cycleId: 2 }] });
    const before = new DatabaseSync(store.databasePath, { readOnly: true });
    let retiredDigest = "";
    let protectedPreviousDigest = "";
    try {
      retiredDigest = String(
        (
          before.prepare("SELECT event_digest FROM mining_event WHERE cycle_id=1").get() as {
            event_digest: string;
          }
        ).event_digest,
      );
      protectedPreviousDigest = String(
        (
          before.prepare("SELECT previous_digest FROM mining_event WHERE cycle_id=2").get() as {
            previous_digest: string;
          }
        ).previous_digest,
      );
    } finally {
      before.close();
    }

    const receipt = await store.enforceRetention({ maxActions: 1 });

    expect(receipt).toMatchObject({ prunedActions: 1, protectedCycleCount: 1 });
    expect(store.queryActions({ window: "all" }).actions.map((entry) => entry.cycleId)).toEqual([
      4, 3, 2,
    ]);
    const inspection = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      const anchor = inspection
        .prepare("SELECT value FROM mining_meta WHERE key LIKE 'retention-anchor:%:actions'")
        .get() as { value: string };
      expect(anchor.value).toContain(retiredDigest);
      expect(
        inspection.prepare("SELECT previous_digest FROM mining_event WHERE cycle_id=2").get(),
      ).toMatchObject({ previous_digest: protectedPreviousDigest });
    } finally {
      inspection.close();
    }
  });

  it("bounds audit artifacts deterministically while preserving unresolved-cycle evidence", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    await store.replaceAuditArtifacts([
      { roundKey: "1:0", context: { cycleId: 1 }, updatedAt: "2026-01-01T00:00:00.000Z" },
      { roundKey: "2:0", context: { cycleId: 2 }, updatedAt: "2026-01-02T00:00:00.000Z" },
      { roundKey: "3:0", context: { cycleId: 3 }, updatedAt: "2026-01-03T00:00:00.000Z" },
      { roundKey: "4:0", context: { cycleId: 4 }, updatedAt: "2026-01-04T00:00:00.000Z" },
      { roundKey: "5:0", context: { cycleId: 5 }, updatedAt: "2026-01-05T00:00:00.000Z" },
    ]);
    await store.replaceOperationalState({ pendingPlannerCycles: [{ cycleId: 2 }] });

    const receipt = await store.enforceRetention({ maxAuditArtifacts: 2 });

    expect(receipt).toMatchObject({ prunedAuditArtifacts: 3, protectedCycleCount: 1 });
    expect(
      (store.readAuditArtifacts() as Array<{ roundKey: string }>).map((entry) => entry.roundKey),
    ).toEqual(["2:0", "5:0"]);
    // Rewriting from the retained reader cannot resurrect rows the policy removed.
    await store.replaceAuditArtifacts(store.readAuditArtifacts());
    expect(store.readAuditArtifacts()).toEqual([
      { roundKey: "2:0", context: { cycleId: 2 }, updatedAt: "2026-01-02T00:00:00.000Z" },
      { roundKey: "5:0", context: { cycleId: 5 }, updatedAt: "2026-01-05T00:00:00.000Z" },
    ]);
  });

  it("protects history and audit evidence for a live submission without operational state", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    const now = Date.now();
    await store.upsertSubmissionRecords([
      {
        requestId: "live-42",
        workflowId: "cycle:42:commit",
        operationKey: "commitCycle:42",
        intentDigest: `sha256:${"a".repeat(64)}`,
        walletId: "agent",
        action: "commitCycle",
        state: "broadcast",
        attempts: 1,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ]);
    await store.appendActions([
      action(41, new Date(now - 2_000).toISOString()),
      action(42, new Date(now - 1_000).toISOString()),
      action(43, new Date(now).toISOString()),
    ]);
    await store.replaceAuditArtifacts([
      { roundKey: "41:0", context: { cycleId: 41 }, updatedAt: "2026-01-01T00:00:00.000Z" },
      { roundKey: "42:0", context: { cycleId: 42 }, updatedAt: "2026-01-02T00:00:00.000Z" },
      { roundKey: "43:0", context: { cycleId: 43 }, updatedAt: "2026-01-03T00:00:00.000Z" },
    ]);

    const receipt = await store.enforceRetention({ maxActions: 1, maxAuditArtifacts: 1 });

    expect(receipt.protectedCycleCount).toBe(1);
    expect(store.queryActions({ window: "all" }).actions.map((entry) => entry.cycleId)).toContain(
      42,
    );
    expect(
      (store.readAuditArtifacts() as Array<{ roundKey: string }>).map((entry) => entry.roundKey),
    ).toContain("42:0");
  });

  it("uses durable audit timestamps rather than artifact keys for replacement and retention order", async () => {
    const stateDir = await tempState();
    const { store } = await openStore({ stateDir });
    await store.replaceAuditArtifacts([
      { roundKey: "z-old", updatedAt: "2026-01-01T00:00:00.000Z" },
      { roundKey: "a-new", updatedAt: "2026-01-03T00:00:00.000Z" },
      { roundKey: "m-mid", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    await store.replaceAuditArtifacts([
      { roundKey: "z-old", updatedAt: "2026-01-04T00:00:00.000Z" },
      { roundKey: "a-new", updatedAt: "2026-01-03T00:00:00.000Z" },
      { roundKey: "m-mid", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    await store.enforceRetention({ maxAuditArtifacts: 2 });

    expect(
      (store.readAuditArtifacts() as Array<{ roundKey: string }>).map((entry) => entry.roundKey),
    ).toEqual(["a-new", "z-old"]);
    await expect(store.replaceAuditArtifacts([{ roundKey: "bad" }])).rejects.toThrow(
      /updatedAt is invalid/u,
    );
  });

  it("quarantines only exact stale Mining temp files", async () => {
    const stateDir = await tempState();
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
    const walletDir = path.dirname(databasePath);
    await fs.mkdir(walletDir, { recursive: true });
    const exactTemp = path.join(walletDir, "runtime-store.json.123.456.tmp");
    const unrelated = path.join(walletDir, "my-notes.tmp");
    await fs.writeFile(exactTemp, "stale", "utf8");
    await fs.writeFile(unrelated, "keep", "utf8");
    const old = new Date(Date.now() - 31 * 60 * 1_000);
    await fs.utimes(exactTemp, old, old);

    const { migration } = await openStore({ stateDir });

    expect(migration).toMatchObject({ quarantinedRecords: 1 });
    await expect(fs.stat(exactTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(unrelated, "utf8")).resolves.toBe("keep");
    expect(await fs.readdir(path.join(walletDir, "corruption-quarantine"))).toHaveLength(1);
  });

  it("recovers stale migration staging state deterministically", async () => {
    const stateDir = await tempState();
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(`${databasePath}.migrating`, "interrupted", "utf8");
    await fs.writeFile(
      `${databasePath}.migration.lock`,
      `${JSON.stringify({ schemaVersion: 1, pid: 999_999_999, createdAt: "old" })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 31 * 60 * 1_000);
    await fs.utimes(`${databasePath}.migration.lock`, old, old);

    const { store, migration } = await openStore({ stateDir });

    expect(migration).toMatchObject({ integrity: "ok" });
    expect(store.integrityCheck()).toBe("ok");
    // A legacy fixed staging path is not ours to remove. Fresh publication
    // now owns only a UUID-bound SQLite family.
    await expect(fs.stat(`${databasePath}.migrating`)).resolves.toBeDefined();
    await expect(fs.stat(`${databasePath}.migration.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("archives before fresh import and leaves JSON authoritative when archive creation fails", async () => {
    const stateDir = await tempState();
    const legacy = path.join(stateDir, "legacy-actions.ndjson");
    const unsafe = path.join(stateDir, "unsafe-link.json");
    const record = `${JSON.stringify(action(11, new Date().toISOString()))}\n`;
    await fs.writeFile(legacy, record, "utf8");
    await fs.symlink(legacy, unsafe);
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");

    await expect(
      SatMiningHistoryStore.open({
        databasePath,
        scope: scope(),
        migration: {
          sources: [{ kind: "action", path: legacy, label: "legacy" }],
          preservePaths: [unsafe],
        },
      }),
    ).rejects.toThrow(/Unsafe Mining legacy source/u);
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(legacy, "utf8")).toBe(record);

    const retry = await openStore({
      stateDir,
      migration: { sources: [{ kind: "action", path: legacy, label: "legacy" }] },
    });
    expect(retry.migration).toMatchObject({
      importedActions: 1,
      archiveManifestPath: expect.any(String),
    });
    const inspection = new DatabaseSync(retry.store.databasePath, { readOnly: true });
    try {
      const rows = inspection
        .prepare("SELECT key, value FROM mining_meta WHERE key LIKE 'legacy-archive-receipt:%'")
        .all() as Array<{ key: string; value: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toMatch(/^legacy-archive-receipt:sha256:[a-f0-9]{64}$/u);
      expect(rows[0]?.value).toContain("manifestDigest");
    } finally {
      inspection.close();
    }
  });

  it("rolls an existing import and receipt back together after a DB transaction failure", async () => {
    const stateDir = await tempState();
    const first = await openStore({ stateDir });
    await first.store.appendActions([action(1, new Date().toISOString())]);
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);
    const legacy = path.join(stateDir, "existing-actions.ndjson");
    const record = `${JSON.stringify(action(12, new Date().toISOString()))}\n`;
    await fs.writeFile(legacy, record, "utf8");
    removeActivationMarker(resolveSatMiningHistoryDatabasePath(stateDir, "agent"));
    const circular: { self?: unknown } = {};
    circular.self = circular;

    await expect(
      SatMiningHistoryStore.open({
        databasePath: resolveSatMiningHistoryDatabasePath(stateDir, "agent"),
        scope: scope(),
        migration: {
          sources: [{ kind: "action", path: legacy, label: "existing" }],
          auditArtifacts: [circular],
        },
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(legacy, "utf8")).toBe(record);
    const failed = new DatabaseSync(resolveSatMiningHistoryDatabasePath(stateDir, "agent"), {
      readOnly: true,
    });
    try {
      expect(failed.prepare("SELECT COUNT(*) AS count FROM mining_event").get()).toMatchObject({
        count: 1,
      });
      expect(
        failed
          .prepare("SELECT COUNT(*) AS count FROM migration_source WHERE source_label='existing'")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        failed
          .prepare(
            "SELECT COUNT(*) AS count FROM mining_meta WHERE key LIKE 'legacy-archive-receipt:%'",
          )
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      failed.close();
    }

    const retry = await openStore({
      stateDir,
      migration: { sources: [{ kind: "action", path: legacy, label: "existing" }] },
    });
    expect(retry.migration).toMatchObject({
      importedActions: 1,
      archiveManifestPath: expect.any(String),
    });
    expect(retry.store.queryActions({ window: "all" }).totalStoredCount).toBe(2);
  });

  it("does not alter an existing SQLite ledger when its required archive cannot be created", async () => {
    const stateDir = await tempState();
    const base = await openStore({ stateDir });
    await base.store.appendActions([action(1, new Date().toISOString())]);
    base.store.close();
    stores.splice(stores.indexOf(base.store), 1);
    const legacy = path.join(stateDir, "existing-archive-actions.ndjson");
    const unsafe = path.join(stateDir, "existing-unsafe-link.json");
    const record = `${JSON.stringify(action(13, new Date().toISOString()))}\n`;
    await fs.writeFile(legacy, record, "utf8");
    await fs.symlink(legacy, unsafe);
    removeActivationMarker(resolveSatMiningHistoryDatabasePath(stateDir, "agent"));

    await expect(
      SatMiningHistoryStore.open({
        databasePath: resolveSatMiningHistoryDatabasePath(stateDir, "agent"),
        scope: scope(),
        migration: {
          sources: [{ kind: "action", path: legacy, label: "existing-archive" }],
          preservePaths: [unsafe],
        },
      }),
    ).rejects.toThrow(/Unsafe Mining legacy source/u);
    expect(await fs.readFile(legacy, "utf8")).toBe(record);
    const inspection = new DatabaseSync(resolveSatMiningHistoryDatabasePath(stateDir, "agent"), {
      readOnly: true,
    });
    try {
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM mining_event").get()).toMatchObject({
        count: 1,
      });
      expect(
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM migration_source WHERE source_label='existing-archive'",
          )
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      inspection.close();
    }
  });

  it("fails closed when a reused archive receipt was tampered", async () => {
    const stateDir = await tempState();
    const legacy = path.join(stateDir, "tampered-actions.ndjson");
    await fs.writeFile(legacy, `${JSON.stringify(action(15, new Date().toISOString()))}\n`, "utf8");
    const opened = await openStore({
      stateDir,
      migration: { sources: [{ kind: "action", path: legacy, label: "tampered" }] },
    });
    const databasePath = opened.store.databasePath;
    opened.store.close();
    stores.splice(stores.indexOf(opened.store), 1);
    const tamper = new DatabaseSync(databasePath);
    try {
      tamper
        .prepare(
          "UPDATE mining_meta SET value='tampered' WHERE key LIKE 'legacy-archive-receipt:%'",
        )
        .run();
    } finally {
      tamper.close();
    }
    removeActivationMarker(databasePath);

    await expect(
      SatMiningHistoryStore.open({
        databasePath,
        scope: scope(),
        migration: { sources: [{ kind: "action", path: legacy, label: "tampered" }] },
      }),
    ).rejects.toThrow(/archive receipt mismatch/u);
  });

  it("does not publish a fresh database when import transaction state cannot commit", async () => {
    const stateDir = await tempState();
    const legacy = path.join(stateDir, "fresh-transaction-actions.ndjson");
    const record = `${JSON.stringify(action(14, new Date().toISOString()))}\n`;
    await fs.writeFile(legacy, record, "utf8");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const unrelatedFixedStaging = `${databasePath}.migrating`;
    await fs.writeFile(unrelatedFixedStaging, "preserve\n", "utf8");

    await expect(
      SatMiningHistoryStore.open({
        databasePath,
        scope: scope(),
        migration: {
          sources: [{ kind: "action", path: legacy, label: "fresh-transaction" }],
          auditArtifacts: [circular],
        },
      }),
    ).rejects.toThrow();
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(unrelatedFixedStaging, "utf8")).toBe("preserve\n");
    expect(
      (await fs.readdir(path.dirname(databasePath))).filter((entry) =>
        entry.startsWith(`${path.basename(databasePath)}.migrating-`),
      ),
    ).toEqual([]);
    expect(await fs.readFile(legacy, "utf8")).toBe(record);

    const retry = await openStore({
      stateDir,
      migration: { sources: [{ kind: "action", path: legacy, label: "fresh-transaction" }] },
    });
    expect(retry.migration).toMatchObject({
      importedActions: 1,
      archiveManifestPath: expect.any(String),
    });
  });

  it("imports the verified archive bytes when the original changes after archive publication", async () => {
    const stateDir = await tempState();
    const legacy = path.join(stateDir, "archive-race-actions.ndjson");
    const original = `${JSON.stringify(action(61, "2026-01-01T00:00:00.000Z"))}\n`;
    const mutated = `${JSON.stringify(action(62, "2026-01-02T00:00:00.000Z"))}\n`;
    await fs.writeFile(legacy, original, "utf8");
    let changed = false;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (String(destination).includes("/legacy-archive/migration-") && !changed) {
        changed = true;
        const replacement = path.join(stateDir, "archive-race-replacement.ndjson");
        await fs.writeFile(replacement, mutated, "utf8");
        await fs.unlink(legacy);
        await fs.symlink(replacement, legacy);
      }
    });

    const { store } = await openStore({
      stateDir,
      migration: { sources: [{ kind: "action", path: legacy, label: "archive-race" }] },
    });
    expect(changed).toBe(true);
    expect(store.queryActions({ window: "all" }).actions).toMatchObject([{ cycleId: 61 }]);
    expect(await fs.readFile(legacy, "utf8")).toBe(mutated);
    const inspection = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            "SELECT source_path, source_sha256 FROM migration_source WHERE source_label='archive-race'",
          )
          .get(),
      ).toEqual({ source_path: legacy, source_sha256: expect.any(String) });
    } finally {
      inspection.close();
    }
  });

  it.each(["runtime", "audit", "submission"] as const)(
    "imports only pinned archived %s JSON when its legacy pathname is replaced",
    async (kind) => {
      const stateDir = await tempState();
      const sourcePath = path.join(stateDir, `${kind}-store.json`);
      const originalByKind = {
        runtime: JSON.stringify({
          version: 12,
          recentActions: [action(91, "2026-08-19T00:00:00.000Z")],
          enabledWanted: true,
        }),
        audit: JSON.stringify({
          version: 1,
          artifacts: [{ roundKey: "audit-original", updatedAt: "2026-08-19T00:00:00.000Z" }],
        }),
        submission: JSON.stringify({
          version: 1,
          records: {
            "request-original": {
              requestId: "request-original",
              workflowId: "cycle:91",
              operationKey: "commit:91",
              intentDigest: `sha256:${"91".repeat(32)}`,
              walletId: "agent",
              action: "commitCycle",
              state: "prepared",
              attempts: 1,
              createdAt: "2026-08-19T00:00:00.000Z",
              updatedAt: "2026-08-19T00:00:00.000Z",
            },
          },
        }),
      } as const;
      const replacementByKind = {
        runtime: JSON.stringify({
          version: 12,
          recentActions: [action(92, "2026-08-19T00:00:01.000Z")],
        }),
        audit: JSON.stringify({
          version: 1,
          artifacts: [{ roundKey: "audit-replacement", updatedAt: "2026-08-19T00:00:01.000Z" }],
        }),
        submission: JSON.stringify({
          version: 1,
          records: {
            "request-replacement": {
              requestId: "request-replacement",
              workflowId: "cycle:92",
              operationKey: "commit:92",
              intentDigest: `sha256:${"92".repeat(32)}`,
              walletId: "agent",
              action: "commitCycle",
              state: "prepared",
              attempts: 1,
              createdAt: "2026-08-19T00:00:01.000Z",
              updatedAt: "2026-08-19T00:00:01.000Z",
            },
          },
        }),
      } as const;
      const original = originalByKind[kind];
      await fs.writeFile(sourcePath, original, "utf8");
      const rename = fs.rename.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (String(destination).includes("/legacy-archive/migration-") && !replaced) {
          replaced = true;
          const replacementPath = `${sourcePath}.replacement`;
          await fs.writeFile(replacementPath, replacementByKind[kind], "utf8");
          await fs.unlink(sourcePath);
          await fs.symlink(replacementPath, sourcePath);
        }
      });
      const fileInputs =
        kind === "runtime"
          ? { runtimePath: sourcePath }
          : kind === "audit"
            ? { auditPath: sourcePath }
            : { submissionPath: sourcePath };

      const { store, migration } = await openStore({
        stateDir,
        migration: { fileInputs },
      });
      expect(replaced).toBe(true);
      const manifest = JSON.parse(
        await fs.readFile(String(migration?.archiveManifestPath), "utf8"),
      ) as { sources: Array<{ sourcePath: string; archiveName: string }> };
      const archived = manifest.sources.find((entry) => entry.sourcePath === sourcePath);
      expect(archived).toBeDefined();
      expect(
        await fs.readFile(
          path.join(path.dirname(String(migration?.archiveManifestPath)), archived!.archiveName),
          "utf8",
        ),
      ).toBe(original);
      if (kind === "runtime") {
        expect(store.queryActions({ window: "all" }).actions).toMatchObject([{ cycleId: 91 }]);
      } else if (kind === "audit") {
        expect(store.readAuditArtifacts()).toEqual([
          { roundKey: "audit-original", updatedAt: "2026-08-19T00:00:00.000Z" },
        ]);
      } else {
        await expect(
          store.read({ walletId: "agent", requestId: "request-original" }),
        ).resolves.toMatchObject({ requestId: "request-original" });
      }
    },
  );

  it("cleans a failed archive staging copy and retries safely for fresh and existing ledgers", async () => {
    for (const existing of [false, true]) {
      const stateDir = await tempState();
      if (existing) {
        const base = await openStore({ stateDir });
        await base.store.appendActions([action(70, "2026-01-01T00:00:00.000Z")]);
        base.store.close();
        stores.splice(stores.indexOf(base.store), 1);
      }
      const legacy = path.join(stateDir, `copy-failure-${String(existing)}.ndjson`);
      const preserved = path.join(stateDir, `copy-failure-${String(existing)}.json`);
      const content = `${JSON.stringify(action(71, "2026-01-02T00:00:00.000Z"))}\n`;
      await fs.writeFile(legacy, content, "utf8");
      await fs.writeFile(preserved, "preserve\n", "utf8");
      if (existing) {
        removeActivationMarker(resolveSatMiningHistoryDatabasePath(stateDir, "agent"));
      }
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
        if (String(file).includes("/legacy-archive/migration-")) {
          throw Object.assign(new Error("injected archive copy failure"), { code: "EEXIST" });
        }
        return await writeFile(file, ...args);
      });
      const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
      await expect(
        SatMiningHistoryStore.open({
          databasePath,
          scope: scope(),
          migration: {
            sources: [{ kind: "action", path: legacy, label: "copy-failure" }],
            preservePaths: [preserved],
          },
        }),
      ).rejects.toThrow(/injected archive copy failure/u);
      expect(await fs.readFile(legacy, "utf8")).toBe(content);
      expect(await fs.readFile(preserved, "utf8")).toBe("preserve\n");
      const archiveParent = path.join(path.dirname(databasePath), "legacy-archive");
      const archiveEntries = await fs.readdir(archiveParent).catch(() => []);
      expect(archiveEntries).toEqual([]);
      if (existing) {
        const inspection = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(
            inspection.prepare("SELECT COUNT(*) AS count FROM mining_event").get(),
          ).toMatchObject({
            count: 1,
          });
          expect(
            inspection.prepare("SELECT COUNT(*) AS count FROM migration_source").get(),
          ).toMatchObject({ count: 0 });
        } finally {
          inspection.close();
        }
      } else {
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      vi.restoreAllMocks();
      const retry = await openStore({
        stateDir,
        migration: {
          sources: [{ kind: "action", path: legacy, label: "copy-failure" }],
          preservePaths: [preserved],
        },
      });
      expect(
        retry.store.queryActions({ window: "all" }).actions.map((entry) => entry.cycleId),
      ).toContain(71);
    }
  });

  it("never invokes legacy migration input after a scope-bound SQLite activation", async () => {
    const stateDir = await tempState();
    const legacy = path.join(stateDir, "activation-actions.ndjson");
    await fs.writeFile(legacy, `${JSON.stringify(action(81, "2026-01-01T00:00:00.000Z"))}\n`);
    const first = await openStore({
      stateDir,
      migration: { sources: [{ kind: "action", path: legacy, label: "activation" }] },
    });
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);
    await fs.writeFile(legacy, `${JSON.stringify(action(82, "2026-01-02T00:00:00.000Z"))}\n`);
    const factory = vi.fn(async () => {
      throw new Error("legacy state must not be read after activation");
    });

    const reopened = await SatMiningHistoryStore.open({
      databasePath: resolveSatMiningHistoryDatabasePath(stateDir, "agent"),
      scope: scope(),
      migrationFactory: factory,
    });
    stores.push(reopened.store);
    expect(factory).not.toHaveBeenCalled();
    expect(reopened.migration).toBeNull();
    expect(
      reopened.store.queryActions({ window: "all" }).actions.map((entry) => entry.cycleId),
    ).toEqual([81]);
  });

  it("fails closed for malformed or mismatched migration activation markers", async () => {
    const stateDir = await tempState();
    const opened = await openStore({ stateDir });
    const databasePath = opened.store.databasePath;
    opened.store.close();
    stores.splice(stores.indexOf(opened.store), 1);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        "UPDATE mining_meta SET value='malformed' WHERE key LIKE 'migration-activation:%'",
      ).run();
    } finally {
      db.close();
    }

    await expect(
      SatMiningHistoryStore.open({ databasePath, scope: scope(), migrationFactory: vi.fn() }),
    ).rejects.toThrow(/activation marker is malformed or mismatched/u);
  });

  it("rejects archive-member or manifest mutation after archive publication without activation", async () => {
    for (const mutation of ["member", "manifest"] as const) {
      const stateDir = await tempState();
      const legacy = path.join(stateDir, `published-${mutation}.ndjson`);
      await fs.writeFile(legacy, `${JSON.stringify(action(90, "2026-01-01T00:00:00.000Z"))}\n`);
      const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
      const rename = fs.rename.bind(fs);
      let changed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (String(destination).includes("/legacy-archive/migration-") && !changed) {
          changed = true;
          const archiveDir = String(destination);
          if (mutation === "manifest") {
            await fs.writeFile(path.join(archiveDir, "manifest.json"), "{}\n", "utf8");
          } else {
            const [member] = await fs.readdir(archiveDir);
            const memberPath = path.join(archiveDir, member!);
            const replacement = `${memberPath}.replacement`;
            await fs.writeFile(replacement, await fs.readFile(memberPath));
            await rename(replacement, memberPath);
          }
        }
      });

      await expect(
        SatMiningHistoryStore.open({
          databasePath,
          scope: scope(),
          migration: {
            sources: [{ kind: "action", path: legacy, label: `published-${mutation}` }],
          },
        }),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      vi.restoreAllMocks();
    }
  });

  it("cleans only its UUID staging family when the fresh checkpoint is busy and retries", async () => {
    const stateDir = await tempState();
    const databasePath = resolveSatMiningHistoryDatabasePath(stateDir, "agent");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const unrelated = `${databasePath}.migrating`;
    await fs.writeFile(unrelated, "unrelated\n", "utf8");
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql: string) {
      if (sql.includes("wal_checkpoint(TRUNCATE)")) {
        return { get: () => ({ busy: 1, log: 1, checkpointed: 0 }) } as never;
      }
      return prepare.call(this, sql);
    });

    await expect(SatMiningHistoryStore.open({ databasePath, scope: scope() })).rejects.toThrow(
      /fresh-history WAL checkpoint failed/u,
    );
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated\n");
    expect(
      (await fs.readdir(path.dirname(databasePath))).filter((entry) =>
        entry.startsWith(`${path.basename(databasePath)}.migrating-`),
      ),
    ).toEqual([]);

    vi.restoreAllMocks();
    const retry = await SatMiningHistoryStore.open({ databasePath, scope: scope() });
    stores.push(retry.store);
    expect(retry.store.integrityCheck()).toBe("ok");
  });

  it("reports an existing checkpoint failure without rolling back the committed activation", async () => {
    const stateDir = await tempState();
    const initial = await openStore({ stateDir });
    const databasePath = initial.store.databasePath;
    initial.store.close();
    stores.splice(stores.indexOf(initial.store), 1);
    removeActivationMarker(databasePath);
    const legacy = path.join(stateDir, "checkpoint-existing.ndjson");
    await fs.writeFile(legacy, `${JSON.stringify(action(100, "2026-01-01T00:00:00.000Z"))}\n`);
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql: string) {
      if (sql.includes("wal_checkpoint(TRUNCATE)")) {
        return { get: () => ({ busy: 1, log: 1, checkpointed: 0 }) } as never;
      }
      return prepare.call(this, sql);
    });

    await expect(
      SatMiningHistoryStore.open({
        databasePath,
        scope: scope(),
        migration: { sources: [{ kind: "action", path: legacy, label: "checkpoint-existing" }] },
      }),
    ).rejects.toThrow(/existing-history WAL checkpoint failed/u);
    vi.restoreAllMocks();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM mining_event").get()).toMatchObject({
        count: 1,
      });
      expect(
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM mining_meta WHERE key LIKE 'migration-activation:%'",
          )
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      inspection.close();
    }
    const factory = vi.fn(async () => {
      throw new Error("activation must avoid legacy reread");
    });
    const retry = await SatMiningHistoryStore.open({
      databasePath,
      scope: scope(),
      migrationFactory: factory,
    });
    stores.push(retry.store);
    expect(factory).not.toHaveBeenCalled();
    expect(
      retry.store.queryActions({ window: "all" }).actions.map((entry) => entry.cycleId),
    ).toEqual([100]);
  });

  it("preserves archived failure history in activated SQLite without reading legacy input", async () => {
    const stateDir = await tempState();
    const initial = await openStore({ stateDir });
    const failure = action(111, "2026-01-03T00:00:00.000Z", {
      status: "failure",
      complete: false,
      message: "retained user-visible failure",
    });
    await initial.store.replaceOperationalState({ archivedFailures: [failure] });
    initial.store.close();
    stores.splice(stores.indexOf(initial.store), 1);
    const factory = vi.fn(async () => {
      throw new Error("activated SQLite must not read stale legacy failures");
    });
    const reopened = await SatMiningHistoryStore.open({
      databasePath: initial.store.databasePath,
      scope: scope(),
      migrationFactory: factory,
    });
    stores.push(reopened.store);
    expect(factory).not.toHaveBeenCalled();
    expect(reopened.store.readOperationalState().archivedFailures).toEqual([failure]);
  });

  it("caps archived failures deterministically at migration and SQLite write boundaries", async () => {
    const stateDir = await tempState();
    const runtimePath = path.join(stateDir, "runtime-store.json");
    const base = Date.parse("2026-08-19T00:00:00.000Z");
    const failures = Array.from({ length: 521 }, (_unused, index) => ({
      action: `failure-${index}`,
      txHash: null,
      status: "failure" as const,
      message: `failure ${index}`,
      at: new Date(base + index * 1_000).toISOString(),
    }));
    await fs.writeFile(
      runtimePath,
      JSON.stringify({ version: 12, recentActions: [], archivedFailures: failures }),
      "utf8",
    );
    const opened = await openStore({
      stateDir,
      migration: { fileInputs: { runtimePath } },
    });
    const expectedActions = Array.from(
      { length: 512 },
      (_unused, index) => `failure-${520 - index}`,
    );
    expect(
      opened.store.readOperationalState().archivedFailures?.map((entry) => entry.action),
    ).toEqual(expectedActions);
    const databasePath = opened.store.databasePath;
    opened.store.close();
    stores.splice(stores.indexOf(opened.store), 1);

    const factory = vi.fn(async () => {
      throw new Error("activated SQLite must not read legacy runtime JSON");
    });
    const reopened = await SatMiningHistoryStore.open({
      databasePath,
      scope: scope(),
      migrationFactory: factory,
    });
    stores.push(reopened.store);
    expect(factory).not.toHaveBeenCalled();
    expect(
      reopened.store.readOperationalState().archivedFailures?.map((entry) => entry.action),
    ).toEqual(expectedActions);

    await reopened.store.replaceOperationalState({ archivedFailures: failures.toReversed() });
    expect(
      reopened.store.readOperationalState().archivedFailures?.map((entry) => entry.action),
    ).toEqual(expectedActions);
    reopened.store.close();
    stores.splice(stores.indexOf(reopened.store), 1);
    const final = await SatMiningHistoryStore.open({ databasePath, scope: scope() });
    stores.push(final.store);
    expect(
      final.store.readOperationalState().archivedFailures?.map((entry) => entry.action),
    ).toEqual(expectedActions);
  });

  it("rotates the sole activation marker when rebinding scope and reopens without legacy input", async () => {
    const stateDir = await tempState();
    const initial = await openStore({ stateDir });
    const rebound = scope("agent", "mainnet");
    await initial.store.rebindScope(rebound);
    const databasePath = initial.store.databasePath;
    initial.store.close();
    stores.splice(stores.indexOf(initial.store), 1);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM mining_meta WHERE key LIKE 'migration-activation:%'",
          )
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      inspection.close();
    }
    const factory = vi.fn(async () => {
      throw new Error("rebound SQLite must not read legacy input");
    });
    const reopened = await SatMiningHistoryStore.open({
      databasePath,
      scope: rebound,
      migrationFactory: factory,
    });
    stores.push(reopened.store);
    expect(factory).not.toHaveBeenCalled();
    expect(reopened.store.getScope()).toEqual(rebound);
  });
});
