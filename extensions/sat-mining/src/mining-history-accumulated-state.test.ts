import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveSatMiningHistoryDatabasePath,
  SatMiningHistoryStore,
  type SatMiningHistoryScope,
} from "./mining-history-store.js";

const RUN_REALISTIC_GATE = process.env.FASED_SECTION20_REALISTIC === "1";
const ACTIONS_PER_WALLET = 500_000;
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1_000;
const roots: string[] = [];

function scope(walletId: string, network: string): SatMiningHistoryScope {
  return {
    walletId,
    authority: `${walletId}-authority`,
    providerId: "local-socket-signer",
    network,
    genesisHash: `${network}-genesis`,
    programId: `${network}-sat-program`,
    mintAddress: `${network}-sat-mint`,
    mintProgramId: "token-program",
    manifestDigest: `${network}-manifest`,
    protocolVersion: "sat-v2",
  };
}

function actionLine(walletId: string, index: number, at: string, complete = true): string {
  return JSON.stringify({
    action: "settlePage",
    cycleId: index,
    txHash: `${walletId}-tx-${index}`,
    status: "success",
    complete,
    message: null,
    at,
  });
}

async function writeAccumulatedActions(
  filePath: string,
  walletId: string,
): Promise<{ first: string; lastAt: string }> {
  const handle = await fs.open(filePath, "wx", 0o600);
  const start = Date.now() - FIVE_YEARS_MS;
  const step = Math.max(1, Math.floor(FIVE_YEARS_MS / (ACTIONS_PER_WALLET - 1)));
  let first = "";
  let lastAt = "";
  try {
    for (let offset = 0; offset < ACTIONS_PER_WALLET; offset += 5_000) {
      const lines: string[] = [];
      const end = Math.min(ACTIONS_PER_WALLET, offset + 5_000);
      for (let index = offset; index < end; index += 1) {
        const at = new Date(start + index * step).toISOString();
        const line = actionLine(walletId, index, at);
        first ||= line;
        lastAt = at;
        lines.push(line);
      }
      await handle.write(`${lines.join("\n")}\n`);
    }
    await handle.write(`${first}\n`);
    await handle.write(
      `${actionLine(walletId, 0, JSON.parse(first).at, false)}\n{malformed-json}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { first, lastAt };
}

async function exerciseWallet(params: {
  stateDir: string;
  walletId: string;
  network: string;
}): Promise<{ databasePath: string; rows: number }> {
  const walletDir = path.dirname(
    resolveSatMiningHistoryDatabasePath(params.stateDir, params.walletId),
  );
  await fs.mkdir(walletDir, { recursive: true });
  const primary = path.join(walletDir, "action-history.ndjson");
  const mirror = path.join(walletDir, "action-history.mirror.ndjson");
  const generated = await writeAccumulatedActions(primary, params.walletId);
  await fs.writeFile(mirror, `${generated.first}\n`, { mode: 0o600 });
  const staleTemp = path.join(walletDir, "runtime-store.json.999999.1.tmp");
  await fs.writeFile(staleTemp, "interrupted-write\n", { mode: 0o600 });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await fs.utimes(staleTemp, old, old);

  const databasePath = resolveSatMiningHistoryDatabasePath(params.stateDir, params.walletId);
  const opened = await SatMiningHistoryStore.open({
    databasePath,
    scope: scope(params.walletId, params.network),
    migration: {
      sources: [
        { kind: "action", path: primary, label: `${params.walletId}-primary` },
        { kind: "action", path: mirror, label: `${params.walletId}-mirror` },
      ],
      operationalState: {
        pendingPlannerCycles: [{ cycleId: ACTIONS_PER_WALLET + 1, stage: "reveal" }],
        roundExecution: [{ roundKey: `${ACTIONS_PER_WALLET + 1}:0`, commitSubmitted: true }],
        claimBacklog: [{ cycleId: ACTIONS_PER_WALLET, nextClaimPage: 2 }],
        workers: { recovery: { enabled: true, running: false } },
      },
      submissionRecords: [
        {
          requestId: `${params.walletId}-active-request`,
          intentDigest: `sha256:${"a".repeat(64)}`,
          state: "unknown",
        },
      ],
    },
  });
  try {
    expect(opened.migration).toMatchObject({
      importedActions: ACTIONS_PER_WALLET + 1,
      duplicateActions: 2,
      malformedRecords: 1,
      conflictRecords: 2,
      quarantinedRecords: 2,
      sourceCount: 2,
      integrity: "ok",
    });
    expect(opened.store.integrityCheck()).toBe("ok");
    expect(opened.store.queryActions({ window: "all", limit: 200 })).toMatchObject({
      totalStoredCount: ACTIONS_PER_WALLET + 1,
      hasMore: true,
      actions: expect.any(Array),
    });
    expect(opened.store.readOperationalState()).toMatchObject({
      pendingPlannerCycles: [{ cycleId: ACTIONS_PER_WALLET + 1, stage: "reveal" }],
      claimBacklog: [{ cycleId: ACTIONS_PER_WALLET, nextClaimPage: 2 }],
    });
    await opened.store.rebindScope(scope(params.walletId, `${params.network}-next`));
    await opened.store.appendActions([
      {
        action: "claim",
        cycleId: ACTIONS_PER_WALLET + 2,
        txHash: `${params.walletId}-next-scope`,
        status: "success",
        complete: true,
        message: null,
        at: generated.lastAt,
      },
    ]);
    expect(opened.store.listScopes()).toHaveLength(2);
  } finally {
    opened.store.close();
  }
  const stat = await fs.stat(databasePath);
  expect(stat.size).toBeGreaterThan(16 * 1024 * 1024);
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = Number(
      (
        inspection.prepare("SELECT COUNT(*) AS count FROM mining_event").get() as {
          count: number;
        }
      ).count,
    );
    expect(rows).toBe(ACTIONS_PER_WALLET + 2);
    expect(
      Number(
        (
          inspection.prepare("SELECT COUNT(*) AS count FROM submission_record").get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(1);
    return { databasePath, rows };
  } finally {
    inspection.close();
  }
}

describe("Section 20 realistic accumulated Mining state", () => {
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it.runIf(RUN_REALISTIC_GATE)(
    "migrates five years and one million events across Wallet and deployment scopes",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-mining-five-years-"));
      roots.push(stateDir);
      const results = [];
      for (const [walletId, network] of [
        ["mining", "devnet"],
        ["mining-2", "mainnet-beta"],
      ] as const) {
        results.push(await exerciseWallet({ stateDir, walletId, network }));
      }
      expect(results.reduce((total, entry) => total + entry.rows, 0)).toBe(1_000_000 + 4);
    },
    20 * 60_000,
  );
});
