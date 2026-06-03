import { describe, expect, test } from "vitest";
import { buildWalletCanaryReport } from "./wallet-canary.js";
import type { WalletStatusSnapshot } from "./wallet-status.js";

function baseStatus(): WalletStatusSnapshot {
  return {
    managedMode: true,
    provider: { id: "embedded-keystore" },
    enabled: true,
    mode: "external",
    runtime: "external-docker",
    settlement: {
      class: "real-chain",
      realChainReady: true,
      summary: "ok",
    },
    chains: ["solana"],
    service: {
      host: "127.0.0.1",
      port: 19444,
      healthy: true,
    },
    stack: {
      configured: true,
      composePath: "/tmp/compose.yml",
      envPath: "/tmp/.env",
      runningServices: 6,
      healthy: true,
    },
    policy: {
      executionMode: "manual",
      capsEnabled: true,
      directSigning: true,
      skillsEnabled: false,
      toolAccessMode: "owner-only",
      allowAgents: [],
      solana: { allowPrograms: [], maxPerTx: "1", maxDaily: "10" },
    },
    approvalAuth: {
      mode: "none",
      ready: true,
      passkeyCount: 0,
      notes: [],
      passkeys: [],
      statePath: "/tmp/approval-auth.json",
    },
    custody: {
      mode: "single-key",
      target: {
        walletId: "agent-1",
        role: "agent",
      },
      scope: {
        chains: ["solana"],
        allowPrograms: [],
        solana: { maxPerTx: "1", maxDaily: "10" },
      },
      unlock: {
        active: false,
      },
      phase2: {
        complete: false,
        splitKeyEnabled: false,
        passkeyCeremonyEnabled: false,
        ephemeralReconstructionEnabled: false,
        notes: [],
      },
    },
    paths: {
      rootDir: "/tmp/wallet",
      keysPath: "/tmp/wallet/keys.json",
      pidPath: "/tmp/wallet/pid",
    },
    checkedAt: new Date().toISOString(),
    startupState: "healthy",
    authState: "ok",
    authMode: "jwt-bootstrap",
    authSource: "bootstrap",
    authBootstrap: {},
  };
}

describe("buildWalletCanaryReport", () => {
  test("passes for healthy external real-chain canary state", () => {
    const report = buildWalletCanaryReport({
      status: baseStatus(),
      parity: {
        ok: true,
        configured: true,
        composePath: "/tmp/compose.yml",
        envPath: "/tmp/.env",
        checks: [],
      },
      requireRealChain: true,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "wallet.stack.parity")?.ok).toBe(true);
  });

  test("fails when real-chain required but settlement is not ready", () => {
    const status = baseStatus();
    status.runtime = "external-custom";
    status.settlement.realChainReady = false;
    const report = buildWalletCanaryReport({
      status,
      requireRealChain: true,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "wallet.runtime.real_chain_source")?.ok).toBe(
      true,
    );
    expect(
      report.checks.find((check) => check.id === "wallet.settlement.real_chain_ready")?.ok,
    ).toBe(false);
  });

  test("requires passkey readiness when approval auth mode is webauthn", () => {
    const status = baseStatus();
    status.approvalAuth.mode = "webauthn";
    status.approvalAuth.ready = false;
    const report = buildWalletCanaryReport({ status, requireRealChain: true });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "wallet.approval_auth.ready")?.required).toBe(
      true,
    );
    expect(report.checks.find((check) => check.id === "wallet.approval_auth.ready")?.ok).toBe(
      false,
    );
  });
});
