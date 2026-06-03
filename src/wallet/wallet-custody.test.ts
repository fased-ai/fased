import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  activateWalletCustodyUnlockSession,
  enrollWalletCustodyDevice,
  enforceWalletCustodyForAutonomousSend,
  initializeWalletCustodyCeremony,
  listSplitKeyWalletCustodyStatuses,
  lockWalletCustodyUnlockSessions,
  recoverWalletCustodyPassphrase,
  readWalletCustodyStatus,
  revokeWalletCustodyDevice,
} from "./wallet-custody.js";
import { writeWalletProviderRegistry } from "./wallet-provider-registry.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

vi.mock("./wallet-approval-auth.js", () => ({
  resolveWalletApprovalAuthMode: vi.fn((env?: NodeJS.ProcessEnv) =>
    String(env?.FASED_WALLET_APPROVAL_AUTH ?? "")
      .trim()
      .toLowerCase() === "webauthn"
      ? "webauthn"
      : "none",
  ),
  consumeWalletApprovalGrant: vi.fn((params: { token?: string }) => {
    const token = String(params.token ?? "").trim();
    if (!token) {
      return { ok: false, code: "approval_token_required", message: "missing token" };
    }
    return { ok: true };
  }),
}));

vi.mock("./local-socket-signer-custody.js", () => ({
  lockLocalSignerCustody: vi.fn(async () => ({ active: false, removed: true })),
  unlockLocalSignerCustody: vi.fn(
    async (params: { sessionId: string; host: string; expiresAt: string }) => ({
      active: true,
      sessionId: params.sessionId,
      host: params.host,
      expiresAt: params.expiresAt,
    }),
  ),
}));

const baseWallet: ResolvedWalletRuntimeConfig = {
  enabled: true,
  mode: "external",
  runtime: "external-custom",
  execution: { mode: "autonomous" },
  chains: ["solana"],
  service: { host: "127.0.0.1", port: 19444 },
  install: { enabled: true, version: "0.1.0" },
  external: { kind: "docker" },
  stack: {
    rootDir: "/tmp/wallet-stack",
    composePath: "/tmp/wallet-stack/docker-compose.yml",
    envPath: "/tmp/wallet-stack/.env",
    projectName: "fased-wallet",
  },
  policy: {
    capsEnabled: true,
    directSigning: false,
    skillsEnabled: false,
    solana: {
      allowPrograms: [],
      caps: { maxPerTx: 1n, maxDaily: 1n },
      tokenCaps: {},
    },
  },
  auth: { mode: "jwt-bootstrap", bootstrapUrl: "" },
  source: { ref: "" },
  toolAccess: {
    mode: "owner-only",
    allowAgents: [],
    allowSkills: [],
    denySkills: [],
    allowSources: [],
  },
};

const baseCfg = {
  wallet: {
    provider: { id: "local-socket-signer" },
    runtime: {
      enabled: true,
      mode: "external",
      runtime: "external-custom",
      service: { host: "127.0.0.1", port: 19444 },
    },
  },
} as unknown as FasedAgentConfig;

function splitKeyEnv(tempDir: string) {
  return {
    FASED_STATE_DIR: tempDir,
    FASED_WALLET_CUSTODY_MODE: "split-key",
    FASED_WALLET_CUSTODY_PHASE2_COMPLETE: "yes",
    FASED_WALLET_CUSTODY_PASSKEY_CEREMONY: "1",
    FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION: "1",
    FASED_WALLET_APPROVAL_AUTH: "webauthn",
  } satisfies NodeJS.ProcessEnv;
}

function writeTestWalletRegistry(
  env: NodeJS.ProcessEnv,
  wallets: Array<{
    id: string;
    name: string;
    purpose: "agent" | "vault" | "mining";
    solana?: string;
  }>,
) {
  writeWalletProviderRegistry(
    {
      version: 1,
      providers: {
        "embedded-keystore": { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-04-14T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
      },
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        name: wallet.name,
        providerId: "local-socket-signer",
        addresses: wallet.solana ? { solana: wallet.solana } : undefined,
        metadata: { purpose: wallet.purpose },
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:00.000Z",
      })),
      assignments: {},
      defaultWalletId: wallets.find((wallet) => wallet.purpose === "agent")?.id,
      updatedAt: "2026-04-14T00:00:00.000Z",
    },
    env,
  );
}

describe("wallet custody phase-2", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fased-wallet-custody-test-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("defaults to single-key mode", () => {
    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {},
    });
    expect(status.mode).toBe("single-key");
    expect(status.target.walletId).toBe("default");
    expect(status.unlock.active).toBe(false);
    expect(status.phase2.complete).toBe(false);
    expect(status.phase2.splitKeyEnabled).toBe(false);
  });

  test("split-key flags without ceremony stay scaffold-only", () => {
    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...splitKeyEnv(tempDir),
        FASED_WALLET_CUSTODY_WALLETS: "default",
      },
    });
    expect(status.mode).toBe("split-key-scaffold");
    expect(status.phase2.complete).toBe(false);
    expect(status.ceremony?.initialized).toBe(false);
  });

  test("split-key wallet list does not mark unrelated wallets as split-key", () => {
    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...splitKeyEnv(tempDir),
        FASED_WALLET_CUSTODY_WALLETS: "agent_wallet",
      },
      walletId: "mining-wallet",
    });
    expect(status.mode).toBe("single-key");
    expect(status.phase2.splitKeyEnabled).toBe(false);
  });

  test("split-key custody does not apply to Agent wallets", async () => {
    const env = splitKeyEnv(tempDir);
    writeWalletProviderRegistry(
      {
        version: 1,
        providers: {
          "embedded-keystore": { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
          "local-socket-signer": { enabled: true, updatedAt: "2026-04-14T00:00:00.000Z" },
          alchemy: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
          turnkey: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
          privy: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
        },
        wallets: [
          {
            id: "agent-wallet",
            name: "Agent",
            providerId: "local-socket-signer",
            addresses: { solana: "Agent1111111111111111111111111111111111111" },
            metadata: { purpose: "agent" },
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
          },
        ],
        assignments: {},
        defaultWalletId: "agent-wallet",
        updatedAt: "2026-04-14T00:00:00.000Z",
      },
      env,
    );
    const init = initializeWalletCustodyCeremony({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    expect(init.ok).toBe(true);

    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
      walletId: "agent-wallet",
    });
    expect(status.target.role).toBe("agent");
    expect(status.mode).toBe("single-key");
    expect(status.phase2.splitKeyEnabled).toBe(false);

    const sendGate = await enforceWalletCustodyForAutonomousSend({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
      walletId: "agent-wallet",
      approvalHost: "127.0.0.1",
    });
    expect(sendGate.ok).toBe(true);
  });

  test("custody ceremony init generates share state and device share", () => {
    const result = initializeWalletCustodyCeremony({
      env: splitKeyEnv(tempDir),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.deviceShare.length).toBeGreaterThan(20);
    expect(result.recoveryShare.length).toBeGreaterThan(20);
    expect(fs.existsSync(result.statePath)).toBe(true);
  });

  test("recovery share can reconstruct the custody passphrase", () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }
    const recovered = recoverWalletCustodyPassphrase({
      env,
      recoveryShare: init.recoveryShare,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) {
      return;
    }
    expect(recovered.passphrase.length).toBeGreaterThan(20);
  });

  test("split-key mode becomes active after ceremony init", () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);

    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env,
    });
    expect(status.mode).toBe("split-key-active");
    expect(status.phase2.complete).toBe(true);
    expect(status.ceremony?.initialized).toBe(true);
  });

  test("lists split-key wallets that still require wallet control passkey", () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    expect(init.ok).toBe(true);

    const statuses = listSplitKeyWalletCustodyStatuses({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
    });

    expect(statuses.map((status) => status.target.walletId)).toContain("agent-wallet");
    expect(statuses.every((status) => status.mode !== "single-key")).toBe(true);
  });

  test("ignores stale legacy split-key folders for unknown non-current wallet roles", () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({
      env,
      walletId: "solana-2",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    expect(init.ok).toBe(true);

    const sharePath = path.join(tempDir, "wallet", "custody", "solana-2", "shares.v1.json");
    const staleShare = JSON.parse(fs.readFileSync(sharePath, "utf8")) as Record<string, unknown>;
    staleShare.role = "payment";
    fs.writeFileSync(sharePath, `${JSON.stringify(staleShare, null, 2)}\n`);

    const statuses = listSplitKeyWalletCustodyStatuses({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
    });

    expect(statuses.map((status) => status.target.walletId)).not.toContain("solana-2");
  });

  test("ignores deleted named split-key wallets even when stale custody env remains", () => {
    const env = {
      ...splitKeyEnv(tempDir),
      FASED_WALLET_CUSTODY_WALLETS: "solana_2",
    };
    writeTestWalletRegistry(env, [
      {
        id: "agent",
        name: "Agent",
        purpose: "agent",
        solana: "Agent1111111111111111111111111111111111111",
      },
      {
        id: "vault",
        name: "Vault",
        purpose: "vault",
        solana: "Vault1111111111111111111111111111111111111",
      },
    ]);
    const init = initializeWalletCustodyCeremony({
      env,
      walletId: "solana-2",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    expect(init.ok).toBe(true);

    const statuses = listSplitKeyWalletCustodyStatuses({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
    });

    expect(statuses.map((status) => status.target.walletId)).not.toContain("solana-2");
    expect(statuses.map((status) => status.target.walletId)).not.toContain("solana_2");
  });

  test("autonomous send is blocked without unlock session", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    const result = await enforceWalletCustodyForAutonomousSend({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
      approvalHost: "127.0.0.1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("custody_unlock_required");
  });

  test("unlock session activates with passkey token + device share", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }

    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      deviceShare: init.deviceShare,
    });
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) {
      return;
    }

    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...env,
        FASED_WALLET_CUSTODY_ACTIVE_HOST: "127.0.0.1",
      },
    });
    expect(status.unlock.active).toBe(true);
    expect(status.unlock.sessionId).toBe(unlocked.session.id);
  });

  test("unlock session honors requested ttl within the allowed window", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }

    const before = Date.now();
    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      deviceShare: init.deviceShare,
      ttlSeconds: 60,
    });
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) {
      return;
    }

    const ttlMs = Date.parse(unlocked.session.expiresAt) - before;
    expect(ttlMs).toBeGreaterThanOrEqual(55_000);
    expect(ttlMs).toBeLessThanOrEqual(65_000);
  });

  test("unlock session can stay open until manual lock", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }

    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      deviceShare: init.deviceShare,
      ttlSeconds: 0,
    });
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) {
      return;
    }

    expect(unlocked.session.expiresAt).toBe("9999-12-31T23:59:59.000Z");
    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...env,
        FASED_WALLET_CUSTODY_ACTIVE_HOST: "127.0.0.1",
      },
    });
    expect(status.unlock.active).toBe(true);
  });

  test("autonomous send is allowed with active unlock session", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }
    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      deviceShare: init.deviceShare,
    });
    expect(unlocked.ok).toBe(true);

    const result = await enforceWalletCustodyForAutonomousSend({
      wallet: baseWallet,
      cfg: baseCfg,
      env,
      approvalHost: "127.0.0.1",
    });
    expect(result.ok).toBe(true);
  });

  test("custody lock clears active unlock session", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }
    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      deviceShare: init.deviceShare,
    });
    expect(unlocked.ok).toBe(true);

    const lockResult = await lockWalletCustodyUnlockSessions({
      env,
      host: "127.0.0.1",
    });
    expect(lockResult.ok).toBe(true);
    if (!lockResult.ok) {
      return;
    }
    expect(lockResult.removed).toBeGreaterThanOrEqual(1);

    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...env,
        FASED_WALLET_CUSTODY_ACTIVE_HOST: "127.0.0.1",
      },
    });
    expect(status.unlock.active).toBe(false);
  });

  test("custody lock with invalid host returns validation error", async () => {
    const result = await lockWalletCustodyUnlockSessions({
      env: splitKeyEnv(tempDir),
      host: "://bad host",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("invalid_host");
  });

  test("split-key active requires local signer provider", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env });
    expect(init.ok).toBe(true);
    const result = await enforceWalletCustodyForAutonomousSend({
      wallet: baseWallet,
      cfg: {
        wallet: {
          provider: { id: "alchemy" },
          runtime: {
            enabled: true,
            mode: "external",
            runtime: "external-custom",
            service: { host: "127.0.0.1", port: 19444 },
          },
        },
      } as unknown as FasedAgentConfig,
      env,
      approvalHost: "127.0.0.1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("custody_provider_unsupported");
  });

  test("wallet custody unlocks are isolated per wallet id", async () => {
    const env = splitKeyEnv(tempDir);
    const initA = initializeWalletCustodyCeremony({
      env,
      walletId: "mining-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    const initB = initializeWalletCustodyCeremony({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    expect(initA.ok).toBe(true);
    expect(initB.ok).toBe(true);
    if (!initA.ok || !initB.ok) {
      return;
    }

    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      walletId: "mining-wallet",
      deviceShare: initA.deviceShare,
    });
    expect(unlocked.ok).toBe(true);

    const miningStatus = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...env,
        FASED_WALLET_CUSTODY_ACTIVE_HOST: "127.0.0.1",
      },
      cfg: baseCfg,
      walletId: "mining-wallet",
    });
    const agentStatus = readWalletCustodyStatus({
      wallet: baseWallet,
      env: {
        ...env,
        FASED_WALLET_CUSTODY_ACTIVE_HOST: "127.0.0.1",
      },
      cfg: baseCfg,
      walletId: "agent-wallet",
    });
    expect(miningStatus.unlock.active).toBe(true);
    expect(agentStatus.unlock.active).toBe(false);
  });

  test("reports active unlocks for the current request host", async () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
    });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }

    const unlocked = await activateWalletCustodyUnlockSession({
      host: "example.tailnet.local:8787",
      approvalToken: "approval-token",
      env,
      cfg: baseCfg,
      wallet: baseWallet,
      walletId: "agent-wallet",
      deviceShare: init.deviceShare,
    });
    expect(unlocked.ok).toBe(true);

    const defaultHostStatus = readWalletCustodyStatus({
      wallet: baseWallet,
      env,
      cfg: baseCfg,
      walletId: "agent-wallet",
    });
    const requestHostStatus = readWalletCustodyStatus({
      wallet: baseWallet,
      env,
      cfg: baseCfg,
      walletId: "agent-wallet",
      approvalHost: "example.tailnet.local:8787",
    });
    expect(defaultHostStatus.unlock.active).toBe(false);
    expect(requestHostStatus.unlock.active).toBe(true);
  });

  test("can enroll a second device without rotating recovery share", () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env, walletId: "agent-wallet" });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }
    const enrolled = enrollWalletCustodyDevice({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
      deviceShare: init.deviceShare,
      label: "Laptop 2",
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) {
      return;
    }
    const recovered = recoverWalletCustodyPassphrase({
      env,
      walletId: "agent-wallet",
      deviceShare: enrolled.deviceShare,
    });
    expect(recovered.ok).toBe(true);
    const status = readWalletCustodyStatus({
      wallet: baseWallet,
      env,
      cfg: baseCfg,
      walletId: "agent-wallet",
    });
    expect(status.ceremony?.devices?.length).toBe(2);
    expect(status.ceremony?.devices?.some((device) => device.label === "Laptop 2")).toBe(true);
  });

  test("can revoke one enrolled device while keeping another active", () => {
    const env = splitKeyEnv(tempDir);
    const init = initializeWalletCustodyCeremony({ env, walletId: "agent-wallet" });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }
    const enrolled = enrollWalletCustodyDevice({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
      deviceShare: init.deviceShare,
      label: "Laptop 2",
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) {
      return;
    }
    const statusBefore = readWalletCustodyStatus({
      wallet: baseWallet,
      env,
      cfg: baseCfg,
      walletId: "agent-wallet",
    });
    const secondDeviceId =
      statusBefore.ceremony?.devices?.find((device) => device.label === "Laptop 2")?.id ?? "";
    const revoked = revokeWalletCustodyDevice({
      env,
      walletId: "agent-wallet",
      wallet: baseWallet,
      cfg: baseCfg,
      deviceId: secondDeviceId,
      deviceShare: init.deviceShare,
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) {
      return;
    }
    const stillWorks = recoverWalletCustodyPassphrase({
      env,
      walletId: "agent-wallet",
      deviceShare: init.deviceShare,
    });
    expect(stillWorks.ok).toBe(true);
    const revokedShare = recoverWalletCustodyPassphrase({
      env,
      walletId: "agent-wallet",
      deviceShare: enrolled.deviceShare,
    });
    expect(revokedShare.ok).toBe(false);
    const statusAfter = readWalletCustodyStatus({
      wallet: baseWallet,
      env,
      cfg: baseCfg,
      walletId: "agent-wallet",
    });
    expect(statusAfter.ceremony?.devices?.length).toBe(1);
  });
});
