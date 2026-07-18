import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMarketplaceTaskAccessToken,
  withDurableMarketplaceRun,
} from "./federation-marketplace-run-store.js";

describe("durable Marketplace run security", () => {
  const preparedRun = (taskAccessToken: string) => ({
    handle: "@seller@example",
    endpoint: "https://seller.example/a2a",
    offerId: "https://seller.example/offers/fixed",
    walletId: "wallet-agent",
    walletName: "Agent",
    providerId: "local-socket-signer" as const,
    walletAddress: "payer",
    senderHandle: "@buyer@example",
    taskId: "task-1",
    challengeId: "a".repeat(64),
    paymentMemo: `fased:a2a-payment:v1:${"a".repeat(64)}`,
    invoiceId: "invoice-1",
    receiptId: "receipt-1",
    taskAccessToken,
    sourceText: "source",
    requestedOutput: "summary-v0",
    summaryStyle: "plain" as const,
    maxSentences: 2,
    amount: "1000",
    currency: "SOL",
    asset: { kind: "native" as const },
    payeeAddress: "payee",
    issuedAt: "2026-07-17T12:00:00.000Z",
    expiresAt: "2026-07-17T12:10:00.000Z",
    settledAt: "2026-07-17T12:01:00.000Z",
  });

  it("encrypts task access capabilities on disk and decrypts them on resume", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-market-run-"));
    const env = { ...process.env, FASED_STATE_DIR: stateDir };
    const taskAccessToken = createMarketplaceTaskAccessToken();
    try {
      await withDurableMarketplaceRun({
        executionIntentId: "intent-1",
        intent: { operation: "summary" },
        env,
        run: async (context) => {
          context.update({
            status: "payment_pending",
            patch: {
              prepared: preparedRun(taskAccessToken),
            },
          });
        },
      });

      const runDir = path.join(stateDir, "federation", "marketplace-runs");
      const runFile = fs
        .readdirSync(runDir)
        .map((name) => path.join(runDir, name))
        .find((filePath) => filePath.endsWith(".json"));
      expect(runFile).toBeTruthy();
      const stored = fs.readFileSync(runFile!, "utf8");
      expect(stored).not.toContain(taskAccessToken);
      expect(stored).toContain("taskAccessTokenEncrypted");

      await withDurableMarketplaceRun({
        executionIntentId: "intent-1",
        intent: { operation: "summary" },
        env,
        run: async (context) => {
          expect(context.record.prepared?.taskAccessToken).toBe(taskAccessToken);
        },
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("removes the encrypted task capability from terminal records", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-market-run-"));
    const env = { ...process.env, FASED_STATE_DIR: stateDir };
    const taskAccessToken = createMarketplaceTaskAccessToken();
    try {
      await withDurableMarketplaceRun({
        executionIntentId: "intent-terminal",
        intent: { operation: "summary" },
        env,
        run: async (context) => {
          context.update({
            status: "payment_pending",
            patch: { prepared: preparedRun(taskAccessToken) },
          });
          context.update({
            status: "paid",
            patch: { txRef: "tx-ref", payerAddress: "payer" },
          });
          context.update({ status: "task_created" });
          context.update({ status: "completed", patch: { result: { ok: true } } });
        },
      });

      const runDir = path.join(stateDir, "federation", "marketplace-runs");
      const runFile = fs
        .readdirSync(runDir)
        .map((name) => path.join(runDir, name))
        .find((filePath) => filePath.endsWith(".json"));
      const stored = fs.readFileSync(runFile!, "utf8");
      expect(stored).not.toContain(taskAccessToken);
      expect(stored).not.toContain("taskAccessTokenEncrypted");
      expect(stored).toContain("taskAccessTokenRedactedAt");

      await withDurableMarketplaceRun({
        executionIntentId: "intent-terminal",
        intent: { operation: "summary" },
        env,
        run: async (context) => {
          expect(context.record.status).toBe("completed");
          expect(context.record.result).toEqual({ ok: true });
        },
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
