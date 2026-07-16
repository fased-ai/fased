import { PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadConfig,
  callLocalSocketSigner,
  requireLocalSocketSignerPath,
  readWalletProviderRegistry,
  resolveWalletProviderId,
  loadWalletProviderSecret,
  inspectSatMinerCycleByAddress,
  inspectSatMinerCyclesByAddress,
} = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  callLocalSocketSigner: vi.fn(),
  requireLocalSocketSignerPath: vi.fn(() => "/tmp/fased-test-signer.sock"),
  readWalletProviderRegistry: vi.fn(() => ({
    defaultWalletId: "solana-1",
    wallets: [
      {
        id: "solana-1",
        providerId: "local-socket-signer",
        addresses: { solana: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW" },
      },
    ],
  })),
  resolveWalletProviderId: vi.fn(() => "local-socket-signer"),
  loadWalletProviderSecret: vi.fn(() => null),
  inspectSatMinerCycleByAddress: vi.fn(),
  inspectSatMinerCyclesByAddress: vi.fn(),
}));

vi.mock("../../src/config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/config.js")>()),
  loadConfig,
}));

vi.mock("../../src/wallet/providers/local-socket-signer-adapter.js", () => ({
  callLocalSocketSigner,
  requireLocalSocketSignerPath,
}));

vi.mock("../../src/wallet/wallet-provider-registry.js", () => ({
  readWalletProviderRegistry,
  resolveWalletUserRole: (wallet?: { metadata?: { purpose?: string; role?: string } }) => {
    const role = wallet?.metadata?.purpose ?? wallet?.metadata?.role;
    return role === "agent" || role === "vault" || role === "mining" ? role : undefined;
  },
}));

vi.mock("../../src/wallet/wallet-provider-resolver.js", () => ({
  resolveWalletProviderId,
}));

vi.mock("../../src/wallet/wallet-secrets-store.js", () => ({
  loadWalletProviderSecret,
}));

vi.mock("./src/rpc-read.js", async () => {
  const actual = await vi.importActual<typeof import("./src/rpc-read.js")>("./src/rpc-read.js");
  return {
    ...actual,
    inspectSatMinerCycleByAddress,
    inspectSatMinerCyclesByAddress,
  };
});

import {
  buildSatCycleCommitment,
  submitSatAbortEmptyCycle,
  submitSatClaimBondStakingRewards,
  submitSatClaimProtocolDistributorSat,
  submitSatClaimUnallocatedStakingRewards,
  submitSatCancelBondUnlock,
  submitSatCloseResolvedCleanupBatch,
  submitSatCloseResolvedCycleArtifacts,
  submitSatCloseResolvedCycleRegistryPage,
  submitSatCloseResolvedMinerCycleState,
  resolveSatValidatorAuthority,
  submitSatDepositMinerCapital,
  submitSatCommitCycle,
  submitSatDistributeCyclePage,
  submitSatFinalizeBondUnlock,
  submitSatFinalizeCycleSettlement,
  submitSatIncreaseBondPosition,
  submitSatInitMinerCapital,
  submitSatOpenBondPosition,
  submitSatSetActiveCommit,
  submitSatOpenCycle,
  submitSatRevealCycle,
  submitSatRefillRegistryReserveFromTreasury,
  submitSatReleaseUnrevealedCommit,
  submitSatRequestBondUnlock,
  submitSatScoreCyclePage,
  submitSatSealCycleEntropy,
  submitSatSettleCyclePage,
  submitSatSyncBondStakingPosition,
  submitSatSyncBondStakingRewards,
  submitSatTopUpRegistryReserve,
} from "./src/solana-submit.js";

const SAT_PROGRAM_ID_TEXT = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
const SAT_BOND_PROGRAM_ID_TEXT = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq";
const SAT_MINT_ADDRESS_TEXT = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa";
const SAT_MINT_PROGRAM_ID_TEXT = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C";
const SAT_PROGRAM_ID = new PublicKey("EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75");
const SAT_BOND_PROGRAM_ID = new PublicKey("D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq");
const SIGNER = new PublicKey("8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TEST_POLICY_HASH = `sha256:${"ab".repeat(32)}`;

function configureLocalSignerMock(addresses: { solana?: string } = { solana: SIGNER.toBase58() }) {
  callLocalSocketSigner.mockImplementation(
    async (_socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
      switch (payload.op) {
        case "getAddresses":
          return addresses;
        case "v2.capabilities":
          return {
            ready: true,
            capabilities: {
              protocol: { current: 2, min: 2, max: 2 },
              intentTypes: ["solana.satAction", "solana.vaultBondAction"],
              operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
              features: [
                "failClosedPolicies",
                "policyHashes",
                "durableCaps",
                "atomicIdempotency",
                "ambiguousBroadcastReconciliation",
                "signerOwnedKeys",
                "typedSolanaTransactions",
                "typedSATActions",
                "typedVaultBondActions",
              ],
            },
          };
        case "v2.policy.get":
          return { hash: TEST_POLICY_HASH };
        case "v2.execute":
          return {
            requestId: payload.request?.requestId ?? "sat-test-request",
            state: "confirmed",
            signature: "tx-submit-cycle",
          };
        default:
          throw new Error(`unexpected signer test op ${payload.op}`);
      }
    },
  );
}

function latestTypedSatRequest() {
  const payload = [...callLocalSocketSigner.mock.calls]
    .reverse()
    .map((call) => call[1])
    .find((candidate) => candidate?.op === "v2.execute");
  if (!payload || payload.op !== "v2.execute") {
    throw new Error("typed SAT v2.execute request was not captured");
  }
  const intent = payload.request.intent;
  return {
    op: payload.op,
    request: {
      ...intent,
      walletId: payload.walletId,
      ...(intent.action === "cleanupBatch" ? { purpose: "sat-cleanup" } : {}),
    },
  };
}

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function findPda(...seeds: Buffer[]): string {
  return PublicKey.findProgramAddressSync(seeds, SAT_PROGRAM_ID)[0].toBase58();
}

function findBondPda(...seeds: Buffer[]): string {
  return PublicKey.findProgramAddressSync(seeds, SAT_BOND_PROGRAM_ID)[0].toBase58();
}

function findAta(owner: PublicKey, mint: PublicKey): string {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0].toBase58();
}

describe("SAT cycle transaction builders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FASED_SAT_PROGRAM_ID = SAT_PROGRAM_ID_TEXT;
    process.env.FASED_SAT_BOND_PROGRAM_ID = SAT_BOND_PROGRAM_ID_TEXT;
    process.env.FASED_SAT_MINT_ADDRESS = SAT_MINT_ADDRESS_TEXT;
    process.env.FASED_SAT_MINT_PROGRAM_ID = SAT_MINT_PROGRAM_ID_TEXT;
    readWalletProviderRegistry.mockImplementation(() => ({
      defaultWalletId: "solana-1",
      wallets: [
        {
          id: "solana-1",
          providerId: "local-socket-signer",
          addresses: { solana: SIGNER.toBase58() },
        },
      ],
    }));
    resolveWalletProviderId.mockImplementation(() => "local-socket-signer");
    loadWalletProviderSecret.mockImplementation(() => null);
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "solana-1",
              network: "devnet",
            },
          },
        },
      },
    });
    configureLocalSignerMock();
  });

  it("defaults init miner capital authority to the configured signer address", async () => {
    await submitSatInitMinerCapital({} as never, {});

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request.request.action).toBe("initMinerCapital");
    expect(Buffer.from(request.request.dataBase64, "base64")).toEqual(
      Buffer.concat([Buffer.from([36]), SIGNER.toBuffer()]),
    );
    expect(request.request.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("fails closed before policy lookup when typed SAT capabilities are missing", async () => {
    callLocalSocketSigner.mockImplementation(
      async (_socketPath: string, payload: { op?: string }) => {
        if (payload.op === "getAddresses") {
          return { solana: SIGNER.toBase58() };
        }
        if (payload.op === "v2.capabilities") {
          return {
            ready: true,
            capabilities: {
              protocol: { current: 2, min: 2, max: 2 },
              intentTypes: ["solana.nativeTransfer"],
              operationStates: ["reserved", "confirmed"],
              features: ["policyHashes"],
            },
          };
        }
        throw new Error(`unexpected signer test op ${payload.op}`);
      },
    );

    await expect(
      submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
    ).rejects.toThrow("required typed SAT protocol-v2 contract");
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "getAddresses",
      "v2.capabilities",
    ]);
  });

  it("reconciles the same durable request after an ambiguous execute transport result", async () => {
    const healthySignerCall = callLocalSocketSigner.getMockImplementation();
    let durableRequestId = "";
    callLocalSocketSigner.mockImplementation(
      async (socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.execute") {
          durableRequestId = String(payload.request?.requestId ?? "");
          throw new Error("socket closed after broadcast");
        }
        if (payload.op === "v2.operation.get" || payload.op === "v2.operation.reconcile") {
          expect(payload.request?.requestId).toBe(durableRequestId);
          return {
            requestId: durableRequestId,
            state: "unknown",
            signature: "ambiguous-sat-signature",
            error: "confirmation timeout",
          };
        }
        if (!healthySignerCall) {
          throw new Error("healthy signer mock is unavailable");
        }
        return await healthySignerCall(socketPath, payload);
      },
    );

    await expect(
      submitSatDepositMinerCapital({} as never, { lamports: 250_000_000 }),
    ).resolves.toMatchObject({
      txHash: "ambiguous-sat-signature",
      signerState: "unknown",
      requestId: expect.stringMatching(/^sat-[0-9a-f-]{36}$/),
    });
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "getAddresses",
      "v2.capabilities",
      "v2.policy.get",
      "v2.execute",
      "v2.operation.get",
      "v2.operation.reconcile",
    ]);
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
  });

  it("uses the reveal account order", async () => {
    const cycleId = 9_859_137;
    const intervalStartCycleId = 9_859_128;
    await submitSatRevealCycle({} as never, {
      cycleId,
      intervalStartCycleId,
      nonceBase64: Buffer.alloc(32, 7).toString("base64"),
      allocationFp: new Array(25).fill(40_000),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "getAddresses",
      "v2.capabilities",
      "v2.policy.get",
      "v2.execute",
    ]);
    const executeEnvelope = callLocalSocketSigner.mock.calls[3]?.[1];
    expect(executeEnvelope).toMatchObject({
      op: "v2.execute",
      walletId: "solana-1",
      request: {
        policyHash: TEST_POLICY_HASH,
        intent: {
          type: "solana.satAction",
          action: "revealCycle",
          context: {
            intervalStartCycleId: String(intervalStartCycleId),
            registryPageIndex: "0",
          },
        },
      },
    });
    expect(executeEnvelope?.request?.requestId).toMatch(/^sat-[0-9a-f-]{36}$/);
    expect(
      callLocalSocketSigner.mock.calls.some((call) =>
        ["sendSolanaInstruction", "sendSolanaInstructions"].includes(call[1]?.op),
      ),
    ).toBe(false);

    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(0)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_unlock_interval_state"), encodeU64(intervalStartCycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId.toBase58(),
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  it("passes the canonical SlotHashes sysvar when sealing cycle entropy", async () => {
    const cycleId = 9_859_137;
    const intervalStartCycleId = 9_859_128;
    await submitSatSealCycleEntropy({} as never, { cycleId, intervalStartCycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_unlock_interval_state"), encodeU64(intervalStartCycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: "SysvarS1otHashes111111111111111111111111111",
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  it("routes missed-reveal penalties through the fixed treasury accounts", async () => {
    const cycleId = 9_859_137;
    await submitSatReleaseUnrevealedCommit({} as never, {
      cycleId,
      minerAuthority: SIGNER.toBase58(),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_vault")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("builds the permissionless empty-cycle abort with writable cycle state", async () => {
    const cycleId = 9_859_137;
    await submitSatAbortEmptyCycle({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(
      Buffer.concat([Buffer.from([94]), encodeU64(cycleId)]),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("builds the protocol-domain commitment deterministically", () => {
    const commitment = buildSatCycleCommitment({
      authority: SIGNER.toBase58(),
      cycleId: 9_859_137,
      committedLamports: 250_000_000,
      nonce: Buffer.alloc(32, 7),
      allocationFp: new Array(25).fill(40_000),
      programId: SAT_PROGRAM_ID_TEXT,
    });

    expect(commitment).toHaveLength(32);
    expect(commitment.toString("hex")).toBe(
      buildSatCycleCommitment({
        authority: SIGNER.toBase58(),
        cycleId: 9_859_137,
        committedLamports: 250_000_000,
        nonce: Buffer.alloc(32, 7),
        allocationFp: new Array(25).fill(40_000),
        programId: SAT_PROGRAM_ID_TEXT,
      }).toString("hex"),
    );
  });

  it.each([
    ["open", () => submitSatOpenBondPosition({} as never, { amountRaw: 100_000_000_000 })],
    ["increase", () => submitSatIncreaseBondPosition({} as never, { amountRaw: 100_000_000_000 })],
    ["request unlock", () => submitSatRequestBondUnlock({} as never)],
    ["cancel unlock", () => submitSatCancelBondUnlock({} as never)],
    ["finalize unlock", () => submitSatFinalizeBondUnlock({} as never)],
    ["sync rewards", () => submitSatSyncBondStakingRewards({} as never)],
    ["sync position", () => submitSatSyncBondStakingPosition({} as never)],
    ["claim rewards", () => submitSatClaimBondStakingRewards({} as never)],
    [
      "claim unallocated rewards",
      () =>
        submitSatClaimUnallocatedStakingRewards({} as never, {
          recipientOwner: "AzXW61LgzhJTXN1so7rBR5auU2oCSzRyNEqFxPkZct3G",
        }),
    ],
  ] as const)(
    "keeps Vault bond %s reviewed-only and never calls direct execute",
    async (_name, submit) => {
      await expect(submit()).rejects.toThrow(
        "requires signer-owned reviewed authorization; direct execution is disabled",
      );
      expect(callLocalSocketSigner.mock.calls.map((call) => call[1].op)).toEqual([
        "getAddresses",
        "v2.capabilities",
      ]);
      expect(callLocalSocketSigner).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ op: "v2.execute" }),
      );
    },
  );

  it("passes the bond program to the atomic protocol distributor claim", async () => {
    const distributor = findBondPda(Buffer.from("sat_bond_staking_distributor"));
    await submitSatClaimProtocolDistributorSat({} as never, { recipientOwner: distributor });

    const request = latestTypedSatRequest();
    expect(request?.request?.programId).toBe(SAT_PROGRAM_ID_TEXT);
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(Buffer.from([85]));
    expect(request?.request?.keys).toHaveLength(13);
    expect(request?.request?.keys?.[4]?.pubkey).toBe(distributor);
    expect(request?.request?.keys?.[12]).toEqual({
      pubkey: SAT_BOND_PROGRAM_ID_TEXT,
      isSigner: false,
      isWritable: false,
    });
  });

  it("marks the exact cycle state writable when closing resolved artifacts", async () => {
    const cycleId = 9_859_151;

    await submitSatCloseResolvedCycleArtifacts({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("includes the treasury vault when opening a cycle", async () => {
    const cycleId = 9_859_145;
    await submitSatOpenCycle({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_global_state")), isSigner: false, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId.toBase58(),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_vault")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("builds treasury-backed registry reserve refill with fixed protocol PDAs", async () => {
    await submitSatRefillRegistryReserveFromTreasury({} as never, {
      targetBalanceLamports: 1_000_000_000,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")[0]).toBe(88);
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_treasury_state")), isSigner: false, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_treasury_vault")), isSigner: false, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_registry_reserve")), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("tops up the registry reserve without invoking protocol genesis", async () => {
    await submitSatTopUpRegistryReserve({} as never, {
      targetBalanceLamports: 200_000_000,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(
      Buffer.concat([Buffer.from([84]), encodeU64(200_000_000)]),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_registry_reserve")), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("rejects reserve targets above the selected genesis profile", async () => {
    await expect(
      submitSatTopUpRegistryReserve({ network: "mainnet-beta" } as never, {
        targetBalanceLamports: 1_000_000_001,
      }),
    ).rejects.toThrow("mainnet-beta genesis maximum 1000000000");
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
  });

  it("falls back to the registry Solana address when local signer getAddresses returns empty", async () => {
    const cycleId = 9_859_143;
    configureLocalSignerMock({});

    await submitSatCommitCycle({} as never, {
      cycleId,
      commitmentHex: "11".repeat(32),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.walletId).toBe("solana-1");
    expect(request?.request?.keys?.[0]).toEqual({
      pubkey: SIGNER.toBase58(),
      isSigner: true,
      isWritable: true,
    });
  });

  it("falls back to the registry Solana address for validator authority resolution", async () => {
    callLocalSocketSigner.mockResolvedValueOnce({});

    await expect(resolveSatValidatorAuthority({} as never)).resolves.toBe(SIGNER.toBase58());
    expect(callLocalSocketSigner).toHaveBeenCalledWith("/tmp/fased-test-signer.sock", {
      op: "getAddresses",
      walletId: "solana-1",
    });
  });

  it("uses the active SAT wallet attachment for deposit even when the loaded config is stale", async () => {
    loadConfig.mockReturnValueOnce({
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });

    await submitSatDepositMinerCapital(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 250_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "getAddresses",
      walletId: "solana-1",
    });
    expect(latestTypedSatRequest()).toMatchObject({
      op: "v2.execute",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("uses config-scoped wallet env for VPS local-signer SAT deposits", async () => {
    loadConfig.mockReturnValueOnce({
      env: {
        vars: {
          FASED_CONFIG_ONLY_MARKER: "cfg-env",
        },
      },
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });
    readWalletProviderRegistry.mockImplementation((env?: NodeJS.ProcessEnv) => ({
      defaultWalletId: "solana-1",
      wallets:
        env?.FASED_CONFIG_ONLY_MARKER === "cfg-env"
          ? [
              {
                id: "solana-1",
                providerId: "local-socket-signer",
                addresses: { solana: SIGNER.toBase58() },
              },
            ]
          : [],
    }));
    resolveWalletProviderId.mockReturnValueOnce("embedded-keystore");

    await submitSatDepositMinerCapital(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 250_000_000 },
    );

    expect(readWalletProviderRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        FASED_CONFIG_ONLY_MARKER: "cfg-env",
      }),
    );
    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(latestTypedSatRequest()).toMatchObject({
      op: "v2.execute",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("uses local-socket-signer for SAT commit changes when registry is stale but self-hosted env exists", async () => {
    loadConfig.mockReturnValueOnce({
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-test-signer.sock",
          FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: "/tmp/keystore-solana-solana-1.v1.enc",
        },
      },
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });
    readWalletProviderRegistry.mockReturnValueOnce({
      defaultWalletId: "solana-1",
      wallets: [],
    });
    resolveWalletProviderId.mockReturnValueOnce("embedded-keystore");

    await submitSatSetActiveCommit(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 350_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "getAddresses",
      walletId: "solana-1",
    });
    expect(latestTypedSatRequest()).toMatchObject({
      op: "v2.execute",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("uses local-socket-signer for SAT commit changes when the registry wallet provider is stale", async () => {
    loadConfig.mockReturnValueOnce({
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-test-signer.sock",
          FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: "/tmp/keystore-solana-solana-1.v1.enc",
        },
      },
      wallet: {
        provider: {
          id: "embedded-keystore",
        },
      },
    });
    readWalletProviderRegistry.mockReturnValueOnce({
      defaultWalletId: "solana-1",
      wallets: [
        {
          id: "solana-1",
          providerId: "embedded-keystore",
          addresses: { solana: SIGNER.toBase58() },
        },
      ],
    });
    resolveWalletProviderId.mockReturnValueOnce("embedded-keystore");

    await submitSatSetActiveCommit(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 350_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "getAddresses",
      walletId: "solana-1",
    });
    expect(latestTypedSatRequest()).toMatchObject({
      op: "v2.execute",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("uses the upgraded settleCyclePage progress PDA", async () => {
    const cycleId = 9_859_142;
    const minerAuthorities = [
      new PublicKey("Wmesty4ZT9XfG2BK5NfaTLyVvHyeG1DW2gZnwZQntuk"),
      new PublicKey("4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY"),
    ];
    const minerCycleAccounts = minerAuthorities.map((authority) =>
      findPda(Buffer.from("sat_miner_cycle_state"), authority.toBuffer(), encodeU64(cycleId)),
    );
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce(
      minerAuthorities.map((authority, index) => ({
        address: minerCycleAccounts[index],
        authority: authority.toBase58(),
        cycleId,
      })),
    );
    await submitSatSettleCyclePage({} as never, {
      cycleId,
      pageIndex: 0,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");

    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_global_state")), isSigner: false, isWritable: false },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(0)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SystemProgram.programId.toBase58(),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_rebate_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: minerCycleAccounts[0],
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: minerCycleAccounts[1],
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("uses the upgraded finalizeCycleSettlement progress PDA", async () => {
    const cycleId = 9_859_149;
    await submitSatFinalizeCycleSettlement({} as never, {
      cycleId,
      pageCount: 2,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");

    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: findPda(Buffer.from("sat_global_state")), isSigner: false, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_rebate_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(0)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(1)),
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  it("closes resolved miner-cycle state for the target authority instead of assuming the executor", async () => {
    const cycleId = 9_859_160;
    const authority = "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY";
    await submitSatCloseResolvedMinerCycleState({} as never, {
      cycleId,
      authority,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: authority, isSigner: false, isWritable: true },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          new PublicKey(authority).toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_capital_state"),
          new PublicKey(authority).toBuffer(),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("passes registry meta when closing a resolved registry page", async () => {
    const cycleId = 9_859_161;
    const pageIndex = 1;
    await submitSatCloseResolvedCycleRegistryPage({} as never, { cycleId, pageIndex });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_meta"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_cycle_registry_page"),
          encodeU64(cycleId),
          encodeU64(pageIndex),
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_registry_reserve")),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("submits cleanup close instructions as one sat-cleanup batch", async () => {
    const cycleId = 9_859_162;
    const authority = "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY";

    await submitSatCloseResolvedCleanupBatch({} as never, [
      { kind: "minerCycleState", cycleId, authority },
      { kind: "cycleRegistryPage", cycleId, pageIndex: 1 },
    ]);

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    const request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.purpose).toBe("sat-cleanup");
    expect(request?.request?.instructions).toHaveLength(2);
    expect(request?.request?.instructions?.[0]?.dataBase64).toBe(
      Buffer.concat([Buffer.from([69]), encodeU64(cycleId)]).toString("base64"),
    );
    expect(request?.request?.instructions?.[1]?.dataBase64).toBe(
      Buffer.concat([Buffer.from([70]), encodeU64(cycleId), encodeU64(1)]).toString("base64"),
    );
  });

  it("uses the upgraded score/distribute progress PDA", async () => {
    const cycleId = 9_859_149;
    const minerAuthority = new PublicKey("Wmesty4ZT9XfG2BK5NfaTLyVvHyeG1DW2gZnwZQntuk");
    const minerCycleAccounts = [
      findPda(Buffer.from("sat_miner_cycle_state"), minerAuthority.toBuffer(), encodeU64(cycleId)),
    ];
    inspectSatMinerCyclesByAddress.mockResolvedValue([
      {
        address: minerCycleAccounts[0],
        authority: minerAuthority.toBase58(),
        cycleId,
        committedLamports: "250000000",
        claimableSatRaw: "0",
        claimableDetRebateLamports: "0",
        claimablePerfRebateLamports: "0",
        claimedSatRaw: "0",
        claimedDetRebateLamports: "0",
        claimedPerfRebateLamports: "0",
        validParticipation: true,
        capitalLockReleased: false,
      },
    ]);

    await submitSatScoreCyclePage({} as never, {
      cycleId,
      pageIndex: 1,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    let request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys?.[0]).toEqual({
      pubkey: SIGNER.toBase58(),
      isSigner: true,
      isWritable: true,
    });
    expect(request?.request?.keys?.[3]?.pubkey).toBe(
      findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(1)),
    );
    expect(request?.request?.keys?.[4]?.pubkey).toBe(
      findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
    );

    await submitSatDistributeCyclePage({} as never, {
      cycleId,
      pageIndex: 1,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(8);
    request = latestTypedSatRequest();
    expect(request?.op).toBe("v2.execute");
    expect(request?.request?.keys?.[0]).toEqual({
      pubkey: SIGNER.toBase58(),
      isSigner: true,
      isWritable: true,
    });
    expect(request?.request?.keys?.[3]?.pubkey).toBe(
      findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findPda(Buffer.from("sat_cycle_state"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_registry_page"), encodeU64(cycleId), encodeU64(1)),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_cycle_settlement_progress_v2"), encodeU64(cycleId)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_global_state")),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_state")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_cycle_state"),
          SIGNER.toBuffer(),
          encodeU64(cycleId),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_rebate_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_treasury_vault")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: minerCycleAccounts[0],
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(Buffer.from("sat_miner_capital_state"), minerAuthority.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });
});
