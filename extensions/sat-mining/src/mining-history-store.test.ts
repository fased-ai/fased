import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    for (const store of stores.splice(0)) {
      store.close();
    }
    await Promise.all(
      tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
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
      sourceCount: 2,
      integrity: "ok",
    });
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
    await store.appendActions([action(1, new Date().toISOString())]);
    await store.appendPlannerOutcome(outcome(1, new Date().toISOString()));
    await store.appendPlannerCycle(plannerCycle(1, new Date().toISOString()));

    await store.clearHistory();

    expect(store.queryActions().totalStoredCount).toBe(0);
    expect(store.queryOutcomes().totalStoredCount).toBe(0);
    expect(store.readRecentPlannerCycles()).toEqual([]);
    expect(await fs.readFile(runtimePath, "utf8")).toBe('{"enabledWanted":true}\n');
    expect(store.integrityCheck()).toBe("ok");
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
