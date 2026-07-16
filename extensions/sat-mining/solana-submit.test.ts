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
            },
          },
        },
      },
    });
    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({ txHash: "tx-submit-cycle", signer: SIGNER.toBase58() });
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");

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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

  it("uses the dedicated bond program and policy account by default", async () => {
    const amountRaw = 100_000_000_000;
    const mint = new PublicKey(SAT_MINT_ADDRESS_TEXT);
    const bondPosition = new PublicKey(
      findBondPda(Buffer.from("sat_bond_position"), SIGNER.toBuffer()),
    );
    const bondTierPolicy = new PublicKey(findBondPda(Buffer.from("sat_bond_tier_policy")));

    await submitSatOpenBondPosition({} as never, { amountRaw });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.request?.programId).toBe(SAT_BOND_PROGRAM_ID_TEXT);
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(
      Buffer.concat([Buffer.from([2]), encodeU64(amountRaw)]),
    );
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: bondTierPolicy.toBase58(), isSigner: false, isWritable: false },
      { pubkey: bondPosition.toBase58(), isSigner: false, isWritable: true },
      { pubkey: findAta(SIGNER, mint), isSigner: false, isWritable: true },
      { pubkey: findAta(bondPosition, mint), isSigner: false, isWritable: true },
      { pubkey: mint.toBase58(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it.each([
    ["sync rewards", submitSatSyncBondStakingRewards, 8],
    ["sync position", submitSatSyncBondStakingPosition, 9],
    ["claim rewards", submitSatClaimBondStakingRewards, 10],
  ] as const)(
    "submits bond staking %s against the dedicated bond program",
    async (_name, submit, ix) => {
      await submit({} as never);

      expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
      const request = callLocalSocketSigner.mock.calls[1]?.[1];
      expect(request?.op).toBe("sendSolanaInstruction");
      expect(request?.request?.programId).toBe(SAT_BOND_PROGRAM_ID_TEXT);
      expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")[0]).toBe(ix);
    },
  );

  it("updates staking weight in the same request-unlock instruction", async () => {
    await submitSatRequestBondUnlock({} as never);

    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_tier_policy")),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_position"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_staking_distributor")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_staking_position"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("updates staking weight in the same cancel-unlock instruction", async () => {
    await submitSatCancelBondUnlock({} as never);

    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.request?.keys?.map((key: { pubkey: string }) => key.pubkey)).toEqual([
      SIGNER.toBase58(),
      findBondPda(Buffer.from("sat_bond_tier_policy")),
      findBondPda(Buffer.from("sat_bond_position"), SIGNER.toBuffer()),
      findBondPda(Buffer.from("sat_bond_staking_distributor")),
      findBondPda(Buffer.from("sat_bond_staking_position"), SIGNER.toBuffer()),
    ]);
  });

  it("verifies zero staking weight before finalizing a bond unlock", async () => {
    await submitSatFinalizeBondUnlock({} as never);

    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.request?.keys?.slice(0, 5)).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_tier_policy")),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_position"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_staking_distributor")),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findBondPda(Buffer.from("sat_bond_staking_position"), SIGNER.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });

  it("passes the bond program to the atomic protocol distributor claim", async () => {
    const distributor = findBondPda(Buffer.from("sat_bond_staking_distributor"));
    await submitSatClaimProtocolDistributorSat({} as never, { recipientOwner: distributor });

    const request = callLocalSocketSigner.mock.calls[1]?.[1];
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

  it("claims quarantined zero-stake rewards only to the supplied treasury account", async () => {
    const mint = new PublicKey(SAT_MINT_ADDRESS_TEXT);
    const treasuryOwner = new PublicKey("AzXW61LgzhJTXN1so7rBR5auU2oCSzRyNEqFxPkZct3G");
    const distributor = new PublicKey(findBondPda(Buffer.from("sat_bond_staking_distributor")));

    await submitSatClaimUnallocatedStakingRewards({} as never, {
      recipientOwner: treasuryOwner.toBase58(),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
    expect(request?.request?.programId).toBe(SAT_BOND_PROGRAM_ID_TEXT);
    expect(Buffer.from(request?.request?.dataBase64 ?? "", "base64")).toEqual(Buffer.from([11]));
    expect(request?.request?.keys).toEqual([
      { pubkey: SIGNER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: distributor.toBase58(), isSigner: false, isWritable: true },
      { pubkey: findAta(distributor, mint), isSigner: false, isWritable: true },
      { pubkey: findAta(treasuryOwner, mint), isSigner: false, isWritable: true },
      { pubkey: treasuryOwner.toBase58(), isSigner: false, isWritable: false },
      { pubkey: mint.toBase58(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("marks the exact cycle state writable when closing resolved artifacts", async () => {
    const cycleId = 9_859_151;

    await submitSatCloseResolvedCycleArtifacts({} as never, { cycleId });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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
    callLocalSocketSigner
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ txHash: "tx-submit-cycle", signer: SIGNER.toBase58() });

    await submitSatCommitCycle({} as never, {
      cycleId,
      commitmentHex: "11".repeat(32),
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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
    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({ txHash: "tx-deposit", signer: SIGNER.toBase58() });

    await submitSatDepositMinerCapital(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 250_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "getAddresses",
      walletId: "solana-1",
    });
    expect(callLocalSocketSigner.mock.calls[1]?.[1]).toMatchObject({
      op: "sendSolanaInstruction",
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
    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({ txHash: "tx-deposit", signer: SIGNER.toBase58() });

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
    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(callLocalSocketSigner.mock.calls[1]?.[1]).toMatchObject({
      op: "sendSolanaInstruction",
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
    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({ txHash: "tx-set-active-commit", signer: SIGNER.toBase58() });

    await submitSatSetActiveCommit(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 350_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "getAddresses",
      walletId: "solana-1",
    });
    expect(callLocalSocketSigner.mock.calls[1]?.[1]).toMatchObject({
      op: "sendSolanaInstruction",
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
    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({ txHash: "tx-set-active-commit", signer: SIGNER.toBase58() });

    await submitSatSetActiveCommit(
      {
        walletId: "solana-1",
      } as never,
      { lamports: 350_000_000 },
    );

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    expect(loadWalletProviderSecret).not.toHaveBeenCalled();
    expect(callLocalSocketSigner.mock.calls[0]?.[1]).toEqual({
      op: "getAddresses",
      walletId: "solana-1",
    });
    expect(callLocalSocketSigner.mock.calls[1]?.[1]).toMatchObject({
      op: "sendSolanaInstruction",
      request: {
        walletId: "solana-1",
      },
    });
  });

  it("uses the upgraded settleCyclePage progress PDA", async () => {
    const cycleId = 9_859_142;
    await submitSatSettleCyclePage({} as never, {
      cycleId,
      pageIndex: 0,
      chunkIndex: 0,
      minerCycleAccounts: [
        "9V3dNMQ1Gqf4Cz4km6o6t3xf9oh1vfy1xTo6cLq4s4qK",
        "J2cCij1fwRjpj6CFa4U2j6vD7E1Qzzf6EX3THh1TjHq6",
      ],
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");

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
        pubkey: "9V3dNMQ1Gqf4Cz4km6o6t3xf9oh1vfy1xTo6cLq4s4qK",
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: "J2cCij1fwRjpj6CFa4U2j6vD7E1Qzzf6EX3THh1TjHq6",
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");

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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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
    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({
        txHash: "tx-cleanup-batch",
        signer: SIGNER.toBase58(),
        metadata: { instructionCount: 2 },
      });
    const cycleId = 9_859_162;
    const authority = "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY";

    await submitSatCloseResolvedCleanupBatch({} as never, [
      { kind: "minerCycleState", cycleId, authority },
      { kind: "cycleRegistryPage", cycleId, pageIndex: 1 },
    ]);

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    const request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstructions");
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
    const minerCycleAccounts = ["4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY"];

    await submitSatScoreCyclePage({} as never, {
      cycleId,
      pageIndex: 1,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(2);
    let request = callLocalSocketSigner.mock.calls[1]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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

    callLocalSocketSigner
      .mockResolvedValueOnce({ solana: SIGNER.toBase58() })
      .mockResolvedValueOnce({ txHash: "tx-distribute-cycle-page", signer: SIGNER.toBase58() });
    inspectSatMinerCyclesByAddress.mockResolvedValueOnce([
      {
        address: "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY",
        authority: "Wmesty4ZT9XfG2BK5NfaTLyVvHyeG1DW2gZnwZQntuk",
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

    await submitSatDistributeCyclePage({} as never, {
      cycleId,
      pageIndex: 1,
      chunkIndex: 0,
      minerCycleAccounts,
    });

    expect(callLocalSocketSigner).toHaveBeenCalledTimes(4);
    request = callLocalSocketSigner.mock.calls[3]?.[1];
    expect(request?.op).toBe("sendSolanaInstruction");
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
        pubkey: "4wxmFJm7xBkqLk7K3qn2gGw8v6SnM8j4rJz7s2p9dJQY",
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: findPda(
          Buffer.from("sat_miner_capital_state"),
          new PublicKey("Wmesty4ZT9XfG2BK5NfaTLyVvHyeG1DW2gZnwZQntuk").toBuffer(),
        ),
        isSigner: false,
        isWritable: true,
      },
    ]);
  });
});
