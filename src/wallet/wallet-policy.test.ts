import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSatBondProgramIdFromEnv } from "../config/sat-runtime-ids.js";
import {
  enforceWalletDailyCap,
  resolveWalletPolicyConfig,
  resolveWalletRecurringTransferPolicy,
  resolveWalletRoleForId,
  resolveWalletRolePolicyProfile,
  upsertWalletPolicyConfig,
  validateWalletTxPolicy,
} from "./wallet-policy.js";

const runtimeConfig = {
  enabled: true,
  mode: "managed",
  runtime: "external-custom",
  chains: ["solana"],
  policy: {
    capsEnabled: true,
    directSigning: true,
    skillsEnabled: false,
    solana: {
      allowPrograms: ["2qwAVnGmFakeMint111111111111111111kg1jVfP7"],
      caps: { maxPerTx: 1_000_000_000n, maxDaily: 2_000_000_000n },
    },
  },
  toolAccess: {
    mode: "owner-only",
    allowAgents: [],
    allowSkills: [],
    denySkills: [],
    allowSources: [],
  },
} as const;

describe("wallet-policy", () => {
  let tempDir = "";

  async function writeProviderRegistry(input: {
    defaultWalletId?: string;
    wallets: Array<{ id: string; name: string; role?: "agent" | "mining" | "vault" }>;
  }) {
    const walletRoot = path.join(tempDir, "wallet");
    await fs.mkdir(walletRoot, { recursive: true });
    await fs.writeFile(
      path.join(walletRoot, "provider-registry.v1.json"),
      `${JSON.stringify(
        {
          version: 1,
          providers: {
            "embedded-keystore": { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
            "local-socket-signer": { enabled: true, updatedAt: "2026-04-14T00:00:00.000Z" },
            alchemy: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
            turnkey: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
            privy: { enabled: false, updatedAt: "2026-04-14T00:00:00.000Z" },
          },
          wallets: input.wallets.map((wallet) => ({
            id: wallet.id,
            name: wallet.name,
            providerId: "local-socket-signer",
            addresses: { solana: `${wallet.id}-solana` },
            ...(wallet.role ? { metadata: { role: wallet.role } } : {}),
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
          })),
          assignments: {},
          defaultWalletId: input.defaultWalletId,
          updatedAt: "2026-04-14T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wallet-policy-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_SAT_PROGRAM_ID", "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75");
    vi.stubEnv("FASED_SAT_MINT_ADDRESS", "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa");
    vi.stubEnv("FASED_SAT_MINT_PROGRAM_ID", "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps native Solana per-tx caps for SOL sends", () => {
    const result = validateWalletTxPolicy({
      config: runtimeConfig as never,
      action: "send",
      chain: "solana",
      amount: "1000000001",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "wallet_cap_per_tx_exceeded",
    });
  });

  it("denies program and token execution when the allowlist is empty", () => {
    const result = validateWalletTxPolicy({
      config: {
        ...runtimeConfig,
        policy: {
          ...runtimeConfig.policy,
          solana: { ...runtimeConfig.policy.solana, allowPrograms: [] },
        },
      } as never,
      action: "send",
      chain: "solana",
      amount: "1",
      program: "2qwAVnGmFakeMint111111111111111111kg1jVfP7",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "wallet_program_allowlist_required",
    });
  });

  it("skips SOL and SPL cap checks when caps are off", () => {
    const uncappedConfig = {
      ...runtimeConfig,
      policy: {
        ...runtimeConfig.policy,
        capsEnabled: false,
      },
    };

    expect(
      validateWalletTxPolicy({
        config: uncappedConfig as never,
        action: "send",
        chain: "solana",
        amount: "999999999999999999",
      }),
    ).toEqual({ ok: true });

    expect(
      validateWalletTxPolicy({
        config: uncappedConfig as never,
        action: "send",
        chain: "solana",
        amount: "999999999999999999",
        program: "2qwAVnGmFakeMint111111111111111111kg1jVfP7",
        requireSolanaTokenCap: true,
      }),
    ).toEqual({ ok: true });
  });

  it("can bypass native Solana caps for reviewed mining operator sends", () => {
    const result = validateWalletTxPolicy({
      config: runtimeConfig as never,
      action: "send",
      chain: "solana",
      amount: "999999999999999999",
      skipNativeSolanaCaps: true,
    });

    expect(result).toEqual({ ok: true });
  });

  it("does not apply SOL-denominated per-tx caps to SPL token sends", () => {
    const result = validateWalletTxPolicy({
      config: runtimeConfig as never,
      action: "send",
      chain: "solana",
      amount: "999999999999999999",
      program: "2qwAVnGmFakeMint111111111111111111kg1jVfP7",
    });

    expect(result).toEqual({ ok: true });
  });

  it("does not accrue SPL token sends against the native Solana daily cap", () => {
    const result = enforceWalletDailyCap({
      config: runtimeConfig as never,
      chain: "solana",
      amount: "999999999999999999",
      program: "2qwAVnGmFakeMint111111111111111111kg1jVfP7",
      env: process.env,
    });

    expect(result).toEqual({ ok: true });
  });

  it("can bypass native Solana daily caps for reviewed mining operator sends", () => {
    const result = enforceWalletDailyCap({
      config: runtimeConfig as never,
      chain: "solana",
      amount: "999999999999999999",
      walletId: "wallet-mining",
      env: process.env,
      skipNativeSolanaCaps: true,
    });

    expect(result).toEqual({ ok: true });
  });

  it("tracks daily caps independently per wallet id", () => {
    const first = enforceWalletDailyCap({
      config: runtimeConfig as never,
      chain: "solana",
      amount: "1500000000",
      walletId: "wallet-agent",
      env: process.env,
    });
    const second = enforceWalletDailyCap({
      config: runtimeConfig as never,
      chain: "solana",
      amount: "1500000000",
      walletId: "wallet-vault",
      env: process.env,
    });
    const third = enforceWalletDailyCap({
      config: runtimeConfig as never,
      chain: "solana",
      amount: "600000000",
      walletId: "wallet-agent",
      env: process.env,
    });

    expect(first).toMatchObject({ ok: true, spentToday: "1500000000" });
    expect(second).toMatchObject({ ok: true, spentToday: "1500000000" });
    expect(third).toMatchObject({
      ok: false,
      code: "wallet_cap_daily_exceeded",
      spentToday: "1500000000",
    });
  });

  it("resolves role defaults and persisted overrides per wallet", async () => {
    await writeProviderRegistry({
      defaultWalletId: "wallet-agent",
      wallets: [
        { id: "wallet-agent", name: "Agent" },
        { id: "wallet-mining", name: "Mining" },
        { id: "wallet-vault", name: "Vault" },
      ],
    });
    const cfg = {
      wallet: {
        runtime: {
          chains: ["solana"],
          policy: {
            directSigning: true,
            solana: {
              maxPerTx: "2500000000",
              maxDaily: "9000000000",
            },
          },
        },
      },
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "wallet-mining",
            },
          },
        },
      },
    } as never;

    const miningDefault = resolveWalletPolicyConfig(cfg, process.env, "wallet-mining");
    const agentDefault = resolveWalletPolicyConfig(cfg, process.env, "wallet-agent");
    const vaultDefault = resolveWalletPolicyConfig(cfg, process.env, "wallet-vault");

    expect(miningDefault.policy.directSigning).toBe(true);
    expect(miningDefault.policy.capsEnabled).toBe(false);
    expect(miningDefault.policy.skillsEnabled).toBe(false);
    expect(miningDefault.policy.solana.caps.maxPerTx).toBe(0n);
    expect(agentDefault.policy.directSigning).toBe(true);
    expect(agentDefault.policy.capsEnabled).toBe(true);
    expect(agentDefault.policy.skillsEnabled).toBe(false);
    expect(agentDefault.policy.solana.caps.maxPerTx).toBe(2500000000n);
    expect(vaultDefault.policy.directSigning).toBe(false);
    expect(vaultDefault.policy.capsEnabled).toBe(true);
    expect(vaultDefault.policy.skillsEnabled).toBe(false);
    expect(vaultDefault.policy.solana.caps.maxPerTx).toBe(1000000000n);

    expect(() =>
      upsertWalletPolicyConfig({
        cfg,
        env: process.env,
        walletId: "wallet-vault",
        patch: {
          directSigning: true,
        },
      }),
    ).toThrow("Vault wallets are manual-only");

    upsertWalletPolicyConfig({
      cfg,
      env: process.env,
      walletId: "wallet-vault",
      patch: {
        solanaMaxPerTx: "4200000000",
      },
    });

    const overriddenVault = resolveWalletPolicyConfig(cfg, process.env, "wallet-vault");
    expect(overriddenVault.policy.directSigning).toBe(false);
    expect(overriddenVault.policy.solana.caps.maxPerTx).toBe(4200000000n);
  });

  it("keeps an explicitly designated Vault role when that wallet is also the default", async () => {
    await writeProviderRegistry({
      defaultWalletId: "wallet-vault",
      wallets: [{ id: "wallet-vault", name: "Vault", role: "vault" }],
    });
    expect(resolveWalletRoleForId({ walletId: "wallet-vault", env: process.env })).toBe("vault");
  });

  it("defaults fresh Agent and Vault wallets to manual capped execution", async () => {
    await writeProviderRegistry({
      defaultWalletId: "wallet-agent",
      wallets: [
        { id: "wallet-agent", name: "Agent" },
        { id: "wallet-vault", name: "Vault" },
      ],
    });
    const cfg = {
      wallet: {
        runtime: {
          chains: ["solana"],
        },
      },
    } as never;

    const agentDefault = resolveWalletPolicyConfig(cfg, process.env, "wallet-agent");
    const vaultDefault = resolveWalletPolicyConfig(cfg, process.env, "wallet-vault");

    expect(agentDefault.policy.directSigning).toBe(false);
    expect(agentDefault.policy.capsEnabled).toBe(true);
    expect(agentDefault.policy.skillsEnabled).toBe(false);
    expect(vaultDefault.policy.directSigning).toBe(false);
    expect(vaultDefault.policy.capsEnabled).toBe(true);
    expect(vaultDefault.policy.skillsEnabled).toBe(false);
  });

  it("stores skill access only for Agent wallets", async () => {
    await writeProviderRegistry({
      defaultWalletId: "wallet-agent",
      wallets: [
        { id: "wallet-agent", name: "Agent" },
        { id: "wallet-vault", name: "Vault" },
      ],
    });
    const cfg = {
      wallet: {
        runtime: {
          chains: ["solana"],
        },
      },
    } as never;

    upsertWalletPolicyConfig({
      cfg,
      env: process.env,
      walletId: "wallet-agent",
      patch: { skillsEnabled: true },
    });

    expect(resolveWalletPolicyConfig(cfg, process.env, "wallet-agent").policy.skillsEnabled).toBe(
      true,
    );
    expect(() =>
      upsertWalletPolicyConfig({
        cfg,
        env: process.env,
        walletId: "wallet-vault",
        patch: { skillsEnabled: true },
      }),
    ).toThrow("Skill wallet access can only be enabled for Agent wallets");
  });

  it("stores recurring transfer policy with Agent wallet caps", async () => {
    await writeProviderRegistry({
      defaultWalletId: "wallet-agent",
      wallets: [
        { id: "wallet-agent", name: "Agent" },
        { id: "wallet-vault", name: "Vault" },
      ],
    });
    const cfg = {
      wallet: {
        runtime: {
          chains: ["solana"],
          policy: {
            directSigning: true,
            solana: {
              maxPerTx: "2500000000",
              maxDaily: "9000000000",
            },
          },
        },
      },
    } as never;

    upsertWalletPolicyConfig({
      cfg,
      env: process.env,
      walletId: "wallet-agent",
      patch: {
        directSigning: true,
        solanaMaxPerTx: "1000000000",
        recurringTransfer: {
          enabled: true,
          chain: "solana",
          to: "@wallet:agent",
          amountMode: "percentage",
          percentage: 40,
          minAmount: "1000000",
          keepAmount: "10000000",
          schedule: { kind: "cron", expr: "0 9 * * *" },
          name: "Agent sweep",
        },
      },
    });

    const policy = resolveWalletPolicyConfig(cfg, process.env, "wallet-agent");
    const recurring = resolveWalletRecurringTransferPolicy({
      cfg,
      env: process.env,
      walletId: "wallet-agent",
    });
    expect(policy.policy.directSigning).toBe(true);
    expect(policy.policy.solana.caps.maxPerTx).toBe(1000000000n);
    expect(recurring).toMatchObject({
      enabled: true,
      to: "@wallet:agent",
      amountMode: "percentage",
      percentage: 40,
      minAmount: "1000000",
      keepAmount: "10000000",
      name: "Agent sweep",
    });

    expect(() =>
      upsertWalletPolicyConfig({
        cfg,
        env: process.env,
        walletId: "wallet-vault",
        patch: {
          recurringTransfer: {
            enabled: true,
            chain: "solana",
            to: "@wallet:agent",
            amountMode: "fixed",
            amount: "1",
          },
        },
      }),
    ).toThrow("generic recurring transfer policy requires an Agent wallet");
  });

  it("keeps mining wallets on SAT sweep policy instead of generic recurring transfer policy", async () => {
    await writeProviderRegistry({
      defaultWalletId: "wallet-agent",
      wallets: [
        { id: "wallet-agent", name: "Agent" },
        { id: "wallet-mining", name: "Mining" },
      ],
    });
    const cfg = {
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "wallet-mining",
            },
          },
        },
      },
    } as never;

    expect(() =>
      upsertWalletPolicyConfig({
        cfg,
        env: process.env,
        walletId: "wallet-mining",
        patch: {
          recurringTransfer: {
            enabled: true,
            chain: "solana",
            to: "@wallet:agent",
            amountMode: "fixed",
            amount: "1",
          },
        },
      }),
    ).toThrow("generic recurring transfer policy requires an Agent wallet");
  });

  it("keeps SAT bond program out of wallet role allowlists", () => {
    vi.stubEnv("FASED_SAT_PROGRAM_ID", "SatProgram1111111111111111111111111111111111");
    vi.stubEnv("FASED_SAT_BOND_PROGRAM_ID", "SatBond1111111111111111111111111111111111111");
    vi.stubEnv("FASED_SAT_MINT_ADDRESS", "SatMint1111111111111111111111111111111111111");
    vi.stubEnv("FASED_SAT_MINT_PROGRAM_ID", "SatMintProgram111111111111111111111111111111");
    const bondProgramId = resolveSatBondProgramIdFromEnv(process.env);
    const miningProfile = resolveWalletRolePolicyProfile("mining", process.env);
    const vaultProfile = resolveWalletRolePolicyProfile("vault", process.env);

    expect(miningProfile.defaults.solana.allowPrograms).not.toContain(bondProgramId);
    expect(vaultProfile.defaults.solana.allowPrograms).not.toContain(bondProgramId);
  });
});
