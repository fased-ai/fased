import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateWalletPolicy } from "./wallet-policy-simulation.js";
import { enforceWalletDailyCap } from "./wallet-policy.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

const runtimeConfig: ResolvedWalletRuntimeConfig = {
  enabled: true,
  mode: "managed",
  runtime: "external-custom",
  execution: { mode: "manual" },
  chains: ["solana"],
  service: { host: "127.0.0.1", port: 19444 },
  install: { enabled: false, version: "test" },
  external: { kind: "custom" },
  auth: { mode: "static-token-compat" },
  source: { ref: "test" },
  stack: {
    rootDir: "",
    composePath: "",
    envPath: "",
    projectName: "test",
  },
  policy: {
    capsEnabled: true,
    directSigning: false,
    skillsEnabled: false,
    solana: {
      allowPrograms: [],
      caps: { maxPerTx: 1_000_000_000n, maxDaily: 2_000_000_000n },
      tokenCaps: {},
    },
  },
  toolAccess: {
    mode: "owner-only",
    allowAgents: [],
    allowSkills: [],
    denySkills: [],
    allowSources: [],
  },
};

describe("wallet-policy-simulation", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wallet-policy-sim-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    const walletRoot = path.join(tempDir, "wallet");
    await fs.mkdir(walletRoot, { recursive: true });
    await fs.writeFile(
      path.join(walletRoot, "provider-registry.v1.json"),
      `${JSON.stringify(
        {
          version: 1,
          providers: {
            "local-socket-signer": {
              enabled: true,
              updatedAt: "2026-05-21T00:00:00.000Z",
            },
          },
          wallets: [
            {
              id: "wallet-agent",
              name: "Agent",
              providerId: "local-socket-signer",
              addresses: { solana: "So11111111111111111111111111111111111111112" },
              role: "agent",
              createdAt: "2026-05-21T00:00:00.000Z",
              updatedAt: "2026-05-21T00:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "wallet-agent",
          updatedAt: "2026-05-21T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported wallet chains", () => {
    const simulation = simulateWalletPolicy({
      config: runtimeConfig,
      payload: {
        chain: "unsupported" as never,
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      mode: "manual",
      source: "control-ui",
      env: process.env,
    });

    expect(simulation.ok).toBe(false);
    expect(simulation.decision).toBe("fail");
    expect(simulation.checks).toContainEqual(
      expect.objectContaining({
        id: "wallet.chain",
        status: "fail",
        code: "wallet_chain_unsupported",
      }),
    );
  });

  it("previews daily cap without mutating usage ledger", () => {
    const simulation = simulateWalletPolicy({
      config: runtimeConfig,
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "750000000",
        amountDisplay: "0.75",
        assetSymbol: "SOL",
      },
      mode: "manual",
      source: "control-ui",
      env: process.env,
    });

    expect(simulation.ok).toBe(true);
    expect(simulation.decision).toBe("needs_approval");
    expect(simulation.diff).toMatchObject({
      fromWalletId: "wallet-agent",
      fromRole: "agent",
      amountDisplay: "0.75",
      token: "SOL",
      source: "control-ui",
    });

    const enforced = enforceWalletDailyCap({
      config: runtimeConfig,
      chain: "solana",
      amount: "750000000",
      walletId: "wallet-agent",
      env: process.env,
    });

    expect(enforced).toMatchObject({
      ok: true,
      spentToday: "750000000",
      limit: "2000000000",
    });
  });
});
