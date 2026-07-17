import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginExternalSubmission,
  claimExternalSubmissionExecution,
  createExternalSubmissionKey,
  getExternalSubmission,
  updateExternalSubmission,
  type ExternalSubmissionEntry,
} from "./external-submission-ledger.js";

const roots: string[] = [];

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`child exited code=${code} signal=${signal}: ${stderr}`));
      }
    });
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for child readiness file ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnLedgerChild(script: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-external-submission-"));
  roots.push(root);
  return { ...process.env, FASED_STATE_DIR: root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("external submission ledger", () => {
  it("derives a stable semantic identity independent of object key order", () => {
    const first = createExternalSubmissionKey({
      kind: "jupiter-swap",
      walletId: "agent",
      explicitIntentId: "tool-call-1",
      intent: { outputMint: "B", nested: { amount: "10", inputMint: "A" } },
    });
    const second = createExternalSubmissionKey({
      kind: "jupiter-swap",
      walletId: "agent",
      explicitIntentId: "tool-call-1",
      intent: { nested: { inputMint: "A", amount: "10" }, outputMint: "B" },
    });
    expect(second).toEqual(first);
  });

  it("atomically persists 0600 state that survives a fresh read", async () => {
    const env = testEnv();
    const identity = createExternalSubmissionKey({
      kind: "jupiter-trigger-create",
      walletId: "agent",
      intent: { inputMint: "A", outputMint: "B", amount: "10" },
    });
    await beginExternalSubmission({
      ...identity,
      kind: "jupiter-trigger-create",
      walletId: "agent",
      env,
    });
    await updateExternalSubmission({
      key: identity.key,
      expectedStates: ["reserved"],
      state: "prepared",
      patch: { signerRequestId: "signer-request-1", details: { artifact: "exact" } },
      env,
    });

    expect(getExternalSubmission({ key: identity.key, env })).toMatchObject({
      state: "prepared",
      signerRequestId: "signer-request-1",
      details: { artifact: "exact" },
    });
    const filePath = path.join(String(env.FASED_STATE_DIR), "wallet", "external-submissions.json");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("fails closed on corruption without replacing the unreadable ledger", async () => {
    const env = testEnv();
    const walletDir = path.join(String(env.FASED_STATE_DIR), "wallet");
    const filePath = path.join(walletDir, "external-submissions.json");
    fs.mkdirSync(walletDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "{not-json\n", { mode: 0o600 });
    const identity = createExternalSubmissionKey({
      kind: "jupiter-swap",
      walletId: "agent",
      intent: { amount: "10" },
    });

    expect(() => getExternalSubmission({ key: identity.key, env })).toThrow(/unreadable/);
    await expect(
      beginExternalSubmission({
        ...identity,
        kind: "jupiter-swap",
        walletId: "agent",
        env,
      }),
    ).rejects.toThrow(/unreadable/);
    expect(fs.readFileSync(filePath, "utf8")).toBe("{not-json\n");
  });

  it("allows only one concurrent execution claim for an intent", async () => {
    const env = testEnv();
    const release = await claimExternalSubmissionExecution("intent-one", env);
    await expect(claimExternalSubmissionExecution("intent-one", env)).rejects.toThrow(
      /already executing/,
    );
    await release();
    const releaseAgain = await claimExternalSubmissionExecution("intent-one", env);
    await releaseAgain();
  });

  it("keeps a live cross-process execution owner authoritative even when its lock looks old", async () => {
    const env = testEnv();
    const readyPath = path.join(String(env.FASED_STATE_DIR), "claim-ready");
    const child = spawnLedgerChild(
      `
        const fs = await import("node:fs");
        const { claimExternalSubmissionExecution } = await import("./src/wallet/external-submission-ledger.ts");
        const release = await claimExternalSubmissionExecution("cross-process-intent", process.env);
        fs.writeFileSync(process.env.FASED_TEST_CLAIM_READY, "ready");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await release();
      `,
      { ...env, FASED_TEST_CLAIM_READY: readyPath },
    );
    const exited = waitForChildExit(child);
    await waitForFile(readyPath);

    const claimDigest = createHash("sha256").update("cross-process-intent").digest("hex");
    const lockPath = path.join(
      String(env.FASED_STATE_DIR),
      "wallet",
      ".external-submission-executions",
      `${claimDigest}.lock`,
    );
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ...payload, createdAt: "2000-01-01T00:00:00.000Z" }),
    );
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    await expect(claimExternalSubmissionExecution("cross-process-intent", env)).rejects.toThrow(
      /already executing/,
    );
    await exited;

    const release = await claimExternalSubmissionExecution("cross-process-intent", env);
    await release();
  });

  it("serializes fresh-read ledger mutations across child processes", async () => {
    const env = testEnv();
    const children = Array.from({ length: 8 }, (_, index) => {
      const child = spawnLedgerChild(
        `
          const { beginExternalSubmission, createExternalSubmissionKey } = await import("./src/wallet/external-submission-ledger.ts");
          const index = process.env.FASED_TEST_LEDGER_INDEX;
          const identity = createExternalSubmissionKey({
            kind: "jupiter-swap",
            walletId: "agent",
            explicitIntentId: "child-" + index,
            intent: { amount: String(index), inputMint: "A", outputMint: "B" },
          });
          await beginExternalSubmission({ ...identity, kind: "jupiter-swap", walletId: "agent", env: process.env });
        `,
        { ...env, FASED_TEST_LEDGER_INDEX: String(index) },
      );
      child.stdin.end();
      return waitForChildExit(child);
    });
    await Promise.all(children);

    const filePath = path.join(String(env.FASED_STATE_DIR), "wallet", "external-submissions.json");
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      entries: ExternalSubmissionEntry[];
    };
    expect(persisted.entries).toHaveLength(8);
    expect(new Set(persisted.entries.map((entry) => entry.explicitIntentId)).size).toBe(8);
  });

  it("binds an explicit intent ID to one immutable semantic intent", async () => {
    const env = testEnv();
    const first = createExternalSubmissionKey({
      kind: "jupiter-swap",
      walletId: "agent",
      explicitIntentId: "cron-run-1",
      intent: { inputMint: "A", outputMint: "B", amount: "10" },
    });
    await beginExternalSubmission({
      ...first,
      kind: "jupiter-swap",
      walletId: "agent",
      env,
    });
    const changed = createExternalSubmissionKey({
      kind: "jupiter-swap",
      walletId: "agent",
      explicitIntentId: "cron-run-1",
      intent: { inputMint: "A", outputMint: "C", amount: "10" },
    });

    await expect(
      beginExternalSubmission({
        ...changed,
        kind: "jupiter-swap",
        walletId: "agent",
        env,
      }),
    ).rejects.toThrow(/already bound to a different immutable intent/);
  });

  it("preserves the previous ledger when an atomic rename is interrupted", async () => {
    const env = testEnv();
    const identity = createExternalSubmissionKey({
      kind: "jupiter-trigger-cancel",
      walletId: "agent",
      intent: { orderId: "order-one" },
    });
    await beginExternalSubmission({
      ...identity,
      kind: "jupiter-trigger-cancel",
      walletId: "agent",
      env,
    });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated interrupted rename");
    });
    try {
      await expect(
        updateExternalSubmission({
          key: identity.key,
          expectedStates: ["reserved"],
          state: "prepared",
          env,
        }),
      ).rejects.toThrow(/simulated interrupted rename/);
    } finally {
      rename.mockRestore();
    }

    expect(getExternalSubmission({ key: identity.key, env })?.state).toBe("reserved");
  });
});
