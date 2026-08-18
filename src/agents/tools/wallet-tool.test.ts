import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import { setDefaultWallet, upsertNamedWallet } from "../../wallet/wallet-provider-registry.js";
import { computeSkillContentSha256Sync } from "../skills/trust.js";
import { createWalletTool } from "./wallet-tool.js";

const mocks = vi.hoisted(() => ({
  provider: {
    id: "local-socket-signer",
    displayName: "Local Socket Signer",
    capabilities: {
      custodyModel: "self-hosted",
      supportsCreateWallet: false,
      supportsPrepare: true,
      supportsSend: true,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      supportedExecutionModes: ["manual", "autonomous"],
      supportedChains: ["solana"],
    },
    health: vi.fn(),
    getAddresses: vi.fn(),
    getBalance: vi.fn(),
    prepareTx: vi.fn(),
    sendTx: vi.fn(),
  },
  createWalletProviderAdapter: vi.fn(),
}));

const AGENT_SOLANA_ADDRESS = "11111111111111111111111111111111";
const VAULT_SOLANA_ADDRESS = "So11111111111111111111111111111111111111112";
const EXTERNAL_SOLANA_ADDRESS = "SysvarC1ock11111111111111111111111111111111";

vi.mock("../../wallet/wallet-provider-resolver.js", () => ({
  createWalletProviderAdapter: mocks.createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet: () => process.env.FASED_WALLET_SOLANA_RPC_URL,
  resolveWalletProviderId: () => "local-socket-signer",
}));

function walletEnabledConfig(): FasedAgentConfig {
  return {
    agents: {
      list: [{ id: "owner", default: true }],
    },
    wallet: {
      runtime: {
        enabled: true,
        mode: "managed",
        chains: ["solana"],
        policy: {
          directSigning: true,
          skillsEnabled: true,
        },
        toolAccess: {
          mode: "owner-only",
        },
      },
    },
  };
}

function setupNamedWallets(params?: { defaultWalletId?: string }) {
  upsertNamedWallet({
    walletId: "agent",
    name: "Agent",
    providerId: "local-socket-signer",
    metadata: { purpose: "agent", role: "agent" },
    env: process.env,
  });
  upsertNamedWallet({
    walletId: "mining",
    name: "Mining",
    providerId: "local-socket-signer",
    metadata: { purpose: "mining", role: "mining" },
    env: process.env,
  });
  upsertNamedWallet({
    walletId: "vault",
    name: "Vault",
    providerId: "local-socket-signer",
    metadata: { purpose: "vault", role: "vault" },
    env: process.env,
  });
  if (params?.defaultWalletId === "agent-alt") {
    upsertNamedWallet({
      walletId: "agent-alt",
      name: "Alternate Agent",
      providerId: "local-socket-signer",
      metadata: { purpose: "agent", role: "agent" },
      env: process.env,
    });
  }
  setDefaultWallet({ walletId: params?.defaultWalletId ?? "agent", env: process.env });
}

async function writeClawHubSkillOrigin(params: {
  workspaceDir: string;
  slug: string;
  registry: string;
}) {
  const originDir = path.join(params.workspaceDir, "skills", params.slug, ".clawhub");
  await fs.mkdir(originDir, { recursive: true });
  const skillDir = path.dirname(originDir);
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${params.slug}\n`, "utf8");
  const contentSha256 = computeSkillContentSha256Sync(skillDir);
  if (!contentSha256) {
    throw new Error("test skill content digest was unavailable");
  }
  await fs.writeFile(
    path.join(originDir, "origin.json"),
    `${JSON.stringify(
      {
        version: 1,
        registry: params.registry,
        slug: params.slug,
        installedVersion: "1.0.0",
        installedAt: Date.now(),
        archiveSha256: "a".repeat(64),
        archiveIntegrityVerified: true,
        contentSha256,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("wallet-tool", () => {
  beforeEach(() => {
    mocks.provider.health.mockResolvedValue({
      ok: true,
      provider: "local-socket-signer",
      configured: true,
      checkedAt: new Date().toISOString(),
    });
    mocks.provider.getAddresses.mockImplementation(async (options?: { walletId?: string }) => ({
      solana: options?.walletId === "vault" ? VAULT_SOLANA_ADDRESS : AGENT_SOLANA_ADDRESS,
    }));
    mocks.provider.getBalance.mockResolvedValue({
      chain: "solana",
      balance: "0",
      unit: "SOL",
    });
    mocks.provider.prepareTx.mockResolvedValue({
      preparedId: "prepared-1",
      chain: "solana",
      status: "prepared",
    });
    mocks.provider.sendTx.mockResolvedValue({
      txHash: "tx-1",
      chain: "solana",
      status: "submitted",
    });
    mocks.createWalletProviderAdapter.mockReturnValue(mocks.provider);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mocks.provider.health.mockReset();
    mocks.provider.getAddresses.mockReset();
    mocks.provider.getBalance.mockReset();
    mocks.provider.prepareTx.mockReset();
    mocks.provider.sendTx.mockReset();
    mocks.createWalletProviderAdapter.mockReset();
  });

  it("returns null when wallet is disabled", () => {
    const tool = createWalletTool({
      config: {
        wallet: {
          runtime: {
            enabled: false,
          },
        },
      },
      agentSessionKey: "agent:owner:main",
    });
    expect(tool).toBeNull();
  });

  it("denies non-owner agent in owner-only mode", async () => {
    const tool = createWalletTool({
      config: walletEnabledConfig(),
      agentSessionKey: "agent:worker:main",
    });
    if (!tool) {
      throw new Error("missing wallet tool");
    }
    await expect(tool.execute("call1", { action: "status" })).rejects.toThrow(
      "wallet_tool_owner_only",
    );
  });

  it("rejects unsupported chains before network calls", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-policy-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(tool.execute("call1", { action: "prepare", chain: "ethereum" })).rejects.toThrow(
        "wallet chain must be solana",
      );
      expect(mocks.provider.prepareTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("executes Agent wallet sends automatically under policy caps", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-send", {
        action: "send",
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      });
      const details = result.details as Record<string, unknown>;
      expect(details.ok).toBe(true);
      expect(details.executed).toBe(true);
      expect(mocks.provider.sendTx).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: "solana",
          walletId: "agent",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects explicit Vault wallet sends from chat automation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-vault-send-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-vault-send", {
          action: "send",
          chain: "solana",
          walletHandle: "@wallet:vault",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("wallet_role_not_allowed");
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires an explicit walletActions manifest before skill wallet sends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-skill-send-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
        requesterSkillId: "trade-skill",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-skill-send", {
          action: "send",
          chain: "solana",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("wallet_action_skill_manifest_required");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects installed ClawHub skills from unallowlisted registries before wallet sends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-registry-"));
    const workspaceDir = path.join(tempDir, "workspace");
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      await writeClawHubSkillOrigin({
        workspaceDir,
        slug: "trade-skill",
        registry: "https://untrusted.example.com",
      });
      const cfg = walletEnabledConfig();
      cfg.agents = {
        list: [{ id: "owner", default: true, workspace: workspaceDir }],
      };
      cfg.skills = {
        marketplace: {
          allowRegistries: ["https://clawhub.com"],
        },
        entries: {
          "trade-skill": {
            config: {
              walletActions: {
                actions: ["send"],
                roles: ["agent"],
                walletIds: ["agent"],
                chains: ["solana"],
                registries: ["https://clawhub.com"],
                maxAmount: "10",
                autonomous: true,
              },
            },
          },
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
        requesterSkillId: "trade-skill",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-skill-registry-send", {
          action: "send",
          chain: "solana",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("wallet_action_skill_registry_not_allowlisted");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("converts human amounts when amountFormat=human", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-human-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await tool.execute("call-send-human", {
        action: "send",
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "0.5",
        amountFormat: "human",
      });
      expect(mocks.provider.sendTx).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: "500000000",
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves destination wallet handles and infers human units for decimal SOL sends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-human-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await tool.execute("call-send-sol-human", {
        action: "send",
        chain: "solana",
        walletHandle: "@wallet:agent",
        to: "@wallet:vault",
        amount: "0.1",
      });
      expect(mocks.provider.sendTx).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: "solana",
          walletId: "agent",
          to: VAULT_SOLANA_ADDRESS,
          amount: "100000000",
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps external Solana destination addresses raw while converting human SOL amounts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-external-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const external = EXTERNAL_SOLANA_ADDRESS;
      await tool.execute("call-send-sol-external", {
        action: "send",
        chain: "solana",
        walletHandle: "@wallet:agent",
        to: external,
        amount: "0.25",
      });
      expect(mocks.provider.sendTx).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: "solana",
          walletId: "agent",
          to: external,
          amount: "250000000",
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed external Solana destination addresses before send", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-bad-addr-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-send-sol-invalid-address", {
          action: "send",
          chain: "solana",
          walletHandle: "@wallet:agent",
          to: "0xnot-a-solana-address",
          amount: "0.25",
        }),
      ).rejects.toThrow("Solana destination address is not a valid Solana address");
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honors @wallet handles for read-only balance even when the default differs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-read-handle-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets({ defaultWalletId: "agent-alt" });
      mocks.provider.getBalance.mockResolvedValueOnce({
        chain: "solana",
        balance: "7",
        unit: "SOL",
      });
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-balance-agent-handle", {
        action: "balance",
        chain: "solana",
        walletHandle: "@wallet:agent",
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            balance: "7",
          }),
        }),
      );
      expect(mocks.provider.getBalance).toHaveBeenCalledWith("solana", { walletId: "agent" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows read-only balance checks for non-Agent wallet handles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-role-read-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await tool.execute("call-balance-mining", {
        action: "balance",
        chain: "solana",
        walletHandle: "@wallet:mining",
      });
      await tool.execute("call-balance-vault", {
        action: "balance",
        chain: "solana",
        walletHandle: "@wallet:vault",
      });
      expect(mocks.provider.getBalance).toHaveBeenNthCalledWith(1, "solana", {
        walletId: "mining",
      });
      expect(mocks.provider.getBalance).toHaveBeenNthCalledWith(2, "solana", {
        walletId: "vault",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not report Solana balance errors for Solana-only wallet balance checks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-only-bal-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19001");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: "1000000000" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: [] } }),
        };
      }),
    );
    try {
      setupNamedWallets();
      mocks.provider.getAddresses.mockResolvedValueOnce({ solana: AGENT_SOLANA_ADDRESS });
      mocks.provider.getBalance.mockRejectedValue(new Error("Solana chain access is not allowed"));
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-balance-sol-only", {
        action: "balance",
        walletHandle: "@wallet:agent",
      });

      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            walletId: "agent",
            balances: expect.objectContaining({
              solana: expect.objectContaining({
                ok: true,
                chain: "solana",
                address: AGENT_SOLANA_ADDRESS,
              }),
            }),
          }),
        }),
      );
      expect((result.details as { result?: { errors?: unknown } }).result?.errors).toBeUndefined();
      expect(mocks.provider.getBalance).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists local wallet handles for chat selection", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-list-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-wallet-list", { action: "list" });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          defaultWalletId: "agent",
          wallets: expect.arrayContaining([
            expect.objectContaining({
              walletId: "agent",
              walletHandle: "@wallet:agent",
            }),
            expect.objectContaining({
              walletId: "mining",
              walletHandle: "@wallet:mining",
            }),
            expect.objectContaining({
              walletId: "vault",
              walletHandle: "@wallet:vault",
            }),
          ]),
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns all local wallet Solana assets for all-wallet balance questions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-balances-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19002");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: "7000000000" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: [] } }),
        };
      }),
    );
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-wallet-balances", {
        action: "balances",
        chain: "solana",
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          chain: "solana",
          wallets: expect.arrayContaining([
            expect.objectContaining({
              walletId: "agent",
              balances: expect.objectContaining({
                solana: expect.objectContaining({
                  ok: true,
                  chain: "solana",
                  assets: expect.arrayContaining([
                    expect.objectContaining({ kind: "native", amountDisplay: "7" }),
                  ]),
                }),
              }),
            }),
            expect.objectContaining({
              walletId: "mining",
              balances: expect.objectContaining({
                solana: expect.objectContaining({ ok: true, chain: "solana" }),
              }),
            }),
            expect.objectContaining({
              walletId: "vault",
              balances: expect.objectContaining({
                solana: expect.objectContaining({ ok: true, chain: "solana" }),
              }),
            }),
          ]),
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns SPL token balance for percentage transfer planning", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-token-bal-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19003");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method?: string;
          params?: Array<{ programId?: string } | string>;
        };
        if (body.method === "getTokenAccountsByOwner") {
          const programId =
            typeof body.params?.[1] === "object" ? String(body.params[1].programId ?? "") : "";
          if (programId.startsWith("TokenzQd")) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ result: { value: [] } }),
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: [
                  {
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: VAULT_SOLANA_ADDRESS,
                            tokenAmount: { amount: "42000000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: [] } }),
        };
      }),
    );
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-balance-sol-token", {
        action: "balance",
        chain: "solana",
        walletHandle: "@wallet:agent",
        program: VAULT_SOLANA_ADDRESS,
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            chain: "solana",
            address: AGENT_SOLANA_ADDRESS,
            program: VAULT_SOLANA_ADDRESS,
            balance: "42000000",
            decimals: 6,
          }),
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns native SOL balance for an external Solana address", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-external-bal-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19004");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: "990000000" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: [] } }),
        };
      }),
    );
    try {
      setupNamedWallets({ defaultWalletId: "agent-alt" });
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-balance-sol-external", {
        action: "balance",
        chain: "solana",
        address: EXTERNAL_SOLANA_ADDRESS,
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            chain: "solana",
            address: EXTERNAL_SOLANA_ADDRESS,
            balance: "0.99",
            amountDisplay: "0.99",
            unit: "SOL",
          }),
        }),
      );
      expect(mocks.provider.getAddresses).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns all visible Solana assets for an external address when balance omits chain", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fased-wallet-tool-sol-ext-balance-no-chain-"),
    );
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19005");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method?: string;
          params?: Array<{ programId?: string } | string>;
        };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: "2193376560" } }),
          };
        }
        if (body.method === "getTokenAccountsByOwner") {
          const programId =
            typeof body.params?.[1] === "object" ? String(body.params[1].programId ?? "") : "";
          if (programId.startsWith("TokenzQd")) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ result: { value: [] } }),
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: [
                  {
                    pubkey: "TokenAcct333333333333333333333333333333333",
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: VAULT_SOLANA_ADDRESS,
                            tokenAmount: { amount: "3045903318184", decimals: 10 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: null } }),
        };
      }),
    );
    try {
      setupNamedWallets({ defaultWalletId: "agent-alt" });
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-balance-sol-external-no-chain", {
        action: "balance",
        address: EXTERNAL_SOLANA_ADDRESS,
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            chain: "solana",
            target: expect.objectContaining({
              kind: "external_solana_address",
              address: EXTERNAL_SOLANA_ADDRESS,
            }),
            assets: expect.arrayContaining([
              expect.objectContaining({
                kind: "native",
                symbol: "SOL",
                amountDisplay: "2.19337656",
              }),
              expect.objectContaining({
                kind: "spl-token",
                program: VAULT_SOLANA_ADDRESS,
                amountDisplay: "304.5903318184",
              }),
            ]),
          }),
        }),
      );
      expect(mocks.provider.getAddresses).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns every address for a wallet handle when address omits chain", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-address-no-chain-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-address-vault-no-chain", {
        action: "address",
        walletHandle: "@wallet:vault",
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            walletId: "vault",
            walletName: "Vault",
            addresses: expect.objectContaining({
              solana: VAULT_SOLANA_ADDRESS,
            }),
          }),
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns all visible Solana assets for wallet balance questions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-assets-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19006");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method?: string;
          params?: Array<{ programId?: string } | string>;
        };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: "1149940000" } }),
          };
        }
        if (body.method === "getTokenAccountsByOwner") {
          const programId =
            typeof body.params?.[1] === "object" ? String(body.params[1].programId ?? "") : "";
          if (programId.startsWith("TokenzQd")) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ result: { value: [] } }),
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: [
                  {
                    pubkey: "TokenAcct111111111111111111111111111111111",
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: VAULT_SOLANA_ADDRESS,
                            tokenAmount: { amount: "42000000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: null } }),
        };
      }),
    );
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-assets-sol", {
        action: "assets",
        chain: "solana",
        walletHandle: "@wallet:agent",
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            chain: "solana",
            address: AGENT_SOLANA_ADDRESS,
            assets: expect.arrayContaining([
              expect.objectContaining({
                kind: "native",
                symbol: "SOL",
                amountDisplay: "1.14994",
              }),
              expect.objectContaining({
                kind: "spl-token",
                program: VAULT_SOLANA_ADDRESS,
                amountDisplay: "42",
              }),
            ]),
          }),
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns visible Solana assets for an external Solana address", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-sol-ext-assets-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "http://127.0.0.1:19007");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method?: string;
          params?: Array<{ programId?: string } | string>;
        };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: "2500000000" } }),
          };
        }
        if (body.method === "getTokenAccountsByOwner") {
          const programId =
            typeof body.params?.[1] === "object" ? String(body.params[1].programId ?? "") : "";
          if (programId.startsWith("TokenzQd")) {
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ result: { value: [] } }),
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: [
                  {
                    pubkey: "TokenAcct222222222222222222222222222222222",
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: VAULT_SOLANA_ADDRESS,
                            tokenAmount: { amount: "3000000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: { value: null } }),
        };
      }),
    );
    try {
      setupNamedWallets({ defaultWalletId: "agent-alt" });
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-assets-sol-external", {
        action: "assets",
        chain: "solana",
        address: EXTERNAL_SOLANA_ADDRESS,
      });
      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            chain: "solana",
            address: EXTERNAL_SOLANA_ADDRESS,
            assets: expect.arrayContaining([
              expect.objectContaining({
                kind: "native",
                symbol: "SOL",
                amountDisplay: "2.5",
              }),
              expect.objectContaining({
                kind: "spl-token",
                program: VAULT_SOLANA_ADDRESS,
                amountDisplay: "3",
              }),
            ]),
          }),
        }),
      );
      expect(mocks.provider.getAddresses).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects Agent sends when automation signing is disabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-autonomous-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          policy: {
            ...cfg.wallet?.runtime?.policy,
            directSigning: false,
          },
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-send", {
          action: "send",
          chain: "solana",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("automated execution disabled by wallet policy");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows risky actions through explicit Agent wallet handles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-handle-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      const result = await tool.execute("call-send-handle", {
        action: "send",
        chain: "solana",
        walletHandle: "@wallet:agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      });
      const details = result.details as Record<string, unknown>;
      expect(details.executed).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects mining and vault wallets as chat automation sources", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-role-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const cfg = walletEnabledConfig();
      cfg.plugins = {
        entries: {
          "sat-mining": {
            config: {
              walletId: "mining",
            },
          },
        },
      };
      const tool = createWalletTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-send-mining", {
          action: "send",
          chain: "solana",
          walletHandle: "@wallet:mining",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("wallet_role_not_allowed");
      await expect(
        tool.execute("call-send-vault", {
          action: "send",
          chain: "solana",
          walletHandle: "@wallet:vault",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("wallet_role_not_allowed");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not execute risky actions from plain wallet names", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-tool-name-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupNamedWallets();
      const tool = createWalletTool({
        config: walletEnabledConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet tool");
      }
      await expect(
        tool.execute("call-send-name", {
          action: "send",
          chain: "solana",
          walletName: "Agent",
          to: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
      ).rejects.toThrow("wallet_handle_required");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces source allowlist when configured", async () => {
    const cfg = walletEnabledConfig();
    cfg.wallet = {
      ...cfg.wallet,
      runtime: {
        ...cfg.wallet?.runtime,
        toolAccess: {
          mode: "owner-only",
          allowSources: ["gateway-http"],
        },
      },
    };
    const tool = createWalletTool({
      config: cfg,
      agentSessionKey: "agent:owner:main",
    });
    if (!tool) {
      throw new Error("missing wallet tool");
    }
    await expect(tool.execute("call-source", { action: "status" })).rejects.toThrow(
      "wallet_tool_source_not_allowlisted",
    );
  });

  it("enforces skill allowlist when configured", async () => {
    const cfg = walletEnabledConfig();
    cfg.wallet = {
      ...cfg.wallet,
      runtime: {
        ...cfg.wallet?.runtime,
        toolAccess: {
          mode: "owner-only",
          allowSkills: ["trade-skill"],
        },
      },
    };
    const missingSkillContextTool = createWalletTool({
      config: cfg,
      agentSessionKey: "agent:owner:main",
    });
    if (!missingSkillContextTool) {
      throw new Error("missing wallet tool");
    }
    await expect(
      missingSkillContextTool.execute("call-missing-skill", { action: "status" }),
    ).rejects.toThrow("wallet_tool_skill_context_required");

    const allowedSkillTool = createWalletTool({
      config: cfg,
      agentSessionKey: "agent:owner:main",
      requesterSkillId: "trade-skill",
    });
    if (!allowedSkillTool) {
      throw new Error("missing wallet tool");
    }
    const status = await allowedSkillTool.execute("call-skill", { action: "status" });
    expect((status.details as { ok?: boolean }).ok).toBe(true);
  });
});
