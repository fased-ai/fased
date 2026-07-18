import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimDurableA2aPaymentReference,
  issueDurableA2aPaymentChallenge,
  reserveDurableA2aTask,
} from "./a2a-task-store.js";

describe("durable A2A task sender quotas", () => {
  it("atomically enforces the active-task quota across different concurrent task IDs", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-a2a-quota-"));
    const env = { ...process.env, FASED_STATE_DIR: stateDir };
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_, index) =>
          reserveDurableA2aTask({
            taskId: `concurrent-${index}`,
            senderHandle: "@sender@example.test",
            input: { prompt: `task ${index}` },
            env,
          }),
        ),
      );
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(8);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toContain("active task quota exceeded");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("durable A2A payment claims", () => {
  it("is idempotent for one task and rejects cross-task payment replay", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-a2a-payment-"));
    const env = { ...process.env, FASED_STATE_DIR: stateDir };
    try {
      await claimDurableA2aPaymentReference({ taskId: "task-1", txRef: "signature-1", env });
      await claimDurableA2aPaymentReference({ taskId: "task-1", txRef: "signature-1", env });
      await expect(
        claimDurableA2aPaymentReference({ taskId: "task-2", txRef: "signature-1", env }),
      ).rejects.toThrow("already claimed");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prunes expired unclaimed payment challenges before reserving capacity", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-a2a-challenge-retention-"));
    const env = { ...process.env, FASED_STATE_DIR: stateDir };
    const challenge = (taskId: string, nowMs: number) =>
      issueDurableA2aPaymentChallenge({
        taskId,
        senderHandle: "@sender@example.test",
        offerId: "offer-1",
        payerAddress: "payer-address",
        payeeAddress: "payee-address",
        amount: 1,
        currency: "SOL",
        asset: { kind: "native" },
        nowMs,
        env,
      });
    try {
      await challenge("expired-task", Date.parse("2026-07-17T00:00:00.000Z"));
      await challenge("current-task", Date.parse("2026-07-17T00:11:00.000Z"));
      const challengeDir = path.join(stateDir, "federation", "a2a-tasks", ".payment-challenges");
      const files = fs
        .readdirSync(challengeDir)
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
      expect(files).toHaveLength(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
