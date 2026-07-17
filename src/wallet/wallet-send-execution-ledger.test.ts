import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";
import {
  beginWalletSendExecution,
  claimWalletSendExecution,
  getWalletSendExecution,
  updateWalletSendExecution,
  walletSendIntentDigest,
} from "./wallet-send-execution-ledger.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-wallet-send-ledger-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, FASED_STATE_DIR: stateDir };
}

describe("wallet send execution ledger", () => {
  it("returns exact retries and rejects execution id collisions", async () => {
    const intentDigest = walletSendIntentDigest({
      chain: "solana",
      to: "destination-a",
      amount: "10",
    });
    const first = await beginWalletSendExecution({
      executionIntentId: "stable-send-1",
      intentDigest,
      walletId: "agent-wallet",
      providerId: "local-socket-signer",
      env: env(),
    });
    const retry = await beginWalletSendExecution({
      executionIntentId: "stable-send-1",
      intentDigest,
      walletId: "agent-wallet",
      providerId: "local-socket-signer",
      env: env(),
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.entry.requestId).toBe(first.entry.requestId);
    await expect(
      beginWalletSendExecution({
        executionIntentId: "stable-send-1",
        intentDigest: walletSendIntentDigest({
          chain: "solana",
          to: "destination-b",
          amount: "10",
        }),
        walletId: "agent-wallet",
        providerId: "local-socket-signer",
        env: env(),
      }),
    ).rejects.toThrow("different immutable intent");
  });

  it("persists unknown and executed reconciliation across ledger reads", async () => {
    const executionIntentId = "ambiguous-send-1";
    await beginWalletSendExecution({
      executionIntentId,
      intentDigest: walletSendIntentDigest({ to: "destination", amount: "11" }),
      walletId: "agent-wallet",
      providerId: "local-socket-signer",
      env: env(),
    });
    await updateWalletSendExecution({
      executionIntentId,
      expectedStates: ["reserved"],
      state: "unknown",
      patch: { reason: "broadcast response was ambiguous", signature: "signature-1" },
      env: env(),
    });
    expect(getWalletSendExecution({ executionIntentId, env: env() })).toMatchObject({
      state: "unknown",
      signature: "signature-1",
    });

    await updateWalletSendExecution({
      executionIntentId,
      expectedStates: ["unknown"],
      state: "executed",
      patch: {
        result: { chain: "solana", txHash: "signature-1", signer: "agent-address" },
      },
      env: env(),
    });
    expect(getWalletSendExecution({ executionIntentId, env: env() })?.state).toBe("executed");
  });

  it("allows only one execution claimant in the process", async () => {
    const release = await claimWalletSendExecution("claim-once-1", env());
    await expect(claimWalletSendExecution("claim-once-1", env())).rejects.toThrow(
      "already in progress",
    );
    await release();
    const releaseAfter = await claimWalletSendExecution("claim-once-1", env());
    await releaseAfter();
  });

  it("fails closed when durable execution identity or terminal evidence is corrupted", async () => {
    const testEnv = env();
    const executionIntentId = "corrupt-send-1";
    await beginWalletSendExecution({
      executionIntentId,
      intentDigest: walletSendIntentDigest({ to: "destination", amount: "12" }),
      walletId: "agent-wallet",
      providerId: "local-socket-signer",
      env: testEnv,
    });
    const ledgerPath = path.join(
      ensureWalletStateDir(testEnv).rootDir,
      "wallet-send-executions.json",
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    ledger.entries[0] = {
      ...ledger.entries[0],
      state: "executed",
      signature: "signature-a",
      result: { chain: "solana", txHash: "signature-b" },
    };
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });

    expect(() => getWalletSendExecution({ executionIntentId, env: testEnv })).toThrow(/unreadable/);
  });
});
