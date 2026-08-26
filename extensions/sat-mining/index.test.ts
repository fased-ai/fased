import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendSatPlannerHistoryOutcome,
  resolveSatPlannerHistoryStorePath,
  resolveSatRuntimeStorePath,
  resolveSatWalletStateDir,
  writeSatRecentActions,
} from "./src/audit-store.js";
import {
  resolveSatMiningHistoryDatabasePath,
  SatMiningHistoryStore,
} from "./src/mining-history-store.js";

const SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
const SAT_BOND_PROGRAM_ID = "8RYKuGb2k8hBcGX34QdYJXdXZkNvD3fKy85s63Pph2j7";
const SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"; // pragma: allowlist secret
const SAT_MINT_PROGRAM_ID = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C";

beforeEach(() => {
  process.env.FASED_SAT_PROGRAM_ID = SAT_PROGRAM_ID;
  process.env.FASED_SAT_BOND_PROGRAM_ID = SAT_BOND_PROGRAM_ID;
  process.env.FASED_SAT_MINT_ADDRESS = SAT_MINT_ADDRESS;
  process.env.FASED_SAT_MINT_PROGRAM_ID = SAT_MINT_PROGRAM_ID;
});

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    completeSimple: vi.fn(async () => ({
      message: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              allocationFp: [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              ],
              rationale: "mock strategic center concentration",
              confidence: "high",
              suggestedDifficulty: "high",
            }),
          },
        ],
      },
    })),
  };
});

vi.mock("../../src/agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({ apiKey: "test-key", source: "test", mode: "api-key" })),
  requireApiKey: vi.fn(() => "test-key"),
}));

vi.mock("../../src/agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: { provider: "openai", id: "gpt-5" },
    authStorage: {},
    modelRegistry: {},
  })),
}));

vi.mock("../../src/wallet/wallet-provider-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/wallet/wallet-provider-registry.js")>();
  return {
    ...actual,
    readWalletProviderRegistry: vi.fn(() => ({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
        {
          id: "wallet-b",
          name: "Wallet B",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-2" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    })),
    resolveWalletUserRole: vi.fn((wallet?: { metadata?: { purpose?: string; role?: string } }) => {
      const purpose = wallet?.metadata?.purpose ?? wallet?.metadata?.role;
      return purpose === "agent" || purpose === "vault" || purpose === "mining"
        ? purpose
        : undefined;
    }),
    upsertNamedWallet: vi.fn(),
  };
});

vi.mock("../../src/wallet/wallet-provider-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/wallet/wallet-provider-resolver.js")>();
  return {
    ...actual,
    createWalletProviderAdapter: vi.fn(() => ({
      health: vi.fn(async () => ({ ok: true, configured: true, details: "ok" })),
      getAddresses: vi.fn(async (options?: { walletId?: string }) => ({
        solana: options?.walletId === "wallet-b" ? "miner-wallet-2" : "miner-wallet-1",
      })),
      getBalance: vi.fn(async () => ({ balance: "1000000000", unit: "lamports" })),
    })),
  };
});

vi.mock("../../src/wallet/providers/local-socket-signer-adapter.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/wallet/providers/local-socket-signer-adapter.js")
    >();
  return {
    ...actual,
    probeLocalSocketSignerHealth: vi.fn(async () => ({
      ok: true,
      details: "fased-signerd native ready",
      readOnly: false,
      keystoreType: "solana-envelope",
      chains: ["solana"],
    })),
  };
});

vi.mock("./src/solana-submit.js", () => ({
  runWithSatSubmissionWorkflow: vi.fn(async (_workflowId, task) => await task()),
  submitSatInitMinerCapital: vi.fn(async () => ({ ok: true, txHash: "tx-init-miner-capital" })),
  submitSatDepositMinerCapital: vi.fn(async () => ({
    ok: true,
    txHash: "tx-deposit-miner-capital",
  })),
  submitSatWithdrawMinerCapital: vi.fn(async () => ({
    ok: true,
    txHash: "tx-withdraw-miner-capital",
  })),
  submitSatSetActiveCommit: vi.fn(async () => ({ ok: true, txHash: "tx-set-active-commit" })),
  submitSatTopUpRegistryReserve: vi.fn(async () => ({
    ok: true,
    txHash: "tx-top-up-registry-reserve",
  })),
  submitSatOpenCycle: vi.fn(async () => ({ ok: true, txHash: "tx-open-cycle" })),
  submitSatCommitCycle: vi.fn(async () => ({ ok: true, txHash: "tx-commit-cycle" })),
  submitSatCloseCommitPhase: vi.fn(async () => ({ ok: true, txHash: "tx-close-commit" })),
  submitSatSealCycleEntropy: vi.fn(async () => ({ ok: true, txHash: "tx-seal-entropy" })),
  submitSatRevealCycle: vi.fn(async () => ({ ok: true, txHash: "tx-reveal-cycle" })),
  submitSatReleaseUnrevealedCommit: vi.fn(async () => ({
    ok: true,
    txHash: "tx-release-commit",
  })),
  submitSatAbortEmptyCycle: vi.fn(async () => ({
    ok: true,
    txHash: "tx-abort-empty-cycle",
  })),
  submitSatClaimCycleRewards: vi.fn(async () => ({ ok: true, txHash: "tx-claim-cycle" })),
  submitSatClaimCycleRewardsBatch: vi.fn(async () => ({
    ok: true,
    txHash: "tx-claim-cycle-batch",
  })),
  submitSatCleanupDistributionLookupTable: vi.fn(async (_config, params) => ({
    lookupTable: "lookup-table-from-signer-binding",
    action: params.action,
    transactionHashes: ["tx-cleanup-distribution-lookup"],
    signerState: "confirmed",
    requestId: "lookup-cleanup-request",
  })),
  submitSatClaimUnallocatedStakingRewards: vi.fn(async () => ({
    ok: true,
    txHash: "tx-claim-unallocated-staking",
  })),
  submitSatSyncBondStakingRewards: vi.fn(async () => ({
    ok: true,
    txHash: "tx-sync-bond-staking",
  })),
  submitSatRetargetUnlock: vi.fn(async () => ({ ok: true, txHash: "tx-retarget" })),
  submitSatValidatorAttestation: vi.fn(async () => ({ ok: true })),
  submitSatOpenDispute: vi.fn(async () => ({ ok: true })),
  submitSatResolveDispute: vi.fn(async () => ({ ok: true })),
  submitSatRepublishEpochRoots: vi.fn(async () => ({ ok: true })),
  resolveSatValidatorAuthority: vi.fn(async () => "validator-auto-1"),
}));

vi.mock("./src/commitment-custody.js", () => ({
  readSignerOwnedSatCommitmentBinding: vi.fn(async ({ cycleId }: { cycleId: number }) => ({
    reference: `sha256:${"ab".repeat(32)}`,
    commitmentHex: "11".repeat(32),
    cycleId: String(cycleId),
    committedLamports: "250000000",
    allocationCount: 25,
    protocolGeneration: "sat-v2",
  })),
}));

vi.mock("./src/rpc-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/rpc-read.js")>();
  return {
    ...actual,
    inspectSatEpoch: vi.fn(async (_config, { epochId }: { epochId: number }) => ({
      address: `epoch-${epochId}`,
      epochId,
      claimsBlocked: true,
      blockedReason: "open_disputes",
      openDisputeCount: 1,
      validatorRejectCount: 0,
      slashReasonCode: 0,
      bucketRoot: "aa",
      scoreRoot: "bb",
      coordinationRoot: "cc",
      epoch: {
        startTs: 0,
        endTs: 600,
        microRoundsTotal: 10,
        validWalletCount: 1,
        baseEligibleWalletCount: 1,
        skillEligibleWalletCount: 1,
        settledEmissionSat: 80,
      },
    })),
    inspectSatDispute: vi.fn(async (_config, params) => ({
      address: "dispute-1",
      recordLocator: {
        roundKey: `${params.epochId}:${params.microRoundId}`,
        epochId: params.epochId,
        microRoundId: params.microRoundId,
        validatorAuthority: params.validatorAuthority,
        targetAuthority: params.targetAuthority,
      },
      validatorAuthority: params.validatorAuthority,
      targetAuthority: params.targetAuthority,
      epochId: params.epochId,
      microRoundId: params.microRoundId,
      reasonCode: 10,
      evidenceHash: "ee",
      targetRoot: "ff",
      openedAt: 1,
      disputeDeadlineTs: 2,
      statusFlag: 2,
      statusLabel: "resolved_dismissed",
      epochClaimStatus: {
        blocked: false,
        blockedReason: null,
        openDisputeCount: 0,
        validatorRejectCount: 0,
        slashReasonCode: 0,
      },
      targetMiningStake: { slashPenaltyOwed: "0" },
    })),
    inspectSatValidatorAttestation: vi.fn(),
    inspectSatChainUnixTime: vi.fn(async () => Math.floor(Date.now() / 1000)),
    inspectCurrentSatRoundBucket: vi.fn(async () => null),
    inspectSatMiningStake: vi.fn(async () => ({
      authority: "miner-wallet-1",
      shares: "1000",
      originalStake: "1000",
      rewardOwed: "80",
      jackpotOwed: "0",
      slashPenaltyOwed: "0",
      autoUnstakeThresholdBps: 0,
    })),
    inspectSatMinerCapital: vi.fn(async () => ({
      address: "miner-capital-1",
      version: 2,
      authority: "miner-wallet-1",
      fundedLamports: "500000000",
      lockedLamports: "0",
      freeLamports: "500000000",
      activeCommitLamports: "250000000",
    })),
    inspectSatMinerCapitalAccountStatus: vi.fn(async () => ({
      address: "miner-capital-1",
      exists: true,
      owner: SAT_PROGRAM_ID,
      expectedOwner: SAT_PROGRAM_ID,
      dataLength: 112,
    })),
    inspectSatPayoutReadiness: vi.fn(async () => ({
      treasuryAddress: "treasury-1",
      treasuryAta: "treasury-ata-1",
      recipientAta: "recipient-ata-1",
      treasuryAtaExists: true,
      recipientAtaExists: true,
      treasuryBalanceRaw: "900000000000",
      recipientBalanceRaw: "100000000000",
    })),
    listSatDisputes: vi.fn(async () => ({
      count: 1,
      disputes: [
        {
          address: "dispute-list-1",
          recordLocator: {
            roundKey: "17:1",
            epochId: 17,
            microRoundId: 1,
            validatorAuthority: "validator-list-1",
            targetAuthority: "target-list-1",
          },
          validatorAuthority: "validator-list-1",
          targetAuthority: "target-list-1",
          epochId: 17,
          microRoundId: 1,
          reasonCode: 10,
          evidenceHash: "ee",
          targetRoot: "ff",
          openedAt: 1,
          disputeDeadlineTs: 2,
          statusFlag: 3,
          statusLabel: "resolved_upheld",
          epochClaimStatus: {
            blocked: true,
            blockedReason: { kind: "corrected_roots_required", slashReasonCode: 10 },
            openDisputeCount: 0,
            validatorRejectCount: 0,
            slashReasonCode: 10,
          },
          targetMiningStake: { slashPenaltyOwed: "30" },
        },
      ],
    })),
    listSatValidatorAttestations: vi.fn(async () => ({
      count: 1,
      attestations: [
        {
          address: "attestation-list-1",
          recordLocator: {
            roundKey: "17:1",
            epochId: 17,
            microRoundId: 1,
            validatorAuthority: "validator-list-1",
            targetAuthority: "target-list-1",
          },
          validatorAuthority: "validator-list-1",
          targetAuthority: "target-list-1",
          epochId: 17,
          microRoundId: 1,
          decisionFlag: 2,
          decisionLabel: "reject",
          reasonCode: 3,
          bucketRoot: "aa",
          scoreRoot: "bb",
          coordinationRoot: "cc",
          evidenceHash: "dd",
          attestedAt: 1,
          epochClaimStatus: {
            blocked: true,
            blockedReason: "open_disputes",
            openDisputeCount: 1,
            validatorRejectCount: 0,
            slashReasonCode: 0,
          },
          targetMiningStake: { slashPenaltyOwed: "10" },
        },
      ],
    })),
  };
});

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

type RegisteredToolOptions = {
  optional?: boolean;
};

type RegisteredGatewayMethod = {
  handler: (ctx: {
    params?: Record<string, unknown>;
    respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
  }) => Promise<void>;
};

describe("sat-mining plugin chat tool boundaries", () => {
  it("registers low-level status diagnostics as optional", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const toolOptions = new Map<string, RegisteredToolOptions | undefined>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: { enabled: true, network: "devnet" },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({
            plugins: {
              entries: {
                "sat-mining": {
                  enabled: true,
                  config: { enabled: true, network: "devnet" },
                },
              },
            },
          })),
          writeConfigFile: vi.fn(),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool, options?: RegisteredToolOptions) => {
        toolOptions.set(tool.name, options);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    expect(toolOptions.get("sat_status")).toEqual({ optional: true });
  });
});

describe("sat-mining plugin config persistence", () => {
  it("persists config updates from commands and tool actions", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const commands = new Map<
      string,
      { handler: (ctx: { args?: string }) => Promise<{ text: string }> }
    >();
    const tools = new Map<string, RegisteredTool>();
    const writes: unknown[] = [];
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled: true,
            config: { enabled: true, network: "devnet", riskMode: "balanced" },
          },
        },
      },
    };

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "swarm",
        walletId: "wallet-a",
        federationHandle: "miner-a",
        federationPeers: ["miner-b"],
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => structuredClone(configState)),
          writeConfigFile: vi.fn(async (next) => {
            writes.push(next);
            Object.assign(configState, next);
          }),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(
        (command: {
          name: string;
          handler: (ctx: { args?: string }) => Promise<{ text: string }>;
        }) => {
          commands.set(command.name, command);
        },
      ),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    await commands.get("satsetrisk")!.handler({ args: "swarm" });
    await commands.get("satsetswarm")!.handler({ args: "miner-a syndicate-x miner-b,miner-c" });
    await tools.get("sat_configure_swarm")!.execute("tool-1", {
      riskMode: "aggressive",
      federationHandle: "miner-z",
      coordinationGroup: "group-z",
      federationPeers: ["miner-y"],
    });

    expect(writes.length).toBe(3);
    const last = writes.at(-1) as {
      plugins?: { entries?: Record<string, { config?: Record<string, unknown> }> };
    };
    expect(last.plugins?.entries?.["sat-mining"]?.config).toMatchObject({
      riskMode: "aggressive",
      federationHandle: "miner-z",
      coordinationGroup: "group-z",
      federationPeers: ["miner-y"],
    });
  });

  it("includes resolved validator authority in attestation submission responses", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const tools = new Map<string, RegisteredTool>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({
            plugins: {
              entries: {
                "sat-mining": {
                  enabled: false,
                  config: { enabled: false, network: "devnet", riskMode: "balanced", walletId },
                },
              },
            },
          })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const result = (await tools.get("sat_submit_validator_attestation")!.execute("tool-2", {
      targetAuthority: "target-1",
      epochId: 7,
      microRoundId: 2,
      decisionFlag: 1,
      reasonCode: 3,
      bucketRoot: "aa",
      scoreRoot: "bb",
      coordinationRoot: "cc",
      evidenceHash: "dd",
    })) as {
      details: { recordLocator: { validatorAuthority: string; targetAuthority: string } };
    };

    expect(result.details.recordLocator.validatorAuthority).toBe("validator-auto-1");
    expect(result.details.recordLocator.targetAuthority).toBe("target-1");
  });

  it("fails closed before gateway attestation persistence is initialized", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
    await gatewayMethods.get("sat.submitValidatorAttestation")!.handler({
      params: {
        targetAuthority: "target-2",
        epochId: 11,
        microRoundId: 4,
        decisionFlag: 1,
        reasonCode: 3,
        bucketRoot: "aa",
        scoreRoot: "bb",
        coordinationRoot: "cc",
        evidenceHash: "dd",
      },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
    });
  });

  it("fails closed before gateway dispute persistence is initialized", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
    await gatewayMethods.get("sat.openDispute")!.handler({
      params: {
        targetAuthority: "target-3",
        epochId: 12,
        microRoundId: 5,
        reasonCode: 10,
        evidenceHash: "ee",
        targetRoot: "ff",
      },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
    });
  });

  it("returns SAT epoch visibility through gateway inspection", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getEpoch")!.handler({
      params: { epochId: 17 },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          epochId: 17,
          claimsBlocked: true,
          blockedReason: "open_disputes",
          bucketRoot: "aa",
          scoreRoot: "bb",
          coordinationRoot: "cc",
        },
      },
    });
  });

  it("returns SAT status gateway payload with epoch health rollup", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.status")!.handler({
      params: {
        action: "status",
        epochId: 17,
        microRoundId: 1,
        validatorAuthority: "validator-list-1",
      },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          action: "status",
          activeEpochHealth: {
            epochId: 17,
            microRoundId: 1,
            validatorAuthority: "validator-list-1",
            disputeCounts: {
              open: 0,
              resolvedDismissed: 0,
              resolvedUpheld: 1,
            },
            attestationCounts: {
              accept: 0,
              reject: 1,
            },
          },
        },
      },
    });
  });

  it("resolves readiness through the selected wallet without scanning every wallet", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const walletResolver = await import("../../src/wallet/wallet-provider-resolver.js");
    const createWalletProviderAdapter = vi.mocked(walletResolver.createWalletProviderAdapter);
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    createWalletProviderAdapter.mockClear();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({
            plugins: {
              entries: {
                "sat-mining": {
                  enabled: true,
                  config: { enabled: true, network: "devnet", walletId: "wallet-a" },
                },
              },
            },
          })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningReadiness")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    const resolvedWalletIds = createWalletProviderAdapter.mock.calls.map(
      ([arg]) => (arg as { walletId?: string }).walletId,
    );
    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          selectedWalletId: "wallet-a",
          selectedAddress: "miner-wallet-1",
        },
      },
    });
    expect(resolvedWalletIds).toEqual(["wallet-a"]);
  });

  it("treats a missing miner-capital PDA as fundable instead of a separate setup step", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const rpcRead = await import("./src/rpc-read.js");
    vi.mocked(rpcRead.inspectSatMinerCapital).mockResolvedValueOnce(null);
    vi.mocked(rpcRead.inspectSatMinerCapitalAccountStatus).mockResolvedValueOnce({
      address: "miner-capital-1",
      exists: false,
      owner: null,
      expectedOwner: SAT_PROGRAM_ID,
      dataLength: 0,
    });
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({
            plugins: {
              entries: {
                "sat-mining": {
                  enabled: true,
                  config: { enabled: true, network: "devnet", walletId: "wallet-a" },
                },
              },
            },
          })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningReadiness")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          ok: false,
          checks: expect.arrayContaining([
            expect.objectContaining({
              key: "minerInitialized",
              ok: false,
              level: "warning",
              detail: "SAT miner capital account will be created by funding Mining capital",
            }),
            expect.objectContaining({
              key: "cycleEntryReady",
              ok: false,
              level: "warning",
              detail: "Fund Mining capital first",
            }),
          ]),
        },
      },
    });
  });

  it("returns unified SAT recovery summary across command, tool, and gateway", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const commands = new Map<
      string,
      { handler: (ctx: { args?: string }) => Promise<{ text: string }> }
    >();
    const tools = new Map<string, RegisteredTool>();
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(
        (command: {
          name: string;
          handler: (ctx: { args?: string }) => Promise<{ text: string }>;
        }) => {
          commands.set(command.name, command);
        },
      ),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const commandResult = await commands.get("satrecoverysummary")!.handler({
      args: "validator-list-1 17 1",
    });
    expect(JSON.parse(commandResult.text)).toMatchObject({
      recommendedNextAction: "resolve_open_disputes",
      disputeCounts: { resolvedUpheld: 1 },
      attestationCounts: { reject: 1 },
    });

    const toolResult = (await tools.get("sat_get_recovery_summary")!.execute("tool-recovery", {
      validatorAuthority: "validator-list-1",
      epochId: 17,
      microRoundId: 1,
    })) as { details: { recommendedNextAction: string } };
    expect(toolResult.details.recommendedNextAction).toBe("resolve_open_disputes");

    let gatewayResponse: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getRecoverySummary")!.handler({
      params: { validatorAuthority: "validator-list-1", epochId: 17, microRoundId: 1 },
      respond: (ok, payload) => {
        gatewayResponse = { ok, payload };
      },
    });
    expect(gatewayResponse).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          recommendedNextAction: "resolve_open_disputes",
          disputeCounts: { resolvedUpheld: 1 },
          attestationCounts: { reject: 1 },
        },
      },
    });
  });

  it("surfaces dispute list status and epoch claim summaries", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const commands = new Map<
      string,
      { handler: (ctx: { args?: string }) => Promise<{ text: string }> }
    >();
    const tools = new Map<string, RegisteredTool>();
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(
        (command: {
          name: string;
          handler: (ctx: { args?: string }) => Promise<{ text: string }>;
        }) => {
          commands.set(command.name, command);
        },
      ),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const commandResult = await commands.get("satdisputesonchain")!.handler({
      args: "validator-list-1 17 1",
    });
    expect(JSON.parse(commandResult.text)).toMatchObject({
      count: 1,
      disputes: [
        {
          statusLabel: "resolved_upheld",
          epochClaimStatus: {
            blocked: true,
          },
        },
      ],
    });

    const toolResult = (await tools.get("sat_list_disputes")!.execute("tool-disputes", {
      validatorAuthority: "validator-list-1",
      epochId: 17,
      microRoundId: 1,
    })) as {
      details: { disputes: Array<{ statusLabel: string; epochClaimStatus: { blocked: boolean } }> };
    };
    expect(toolResult.details.disputes[0]).toMatchObject({
      statusLabel: "resolved_upheld",
      epochClaimStatus: { blocked: true },
    });

    let gatewayResponse: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.listDisputes")!.handler({
      params: { validatorAuthority: "validator-list-1", epochId: 17, microRoundId: 1 },
      respond: (ok, payload) => {
        gatewayResponse = { ok, payload };
      },
    });
    expect(gatewayResponse).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          disputes: [
            {
              statusLabel: "resolved_upheld",
              epochClaimStatus: { blocked: true },
            },
          ],
        },
      },
    });
  });

  it("surfaces attestation list decision and epoch claim summaries", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const commands = new Map<
      string,
      { handler: (ctx: { args?: string }) => Promise<{ text: string }> }
    >();
    const tools = new Map<string, RegisteredTool>();
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(
        (command: {
          name: string;
          handler: (ctx: { args?: string }) => Promise<{ text: string }>;
        }) => {
          commands.set(command.name, command);
        },
      ),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const commandResult = await commands.get("satattestations")!.handler({
      args: "validator-list-1 17 1",
    });
    expect(JSON.parse(commandResult.text)).toMatchObject({
      count: 1,
      attestations: [
        {
          decisionLabel: "reject",
          epochClaimStatus: {
            blocked: true,
          },
        },
      ],
    });

    const toolResult = (await tools
      .get("sat_list_validator_attestations")!
      .execute("tool-attestations", {
        validatorAuthority: "validator-list-1",
        epochId: 17,
        microRoundId: 1,
      })) as {
      details: {
        attestations: Array<{ decisionLabel: string; epochClaimStatus: { blocked: boolean } }>;
      };
    };
    expect(toolResult.details.attestations[0]).toMatchObject({
      decisionLabel: "reject",
      epochClaimStatus: { blocked: true },
    });

    let gatewayResponse: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.listValidatorAttestations")!.handler({
      params: { validatorAuthority: "validator-list-1", epochId: 17, microRoundId: 1 },
      respond: (ok, payload) => {
        gatewayResponse = { ok, payload };
      },
    });
    expect(gatewayResponse).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          attestations: [
            {
              decisionLabel: "reject",
              epochClaimStatus: { blocked: true },
            },
          ],
        },
      },
    });
  });

  it("surfaces blocked epoch summary in command and status tool output", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const commands = new Map<
      string,
      { handler: (ctx: { args?: string }) => Promise<{ text: string }> }
    >();
    const tools = new Map<string, RegisteredTool>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(
        (command: {
          name: string;
          handler: (ctx: { args?: string }) => Promise<{ text: string }>;
        }) => {
          commands.set(command.name, command);
        },
      ),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const epochCommand = await commands.get("satepoch")!.handler({ args: "17" });
    expect(JSON.parse(epochCommand.text)).toMatchObject({
      epochId: 17,
      claimsBlocked: true,
      blockedReason: "open_disputes",
    });

    const statusTool = (await tools.get("sat_status")!.execute("tool-status", {
      action: "status",
      epochId: 17,
      microRoundId: 1,
      validatorAuthority: "validator-list-1",
    })) as {
      details: {
        activeEpoch: { claimsBlocked: boolean; blockedReason: unknown } | null;
        activeEpochHealth: unknown;
      };
    };
    expect(statusTool.details.activeEpoch).toBeNull();

    expect(statusTool.details.activeEpochHealth).toMatchObject({
      epochId: 17,
      microRoundId: 1,
      validatorAuthority: "validator-list-1",
      disputeCounts: {
        open: 0,
        resolvedDismissed: 0,
        resolvedUpheld: 1,
      },
      attestationCounts: {
        accept: 0,
        reject: 1,
      },
    });

    const epochTool = (await tools.get("sat_get_epoch")!.execute("tool-epoch", {
      epochId: 17,
    })) as { details: { claimsBlocked: boolean; blockedReason: unknown } };
    expect(epochTool.details).toMatchObject({
      claimsBlocked: true,
      blockedReason: "open_disputes",
    });
  });

  it("fails closed for dispute resolution and corrected root republish before startup", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let resolveResponse: { ok: boolean; payload: unknown; error?: unknown } | null = null;
    await gatewayMethods.get("sat.resolveDispute")!.handler({
      params: {
        disputeAuthority: "validator-auto-1",
        targetAuthority: "target-4",
        epochId: 13,
        microRoundId: 6,
        statusFlag: 2,
      },
      respond: (ok, payload, error) => {
        resolveResponse = { ok, payload, error };
      },
    });

    expect(resolveResponse).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
    });

    let republishResponse: { ok: boolean; payload: unknown; error?: unknown } | null = null;
    await gatewayMethods.get("sat.republishEpochRoots")!.handler({
      params: {
        epochId: 13,
        bucketRoot: "aa".repeat(32),
        scoreRoot: "bb".repeat(32),
        coordinationRoot: "cc".repeat(32),
      },
      respond: (ok, payload, error) => {
        republishResponse = { ok, payload, error };
      },
    });

    expect(republishResponse).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
    });
  });

  it("returns republish preflight reasons when corrected roots would be rejected", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const commands = new Map<
      string,
      { handler: (ctx: { args?: string }) => Promise<{ text: string }> }
    >();
    const tools = new Map<string, RegisteredTool>();
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(
        (command: {
          name: string;
          handler: (ctx: { args?: string }) => Promise<{ text: string }>;
        }) => {
          commands.set(command.name, command);
        },
      ),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const result = await commands.get("satrepublishroots")!.handler({
      args: `13 ${"aa".repeat(32)} ${"bb".repeat(32)} ${"cc".repeat(32)}`,
    });
    const parsed = JSON.parse(result.text) as {
      preflight: { canRepublish: boolean; rejectionReasons: Array<{ code: string }> };
    };
    expect(parsed.preflight.canRepublish).toBe(false);
    expect(parsed.preflight.rejectionReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "open_disputes_present" })]),
    );

    const toolResult = (await tools.get("sat_republish_epoch_roots")!.execute("tool-republish", {
      epochId: 13,
      bucketRoot: "aa".repeat(32),
      scoreRoot: "bb".repeat(32),
      coordinationRoot: "cc".repeat(32),
    })) as {
      details: { preflight: { canRepublish: boolean; rejectionReasons: Array<{ code: string }> } };
    };
    expect(toolResult.details.preflight.canRepublish).toBe(false);
    expect(toolResult.details.preflight.rejectionReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "open_disputes_present" })]),
    );

    let gatewayResponse: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.republishEpochRoots")!.handler({
      params: {
        epochId: 13,
        bucketRoot: "aa".repeat(32),
        scoreRoot: "bb".repeat(32),
        coordinationRoot: "cc".repeat(32),
      },
      respond: (ok, payload, error) => {
        gatewayResponse = { ok, payload, error };
      },
    });
    expect(gatewayResponse).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Mining history service is not ready",
      },
    });
    expect(gatewayResponse?.payload).toBeUndefined();
  });

  it("returns mining readiness with real stake and payout probes", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningReadiness")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          balances: {
            solBalanceLamports: "1000000000",
            satBalanceRaw: "100000000000",
          },
          checks: expect.arrayContaining([
            expect.objectContaining({ key: "cycleEntryReady", ok: true }),
            expect.objectContaining({ key: "ataReady", ok: true }),
          ]),
        },
      },
    });
  });

  it("starts mining through the runtime-backed gateway method", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          started: true,
          status: {
            running: true,
            walletId: "wallet-a",
            nextAction: "participation",
            nextActionDetail: expect.stringMatching(/Cycle .* is open for participation/),
            recentActions: expect.arrayContaining([
              expect.objectContaining({ action: "startMining", status: "success" }),
            ]),
          },
        },
      },
    });
  });

  it("starts mining when payout readiness is temporarily unavailable", async () => {
    const rpcRead = await import("./src/rpc-read.js");
    vi.mocked(rpcRead.inspectSatPayoutReadiness).mockRejectedValueOnce(
      new Error("payout probe timeout"),
    );
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger,
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger,
    });

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          started: true,
          status: {
            running: true,
            walletId: "wallet-a",
          },
        },
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("startMining payout readiness probe unavailable"),
    );
  });

  it("returns a fresh non-clearing status when startMining resumes from drain mode", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled: true,
            config: {
              enabled: true,
              drainOnly: true,
              network: "devnet",
              riskMode: "balanced",
              walletId: "wallet-a",
            },
          },
        },
      },
    };

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        drainOnly: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => structuredClone(configState)),
          writeConfigFile: vi.fn(async (next) => {
            Object.assign(configState, next);
          }),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    await gatewayMethods.get("sat.getMiningStatus")!.handler({
      respond: vi.fn(),
    });

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          started: true,
          status: {
            running: true,
            enabledWanted: true,
            drainOnly: false,
            walletId: "wallet-a",
          },
        },
      },
    });
  });

  it("marks drain mode complete when miner capital is clear", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled: true,
            config: {
              enabled: true,
              drainOnly: true,
              network: "devnet",
              riskMode: "balanced",
              walletId: "wallet-a",
            },
          },
        },
      },
    };

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        drainOnly: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => structuredClone(configState)),
          writeConfigFile: vi.fn(async (next) => {
            Object.assign(configState, next);
          }),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningStatus")!.handler({
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          running: false,
          enabledWanted: false,
          drainOnly: false,
          nextActionDetail: "Mining is stopped",
        },
      },
    });
    expect(configState.plugins.entries["sat-mining"].config.drainOnly).toBe(false);
  });

  it("starts mining when the wallet provider balance probe is temporarily unavailable", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const walletResolvers = await import("../../src/wallet/wallet-provider-resolver.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const adapterMock = vi.mocked(walletResolvers.createWalletProviderAdapter);
    const originalAdapterImpl = adapterMock.getMockImplementation();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ result: { value: 700000000 } }),
        }) as Response,
    ) as typeof fetch;
    try {
      adapterMock.mockImplementation(
        () =>
          ({
            health: vi.fn(async () => ({ ok: true, configured: true, details: "ok" })),
            getAddresses: vi.fn(async (options?: { walletId?: string }) => ({
              solana: options?.walletId === "wallet-b" ? "miner-wallet-2" : "miner-wallet-1",
            })),
            getBalance: vi.fn(async () => {
              throw new Error("temporary balance probe failure");
            }),
          }) as never,
      );

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({
              env: { vars: { FASED_WALLET_SOLANA_RPC_URL__WALLET_A: "https://rpc.example" } },
              plugins: { entries: {} },
            })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: "/tmp",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.startMining")!.handler({
        params: { walletId: "wallet-a" },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            started: true,
            status: expect.objectContaining({
              running: true,
              walletId: "wallet-a",
            }),
          },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      adapterMock.mockImplementation(
        originalAdapterImpl ??
          (() =>
            ({
              health: vi.fn(async () => ({ ok: true, configured: true, details: "ok" })),
              getAddresses: vi.fn(async (options?: { walletId?: string }) => ({
                solana: options?.walletId === "wallet-b" ? "miner-wallet-2" : "miner-wallet-1",
              })),
              getBalance: vi.fn(async () => ({ balance: "1000000000", unit: "lamports" })),
            }) as never),
      );
    }
  });

  it("starts mining by topping up wallet reserve from free miner capital when possible", async () => {
    const solanaSubmit = await import("./src/solana-submit.js");
    const rpcRead = await import("./src/rpc-read.js");
    vi.mocked(rpcRead.inspectSatMinerCapital).mockResolvedValueOnce({
      address: "capital",
      version: 2,
      authority: "miner-wallet-1",
      fundedLamports: "1000000000",
      lockedLamports: "0",
      freeLamports: "1000000000",
      activeCommitLamports: "250000000",
    });
    const walletResolvers = await import("../../src/wallet/wallet-provider-resolver.js");
    const adapterMock = vi.mocked(walletResolvers.createWalletProviderAdapter);
    adapterMock.mockImplementation(
      () =>
        ({
          health: vi.fn(async () => ({ ok: true, configured: true, details: "ok" })),
          getAddresses: vi.fn(async () => ({ solana: "miner-wallet-1" })),
          getBalance: vi.fn(async () => ({ balance: "140000000", unit: "lamports" })),
        }) as never,
    );

    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(vi.mocked(solanaSubmit.submitSatWithdrawMinerCapital)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lamports: 10250000 }),
    );
    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          started: true,
          status: expect.objectContaining({
            running: true,
            walletId: "wallet-a",
          }),
        },
      },
    });
  });

  it("preserves unresolved SAT backlog across startMining so recovery context survives restart", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-mining-start-preserve-"));
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const pendingCycleId = currentCycleId - 2;
    const runtimeStorePath = resolveSatRuntimeStorePath(stateDir, "wallet-a");

    await writeSatRecentActions(
      runtimeStorePath,
      [
        {
          action: "submitCycle",
          cycleId: pendingCycleId,
          txHash: "tx-submit-pending",
          status: "success",
          at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          action: "openCycle",
          cycleId: pendingCycleId,
          txHash: "tx-open-pending",
          status: "success",
          at: new Date(Date.now() - 65_000).toISOString(),
        },
      ],
      {
        roundExecution: [
          {
            roundKey: `${pendingCycleId}:0`,
            execution: {
              openRoundSubmitted: true,
              participationSubmitted: true,
              epochFinalized: false,
              crankSubmitted: false,
              claimSubmitted: false,
            },
          },
        ],
        lastKnownStatus: {
          walletId: "wallet-a",
          currentSolBalanceLamports: "1000000000",
          currentSatBalanceRaw: "0",
          registryReserveLamports: "200000000",
          currentCapitalAddress: "capital-a",
          currentCapitalFundedLamports: "5000000000",
          currentCapitalLockedLamports: "250000000",
          currentCapitalFreeLamports: "4750000000",
          currentCapitalFirstPendingCycleId: pendingCycleId,
          currentCapitalLastPendingCycleId: pendingCycleId,
          currentCapitalPendingCycleCount: 1,
          activeCommitLamports: "250000000",
          exactPendingCycleId: pendingCycleId,
          exactPendingStage: "submitted",
          exactPendingReason: "pending capital",
          chainTime: null,
          updatedAt: new Date().toISOString(),
        },
        enabledWanted: true,
        currentRunStartedAt: new Date(Date.now() - 300_000).toISOString(),
      },
    );

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    const persisted = JSON.parse(await fs.readFile(runtimeStorePath, "utf8")) as {
      recentActions: Array<{ action: string; cycleId?: number | null; status: string }>;
      roundExecution: Array<{ roundKey: string }>;
    };

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          started: true,
          status: expect.objectContaining({
            running: true,
            pendingCycleIds: expect.arrayContaining([pendingCycleId]),
            latestSubmittedCycleId: pendingCycleId,
          }),
        },
      },
    });
    expect(persisted.roundExecution).toEqual(
      expect.arrayContaining([expect.objectContaining({ roundKey: `${pendingCycleId}:0` })]),
    );
    expect(persisted.recentActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "submitCycle",
          cycleId: pendingCycleId,
          status: "success",
        }),
      ]),
    );
  });

  it("keeps mining enabled while bootstrap waits for chain time", async () => {
    const rpcRead = await import("./src/rpc-read.js");
    const inspectSatChainUnixTimeMock = vi.mocked(rpcRead.inspectSatChainUnixTime);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-mining-bootstrap-wait-"));
    inspectSatChainUnixTimeMock.mockRejectedValue(new Error("chain time unavailable"));
    try {
      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.startMining")!.handler({
        params: { walletId: "wallet-a" },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            started: false,
            status: expect.objectContaining({
              running: false,
              enabledWanted: true,
              nextAction: "starting",
              nextActionDetail: "Waiting for fresh chain time before starting SAT workers.",
              bootstrapState: "waiting",
              bootstrapReason: "Waiting for fresh chain time before starting SAT workers.",
            }),
          },
        },
      });
    } finally {
      inspectSatChainUnixTimeMock.mockImplementation(async () => Math.floor(Date.now() / 1000));
    }
  });

  it("does not auto-bind the registry default wallet during service startup when config omits walletId", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const writes: unknown[] = [];
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled: true,
            config: {
              enabled: true,
              network: "devnet",
              riskMode: "balanced",
            },
          },
        },
      },
    };

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => structuredClone(configState)),
          writeConfigFile: vi.fn(async (next) => {
            writes.push(next);
            Object.assign(configState, next);
          }),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    expect(writes).toHaveLength(0);
  });

  it("stays stopped on first startup until the user explicitly starts mining", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-first-start-"));
    try {
      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            running: false,
            enabledWanted: false,
            walletId: "wallet-a",
          },
        },
      });
    } finally {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt >= 4) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  it("restores the last enabled mining state on service restart for the attached wallet", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-restart-enabled-"));
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        enabledWanted: true,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({
              plugins: {
                entries: {
                  "sat-mining": {
                    enabled: true,
                    config: {
                      enabled: true,
                      network: "devnet",
                      riskMode: "balanced",
                      walletId: "wallet-a",
                    },
                  },
                },
              },
            })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            running: true,
            enabledWanted: true,
            walletId: "wallet-a",
          },
        },
      });
    } finally {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt >= 4) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  it("restores drain-only release mode on restart when stopped runtime still has locked capital", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-restart-drain-"));
    let inspectSatOpsCapitalSpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        enabledWanted: false,
        lastKnownStatus: {
          walletId: "wallet-a",
          currentSolBalanceLamports: "9000000000",
          currentSatBalanceRaw: "0",
          registryReserveLamports: "200000000",
          currentCapitalAddress: "miner-capital-1",
          currentCapitalFundedLamports: "2494717813",
          currentCapitalLockedLamports: "2475000000",
          currentCapitalFreeLamports: "19717813",
          currentCapitalFirstPendingCycleId: 5932686,
          currentCapitalLastPendingCycleId: 5932694,
          currentCapitalPendingCycleCount: 9,
          activeCommitLamports: "320000000",
          exactPendingCycleId: 5932686,
          exactPendingStage: "stale-closed",
          exactPendingReason: "pending cycle 5932686 is stale-closed",
          chainTime: null,
          updatedAt: "2026-05-26T16:08:44.137Z",
        },
      });

      const rpcRead = await import("./src/rpc-read.js");
      const { satOps } = await import("./src/sat-ops.js");
      inspectSatOpsCapitalSpy = vi.spyOn(satOps, "inspectSatMinerCapital").mockResolvedValue({
        address: "miner-capital-1",
        version: 2,
        authority: "miner-wallet-1",
        fundedLamports: "2494717813",
        lockedLamports: "2475000000",
        freeLamports: "19717813",
        activeCommitLamports: "320000000",
        firstPendingCycleId: 5932686,
        lastPendingCycleId: 5932694,
      });
      vi.mocked(rpcRead.inspectSatMinerCapital)
        .mockResolvedValueOnce({
          address: "miner-capital-1",
          version: 2,
          authority: "miner-wallet-1",
          fundedLamports: "2494717813",
          lockedLamports: "2475000000",
          freeLamports: "19717813",
          activeCommitLamports: "320000000",
          firstPendingCycleId: 5932686,
          lastPendingCycleId: 5932694,
        })
        .mockResolvedValueOnce({
          address: "miner-capital-1",
          version: 2,
          authority: "miner-wallet-1",
          fundedLamports: "2494717813",
          lockedLamports: "2475000000",
          freeLamports: "19717813",
          activeCommitLamports: "320000000",
          firstPendingCycleId: 5932686,
          lastPendingCycleId: 5932694,
        });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const configState = {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: false,
                drainOnly: false,
                network: "devnet",
                riskMode: "balanced",
                walletId: "wallet-a",
              },
            },
          },
        },
      };
      const writeConfigFile = vi.fn(async (next) => {
        Object.assign(configState, next);
      });

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: false,
          drainOnly: false,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile,
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            running: true,
            enabledWanted: false,
            drainOnly: true,
            walletId: "wallet-a",
          },
        },
      });
      expect(configState.plugins.entries["sat-mining"].config.enabled).toBe(false);
      expect(configState.plugins.entries["sat-mining"].config.drainOnly).toBe(false);
      expect(writeConfigFile).not.toHaveBeenCalled();
    } finally {
      inspectSatOpsCapitalSpy?.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves active mining mode on restart when active runtime has locked capital", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-restart-active-locked-"));
    let inspectSatOpsCapitalSpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        enabledWanted: true,
        lastKnownStatus: {
          walletId: "wallet-a",
          currentSolBalanceLamports: "9000000000",
          currentSatBalanceRaw: "0",
          registryReserveLamports: "200000000",
          currentCapitalAddress: "miner-capital-1",
          currentCapitalFundedLamports: "9969049396",
          currentCapitalLockedLamports: "9945000000",
          currentCapitalFreeLamports: "24049396",
          currentCapitalFirstPendingCycleId: 5933662,
          currentCapitalLastPendingCycleId: 5933662,
          currentCapitalPendingCycleCount: 1,
          activeCommitLamports: "9945000000",
          exactPendingCycleId: 5933662,
          exactPendingStage: "claiming",
          exactPendingReason: "pending cycle 5933662 is claiming",
          chainTime: null,
          updatedAt: "2026-05-29T23:51:35.860Z",
        },
      });

      const { satOps } = await import("./src/sat-ops.js");
      inspectSatOpsCapitalSpy = vi.spyOn(satOps, "inspectSatMinerCapital").mockResolvedValue({
        address: "miner-capital-1",
        version: 2,
        authority: "miner-wallet-1",
        fundedLamports: "9969049396",
        lockedLamports: "9945000000",
        freeLamports: "24049396",
        activeCommitLamports: "9945000000",
        firstPendingCycleId: 5933662,
        lastPendingCycleId: 5933662,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const configState = {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                drainOnly: false,
                network: "devnet",
                riskMode: "balanced",
                walletId: "wallet-a",
              },
            },
          },
        },
      };

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          drainOnly: false,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile: vi.fn(async (next) => {
              Object.assign(configState, next);
            }),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            running: true,
            enabledWanted: true,
            drainOnly: false,
            walletId: "wallet-a",
          },
        },
      });
      expect(configState.plugins.entries["sat-mining"].config.enabled).toBe(true);
      expect(configState.plugins.entries["sat-mining"].config.drainOnly).toBe(false);
    } finally {
      inspectSatOpsCapitalSpy?.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports batch claim status in mining status", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-batch-claim-status-"));
    try {
      const claimedAt = new Date().toISOString();
      await writeSatRecentActions(
        resolveSatRuntimeStorePath(tempDir, "wallet-a"),
        [
          {
            action: "claimCycleRewardsBatch",
            cycleId: 123,
            txHash: "tx-claim-batch-123",
            status: "success",
            at: claimedAt,
          },
        ],
        {
          enabledWanted: true,
          lastAction: "claimCycleRewardsBatch",
          lastActionTxHash: "tx-claim-batch-123",
        },
      );

      const rpcRead = await import("./src/rpc-read.js");
      vi.spyOn(rpcRead, "inspectSatClaimReceipt").mockResolvedValue({
        signature: "tx-claim-batch-123",
        feeLamports: "5000",
        claimedSatRaw: "123000000",
        transferredSatRaw: "123000000",
        solRebateLamports: "15000",
        payoutExecuted: true,
        pendingPayoutRaw: "0",
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        params: { forceFresh: true, includeTxReceipts: true },
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            lastClaimTxHash: "tx-claim-batch-123",
            lastClaimAt: claimedAt,
            lastClaimTransferredSatRaw: "123000000",
            recentActions: [
              expect.objectContaining({
                action: "claimCycleRewardsBatch",
                cycleId: 123,
                txHash: "tx-claim-batch-123",
              }),
            ],
          },
        },
      });
    } finally {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt >= 4) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  it("reconciles claimed cycles from planner history when persisted round execution is stale", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-claimed-reconcile-"));
    try {
      const previousCycleId = Math.max(0, Math.floor(Date.now() / 1000 / 300) - 1);
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        plannerHistory: [
          {
            cycleId: previousCycleId,
            committedLamports: "300000000",
            totalSatEarnedRaw: "362500000000",
            totalRebateLamports: "12000",
            txFeeLamports: "20000",
            netLiveCostLamports: "23000",
            validParticipation: true,
            recordedAt: new Date().toISOString(),
          },
        ],
        roundExecution: [
          {
            roundKey: `${previousCycleId}:0`,
            execution: {
              openRoundSubmitted: true,
              participationSubmitted: true,
              epochFinalized: false,
              crankSubmitted: false,
              claimSubmitted: false,
            },
          },
        ],
        enabledWanted: true,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            timeline: expect.arrayContaining([
              expect.objectContaining({
                key: "claim",
                status: "completed",
              }),
            ]),
          },
        },
      });
    } finally {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt >= 4) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  it("returns current-era mining history instead of dropping it with a millisecond cycle anchor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-era-"));
    try {
      const currentCycleId = Math.floor(Date.now() / 1000 / 300);
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        plannerHistory: [
          {
            cycleId: currentCycleId,
            committedLamports: "6400000000",
            totalSatEarnedRaw: "5073457139708",
            totalRebateLamports: "424960",
            txFeeLamports: "30000",
            netLiveCostLamports: "136240",
            validParticipation: true,
            recordedAt: new Date().toISOString(),
          },
          {
            cycleId: currentCycleId - 1,
            committedLamports: "4425000000",
            totalSatEarnedRaw: "4652000000000",
            totalRebateLamports: "110000",
            txFeeLamports: "30000",
            netLiveCostLamports: "140000",
            validParticipation: true,
            recordedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        ],
        enabledWanted: true,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => services.push(service)),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        registerTool: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningHistory")!.handler({
        params: { window: "24h" },
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            latestCycleId: currentCycleId,
            matchingOutcomeCount: 2,
            outcomes: [
              expect.objectContaining({ cycleId: currentCycleId }),
              expect.objectContaining({ cycleId: currentCycleId - 1 }),
            ],
          },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs a claimed cycle into planner history when only submit and claim actions were persisted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-repair-"));
    let mainService:
      | {
          id: string;
          start?: (ctx?: unknown) => Promise<void>;
          stop?: (ctx?: unknown) => Promise<void>;
        }
      | undefined;
    try {
      const cycleId = Math.max(1, Math.floor(Date.now() / 1000 / 300) - 2);
      await writeSatRecentActions(
        resolveSatRuntimeStorePath(tempDir, "wallet-a"),
        [
          {
            action: "submitCycle",
            cycleId,
            txHash: "tx-submit-repair",
            status: "success",
            at: new Date(Date.now() - 120_000).toISOString(),
          },
          {
            action: "claimCycleRewardsBatch",
            cycleId,
            txHash: "tx-claim-repair",
            status: "success",
            at: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
        {
          enabledWanted: true,
          pendingPlannerCycles: [
            {
              cycleId,
              riskMode: "aggressive",
              strategyPreset: "conviction",
              strategyExecution: "auto",
              strategySource: "skill",
              strategyFallbackUsed: true,
              modelId: "test-model",
              participantCount: 2,
              pageCount: 1,
              crowdingRatioFp: "500000",
              plannerRationale: "repair me",
              strategyRationale: "repair me too",
              capitalFundedLamports: "10493000000",
              capitalFreeLamports: "4418000000",
              decidedAt: new Date(Date.now() - 130_000).toISOString(),
            },
          ],
        },
      );

      vi.resetModules();
      const rpcRead = await import("./src/rpc-read.js");
      vi.spyOn(rpcRead, "inspectSatClaimReceipt").mockResolvedValue({
        signature: "tx-claim-repair",
        feeLamports: "5000",
        claimedSatRaw: "20130000000",
        transferredSatRaw: "20130000000",
        solRebateLamports: "480000",
        payoutExecuted: true,
        pendingPayoutRaw: "0",
      });
      vi.spyOn(rpcRead, "inspectSatTxReceipt").mockImplementation(async (_config, params) => {
        if (params.signature === "tx-submit-repair") {
          return {
            signature: params.signature,
            feeLamports: "5000",
            logMessages: [
              "Program log: submit_cycle treasury state exists transferring erosion 317025 from funded committed 3825000000",
            ],
          };
        }
        if (params.signature === "tx-claim-repair") {
          return {
            signature: params.signature,
            feeLamports: "5000",
          };
        }
        return null;
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => services.push(service)),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        registerTool: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningHistory")!.handler({
        params: { window: "24h" },
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            matchingOutcomeCount: 1,
            outcomes: [
              expect.objectContaining({
                cycleId,
                committedLamports: "3825000000",
                totalSatEarnedRaw: "20130000000",
                totalRebateLamports: "480000",
                validParticipation: true,
              }),
            ],
          },
        },
      });
    } finally {
      await mainService?.stop?.({});
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt >= 4) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  it("returns a coherent status snapshot with explicit settled, submitted, and pending cycle fields", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-status-snapshot-"));
    try {
      const currentCycleId = Math.floor(Date.now() / 1000 / 300);
      const previousCycleId = Math.max(0, currentCycleId - 1);
      await writeSatRecentActions(
        resolveSatRuntimeStorePath(tempDir, "wallet-a"),
        [
          {
            action: "submitCycle",
            cycleId: currentCycleId,
            txHash: "tx-submit-current",
            status: "success",
            at: new Date().toISOString(),
          },
          {
            action: "claimCycleRewardsBatch",
            cycleId: previousCycleId,
            txHash: "tx-claim-previous",
            status: "success",
            at: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
        {
          plannerHistory: [
            {
              cycleId: previousCycleId,
              committedLamports: "6375000000",
              totalSatEarnedRaw: "5075000000000",
              totalRebateLamports: "423301",
              txFeeLamports: "30000",
              netLiveCostLamports: "-74551",
              validParticipation: true,
              recordedAt: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
          roundExecution: [
            {
              roundKey: `${currentCycleId}:0`,
              execution: {
                openRoundSubmitted: true,
                participationSubmitted: true,
                epochFinalized: false,
                crankSubmitted: false,
                claimSubmitted: false,
              },
            },
          ],
          enabledWanted: true,
        },
      );

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            currentCycleId,
            latestSettledCycleId: previousCycleId,
            latestSubmittedCycleId: currentCycleId,
            pendingCycleIds: [],
            settledHistory: [
              expect.objectContaining({
                cycleId: previousCycleId,
                totalSatEarnedRaw: "5075000000000",
                netLiveCostLamports: "-74551",
              }),
            ],
          },
        },
      });
      expect(
        (
          response as unknown as {
            payload: { payload: { snapshotAt: string; updatedAt: string } };
          }
        ).payload.payload.snapshotAt,
      ).toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not report recovery backlog blocked when a stale pending range has zero locked capital", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-status-stale-pending-"));
    try {
      const rpcRead = await import("./src/rpc-read.js");
      const inspectMinerCapitalMock = vi.mocked(rpcRead.inspectSatMinerCapital);
      inspectMinerCapitalMock.mockImplementation(async () => ({
        address: "capital",
        version: 2,
        authority: "miner-wallet-1",
        fundedLamports: "5600000000",
        lockedLamports: "0",
        freeLamports: "5600000000",
        activeCommitLamports: "4090000000",
        firstPendingCycleId: 5918111,
        lastPendingCycleId: 5918142,
      }));

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            blocked: false,
            blockedReason: undefined,
            currentCapitalPendingCycleCount: 32,
            currentCapitalLockedLamports: "0",
          },
        },
      });
    } finally {
      const rpcRead = await import("./src/rpc-read.js");
      vi.mocked(rpcRead.inspectSatMinerCapital).mockImplementation(async () => ({
        address: "miner-capital-1",
        version: 2,
        authority: "miner-wallet-1",
        fundedLamports: "500000000",
        lockedLamports: "0",
        freeLamports: "500000000",
        activeCommitLamports: "250000000",
      }));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers the effective local pending cycle over a stale raw pending-range prefix", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-status-effective-pending-"));
    try {
      const currentCycleId = Math.floor(Date.now() / 1000 / 300);
      const submittedCycleId = currentCycleId - 1;
      const rpcRead = await import("./src/rpc-read.js");
      vi.mocked(rpcRead.inspectSatMinerCapital).mockResolvedValueOnce({
        address: "capital",
        version: 2,
        authority: "miner-wallet-1",
        fundedLamports: "5600000000",
        lockedLamports: "3050000000",
        freeLamports: "2550000000",
        activeCommitLamports: "3050000000",
        firstPendingCycleId: submittedCycleId - 100,
        lastPendingCycleId: submittedCycleId,
      });
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [
        {
          action: "submitCycle",
          cycleId: submittedCycleId,
          status: "success",
          txHash: "tx-submit",
          at: new Date().toISOString(),
        },
      ]);

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            currentCapitalPendingCycleCount: 1,
            currentCapitalFirstPendingCycleId: submittedCycleId,
            currentCapitalLastPendingCycleId: submittedCycleId,
            pendingCycleIds: [submittedCycleId],
            blocked: false,
          },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("hides internal maintenance actions from user-facing mining status", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-public-actions-"));
    try {
      const actionAt = new Date().toISOString();
      await writeSatRecentActions(
        resolveSatRuntimeStorePath(tempDir, "wallet-a"),
        [
          {
            action: "claimCycleRewardsBatch",
            cycleId: 320,
            status: "success",
            txHash: "tx-claim",
            at: actionAt,
          },
          {
            action: "submitCycle",
            cycleId: 321,
            status: "success",
            txHash: "tx-submit",
            at: actionAt,
          },
          {
            action: "bootstrapRegistryReserve",
            status: "success",
            txHash: "tx-bootstrap",
            at: actionAt,
          },
          {
            action: "openCycle",
            cycleId: 321,
            status: "success",
            txHash: "tx-open",
            at: actionAt,
          },
        ],
        {
          enabledWanted: true,
          lastAction: "bootstrapRegistryReserve",
          lastActionTxHash: "tx-bootstrap",
        },
      );

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            lastAction: "claimCycleRewardsBatch",
            lastActionTxHash: "tx-claim",
            recentActions: expect.arrayContaining([
              expect.objectContaining({ action: "submitCycle", cycleId: 321 }),
              expect.objectContaining({ action: "claimCycleRewardsBatch", cycleId: 320 }),
            ]),
          },
        },
      });
      expect(
        (
          response as unknown as {
            payload: { payload: { recentActions: Array<{ action: string }> } };
          }
        ).payload.payload.recentActions,
      ).toHaveLength(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("filters stale historical actions out of the live mining status feed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-status-recent-actions-"));
    try {
      const currentCycleId = Math.floor(Date.now() / 1000 / 300);
      const staleCycleId = Math.max(0, currentCycleId - 40);
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [
        {
          action: "depositMinerCapital",
          status: "success",
          txHash: "tx-old-wallet",
          at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
        },
        {
          action: "submitCycle",
          cycleId: staleCycleId,
          status: "success",
          txHash: "tx-old-cycle",
          at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
        },
        {
          action: "submitCycle",
          cycleId: currentCycleId,
          status: "success",
          txHash: "tx-current-cycle",
          at: new Date().toISOString(),
        },
      ]);

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => services.push(service)),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        registerTool: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            recentActions: [
              expect.objectContaining({ action: "submitCycle", cycleId: currentCycleId }),
            ],
          },
        },
      });
      expect(
        (
          response as unknown as {
            payload: {
              payload: {
                recentActions: Array<{
                  action: string;
                  cycleId?: number | null;
                  txHash?: string | null;
                }>;
              };
            };
          }
        ).payload.payload.recentActions,
      ).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ txHash: "tx-old-wallet" }),
          expect.objectContaining({ cycleId: staleCycleId, txHash: "tx-old-cycle" }),
        ]),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers explicit persisted config enabled=true over stale runtime disabled state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-restart-config-on-"));
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        enabledWanted: false,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const configState = {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                network: "devnet",
                riskMode: "balanced",
                walletId: "wallet-a",
              },
            },
          },
        },
      };

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            running: true,
            enabledWanted: true,
            walletId: "wallet-a",
          },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers explicit persisted config enabled=false over stale runtime enabled state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-restart-config-off-"));
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        enabledWanted: true,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const configState = {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: false,
                network: "devnet",
                riskMode: "balanced",
                walletId: "wallet-a",
              },
            },
          },
        },
      };

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            running: false,
            enabledWanted: false,
            walletId: "wallet-a",
          },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a stopped fallback status when stopMining succeeds but status refresh fails", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const { satOps } = await import("./src/sat-ops.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: vi.fn(),
    });

    const inspectConnectionDetailsSpy = vi
      .spyOn(satOps, "inspectConnectionDetails")
      .mockImplementation(() => {
        throw new Error("status snapshot failed");
      });

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.stopMining")!.handler({
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    inspectConnectionDetailsSpy.mockRestore();

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          stopped: true,
          status: {
            running: false,
            enabledWanted: false,
            nextAction: "wait",
            nextActionDetail: "Mining is stopped",
            walletId: "wallet-a",
            currentCapitalFundedLamports: "500000000",
            currentCapitalFreeLamports: "500000000",
            activeCommitLamports: "250000000",
          },
        },
      },
    });
  });

  it("resolves mining status against the refreshed local-signer wallet address", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-refreshed-wallet-address-"));
    const { default: satMiningPlugin } = await import("./implementation.js");
    const { satOps } = await import("./src/sat-ops.js");
    const walletRegistry = await import("../../src/wallet/wallet-provider-registry.js");
    const walletResolvers = await import("../../src/wallet/wallet-provider-resolver.js");
    const rpcRead = await import("./src/rpc-read.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled: true,
            config: {
              walletId: "wallet-a",
              network: "devnet",
              riskMode: "balanced",
            },
          },
        },
      },
    };
    const registryMock = vi.mocked(walletRegistry.readWalletProviderRegistry);
    const adapterMock = vi.mocked(walletResolvers.createWalletProviderAdapter);
    const inspectMinerCapitalMock = vi.mocked(rpcRead.inspectSatMinerCapital);
    const payoutReadinessMock = vi.mocked(rpcRead.inspectSatPayoutReadiness);
    const originalRegistryImpl = registryMock.getMockImplementation();
    const originalAdapterImpl = adapterMock.getMockImplementation();
    const originalInspectMinerCapitalImpl = inspectMinerCapitalMock.getMockImplementation();
    const originalPayoutReadinessImpl = payoutReadinessMock.getMockImplementation();
    const readSnapshotSpy = vi.spyOn(satOps, "readSnapshot").mockResolvedValue({
      authority: "legacy-wallet-a",
      roundBucket: null,
      epoch: null,
      walletEpoch: null,
      roundCommit: null,
      roundState: null,
      stake: null,
      payoutReadiness: null,
      treasuryState: null,
      registryReserve: null,
    } as never);
    try {
      registryMock.mockImplementation(
        () =>
          ({
            defaultWalletId: "wallet-a",
            wallets: [
              {
                id: "wallet-a",
                name: "Wallet A",
                providerId: "local-socket-signer",
                addresses: { solana: "stale-wallet-a" },
                metadata: { role: "mining", purpose: "mining" },
              },
            ],
          }) as never,
      );
      adapterMock.mockImplementation(
        () =>
          ({
            health: vi.fn(async () => ({ ok: true, configured: true, details: "ok" })),
            getAddresses: vi.fn(async (options?: { walletId?: string }) => ({
              solana: options?.walletId === "wallet-a" ? "live-wallet-a" : "default-wallet-a",
            })),
            getBalance: vi.fn(async () => ({ balance: "1000000000", unit: "lamports" })),
          }) as never,
      );
      inspectMinerCapitalMock.mockImplementation(async (_config, params) => {
        return params.authority === "live-wallet-a"
          ? ({
              address: "miner-capital-live",
              authority: "live-wallet-a",
              fundedLamports: "350000000",
              lockedLamports: "0",
              freeLamports: "350000000",
              activeCommitLamports: "250000000",
            } as never)
          : (null as never);
      });
      payoutReadinessMock.mockImplementation(async (_config, params) => {
        return params.authority === "live-wallet-a"
          ? ({
              treasuryAddress: "treasury-1",
              treasuryAta: "treasury-ata-1",
              recipientAta: "recipient-ata-1",
              treasuryAtaExists: true,
              recipientAtaExists: true,
              treasuryBalanceRaw: "900000000000",
              recipientBalanceRaw: "42000000000",
            } as never)
          : (null as never);
      });

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            walletId: "wallet-a",
            validatorAuthority: "live-wallet-a",
            currentCapitalFundedLamports: "350000000",
            currentSatBalanceRaw: "42000000000",
          },
        },
      });

      response = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            walletId: "wallet-a",
            validatorAuthority: "live-wallet-a",
            currentCapitalFundedLamports: "350000000",
            currentSatBalanceRaw: "42000000000",
          },
        },
      });
      expect(readSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(inspectMinerCapitalMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authority: "live-wallet-a" }),
      );
    } finally {
      readSnapshotSpy.mockRestore();
      registryMock.mockImplementation(
        originalRegistryImpl ??
          (() =>
            ({
              defaultWalletId: "wallet-a",
              wallets: [
                {
                  id: "wallet-a",
                  name: "Wallet A",
                  providerId: "embedded-keystore",
                  addresses: { solana: "miner-wallet-1" },
                  metadata: { role: "mining", purpose: "mining" },
                },
                {
                  id: "wallet-b",
                  name: "Wallet B",
                  providerId: "embedded-keystore",
                  addresses: { solana: "miner-wallet-2" },
                },
              ],
            }) as never),
      );
      adapterMock.mockImplementation(
        originalAdapterImpl ??
          (() =>
            ({
              health: vi.fn(async () => ({ ok: true, configured: true, details: "ok" })),
              getAddresses: vi.fn(async (options?: { walletId?: string }) => ({
                solana: options?.walletId === "wallet-b" ? "miner-wallet-2" : "miner-wallet-1",
              })),
              getBalance: vi.fn(async () => ({ balance: "1000000000", unit: "lamports" })),
            }) as never),
      );
      inspectMinerCapitalMock.mockImplementation(
        originalInspectMinerCapitalImpl ??
          (async () =>
            ({
              address: "miner-capital-1",
              version: 2,
              authority: "miner-wallet-1",
              fundedLamports: "500000000",
              lockedLamports: "0",
              freeLamports: "500000000",
              activeCommitLamports: "250000000",
            }) as never),
      );
      payoutReadinessMock.mockImplementation(
        originalPayoutReadinessImpl ??
          (async () =>
            ({
              treasuryAddress: "treasury-1",
              treasuryAta: "treasury-ata-1",
              recipientAta: "recipient-ata-1",
              treasuryAtaExists: true,
              recipientAtaExists: true,
              treasuryBalanceRaw: "900000000000",
              recipientBalanceRaw: "100000000000",
            }) as never),
      );
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns a gateway error shape when stopMining persistence fails", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{ id: string; start?: (ctx: unknown) => Promise<void> | void }> = [];
    const writeConfigFile = vi.fn(async () => {
      throw new Error("persist failed");
    });

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        walletId: "wallet-a",
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {
        config: {
          loadConfig: () => ({
            plugins: {
              entries: {
                "sat-mining": {
                  config: { enabled: true, network: "devnet", walletId: "wallet-a" },
                },
              },
            },
          }),
          writeConfigFile,
        },
      },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.stopMining")!.handler({
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(response).toMatchObject({
      ok: false,
      payload: undefined,
      error: {
        code: "UNAVAILABLE",
        message: "persist failed",
      },
    });
  });

  it("persists commitLamports after setActiveCommit succeeds", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{ id: string; start?: (ctx: unknown) => Promise<void> | void }> = [];
    const writeConfigFile = vi.fn(async () => {});
    const solanaSubmit = await import("./src/solana-submit.js");
    const setActiveCommitMock = vi.mocked(solanaSubmit.submitSatSetActiveCommit);

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        walletId: "wallet-a",
        commitLamports: 12_930_000_000,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {
        config: {
          loadConfig: () => ({
            plugins: {
              entries: {
                "sat-mining": {
                  enabled: true,
                  config: {
                    enabled: true,
                    network: "devnet",
                    walletId: "wallet-a",
                    commitLamports: 12_930_000_000,
                  },
                },
              },
            },
          }),
          writeConfigFile,
        },
      },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.setActiveCommit")!.handler({
      params: { lamports: 300_000_000 },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(setActiveCommitMock).toHaveBeenCalledWith(expect.anything(), { lamports: 300_000_000 });
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: {
          entries: {
            "sat-mining": expect.objectContaining({
              config: expect.objectContaining({
                commitLamports: 300_000_000,
              }),
            }),
          },
        },
      }),
    );
    expect(response).toMatchObject({
      ok: true,
      error: undefined,
    });
  });

  it("does not persist commitLamports when setActiveCommit is used for a one-cycle auto adjustment", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{ id: string; start?: (ctx: unknown) => Promise<void> | void }> = [];
    const writeConfigFile = vi.fn(async () => {});
    const solanaSubmit = await import("./src/solana-submit.js");
    const setActiveCommitMock = vi.mocked(solanaSubmit.submitSatSetActiveCommit);

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        walletId: "wallet-a",
        commitLamports: 9_275_000_000,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {
        config: {
          loadConfig: () => ({
            plugins: {
              entries: {
                "sat-mining": {
                  enabled: true,
                  config: {
                    enabled: true,
                    network: "devnet",
                    walletId: "wallet-a",
                    commitLamports: 9_275_000_000,
                  },
                },
              },
            },
          }),
          writeConfigFile,
        },
      },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.setActiveCommit")!.handler({
      params: { lamports: 575_000_000, persistConfig: false },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(setActiveCommitMock).toHaveBeenCalledWith(expect.anything(), { lamports: 575_000_000 });
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: true,
      error: undefined,
    });
  });

  it("auto-initializes SAT miner capital before funding when the capital PDA is missing", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{ id: string; start?: (ctx: unknown) => Promise<void> | void }> = [];
    const solanaSubmit = await import("./src/solana-submit.js");
    const rpcRead = await import("./src/rpc-read.js");
    const initCapitalMock = vi.mocked(solanaSubmit.submitSatInitMinerCapital);
    const depositCapitalMock = vi.mocked(solanaSubmit.submitSatDepositMinerCapital);
    const capitalStatusMock = vi.mocked(rpcRead.inspectSatMinerCapitalAccountStatus);

    capitalStatusMock
      .mockResolvedValueOnce({
        address: "miner-capital-1",
        exists: false,
        owner: null,
        expectedOwner: SAT_PROGRAM_ID,
        dataLength: 0,
      })
      .mockResolvedValueOnce({
        address: "miner-capital-1",
        exists: true,
        owner: SAT_PROGRAM_ID,
        expectedOwner: SAT_PROGRAM_ID,
        dataLength: 112,
      });

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        walletId: "wallet-a",
      },
      runtime: {
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir: "/tmp",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.depositMinerCapital")!.handler({
      params: { lamports: 250_000_000 },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(initCapitalMock).toHaveBeenCalled();
    expect(depositCapitalMock).toHaveBeenCalledWith(expect.anything(), { lamports: 250_000_000 });
    expect(response).toMatchObject({ ok: true, error: undefined });
  });

  it("surfaces a capital-owner mismatch clearly in mining readiness", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const rpcRead = await import("./src/rpc-read.js");
    const capitalStatusMock = vi.mocked(rpcRead.inspectSatMinerCapitalAccountStatus);
    const inspectCapitalMock = vi.mocked(rpcRead.inspectSatMinerCapital);

    capitalStatusMock.mockResolvedValueOnce({
      address: "miner-capital-1",
      exists: true,
      owner: "11111111111111111111111111111111",
      expectedOwner: SAT_PROGRAM_ID,
      dataLength: 0,
    });
    inspectCapitalMock.mockResolvedValueOnce(null);

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningReadiness")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          checks: expect.arrayContaining([
            expect.objectContaining({
              key: "minerInitialized",
              ok: false,
              detail: expect.stringContaining("owner mismatch"),
            }),
            expect.objectContaining({
              key: "cycleEntryReady",
              ok: false,
              detail: expect.stringContaining("invalid owner"),
            }),
          ]),
        },
      },
    });
  });

  it("persists round execution immediately after openCycle and commitCycle succeed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-submit-persist-"));
    try {
      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{ id: string; start?: (ctx: unknown) => Promise<void> | void }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({
              plugins: {
                entries: {
                  "sat-mining": {
                    enabled: true,
                    config: {
                      enabled: true,
                      network: "devnet",
                      walletId: "wallet-a",
                    },
                  },
                },
              },
            })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 123 },
        respond: () => {},
      });
      await gatewayMethods.get("sat.commitCycle")!.handler({
        params: {
          cycleId: 123,
          commitmentHex: "11".repeat(32),
          commitmentReference: `sha256:${"ab".repeat(32)}`,
        },
        respond: () => {},
      });

      const persisted = await SatMiningHistoryStore.openReadOnly({
        databasePath: resolveSatMiningHistoryDatabasePath(tempDir, "wallet-a"),
      });
      try {
        expect(persisted.readOperationalState().roundExecution).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              roundKey: "123:0",
              execution: expect.objectContaining({
                openRoundSubmitted: true,
                commitSubmitted: true,
                participationSubmitted: false,
              }),
            }),
          ]),
        );
      } finally {
        persisted.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not record commitCycle rollover as a hard recent-action failure", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-submit-rollover-"));
    const solanaSubmit = await import("./src/solana-submit.js");
    vi.mocked(solanaSubmit.submitSatCommitCycle).mockRejectedValueOnce(
      new Error(
        "Transaction simulation failed: Error processing Instruction 0: InvalidInstructionData Program log: commit_cycle cycle mismatch: requested=123, current=124",
      ),
    );
    try {
      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{ id: string; start?: (ctx: unknown) => Promise<void> | void }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({
              plugins: {
                entries: {
                  "sat-mining": {
                    enabled: true,
                    config: {
                      enabled: true,
                      network: "devnet",
                      walletId: "wallet-a",
                    },
                  },
                },
              },
            })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.commitCycle")!.handler({
        params: {
          cycleId: 123,
          commitmentHex: "11".repeat(32),
          commitmentReference: `sha256:${"ab".repeat(32)}`,
        },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });

      const persisted = await SatMiningHistoryStore.openReadOnly({
        databasePath: resolveSatMiningHistoryDatabasePath(tempDir, "wallet-a"),
      });

      expect((response as { ok: boolean } | null)?.ok).toBe(false);
      try {
        expect(
          persisted
            .queryActions({ window: "all" })
            .actions.some(
              (entry) =>
                entry.action === "commitCycle" &&
                entry.cycleId === 123 &&
                entry.status === "failure",
            ),
        ).toBe(false);
      } finally {
        persisted.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports unattached readiness without mutating persisted config first", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const writeConfigFile = vi.fn(async () => {});

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({
            plugins: { entries: { "sat-mining": { enabled: true, config: {} } } },
          })),
          writeConfigFile,
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningReadiness")!.handler({
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          selectedWalletId: undefined,
          checks: expect.arrayContaining([
            expect.objectContaining({ key: "walletSelected", ok: false }),
            expect.objectContaining({
              key: "signerReady",
              remediation:
                "Use the local native signer for unattended Mining. Wallet Standard and Turnkey are reviewed/manual wallet paths, not background Mining signers.",
            }),
          ]),
        },
      },
    });
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects an Agent wallet for SAT mining in readiness and start", async () => {
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    const registryMock = vi.mocked(readWalletProviderRegistry);
    registryMock.mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Agent",
          providerId: "embedded-keystore",
          addresses: { solana: "agent-wallet-1" },
          metadata: { role: "agent", purpose: "agent" },
        },
      ],
    } as never);

    try {
      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const configState = {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: { enabled: true, network: "devnet", walletId: "wallet-a" },
            },
          },
        },
      };

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn(),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      for (const method of ["sat.getMiningReadiness", "sat.startMining", "sat.setMinerProfile"]) {
        let response: { ok: boolean; error?: unknown } | null = null;
        await gatewayMethods.get(method)!.handler({
          params: { walletId: "wallet-a" },
          respond: (ok, _payload, error) => {
            response = { ok, error };
          },
        });
        if (method === "sat.getMiningReadiness") {
          expect(response).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message:
                "walletId wallet-a is not the dedicated Mining wallet; create or import @wallet:mining and use that wallet for SAT mining",
            },
          });
        } else {
          expect(response).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
          });
        }
      }

      let walletsResponse: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.listMiningWallets")!.handler({
        respond: (ok, payload) => {
          walletsResponse = { ok, payload };
        },
      });
      expect(walletsResponse).toMatchObject({
        ok: true,
        payload: { ok: true, payload: { wallets: [] } },
      });
    } finally {
      registryMock.mockReturnValue({
        defaultWalletId: "wallet-a",
        wallets: [
          {
            id: "wallet-a",
            name: "Wallet A",
            providerId: "embedded-keystore",
            addresses: { solana: "miner-wallet-1" },
            metadata: { role: "mining", purpose: "mining" },
          },
          {
            id: "wallet-b",
            name: "Wallet B",
            providerId: "embedded-keystore",
            addresses: { solana: "miner-wallet-2" },
            metadata: { role: "mining", purpose: "mining" },
          },
        ],
      } as never);
    }
  });

  it("fails startMining when no configured or default wallet is available", async () => {
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    const registryMock = vi.mocked(readWalletProviderRegistry);
    registryMock.mockReturnValue({
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    } as never);

    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({
            plugins: { entries: { "sat-mining": { enabled: true, config: {} } } },
          })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(response).toMatchObject({
      ok: false,
      payload: undefined,
      error: {
        code: "UNAVAILABLE",
        message: "Mining history service is not ready",
      },
    });
    registryMock.mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
        {
          id: "wallet-b",
          name: "Wallet B",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-2" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    } as never);
  });

  it("keeps mining stopped when the active commit transaction fails", async () => {
    const solanaSubmit = await import("./src/solana-submit.js");
    vi.mocked(solanaSubmit.submitSatSetActiveCommit)
      .mockRejectedValueOnce(new Error("set active commit transaction failed"))
      .mockRejectedValueOnce(new Error("profile commit transaction failed"));
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const writeConfigFile = vi.fn(async () => {});

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile,
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
    await gatewayMethods.get("sat.startMining")!.handler({
      params: { walletId: "wallet-a" },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(response).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
    });
    expect(writeConfigFile).not.toHaveBeenCalled();

    response = null;
    await gatewayMethods.get("sat.setMinerProfile")!.handler({
      params: { profile: { walletId: "wallet-a" }, syncActiveCommit: true },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });
    expect(response).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
    });
  });

  it("keeps mining wallet attachment read-only through gateway methods", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const writes: unknown[] = [];
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled: true,
            config: {
              enabled: true,
              network: "devnet",
              riskMode: "balanced",
              walletId: "wallet-a",
            },
          },
        },
      },
    };

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => structuredClone(configState)),
          writeConfigFile: vi.fn(async (next) => {
            writes.push(next);
            Object.assign(configState, next);
          }),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    expect(gatewayMethods.has("sat.attachMiningWallet")).toBe(false);
    expect(gatewayMethods.has("sat.detachMiningWallet")).toBe(false);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.getMiningWalletAttachment")!.handler({
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });
    expect(response).toMatchObject({
      ok: true,
      payload: { ok: true, payload: { walletId: "wallet-a", attached: true } },
    });
    expect(writes).toHaveLength(0);
  });

  it("migrates persisted runtime actions into the permanent ledger on startup", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-action-history-backfill-"));
    let mainService:
      | {
          id: string;
          start?: (ctx?: unknown) => Promise<void>;
          stop?: (ctx?: unknown) => Promise<void>;
        }
      | undefined;
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [
        {
          action: "submitCycle",
          cycleId: 101,
          txHash: "tx-submit-101",
          status: "success",
          at: new Date().toISOString(),
        },
      ]);

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({
              plugins: {
                entries: {
                  "sat-mining": {
                    enabled: true,
                    config: {
                      enabled: true,
                      network: "devnet",
                      riskMode: "balanced",
                      walletId: "wallet-a",
                    },
                  },
                },
              },
            })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningHistory")!.handler({
        params: { window: "all", activityWindow: "all" },
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      await expect(
        fs.stat(path.join(tempDir, "sat-mining", "wallets", "wallet-a", "mining.sqlite")),
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            actions: [expect.objectContaining({ action: "submitCycle", cycleId: 101 })],
            totalStoredActionCount: 1,
          },
        },
      });
    } finally {
      await mainService?.stop?.({});
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("hydrates activated SQLite runtime intent and locked-capital recovery without legacy readers", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-activated-runtime-restart-"));
    let mainService:
      | {
          id: string;
          start?: (ctx?: unknown) => Promise<void>;
          stop?: (ctx?: unknown) => Promise<void>;
        }
      | undefined;
    const runtimeStorePath = resolveSatRuntimeStorePath(stateDir, "wallet-a");
    const auditStorePath = path.join(
      stateDir,
      "sat-mining",
      "wallets",
      "wallet-a",
      "audit-store.json",
    );
    const plannerHistoryStorePath = resolveSatPlannerHistoryStorePath(stateDir, "wallet-a");
    const submissionStorePath = path.join(
      stateDir,
      "sat-mining",
      "wallets",
      "wallet-a",
      "submission-ledger.json",
    );
    try {
      const seeded = await SatMiningHistoryStore.open({
        databasePath: resolveSatMiningHistoryDatabasePath(stateDir, "wallet-a"),
        scope: {
          walletId: "wallet-a",
          authority: "miner-wallet-1",
          providerId: "embedded-keystore",
          network: "devnet",
          programId: SAT_PROGRAM_ID,
          mintAddress: SAT_MINT_ADDRESS,
          mintProgramId: SAT_MINT_PROGRAM_ID,
          protocolVersion: "sat-v2",
        },
      });
      await seeded.store.replaceOperationalState({
        archivedFailures: [
          {
            action: "withdrawMinerCapital",
            txHash: null,
            status: "failure",
            message: "restart recovery remains required",
            at: "2026-08-19T00:00:00.000Z",
          },
        ],
        workers: {
          recovery: {
            enabled: true,
            running: false,
            retryCount: 2,
            rpcTimeoutCount: 0,
            waitingReason: "locked capital recovery",
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            lastFailureAt: "2026-08-19T00:00:00.000Z",
            lastError: "pending recovery",
            lastDetail: "capital is still locked",
            lastSelectedCycleId: 91,
            lastSelectedStage: "claim",
            lastSkipReason: null,
          },
        },
        runtimeMeta: {
          enabledWanted: true,
          lastKnownStatus: {
            walletId: "wallet-a",
            currentSolBalanceLamports: "1000000000",
            currentSatBalanceRaw: "0",
            registryReserveLamports: "0",
            currentCapitalAddress: "capital-a",
            currentCapitalFundedLamports: "5000000000",
            currentCapitalLockedLamports: "250000000",
            currentCapitalFreeLamports: "4750000000",
            currentCapitalFirstPendingCycleId: 91,
            currentCapitalLastPendingCycleId: 91,
            currentCapitalPendingCycleCount: 1,
            activeCommitLamports: "250000000",
            exactPendingCycleId: 91,
            exactPendingStage: "submitted",
            exactPendingReason: "locked recovery",
            chainTime: null,
            updatedAt: "2026-08-19T00:00:00.000Z",
          },
        },
      });
      seeded.store.close();

      // The activated marker must prevent all three legacy JSON readers from
      // reopening these hostile pathnames during the plugin restart.
      for (const legacyPath of [
        runtimeStorePath,
        auditStorePath,
        plannerHistoryStorePath,
        submissionStorePath,
      ]) {
        await fs.mkdir(path.dirname(legacyPath), { recursive: true });
        const replacement = `${legacyPath}.replacement`;
        await fs.writeFile(
          replacement,
          legacyPath === plannerHistoryStorePath
            ? `${JSON.stringify({
                cycleId: 999_999,
                committedLamports: "1",
                totalSatEarnedRaw: "1",
                totalRebateLamports: "0",
                txFeeLamports: "0",
                netLiveCostLamports: "1",
                validParticipation: true,
                recordedAt: "2026-08-19T00:00:00.000Z",
              })}\n`
            : "legacy reader must remain unused\n",
          "utf8",
        );
        await fs.symlink(replacement, legacyPath);
      }
      const guardedLegacyPaths = new Set([
        runtimeStorePath,
        auditStorePath,
        plannerHistoryStorePath,
        submissionStorePath,
      ]);
      const readFile = fs.readFile.bind(fs);
      const legacyRead = vi.spyOn(fs, "readFile").mockImplementation(async (file, ...args) => {
        if (guardedLegacyPaths.has(String(file))) {
          throw new Error(`legacy reader was invoked for ${String(file)}`);
        }
        return await readFile(file, ...args);
      });
      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: false,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
            writeConfigFile: vi.fn(async () => {}),
          },
        },
        logger,
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir,
        logger,
      });
      expect(
        legacyRead.mock.calls.filter(([file]) => guardedLegacyPaths.has(String(file))),
      ).toEqual([]);
      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        params: { responsive: true },
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });
      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: expect.objectContaining({
            enabledWanted: true,
            archivedFailures: [expect.objectContaining({ action: "withdrawMinerCapital" })],
            workers: expect.objectContaining({
              recovery: expect.objectContaining({
                retryCount: 2,
                waitingReason: "locked capital recovery",
                lastSelectedCycleId: 91,
              }),
            }),
            settledHistory: expect.not.arrayContaining([
              expect.objectContaining({ cycleId: 999_999 }),
            ]),
          }),
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("preserved active mining mode for locked miner capital"),
      );
    } finally {
      await mainService?.stop?.({});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("retries SAT worker startup after service boot when wallet readiness arrives later", async () => {
    vi.useFakeTimers();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-wallet-retry-startup-"));
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    const registryMock = vi.mocked(readWalletProviderRegistry);
    let walletReady = false;
    registryMock.mockImplementation(
      () =>
        ({
          defaultWalletId: "wallet-a",
          wallets: walletReady
            ? [
                {
                  id: "wallet-a",
                  name: "Wallet A",
                  providerId: "embedded-keystore",
                  addresses: { solana: "miner-wallet-1" },
                  metadata: { role: "mining", purpose: "mining" },
                },
              ]
            : [],
        }) as never,
    );
    try {
      await writeSatRecentActions(resolveSatRuntimeStorePath(tempDir, "wallet-a"), [], {
        enabledWanted: true,
      });

      const { default: satMiningPlugin } = await import("./implementation.js");
      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const configState = {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                network: "devnet",
                riskMode: "balanced",
                walletId: "wallet-a",
              },
            },
          },
        },
      };

      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => structuredClone(configState)),
            writeConfigFile: vi.fn(async (next) => {
              Object.assign(configState, next);
            }),
          },
        },
        logger,
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger,
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });
      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: { walletId: "wallet-a", running: false, enabledWanted: true },
        },
      });

      walletReady = true;
      await vi.advanceTimersByTimeAsync(10_000);

      response = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });
      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: { walletId: "wallet-a", running: true, enabledWanted: true },
        },
      });

      await mainService?.stop?.({});
    } finally {
      registryMock.mockReturnValue({
        defaultWalletId: "wallet-a",
        wallets: [
          {
            id: "wallet-a",
            name: "Wallet A",
            providerId: "embedded-keystore",
            addresses: { solana: "miner-wallet-1" },
            metadata: { role: "mining", purpose: "mining" },
          },
          {
            id: "wallet-b",
            name: "Wallet B",
            providerId: "embedded-keystore",
            addresses: { solana: "miner-wallet-2" },
            metadata: { role: "mining", purpose: "mining" },
          },
        ],
      } as never);
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes persisted planner outcomes in mining status settled history", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-status-persisted-history-"));
    try {
      const runtimeStorePath = resolveSatRuntimeStorePath(tempDir, "wallet-a");
      await writeSatRecentActions(runtimeStorePath, [], {
        enabledWanted: true,
      });
      await appendSatPlannerHistoryOutcome(resolveSatPlannerHistoryStorePath(tempDir, "wallet-a"), {
        cycleId: 5920455,
        committedLamports: "6075000000",
        totalSatEarnedRaw: "3142813930597",
        totalRebateLamports: "384970",
        txFeeLamports: "25000",
        netLiveCostLamports: "129255",
        erosionLamports: "504225",
        submitFeeLamports: "5000",
        keeperFeeLamports: "10000",
        claimFeeLamports: "5000",
        otherFeeLamports: "5000",
        keeperBountyLamports: "15000",
        cycleKeeperBountyPaidLamports: "30000",
        validParticipation: true,
        recordedAt: new Date().toISOString(),
      });

      const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
      const services: Array<{
        id: string;
        start?: (ctx?: unknown) => Promise<void>;
        stop?: (ctx?: unknown) => Promise<void>;
      }> = [];
      const { default: satMiningPlugin } = await import("./implementation.js");
      satMiningPlugin.register({
        id: "sat-mining",
        name: "SAT Mining",
        source: "test",
        config: {} as never,
        pluginConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "balanced",
          walletId: "wallet-a",
        },
        runtime: {
          version: "test",
          config: {
            loadConfig: vi.fn(() => ({
              plugins: {
                entries: {
                  "sat-mining": {
                    enabled: true,
                    config: {
                      network: "devnet",
                      riskMode: "balanced",
                      walletId: "wallet-a",
                    },
                  },
                },
              },
            })),
            writeConfigFile: vi.fn(),
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpHandler: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(
          (name: string, handler: RegisteredGatewayMethod["handler"]) => {
            gatewayMethods.set(name, { handler });
          },
        ),
        registerCli: vi.fn(),
        registerService: vi.fn((service) => {
          services.push(service);
        }),
        registerProvider: vi.fn(),
        registerCapability: vi.fn(),
        registerCommand: vi.fn(),
        resolvePath: vi.fn((input: string) => input),
        on: vi.fn(),
      } as never);

      const mainService = services.find((service) => service.id === "sat-mining");
      await mainService?.start?.({
        config: {},
        stateDir: tempDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      let response: { ok: boolean; payload: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload) => {
          response = { ok, payload };
        },
      });

      expect(response).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          payload: {
            settledHistory: [
              expect.objectContaining({ cycleId: 5920455, validParticipation: true }),
            ],
          },
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sat-mining cycle gateway integration", () => {
  it("registers and executes cycle-native gateway methods", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-cycle-gateway-"));

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    const mainService = services.find((service) => service.id === "sat-mining");
    await mainService?.start?.({
      config: {},
      stateDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    for (const method of [
      "sat.openCycle",
      "sat.topUpRegistryReserve",
      "sat.commitCycle",
      "sat.closeCommitPhase",
      "sat.sealCycleEntropy",
      "sat.revealCycle",
      "sat.releaseUnrevealedCommit",
      "sat.abortEmptyCycle",
      "sat.submitCycle",
      "sat.settleCyclePage",
      "sat.cleanupDistributionLookupTable",
      "sat.claimCycleRewards",
      "sat.retargetUnlock",
    ]) {
      expect(gatewayMethods.has(method)).toBe(true);
    }
    expect(gatewayMethods.has("sat.bootstrapRegistryReserve")).toBe(false);
    expect(gatewayMethods.has("sat.setProtocolRecipients")).toBe(false);

    let response: { ok: boolean; payload: unknown } | null = null;
    await gatewayMethods.get("sat.openCycle")!.handler({
      params: { cycleId: 123, idempotencyKey: "manual-open-cycle-123" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });
    expect(response).toMatchObject({ ok: true });
    const solanaSubmit = await import("./src/solana-submit.js");
    expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).toHaveBeenCalledWith(
      "gateway:sat.openCycle:manual-open-cycle-123",
      expect.any(Function),
    );

    response = null;
    await gatewayMethods.get("sat.cleanupDistributionLookupTable")!.handler({
      params: { cycleId: 123, pageIndex: 4, action: "deactivate" },
      respond: (ok, payload) => {
        response = { ok, payload };
      },
    });
    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        payload: {
          request: {
            cycleId: 123,
            pageIndex: 4,
            action: "deactivate",
            lookupTableAddress: "lookup-table-from-signer-binding",
          },
        },
      },
    });
    expect(vi.mocked(solanaSubmit.submitSatCleanupDistributionLookupTable)).toHaveBeenCalledWith(
      expect.anything(),
      { cycleId: 123, pageIndex: 4, action: "deactivate" },
    );
    await mainService?.stop?.({});
    await fs.rm(stateDir, { recursive: true, force: true });
  });
});

describe("sat-mining capital signer guard", () => {
  it("refuses capital actions when the running local signer does not allow solana", async () => {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    const { probeLocalSocketSignerHealth } =
      await import("../../src/wallet/providers/local-socket-signer-adapter.js");
    const solanaSubmit = await import("./src/solana-submit.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const registryMock = vi.mocked(readWalletProviderRegistry);
    const probeMock = vi.mocked(probeLocalSocketSignerHealth);

    registryMock.mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "local-socket-signer",
          addresses: { solana: "miner-wallet-1" },
        },
      ],
    } as never);
    probeMock.mockResolvedValue({
      ok: true,
      details: "fased-signerd native ready",
      readOnly: false,
      keystoreType: "solana-envelope",
      chains: [],
    });

    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => ({ plugins: { entries: {} } })),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);

    vi.mocked(solanaSubmit.submitSatInitMinerCapital).mockClear();
    vi.mocked(solanaSubmit.submitSatDepositMinerCapital).mockClear();
    vi.mocked(solanaSubmit.submitSatWithdrawMinerCapital).mockClear();
    vi.mocked(solanaSubmit.submitSatSetActiveCommit).mockClear();

    for (const method of [
      "sat.initMinerCapital",
      "sat.depositMinerCapital",
      "sat.withdrawMinerCapital",
      "sat.setActiveCommit",
    ]) {
      let response: { ok: boolean; payload: unknown; error: unknown } | null = null;
      await gatewayMethods.get(method)!.handler({
        params:
          method === "sat.initMinerCapital"
            ? {}
            : method === "sat.setActiveCommit"
              ? { lamports: 123_000_000, persistConfig: false }
              : { lamports: 123_000_000 },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Mining history service is not ready",
        },
      });
    }

    expect(vi.mocked(solanaSubmit.submitSatInitMinerCapital)).not.toHaveBeenCalled();
    expect(vi.mocked(solanaSubmit.submitSatDepositMinerCapital)).not.toHaveBeenCalled();
    expect(vi.mocked(solanaSubmit.submitSatWithdrawMinerCapital)).not.toHaveBeenCalled();
    expect(vi.mocked(solanaSubmit.submitSatSetActiveCommit)).not.toHaveBeenCalled();
  });
});

describe("sat-mining durable history startup", () => {
  async function registerMiningPlugin(
    walletId: string,
    opts?: { enabled?: boolean; persistedConfig?: Record<string, unknown> },
  ) {
    const { default: satMiningPlugin } = await import("./implementation.js");
    const gatewayMethods = new Map<string, RegisteredGatewayMethod>();
    const enabled = opts?.enabled ?? false;
    const configState = {
      plugins: {
        entries: {
          "sat-mining": {
            enabled,
            config: {
              enabled,
              network: "devnet",
              riskMode: "balanced",
              walletId,
              ...(opts?.persistedConfig ?? {}),
            },
          },
        },
      },
    };
    const writeConfigFile = vi.fn(async (next: typeof configState) => {
      Object.assign(configState, next);
    });
    const services: Array<{
      id: string;
      start?: (ctx?: unknown) => Promise<void>;
      stop?: (ctx?: unknown) => Promise<void>;
    }> = [];
    satMiningPlugin.register({
      id: "sat-mining",
      name: "SAT Mining",
      source: "test",
      config: {} as never,
      pluginConfig: {
        enabled,
        network: "devnet",
        riskMode: "balanced",
        walletId,
      },
      runtime: {
        version: "test",
        config: {
          loadConfig: vi.fn(() => structuredClone(configState)),
          writeConfigFile,
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpHandler: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredGatewayMethod["handler"]) => {
        gatewayMethods.set(name, { handler });
      }),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => {
        services.push(service);
      }),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((input: string) => input),
      on: vi.fn(),
    } as never);
    return {
      gatewayMethods,
      mainService: services.find((service) => service.id === "sat-mining"),
      writeConfigFile,
      configState,
    };
  }

  async function registerTransitionWallets() {
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    const registryMock = vi.mocked(readWalletProviderRegistry);
    registryMock.mockReset();
    registryMock.mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
        {
          id: "wallet-b",
          name: "Wallet B",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-2" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    } as never);
  }

  it("reconciles and stops the enabled unattached SQLite store without authorizing mutations", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-unattached-history-"));
    const { gatewayMethods, mainService } = await registerMiningPlugin("", { enabled: true });
    try {
      await expect(
        mainService?.start?.({
          config: {},
          stateDir,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        }),
      ).resolves.toBeUndefined();
      await expect(mainService?.stop?.({})).resolves.toBeUndefined();

      let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 123 },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
    } finally {
      await mainService?.stop?.({});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy capital drainable while blocking deposits and fresh cycle entry before submission", async () => {
    const rpcRead = await import("./src/rpc-read.js");
    const solanaSubmit = await import("./src/solana-submit.js");
    const walletRegistry = await import("../../src/wallet/wallet-provider-registry.js");
    const inspectCapitalMock = vi.mocked(rpcRead.inspectSatMinerCapital);
    const registryMock = vi.mocked(walletRegistry.readWalletProviderRegistry);
    const originalInspectCapitalImpl = inspectCapitalMock.getMockImplementation();
    const originalRegistryImpl = registryMock.getMockImplementation();
    await registerTransitionWallets();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-legacy-drain-only-"));
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    const legacyCapital = {
      address: "legacy-miner-capital-1",
      version: 1,
      authority: "miner-wallet-1",
      fundedLamports: "500000000",
      lockedLamports: "0",
      freeLamports: "500000000",
      activeCommitLamports: "250000000",
      firstPendingCycleId: 0,
      lastPendingCycleId: 0,
    };
    inspectCapitalMock.mockResolvedValue(legacyCapital);
    vi.mocked(solanaSubmit.submitSatDepositMinerCapital).mockClear();
    vi.mocked(solanaSubmit.submitSatSetActiveCommit).mockClear();
    vi.mocked(solanaSubmit.submitSatCommitCycle).mockClear();
    vi.mocked(solanaSubmit.submitSatWithdrawMinerCapital).mockClear();
    const invoke = async (method: string, params: Record<string, unknown>) => {
      let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get(method)!.handler({
        params,
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      return response;
    };
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      await expect(invoke("sat.depositMinerCapital", { lamports: 1 })).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/blocked for legacy generation 1/u) },
      });
      await expect(
        invoke("sat.setActiveCommit", { lamports: 250_000_000, persistConfig: false }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/blocked for legacy generation 1/u) },
      });
      await expect(
        invoke("sat.commitCycle", { cycleId: 7, commitmentHex: "ab".repeat(32) }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/blocked for legacy generation 1/u) },
      });
      await expect(invoke("sat.withdrawMinerCapital", { lamports: 1 })).resolves.toMatchObject({
        ok: true,
      });

      expect(vi.mocked(solanaSubmit.submitSatDepositMinerCapital)).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.submitSatSetActiveCommit)).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.submitSatCommitCycle)).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.submitSatWithdrawMinerCapital)).toHaveBeenCalledOnce();
    } finally {
      if (originalInspectCapitalImpl) {
        inspectCapitalMock.mockImplementation(originalInspectCapitalImpl);
      } else {
        inspectCapitalMock.mockReset();
      }
      if (originalRegistryImpl) {
        registryMock.mockImplementation(originalRegistryImpl);
      } else {
        registryMock.mockReset();
      }
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["../escape", "legacy wallet", "wallet/a/b"])(
    "keeps SQLite and migration descriptors under the normalized state root for %s",
    async (walletId) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-normalized-history-"));
      const { mainService } = await registerMiningPlugin(walletId);
      try {
        await mainService?.start?.({
          config: {},
          stateDir,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        });
        const walletStateDir = resolveSatWalletStateDir(stateDir, walletId);
        const databasePath = path.join(walletStateDir, "mining.sqlite");
        expect(path.dirname(resolveSatPlannerHistoryStorePath(stateDir, walletId))).toBe(
          walletStateDir,
        );
        expect(path.dirname(resolveSatRuntimeStorePath(stateDir, walletId))).toBe(walletStateDir);
        await expect(fs.stat(databasePath)).resolves.toMatchObject({
          isFile: expect.any(Function),
        });
        expect(path.relative(walletStateDir, databasePath)).toBe("mining.sqlite");
      } finally {
        await mainService?.stop?.({}).catch(() => {});
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("opens a registered unsafe wallet history query only from its normalized state root", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-query-normalized-history-"));
    const requestedWalletId = "../legacy/query wallet";
    const databasePath = path.join(
      resolveSatWalletStateDir(stateDir, requestedWalletId),
      "mining.sqlite",
    );
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    vi.mocked(readWalletProviderRegistry).mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
        {
          id: requestedWalletId,
          name: "Legacy Mining Wallet",
          providerId: "embedded-keystore",
          addresses: { solana: "legacy-miner-wallet" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    } as never);
    const seeded = await SatMiningHistoryStore.open({
      databasePath,
      scope: {
        walletId: requestedWalletId,
        authority: "legacy-miner-wallet",
        providerId: "embedded-keystore",
        network: "devnet",
        programId: SAT_PROGRAM_ID,
        mintAddress: SAT_MINT_ADDRESS,
        mintProgramId: SAT_MINT_PROGRAM_ID,
        protocolVersion: "sat-v2",
      },
    });
    seeded.store.close();
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningHistorySeries")!.handler({
        params: { walletId: requestedWalletId, window: "all" },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      expect(response).toMatchObject({ ok: true });
      expect(
        path.relative(resolveSatWalletStateDir(stateDir, requestedWalletId), databasePath),
      ).toBe("mining.sqlite");
    } finally {
      await mainService?.stop?.({});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects normalized wallet-directory alias scopes before every cross-wallet query callback", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-query-wallet-alias-"));
    const requestedWalletId = "wallet/a";
    const storedWalletId = "wallet_a";
    const databasePath = path.join(
      resolveSatWalletStateDir(stateDir, storedWalletId),
      "mining.sqlite",
    );
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    vi.mocked(readWalletProviderRegistry).mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
        {
          id: requestedWalletId,
          name: "Alias Mining Wallet",
          providerId: "embedded-keystore",
          addresses: { solana: "alias-miner-wallet" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    } as never);
    const seeded = await SatMiningHistoryStore.open({
      databasePath,
      scope: {
        walletId: storedWalletId,
        authority: "stored-miner-wallet",
        providerId: "embedded-keystore",
        network: "devnet",
        programId: SAT_PROGRAM_ID,
        mintAddress: SAT_MINT_ADDRESS,
        mintProgramId: SAT_MINT_PROGRAM_ID,
        protocolVersion: "sat-v2",
      },
    });
    const storedScopeKey = seeded.store.getScopeKey();
    seeded.store.close();
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      for (const params of [
        { walletId: requestedWalletId, window: "all" },
        { walletId: requestedWalletId, scopeId: storedScopeKey, window: "all" },
      ]) {
        let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
        await gatewayMethods.get("sat.getMiningHistorySeries")!.handler({
          params,
          respond: (ok, payload, error) => {
            response = { ok, payload, error };
          },
        });
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Mining history scope does not match the requested Wallet ID",
          },
        });
        expect(response?.payload).toBeUndefined();
      }
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a caller-selected foreign scope from the active wallet history store", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-current-scope-alias-"));
    const databasePath = path.join(resolveSatWalletStateDir(stateDir, "wallet-a"), "mining.sqlite");
    const primary = await SatMiningHistoryStore.open({
      databasePath,
      scope: {
        walletId: "wallet-a",
        authority: "miner-wallet-1",
        providerId: "embedded-keystore",
        network: "devnet",
        programId: SAT_PROGRAM_ID,
        mintAddress: SAT_MINT_ADDRESS,
        mintProgramId: SAT_MINT_PROGRAM_ID,
        protocolVersion: "sat-v2",
      },
    });
    primary.store.close();
    const foreign = await SatMiningHistoryStore.open({
      databasePath: path.join(stateDir, "foreign-scope.sqlite"),
      scope: {
        walletId: "wallet-b",
        authority: "miner-wallet-2",
        providerId: "embedded-keystore",
        network: "devnet",
        programId: SAT_PROGRAM_ID,
        mintAddress: SAT_MINT_ADDRESS,
        mintProgramId: SAT_MINT_PROGRAM_ID,
        protocolVersion: "sat-v2",
      },
    });
    const foreignScopeKey = foreign.store.getScopeKey();
    foreign.store.close();
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO history_scope (
             scope_key, wallet_id, authority, provider_id, network,
             program_id, mint_address, mint_program_id, protocol_version, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          foreignScopeKey,
          "wallet-b",
          "miner-wallet-2",
          "embedded-keystore",
          "devnet",
          SAT_PROGRAM_ID,
          SAT_MINT_ADDRESS,
          SAT_MINT_PROGRAM_ID,
          "sat-v2",
          Date.now(),
        );
    } finally {
      database.close();
    }
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningHistorySeries")!.handler({
        params: { walletId: "wallet-a", scopeId: foreignScopeKey, window: "all" },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Mining history scope does not match the requested Wallet ID",
        },
      });
      expect(response?.payload).toBeUndefined();
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each([".", ".."])(
    "fails closed before persistence startup for the unsafe registered wallet ID %s",
    async (walletId) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-contained-history-"));
      const walletsRoot = path.join(stateDir, "sat-mining", "wallets");
      const unsafeStateDir = walletId === "." ? walletsRoot : path.join(stateDir, "sat-mining");
      const { mainService } = await registerMiningPlugin(walletId);
      try {
        expect(mainService).toBeDefined();
        await expect(
          mainService!.start!({
            config: {},
            stateDir,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          }),
        ).rejects.toThrow("Mining wallet state path is outside the wallet state root");

        for (const filename of [
          "mining.sqlite",
          "audit-store.json",
          "runtime-store.json",
          "planner-history.ndjson",
          "action-history.ndjson",
          "action-history.mirror.ndjson",
        ]) {
          await expect(fs.stat(path.join(unsafeStateDir, filename))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        await mainService?.stop?.({}).catch(() => {});
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.each([".", ".."])(
    "rejects a registered cross-wallet history query for unsafe wallet ID %s",
    async (requestedWalletId) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-contained-query-"));
      const walletsRoot = path.join(stateDir, "sat-mining", "wallets");
      const unsafeStateDir =
        requestedWalletId === "." ? walletsRoot : path.join(stateDir, "sat-mining");
      const { readWalletProviderRegistry } =
        await import("../../src/wallet/wallet-provider-registry.js");
      vi.mocked(readWalletProviderRegistry).mockReturnValue({
        defaultWalletId: "wallet-a",
        wallets: [
          {
            id: "wallet-a",
            name: "Wallet A",
            providerId: "embedded-keystore",
            addresses: { solana: "miner-wallet-1" },
            metadata: { role: "mining", purpose: "mining" },
          },
          {
            id: requestedWalletId,
            name: "Unsafe Legacy Mining Wallet",
            providerId: "embedded-keystore",
            addresses: { solana: "unsafe-miner-wallet" },
            metadata: { role: "mining", purpose: "mining" },
          },
        ],
      } as never);
      const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
      try {
        await mainService?.start?.({
          config: {},
          stateDir,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        });
        let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
        await gatewayMethods.get("sat.getMiningHistorySeries")!.handler({
          params: { walletId: requestedWalletId, window: "all" },
          respond: (ok, payload, error) => {
            response = { ok, payload, error };
          },
        });
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Mining wallet state path is outside the wallet state root",
          },
        });
        for (const filename of [
          "mining.sqlite",
          "audit-store.json",
          "runtime-store.json",
          "planner-history.ndjson",
          "action-history.ndjson",
          "action-history.mirror.ndjson",
        ]) {
          await expect(fs.stat(path.join(unsafeStateDir, filename))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        await mainService?.stop?.({}).catch(() => {});
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("restores the prior wallet after a failed switch before later submission-capable mutation", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-switch-failure-"));
    const { readWalletProviderRegistry } =
      await import("../../src/wallet/wallet-provider-registry.js");
    const solanaSubmit = await import("./src/solana-submit.js");
    vi.mocked(readWalletProviderRegistry).mockReturnValue({
      defaultWalletId: "wallet-a",
      wallets: [
        {
          id: "wallet-a",
          name: "Wallet A",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-1" },
          metadata: { role: "mining", purpose: "mining" },
        },
        {
          id: "wallet-b",
          name: "Wallet B",
          providerId: "embedded-keystore",
          addresses: { solana: "miner-wallet-2" },
          metadata: { role: "mining", purpose: "mining" },
        },
      ],
    } as never);
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    const targetDatabasePath = path.join(
      resolveSatWalletStateDir(stateDir, "wallet-b"),
      "mining.sqlite",
    );
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      await fs.mkdir(targetDatabasePath, { recursive: true });

      let switchResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          switchResponse = { ok, payload, error };
        },
      });
      expect(switchResponse).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });

      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 123 },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });

      expect(response).toMatchObject({
        ok: true,
      });
      expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).toHaveBeenCalledTimes(1);
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fences submission mutations while old-wallet persistence is suspended, then permits the completed switch", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-switch-fence-"));
    await registerTransitionWallets();
    const solanaSubmit = await import("./src/solana-submit.js");
    const { SatMiningHistoryStore: ActiveMiningHistoryStore } =
      await import("./src/mining-history-store.js");
    const { gatewayMethods, mainService, writeConfigFile } = await registerMiningPlugin("wallet-a");
    let releaseOldPersistence!: () => void;
    const oldPersistenceReleased = new Promise<void>((resolve) => {
      releaseOldPersistence = resolve;
    });
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      const persistenceSpy = vi
        .spyOn(ActiveMiningHistoryStore.prototype, "replaceAuditArtifacts")
        .mockImplementationOnce(async () => {
          await oldPersistenceReleased;
        });
      let switchResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      const switchPromise = gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          switchResponse = { ok, payload, error };
        },
      });
      await vi.waitFor(() => expect(persistenceSpy).toHaveBeenCalledTimes(1));

      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      writeConfigFile.mockClear();
      let fencedResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 123 },
        respond: (ok, payload, error) => {
          fencedResponse = { ok, payload, error };
        },
      });
      expect(fencedResponse).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
      expect(fencedResponse?.payload).toBeUndefined();
      expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();

      let fencedRead: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMinerProfile")!.handler({
        respond: (ok, payload, error) => {
          fencedRead = { ok, payload, error };
        },
      });
      expect(fencedRead).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
      expect(fencedRead?.payload).toBeUndefined();

      releaseOldPersistence();
      await switchPromise;
      persistenceSpy.mockRestore();
      expect(switchResponse).toMatchObject({ ok: true });

      let retryResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 124 },
        respond: (ok, payload, error) => {
          retryResponse = { ok, payload, error };
        },
      });
      expect(retryResponse).toMatchObject({ ok: true });
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).toHaveBeenCalledTimes(1);
    } finally {
      releaseOldPersistence?.();
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed after pre-close old-store persistence failure and permits a clean retry", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-preclose-failure-"));
    await registerTransitionWallets();
    const solanaSubmit = await import("./src/solana-submit.js");
    const { SatMiningHistoryStore: ActiveMiningHistoryStore } =
      await import("./src/mining-history-store.js");
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      const persistenceSpy = vi
        .spyOn(ActiveMiningHistoryStore.prototype, "replaceAuditArtifacts")
        .mockRejectedValueOnce(new Error("old history persistence failed"));
      let failedSwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          failedSwitch = { ok, payload, error };
        },
      });
      persistenceSpy.mockRestore();
      expect(failedSwitch).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });

      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      let restoredResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 125 },
        respond: (ok, payload, error) => {
          restoredResponse = { ok, payload, error };
        },
      });
      expect(restoredResponse).toMatchObject({ ok: true });
      expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).toHaveBeenCalledTimes(1);

      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      let retrySwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          retrySwitch = { ok, payload, error };
        },
      });
      expect(retrySwitch).toMatchObject({ ok: true });
      let retryMutation: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 127 },
        respond: (ok, payload, error) => {
          retryMutation = { ok, payload, error };
        },
      });
      expect(retryMutation).toMatchObject({ ok: true });
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).toHaveBeenCalledTimes(1);
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("closes an unready target store when post-open restoration fails", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-postopen-failure-"));
    await registerTransitionWallets();
    const solanaSubmit = await import("./src/solana-submit.js");
    const { SatMiningHistoryStore: ActiveMiningHistoryStore } =
      await import("./src/mining-history-store.js");
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      let seededAction: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 126 },
        respond: (ok, payload, error) => {
          seededAction = { ok, payload, error };
        },
      });
      expect(seededAction).toMatchObject({ ok: true });
      const closeSpy = vi.spyOn(ActiveMiningHistoryStore.prototype, "close");
      const restoreSpy = vi
        .spyOn(ActiveMiningHistoryStore.prototype, "readOperationalState")
        .mockImplementationOnce(() => {
          throw new Error("target history restoration failed");
        });
      let failedSwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          failedSwitch = { ok, payload, error };
        },
      });
      restoreSpy.mockRestore();
      expect(failedSwitch).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(closeSpy).toHaveBeenCalledTimes(3);
      closeSpy.mockRestore();

      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      let restoredProfile: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMinerProfile")!.handler({
        respond: (ok, payload, error) => {
          restoredProfile = { ok, payload, error };
        },
      });
      expect(restoredProfile).toMatchObject({
        ok: true,
        payload: { payload: { walletId: "wallet-a" } },
      });
      let restoredMutation: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 127 },
        respond: (ok, payload, error) => {
          restoredMutation = { ok, payload, error };
        },
      });
      expect(restoredMutation).toMatchObject({ ok: true });
      expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).toHaveBeenCalledTimes(1);
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rolls back to the exact prior wallet when target config persistence fails", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-target-config-failure-"));
    await registerTransitionWallets();
    const { gatewayMethods, mainService, writeConfigFile } = await registerMiningPlugin("wallet-a");
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      writeConfigFile.mockRejectedValueOnce(new Error("target config write failed"));
      let failedSwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          failedSwitch = { ok, payload, error };
        },
      });
      expect(failedSwitch).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });

      let restoredProfile: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMinerProfile")!.handler({
        respond: (ok, payload, error) => {
          restoredProfile = { ok, payload, error };
        },
      });
      expect(restoredProfile).toMatchObject({
        ok: true,
        payload: { payload: { walletId: "wallet-a" } },
      });
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stops partial target workers and restores the running A worker state after target readiness fails", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-target-worker-failure-"));
    await registerTransitionWallets();
    const rpcRead = await import("./src/rpc-read.js");
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-a"), [], {
      enabledWanted: true,
    });
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-b"), [], {
      enabledWanted: true,
    });
    const { gatewayMethods, mainService, configState } = await registerMiningPlugin("wallet-a", {
      enabled: true,
      persistedConfig: {
        cycleCadence: 12,
        tokenConfig: { mintDecimals: 9, treasuryMode: "locked" },
        unknownRollbackSentinel: { nested: ["retain", 7] },
      },
    });
    const priorPersistedEntry = structuredClone(configState.plugins.entries["sat-mining"]);
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      let initialStatus: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload, error) => {
          initialStatus = { ok, payload, error };
        },
      });
      expect(initialStatus).toMatchObject({
        ok: true,
        payload: {
          payload: {
            walletId: "wallet-a",
            running: true,
            bootstrapState: "ready",
            bootstrapWalletId: "wallet-a",
            workers: { roundWatcher: expect.any(Object) },
          },
        },
      });

      // The preceding transition regression leaves a fresh chain-time cache.
      // Advance beyond its reuse window so this failure is injected into B,
      // rather than being hidden by that prior A cache entry.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
      vi.mocked(rpcRead.inspectSatChainUnixTime).mockRejectedValueOnce(
        new Error("target chain time unavailable"),
      );
      let failedSwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          failedSwitch = { ok, payload, error };
        },
      });
      nowSpy.mockRestore();
      expect(failedSwitch).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(configState.plugins.entries["sat-mining"]).toEqual(priorPersistedEntry);
      expect(JSON.stringify(configState.plugins.entries["sat-mining"])).toBe(
        JSON.stringify(priorPersistedEntry),
      );

      let restoredStatus: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload, error) => {
          restoredStatus = { ok, payload, error };
        },
      });
      expect(restoredStatus).toMatchObject({
        ok: true,
        payload: {
          payload: {
            walletId: "wallet-a",
            running: true,
            bootstrapState: "ready",
            bootstrapWalletId: "wallet-a",
            workers: { roundWatcher: expect.any(Object) },
          },
        },
      });
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps reads and mutations fenced when target rollback restoration fails", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-rollback-fence-"));
    await registerTransitionWallets();
    const rpcRead = await import("./src/rpc-read.js");
    const solanaSubmit = await import("./src/solana-submit.js");
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-a"), [], {
      enabledWanted: true,
    });
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-b"), [], {
      enabledWanted: true,
    });
    const { gatewayMethods, mainService, writeConfigFile, configState } =
      await registerMiningPlugin("wallet-a", {
        enabled: true,
      });
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      writeConfigFile.mockClear();
      writeConfigFile.mockImplementationOnce(async (next) => {
        Object.assign(configState, next);
      });
      writeConfigFile.mockRejectedValueOnce(new Error("rollback config restore failed"));
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
      vi.mocked(rpcRead.inspectSatChainUnixTime).mockRejectedValueOnce(
        new Error("target chain time unavailable"),
      );
      let failedSwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          failedSwitch = { ok, payload, error };
        },
      });
      nowSpy.mockRestore();
      expect(failedSwitch).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(failedSwitch?.error).toMatchObject({
        message: expect.stringContaining("rollback failed"),
      });

      writeConfigFile.mockClear();
      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      let fencedRead: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMinerProfile")!.handler({
        respond: (ok, payload, error) => {
          fencedRead = { ok, payload, error };
        },
      });
      expect(fencedRead).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
      expect(fencedRead?.payload).toBeUndefined();

      let fencedMutation: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 129 },
        respond: (ok, payload, error) => {
          fencedMutation = { ok, payload, error };
        },
      });
      expect(fencedMutation).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
      expect(fencedMutation?.payload).toBeUndefined();
      expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stops terminal rollback workers and clears their fence only after a ready service restart", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-rollback-worker-fence-"));
    await registerTransitionWallets();
    const rpcRead = await import("./src/rpc-read.js");
    const solanaSubmit = await import("./src/solana-submit.js");
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-a"), [], {
      enabledWanted: true,
    });
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-b"), [], {
      enabledWanted: true,
    });
    const { gatewayMethods, mainService, writeConfigFile } = await registerMiningPlugin(
      "wallet-a",
      { enabled: true },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      vi.setSystemTime(new Date("2030-01-01T00:10:00.000Z"));
      vi.mocked(rpcRead.inspectSatChainUnixTime)
        .mockRejectedValueOnce(new Error("target worker readiness failed"))
        .mockRejectedValueOnce(new Error("rollback worker readiness failed"));
      let failedSwitch: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.setMinerProfile")!.handler({
        params: { profile: { walletId: "wallet-b" }, syncActiveCommit: false },
        respond: (ok, payload, error) => {
          failedSwitch = { ok, payload, error };
        },
      });
      expect(failedSwitch).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("rollback failed"),
        },
      });

      writeConfigFile.mockClear();
      vi.mocked(rpcRead.inspectSatChainUnixTime).mockClear();
      vi.mocked(rpcRead.inspectCurrentSatRoundBucket).mockClear();
      vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow).mockClear();
      vi.mocked(solanaSubmit.submitSatOpenCycle).mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.mocked(rpcRead.inspectSatChainUnixTime)).not.toHaveBeenCalled();
      expect(vi.mocked(rpcRead.inspectCurrentSatRoundBucket)).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.runWithSatSubmissionWorkflow)).not.toHaveBeenCalled();
      expect(vi.mocked(solanaSubmit.submitSatOpenCycle)).not.toHaveBeenCalled();

      for (const method of ["sat.getMinerProfile", "sat.getMiningStatus"] as const) {
        let readResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
        await gatewayMethods.get(method)!.handler({
          respond: (ok, payload, error) => {
            readResponse = { ok, payload, error };
          },
        });
        expect(readResponse).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
        });
        expect(readResponse?.payload).toBeUndefined();
      }
      let mutationResponse: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.openCycle")!.handler({
        params: { cycleId: 130 },
        respond: (ok, payload, error) => {
          mutationResponse = { ok, payload, error };
        },
      });
      expect(mutationResponse).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
      expect(mutationResponse?.payload).toBeUndefined();

      await mainService?.stop?.({});
      vi.mocked(rpcRead.inspectSatChainUnixTime).mockResolvedValue(Math.floor(Date.now() / 1000));
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      let recoveredRead: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMinerProfile")!.handler({
        respond: (ok, payload, error) => {
          recoveredRead = { ok, payload, error };
        },
      });
      expect(recoveredRead).toMatchObject({
        ok: true,
        payload: { payload: { walletId: "wallet-a" } },
      });
    } finally {
      await mainService?.stop?.({});
      vi.useRealTimers();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("restores A bootstrap state when the attach-wallet route cannot persist B configuration", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "sat-history-attach-bootstrap-failure-"),
    );
    await registerTransitionWallets();
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-a"), [], {
      enabledWanted: true,
    });
    await writeSatRecentActions(resolveSatRuntimeStorePath(stateDir, "wallet-b"), [], {
      enabledWanted: true,
    });
    const { gatewayMethods, mainService, writeConfigFile } = await registerMiningPlugin(
      "wallet-a",
      {
        enabled: true,
      },
    );
    try {
      await mainService?.start?.({
        config: {},
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      let initialStatus: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload, error) => {
          initialStatus = { ok, payload, error };
        },
      });
      expect(initialStatus).toMatchObject({
        ok: true,
        payload: {
          payload: { walletId: "wallet-a", running: true, bootstrapState: "ready" },
        },
      });
      writeConfigFile.mockRejectedValueOnce(new Error("attach target config write failed"));
      let failedAttach: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.startMining")!.handler({
        params: { walletId: "wallet-b" },
        respond: (ok, payload, error) => {
          failedAttach = { ok, payload, error };
        },
      });
      expect(failedAttach).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });

      let restoredStatus: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.getMiningStatus")!.handler({
        respond: (ok, payload, error) => {
          restoredStatus = { ok, payload, error };
        },
      });
      expect(restoredStatus).toMatchObject({
        ok: true,
        payload: {
          payload: {
            walletId: "wallet-a",
            running: true,
            bootstrapState: "ready",
            bootstrapWalletId: "wallet-a",
          },
        },
      });
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rolls back a failed SQLite start, rejects durable mutation, then retries cleanly", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-history-start-failure-"));
    const { gatewayMethods, mainService } = await registerMiningPlugin("wallet-a");
    const databasePath = path.join(resolveSatWalletStateDir(stateDir, "wallet-a"), "mining.sqlite");
    try {
      await fs.mkdir(databasePath, { recursive: true });
      expect(mainService).toBeDefined();
      await expect(
        mainService!.start!({
          config: {},
          stateDir,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        }),
      ).rejects.toThrow();

      let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
      await gatewayMethods.get("sat.clearMiningHistory")!.handler({
        params: { confirmation: "clear-mining-history" },
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "Mining history service is not ready" },
      });
      expect(response?.payload).toBeUndefined();

      await fs.rm(databasePath, { recursive: true, force: true });
      await expect(
        mainService!.start!({
          config: {},
          stateDir,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await mainService?.stop?.({}).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
