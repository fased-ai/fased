import { describe, expect, it, vi } from "vitest";

const {
  callLocalSocketSigner,
  executeTypedSatIntent,
  inspectSatCycleRegistryMeta,
  inspectSatMinerCapital,
  inspectSatVNextRuntimeActivation,
  ids,
} = vi.hoisted(() => {
  const ids = {
    miningWallet: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW", // pragma: allowlist secret
    keeperWallet: "5peszKe8y7dv8KqdSse9UFxmaLxGsy7pWJBm6KpGnGA3", // pragma: allowlist secret
    miningProgram: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
    mintProgram: "71Med1feR4RvP9crdNYtAdMB2YQmSmkbyZhKYRzcRJKL", // pragma: allowlist secret
    bondProgram: "5peszKe8y7dv8KqdSse9UFxmaLxGsy7pWJBm6KpGnGA3", // pragma: allowlist secret
    mint: "BbZ7cUmbD9s43jeqK65Jjg8QWo5VNMZovKURVEYx4DqU", // pragma: allowlist secret
    permanentMiningId: "71Med1feR4RvP9crdNYtAdMB2YQmSmkbyZhKYRzcRJKL", // pragma: allowlist secret
  };
  Object.assign(process.env, {
    FASED_SAT_DEPLOYMENT_ID: "SAT-DEP-0011",
    FASED_SAT_PROGRAM_ID: ids.miningProgram,
    FASED_SAT_MINT_PROGRAM_ID: ids.mintProgram,
    FASED_SAT_BOND_PROGRAM_ID: ids.bondProgram,
    FASED_SAT_MINT_ADDRESS: ids.mint,
    FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-vnext-test-signer.sock",
  });
  return {
    ids,
    callLocalSocketSigner: vi.fn(
      async (_socketPath: string, payload: { op?: string; walletId?: string }) => {
        if (payload.op === "v2.keeperFeePayer.get") {
          if (payload.walletId === "keeper-wallet") {
            return {
              miningWalletId: "keeper-wallet",
              feePayerWalletId: "keeper-wallet",
              feePayerPublicKey: ids.keeperWallet,
              state: "ready",
            };
          }
          return {
            miningWalletId: "mining-wallet",
            feePayerWalletId: "keeper-wallet",
            feePayerPublicKey: ids.keeperWallet,
            state: "ready",
          };
        }
        if (payload.op === "v2.wallet.get") {
          return { walletId: payload.walletId, publicKey: ids.miningWallet };
        }
        if (payload.op === "v2.capabilities") {
          return {
            ready: true,
            capabilities: {
              protocol: { current: 2, min: 2, max: 2 },
              intentTypes: ["solana.satAction"],
              operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
              features: [
                "failClosedPolicies",
                "policyHashes",
                "durableCaps",
                "atomicIdempotency",
                "ambiguousBroadcastReconciliation",
                "signerOwnedKeys",
                "signerOwnedEncryptedSATCommitments",
                "typedSolanaTransactions",
                "typedSATActions",
              ],
            },
          };
        }
        throw new Error(`unexpected signer operation ${payload.op}`);
      },
    ),
    executeTypedSatIntent: vi.fn(async (request: { action: string }) => ({
      requestId: `request-${request.action}`,
      state: "confirmed",
      signature: `signature-${request.action}`,
    })),
    inspectSatCycleRegistryMeta: vi.fn(async () => ({ participantCount: 0 })),
    inspectSatMinerCapital: vi.fn(async () => ({
      version: 2,
      permanentMiningId: ids.permanentMiningId,
    })),
    inspectSatVNextRuntimeActivation: vi.fn(async () => ({ active: true })),
  };
});

vi.mock("fased/plugin-sdk/sat-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fased/plugin-sdk/sat-runtime")>()),
  callLocalSocketSigner,
  loadConfig: vi.fn(() => ({
    plugins: {
      entries: {
        "sat-mining": {
          config: { walletId: "mining-wallet", network: "devnet" },
        },
      },
    },
  })),
  readWalletProviderRegistry: vi.fn(() => ({
    defaultWalletId: "mining-wallet",
    wallets: [
      {
        id: "mining-wallet",
        providerId: "local-socket-signer",
        addresses: { solana: ids.miningWallet },
      },
    ],
  })),
  requireLocalSocketSignerPath: vi.fn(() => "/tmp/fased-vnext-test-signer.sock"),
  resolveWalletProviderId: vi.fn(() => "local-socket-signer"),
}));

vi.mock("./src/rpc-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/rpc-read.js")>()),
  inspectSatCycleRegistryMeta,
  inspectSatMinerCapital,
  inspectSatVNextRuntimeActivation,
}));

vi.mock("./src/submission-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/submission-service.js")>()),
  executeTypedSatIntent,
}));

import { parseSatMiningConfig } from "./src/config.js";
import {
  buildSatCycleCommitment,
  submitSatCloseResolvedCycleArtifacts,
  submitSatCloseResolvedCycleRegistryPage,
  submitSatCloseResolvedCleanupBatch,
  submitSatCloseCommitPhase,
  submitSatCommitCycle,
  submitSatInitMinerCapital,
  submitSatOpenCycle,
  submitSatRevealCycle,
  submitSatSealCycleEntropy,
  submitSatSnapshotKeeperCapabilities,
} from "./src/solana-submit.js";
import { SAT_VNEXT_INTERFACE } from "./src/vnext-interface-manifest.js";

describe("SAT generation-2 transaction builders", () => {
  it("uses the generation-2 direct minimum only while its deployment is active", () => {
    expect(
      parseSatMiningConfig({ enabled: true, network: "devnet", riskMode: "balanced" })
        .commitLamports,
    ).toBe(SAT_VNEXT_INTERFACE.active ? 1_000_000_000 : 250_000_000);
  });

  it("builds the exact 16-channel commitment domain", () => {
    const base = {
      authority: ids.miningWallet,
      cycleId: 7,
      committedLamports: 1_000_000_000,
      nonce: Buffer.alloc(32, 9),
      allocationFp: new Array(16).fill(62_500),
      programId: ids.miningProgram,
    };
    expect(buildSatCycleCommitment(base)).toHaveLength(32);
    expect(
      buildSatCycleCommitment({
        ...base,
        allocationFp: new Array(25).fill(40_000),
      }),
    ).not.toEqual(buildSatCycleCommitment(base));
  });

  it("binds common keeper work to generated actions and the separate keeper signer", async () => {
    if (!SAT_VNEXT_INTERFACE.active) {
      expect(SAT_VNEXT_INTERFACE.publicEntryEnabled).toBe(false);
      return;
    }
    const config = {
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "mining-wallet",
      keeperMode: "dedicated",
      keeperWalletId: "keeper-wallet",
      permanentMiningId: ids.permanentMiningId,
    } as const;

    await submitSatInitMinerCapital(config, {});
    await submitSatCommitCycle(config, { cycleId: 7, commitmentHex: "11".repeat(32) });
    await submitSatRevealCycle(config, {
      cycleId: 7,
      nonceBase64: Buffer.alloc(32, 9).toString("base64"),
      allocationFp: new Array(16).fill(62_500),
    });
    await submitSatOpenCycle(config, { cycleId: 7 });
    await submitSatCloseCommitPhase(config, { cycleId: 7 });
    await submitSatSnapshotKeeperCapabilities(config, {
      cycleId: 7,
      expectedRegistryRevision: 3,
    });
    await submitSatSealCycleEntropy(config, { cycleId: 7 });
    await submitSatCloseResolvedCycleRegistryPage(config, { cycleId: 7, pageIndex: 0 });
    await submitSatCloseResolvedCycleArtifacts(config, { cycleId: 7 });

    const calls = executeTypedSatIntent.mock.calls.map(([request]) => request);
    expect(calls.map((request) => request.action)).toEqual([
      "initMinerCapital",
      "commitCycleV2",
      "revealCycleV2",
      "openCycleV2",
      "closeCommitPhaseV2",
      "snapshotKeeperCapabilitiesV2",
      "sealCycleEntropyV2",
      "closeResolvedCycleRegistryPageV2",
      "closeResolvedCycleArtifactsV2",
    ]);
    expect(calls[0]?.instruction.keys).toHaveLength(5);
    expect(calls[0]?.instruction.keys[1]?.pubkey).toBe(ids.permanentMiningId);
    expect(calls[1]?.instruction.keys).toHaveLength(10);
    expect(calls[1]?.instruction.context).toEqual({
      permanentMiningIds: [ids.permanentMiningId],
    });
    expect(calls[2]?.instruction.keys).toHaveLength(10);
    expect(calls[5]?.instruction.keys).toHaveLength(6);
    expect(calls[7]?.instruction.keys).toHaveLength(5);
    expect(calls[8]?.instruction.keys).toHaveLength(6);
    for (const request of calls.slice(3)) {
      expect(request.useKeeperFeePayer).toBe(true);
      expect(request.instruction.keys[0]).toMatchObject({
        pubkey: ids.keeperWallet,
        isSigner: true,
      });
    }
    expect(
      callLocalSocketSigner.mock.calls
        .map(([, payload]) => payload)
        .filter((payload) => payload.op === "v2.keeperFeePayer.get")
        .map((payload) => payload.walletId),
    ).toEqual([
      "keeper-wallet",
      "keeper-wallet",
      "keeper-wallet",
      "keeper-wallet",
      "keeper-wallet",
      "keeper-wallet",
    ]);
    expect(callLocalSocketSigner).toHaveBeenCalledWith("/tmp/fased-vnext-test-signer.sock", {
      op: "v2.keeperFeePayer.get",
      walletId: "keeper-wallet",
    });
  });

  it("uses the configured standalone Keeper wallet for dedicated cycle opening", async () => {
    if (!SAT_VNEXT_INTERFACE.active) {
      expect(SAT_VNEXT_INTERFACE.publicEntryEnabled).toBe(false);
      return;
    }
    await submitSatOpenCycle(
      {
        enabled: false,
        network: "devnet",
        riskMode: "balanced",
        walletId: "mining-wallet",
        keeperMode: "dedicated",
        keeperWalletId: "keeper-wallet",
      },
      { cycleId: 7 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledWith("/tmp/fased-vnext-test-signer.sock", {
      op: "v2.keeperFeePayer.get",
      walletId: "keeper-wallet",
    });
    expect(executeTypedSatIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "keeper-wallet",
        useKeeperFeePayer: true,
        action: "openCycleV2",
      }),
    );
  });

  it("routes a generation-2 cleanup batch through the standalone Keeper signer", async () => {
    if (!SAT_VNEXT_INTERFACE.active) {
      expect(SAT_VNEXT_INTERFACE.publicEntryEnabled).toBe(false);
      return;
    }
    const config = {
      enabled: false,
      network: "devnet",
      riskMode: "balanced",
      walletId: "mining-wallet",
      keeperMode: "dedicated",
      keeperWalletId: "keeper-wallet",
      permanentMiningId: ids.permanentMiningId,
    } as const;

    await submitSatCloseResolvedCleanupBatch(config, [
      { kind: "cycleRegistryPage", cycleId: 7, pageIndex: 0 },
      { kind: "cycleArtifacts", cycleId: 7 },
    ]);

    expect(executeTypedSatIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "keeper-wallet",
        useKeeperFeePayer: true,
        action: "cleanupBatch",
        instructions: expect.arrayContaining([
          expect.objectContaining({ action: "closeResolvedCycleRegistryPageV2" }),
          expect.objectContaining({ action: "closeResolvedCycleArtifactsV2" }),
        ]),
      }),
    );
  });
});
