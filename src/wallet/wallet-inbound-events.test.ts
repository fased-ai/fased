import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendWalletAuditEntry } from "./wallet-audit-log.js";
import {
  listWalletInboundEvents,
  reconcileWalletInboundEvents,
  recordWalletInboundWebhookEvent,
} from "./wallet-inbound-events.js";

const ENV_KEYS = ["FASED_STATE_DIR"] as const;
const BASE_CFG = {
  gateway: { trustedProxies: [] },
  wallet: {
    provider: { id: "embedded-keystore" as const },
  },
};
const BASE_WALLET = {
  enabled: true,
  mode: "external" as const,
  runtime: "external-docker" as const,
  execution: { mode: "manual" as const },
  chains: ["solana"] as const,
  service: { host: "127.0.0.1", port: 19444 },
  install: { enabled: true, version: "0.1.0" },
  external: { kind: "docker" as const },
  stack: {
    rootDir: "/tmp",
    composePath: "/tmp/docker-compose.yml",
    envPath: "/tmp/.env",
    projectName: "fased-wallet",
  },
  policy: {
    directSigning: true,
    solana: { allowPrograms: [], caps: { maxPerTx: 1n, maxDaily: 1n } },
  },
  toolAccess: { mode: "owner-only" as const, allowAgents: [] },
};

async function withTempState(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const prevEnv: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    prevEnv[key] = process.env[key];
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-wallet-inbound-test-"));
  process.env.FASED_STATE_DIR = dir;
  try {
    await run(process.env);
  } finally {
    for (const key of ENV_KEYS) {
      const prev = prevEnv[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe("wallet inbound events", () => {
  afterEach(() => {
    // no-op; kept for symmetry if future globals are added.
  });

  test("records webhook inbound event and returns it in list output", async () => {
    await withTempState(async (env) => {
      const recorded = recordWalletInboundWebhookEvent({
        cfg: BASE_CFG as never,
        wallet: BASE_WALLET as never,
        payload: {
          providerId: "embedded-keystore",
          chain: "solana",
          direction: "inbound",
          amount: "1000",
          txHash: "So11111111111111111111111111111111111111112",
          address: "So11111111111111111111111111111111111111112",
          status: "confirmed",
        },
        env,
        actor: "test-webhook",
      });
      expect(recorded.ok).toBe(true);
      expect(recorded.event.chain).toBe("solana");
      expect(recorded.event.source).toBe("webhook");

      const events = listWalletInboundEvents({
        env,
        providerId: "embedded-keystore",
        limit: 10,
      });
      expect(events.length).toBe(1);
      expect(events[0]?.txHash).toBe("So11111111111111111111111111111111111111112");
      expect(events[0]?.status).toBe("confirmed");
    });
  });

  test("keeps local signer inbound events across ledger reloads", async () => {
    await withTempState(async (env) => {
      recordWalletInboundWebhookEvent({
        cfg: {
          gateway: { trustedProxies: [] },
          wallet: { provider: { id: "local-socket-signer" as const } },
        } as never,
        wallet: BASE_WALLET as never,
        payload: {
          providerId: "local-socket-signer",
          chain: "solana",
          direction: "inbound",
          amount: "2500",
          txHash: "So11111111111111111111111111111111111111113",
          status: "confirmed",
        },
        env,
        actor: "test-webhook",
      });

      const events = listWalletInboundEvents({
        env,
        providerId: "local-socket-signer",
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.providerId).toBe("local-socket-signer");
      expect(events[0]?.amount).toBe("2500");
    });
  });

  test("reconciles inbound event by tx hash against wallet audit entries", async () => {
    await withTempState(async (env) => {
      recordWalletInboundWebhookEvent({
        cfg: BASE_CFG as never,
        wallet: BASE_WALLET as never,
        payload: {
          providerId: "alchemy",
          chain: "solana",
          direction: "outbound",
          amount: "5",
          txHash: "So11111111111111111111111111111111111111112",
          status: "detected",
        },
        env,
        actor: "test-webhook",
      });
      appendWalletAuditEntry({
        action: "send_executed",
        actor: "test-suite",
        details: {
          txHash: "So11111111111111111111111111111111111111112",
          requestId: "req-1",
          providerId: "alchemy",
        },
        env,
      });

      const result = reconcileWalletInboundEvents({ env, limitAuditEntries: 200 });
      expect(result.ok).toBe(true);
      expect(result.reconciled).toBeGreaterThanOrEqual(1);

      const events = listWalletInboundEvents({ env, providerId: "alchemy", limit: 10 });
      expect(events[0]?.status).toBe("reconciled");
      expect(events[0]?.reconciledTo?.requestId).toBe("req-1");
    });
  });

  test("fails closed without replacing corrupt inbound event history", async () => {
    await withTempState(async (env) => {
      const walletRoot = path.join(String(env.FASED_STATE_DIR), "wallet");
      const ledgerPath = path.join(walletRoot, "wallet-inbound-events.v1.json");
      await mkdir(walletRoot, { recursive: true });
      await writeFile(ledgerPath, "{not-json\n", "utf8");

      expect(() => listWalletInboundEvents({ env, limit: 10 })).toThrow(
        "refusing to reset event history",
      );
      await expect(readFile(ledgerPath, "utf8")).resolves.toBe("{not-json\n");
    });
  });
});
