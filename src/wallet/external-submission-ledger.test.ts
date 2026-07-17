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
} from "./external-submission-ledger.js";

const roots: string[] = [];

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

  it("atomically persists 0600 state that survives a fresh read", () => {
    const env = testEnv();
    const identity = createExternalSubmissionKey({
      kind: "jupiter-trigger-create",
      walletId: "agent",
      intent: { inputMint: "A", outputMint: "B", amount: "10" },
    });
    beginExternalSubmission({
      ...identity,
      kind: "jupiter-trigger-create",
      walletId: "agent",
      env,
    });
    updateExternalSubmission({
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

  it("fails closed on corruption without replacing the unreadable ledger", () => {
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
    expect(() =>
      beginExternalSubmission({
        ...identity,
        kind: "jupiter-swap",
        walletId: "agent",
        env,
      }),
    ).toThrow(/unreadable/);
    expect(fs.readFileSync(filePath, "utf8")).toBe("{not-json\n");
  });

  it("allows only one concurrent execution claim for an intent", () => {
    const env = testEnv();
    const release = claimExternalSubmissionExecution("intent-one", env);
    expect(() => claimExternalSubmissionExecution("intent-one", env)).toThrow(/already executing/);
    release();
    const releaseAgain = claimExternalSubmissionExecution("intent-one", env);
    releaseAgain();
  });

  it("binds an explicit intent ID to one immutable semantic intent", () => {
    const env = testEnv();
    const first = createExternalSubmissionKey({
      kind: "jupiter-swap",
      walletId: "agent",
      explicitIntentId: "cron-run-1",
      intent: { inputMint: "A", outputMint: "B", amount: "10" },
    });
    beginExternalSubmission({
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

    expect(() =>
      beginExternalSubmission({
        ...changed,
        kind: "jupiter-swap",
        walletId: "agent",
        env,
      }),
    ).toThrow(/already bound to a different immutable intent/);
  });

  it("preserves the previous ledger when an atomic rename is interrupted", () => {
    const env = testEnv();
    const identity = createExternalSubmissionKey({
      kind: "jupiter-trigger-cancel",
      walletId: "agent",
      intent: { orderId: "order-one" },
    });
    beginExternalSubmission({
      ...identity,
      kind: "jupiter-trigger-cancel",
      walletId: "agent",
      env,
    });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated interrupted rename");
    });
    try {
      expect(() =>
        updateExternalSubmission({
          key: identity.key,
          expectedStates: ["reserved"],
          state: "prepared",
          env,
        }),
      ).toThrow(/simulated interrupted rename/);
    } finally {
      rename.mockRestore();
    }

    expect(getExternalSubmission({ key: identity.key, env })?.state).toBe("reserved");
  });
});
