import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.FASED_LIVE_TEST);
const SAT_LIVE = isTruthyEnvValue(process.env.FASED_LIVE_SAT_MINING);
const describeLive = LIVE && SAT_LIVE ? describe : describe.skip;
const LIFECYCLE_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.FASED_LIVE_SAT_MINING_LIFECYCLE_TIMEOUT_MS ?? "900000", 10) ||
    900_000,
);
const TEST_TIMEOUT_MS = LIFECYCLE_TIMEOUT_MS + 120_000;

type GatewayStatus = {
  ok: true;
  status: {
    running: boolean;
    enabledWanted?: boolean;
    drainOnly?: boolean;
    walletId?: string;
    nextAction?: string;
    nextActionDetail?: string;
    currentRunStartedAt?: string | null;
    lastFailure?: string | null;
    recentActions?: Array<{
      action?: string;
      cycleId?: number | null;
      txHash?: string | null;
      status: "success" | "failure";
      at: string;
      message?: string | null;
    }>;
    archivedFailures?: Array<unknown>;
    workers?: Record<string, { waitingReason?: string | null }>;
  };
};

type GatewayWallets = {
  ok: true;
  wallets: Array<{ walletId?: string; solBalanceLamports?: string }>;
  defaultWalletId?: string;
};

type GatewayReadiness = {
  ok: true;
  readiness: {
    ok: boolean;
    selectedWalletId?: string;
    checks: Array<{ key: string; ok: boolean; detail?: string }>;
  };
};

type GatewayStartStop = {
  ok: true;
  started?: boolean;
  stopped?: boolean;
  status: GatewayStatus["status"];
};

async function loadGatewayConfig() {
  const configPath =
    process.env.FASED_CONFIG_PATH?.trim() || path.join(os.homedir(), ".fased", "fased.json");
  const raw = await fs.readFile(configPath, "utf8");
  const cfg = JSON.parse(raw) as {
    gateway?: { port?: number; auth?: { token?: string } };
    plugins?: { entries?: Record<string, { config?: { walletId?: string } }> };
  };
  return {
    token: String(cfg.gateway?.auth?.token ?? "").trim(),
    port: Number(cfg.gateway?.port ?? 18789),
    walletId: String(cfg.plugins?.entries?.["sat-mining"]?.config?.walletId ?? "").trim(),
  };
}

async function gatewayJson<T>(
  port: number,
  token: string,
  path: string,
  method = "GET",
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status >= 500 && isTransientGatewayText(text)) {
          lastError = new Error(`${method} ${path} failed: ${response.status} ${text}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
      }
      return JSON.parse(text) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 11) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    }
  }
  throw lastError ?? new Error(`${method} ${path} failed`);
}

function isTransientGatewayText(text: string): boolean {
  return (
    text.includes("service restart") ||
    text.includes("mining_readiness_failed") ||
    text.includes("gateway timeout") ||
    text.includes("Gateway target:")
  );
}

async function waitForStatus(
  port: number,
  token: string,
  predicate: (status: GatewayStatus["status"]) => boolean,
  timeoutMs = 20_000,
): Promise<GatewayStatus["status"]> {
  const startedAt = Date.now();
  let lastStatus: GatewayStatus["status"] | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const response = await gatewayJson<GatewayStatus>(port, token, "/api/mining/status");
    lastStatus = response.status;
    if (predicate(response.status)) {
      return response.status;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for SAT mining status: ${JSON.stringify(lastStatus)}`);
}

async function waitForLifecycleEvidence(
  port: number,
  token: string,
  sinceMs: number,
  timeoutMs = LIFECYCLE_TIMEOUT_MS,
): Promise<GatewayStatus["status"]> {
  return waitForStatus(
    port,
    token,
    (status) => {
      const successfulActions = status.recentActions ?? [];
      const actionAfterStart = (action: string) =>
        successfulActions.some((entry) => {
          const atMs = Date.parse(entry.at);
          return (
            entry.status === "success" &&
            entry.action === action &&
            Boolean(entry.txHash) &&
            Number.isFinite(atMs) &&
            atMs >= sinceMs - 5_000
          );
        });
      return actionAfterStart("submitCycle") && actionAfterStart("claimCycleRewardsBatch");
    },
    timeoutMs,
  );
}

describeLive("sat mining live", () => {
  it(
    "validates deployed SAT + agent mining runtime path",
    async () => {
      const { token, port, walletId: configuredWalletId } = await loadGatewayConfig();
      expect(token.length).toBeGreaterThan(0);

      const stoppedBeforeStart = await gatewayJson<GatewayStartStop>(
        port,
        token,
        "/api/mining/stop",
        "POST",
      );
      expect(stoppedBeforeStart.stopped).toBe(true);
      await waitForStatus(
        port,
        token,
        (status) =>
          status.drainOnly === true || (!status.running && !(status.enabledWanted ?? false)),
      );

      const wallets = await gatewayJson<GatewayWallets>(port, token, "/api/mining/wallets");
      const walletId = configuredWalletId || String(wallets.defaultWalletId ?? "").trim();
      expect(walletId.length).toBeGreaterThan(0);
      expect(String(wallets.defaultWalletId ?? "").trim()).toBe(walletId);
      expect(
        wallets.wallets.some((entry) => String(entry.walletId ?? "").trim() === walletId),
      ).toBe(true);

      const readiness = await gatewayJson<GatewayReadiness>(
        port,
        token,
        `/api/mining/readiness?walletId=${encodeURIComponent(walletId)}`,
      );
      expect(readiness.readiness.selectedWalletId).toBe(walletId);
      expect(readiness.readiness.checks.find((check) => check.key === "walletSelected")?.ok).toBe(
        true,
      );
      expect(readiness.readiness.checks.find((check) => check.key === "signerReady")?.ok).toBe(
        true,
      );
      expect(readiness.readiness.checks.find((check) => check.key === "rpcReady")?.ok).toBe(true);
      expect(readiness.readiness.checks.find((check) => check.key === "fundingReady")?.ok).toBe(
        true,
      );

      const preStartStatus = await gatewayJson<GatewayStatus>(port, token, "/api/mining/status");
      expect(preStartStatus.status.walletId).toBe(walletId);
      expect(
        preStartStatus.status.drainOnly === true ||
          (!preStartStatus.status.running && !(preStartStatus.status.enabledWanted ?? false)),
      ).toBe(true);

      const startRequestedAtMs = Date.now();
      const started = await gatewayJson<GatewayStartStop>(port, token, "/api/mining/start", "POST");
      expect(started.status.walletId).toBe(walletId);

      const runningStatus = await waitForStatus(
        port,
        token,
        (status) => status.running && (status.enabledWanted ?? false),
      );
      expect(runningStatus.walletId).toBe(walletId);
      expect(typeof runningStatus.currentRunStartedAt).toBe("string");
      expect(runningStatus.lastFailure ?? null).toBeNull();
      expect(runningStatus.nextAction).not.toBe("starting");
      expect(Array.isArray(runningStatus.archivedFailures)).toBe(true);
      if (runningStatus.workers) {
        expect(Object.keys(runningStatus.workers).length).toBeGreaterThan(0);
      }

      try {
        const lifecycleStatus = await waitForLifecycleEvidence(port, token, startRequestedAtMs);
        for (const action of ["submitCycle", "claimCycleRewardsBatch"]) {
          expect(
            lifecycleStatus.recentActions?.some(
              (entry) =>
                entry.status === "success" &&
                entry.action === action &&
                Boolean(entry.txHash) &&
                Date.parse(entry.at) >= startRequestedAtMs - 5_000,
            ) ?? false,
          ).toBe(true);
        }

        const repeatedStatusChecks = await Promise.all([
          gatewayJson<GatewayStatus>(port, token, "/api/mining/status"),
          gatewayJson<GatewayStatus>(port, token, "/api/mining/status"),
          gatewayJson<GatewayStatus>(port, token, "/api/mining/status"),
        ]);
        expect(repeatedStatusChecks.every((entry) => entry.status.running)).toBe(true);
      } finally {
        const stopped = await gatewayJson<GatewayStartStop>(
          port,
          token,
          "/api/mining/stop",
          "POST",
        );
        expect(stopped.stopped).toBe(true);

        const stoppedStatus = await waitForStatus(
          port,
          token,
          (status) =>
            status.drainOnly === true || (!status.running && !(status.enabledWanted ?? false)),
        );
        expect(
          stoppedStatus.drainOnly === true ||
            (!stoppedStatus.running && !(stoppedStatus.enabledWanted ?? false)),
        ).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
