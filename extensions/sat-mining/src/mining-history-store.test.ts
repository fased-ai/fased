import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

  afterEach(async () => {
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
    expect(converged.migration).toMatchObject({ importedActions: 1, integrity: "ok" });
    expect(converged.store.queryActions({ window: "all" }).totalStoredCount).toBe(3);
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
    await store.replaceAuditArtifacts([{ roundKey: "9:0", txHash: "tx-9" }]);
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
    expect(store.readAuditArtifacts()).toEqual([{ roundKey: "9:0", txHash: "tx-9" }]);
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
    await expect(fs.stat(`${databasePath}.migrating`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${databasePath}.migration.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
