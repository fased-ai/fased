import http from "node:http";
import type { AddressInfo } from "node:net";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateSatRevealSharedRentLamports,
  createReadConnection,
  decodeSatBondPosition,
  decodeSatBondStakingDistributor,
  decodeSatCycle,
  decodeSatCycleSettlementProgressV2,
  decodeSatCycleSettlementProgressV3,
  decodeSatRoundBucket,
  decodeSatCycleRegistryPage,
  decodeSatGlobalState,
  decodeSatKeeperCapability,
  decodeSatMinerCapital,
  decodeSatMinerCycle,
  decodeSatMinerCycleV2,
  inspectSatCycleAccountExists,
  inspectSatChainUnixTime,
  inspectSatAddressLookupTable,
  inspectSatMinerCycleByAddress,
  inspectSatMinerCyclesByAddress,
  inspectSatConnectionDetails,
  invalidateSatReadCaches,
  resolveDefaultSolanaPublicReadFallbackUrl,
  SAT_RENT_ACCOUNT_SPACES,
} from "./rpc-read.js";

const READ_RPC_ENV_KEYS = [
  "FASED_WALLET_SOLANA_READ_RPC_URL",
  "FASED_WALLET_SOLANA_READ_RPC_FALLBACK_URL",
  "FASED_WALLET_SOLANA_RPC_URL",
  "FASED_WALLET_SOLANA_RPC_FALLBACK_URL",
  "FASED_SAT_PROGRAM_ID",
  "FASED_SAT_BOND_PROGRAM_ID",
  "FASED_SAT_MINT_ADDRESS",
  "FASED_SAT_MINT_PROGRAM_ID",
  "FASED_SAT_RPC_REQUEST_TIMEOUT_MS",
] as const;

const readRpcEnvSnapshot = new Map<string, string | undefined>();
const startedServers: http.Server[] = [];

beforeEach(() => {
  invalidateSatReadCaches();
  for (const key of READ_RPC_ENV_KEYS) {
    readRpcEnvSnapshot.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  invalidateSatReadCaches();
  for (const key of READ_RPC_ENV_KEYS) {
    const original = readRpcEnvSnapshot.get(key);
    if (original == null) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  readRpcEnvSnapshot.clear();
  await Promise.all(
    startedServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("SAT RPC diagnostic redaction", () => {
  it("redacts credential-bearing primary and fallback URLs", () => {
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"; // pragma: allowlist secret
    process.env.FASED_SAT_BOND_PROGRAM_ID = "8RYKuGb2k8hBcGX34QdYJXdXZkNvD3fKy85s63Pph2j7"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_PROGRAM_ID = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C"; // pragma: allowlist secret
    process.env.FASED_WALLET_SOLANA_READ_RPC_URL =
      "https://primary.example/rpc?api-key=primary-secret";
    process.env.FASED_WALLET_SOLANA_READ_RPC_FALLBACK_URL =
      "https://fallback.example/rpc?token=fallback-secret";

    const details = inspectSatConnectionDetails();

    expect(details.rpcUrl).toBe("https://primary.example/rpc?api-key=***");
    expect(details.readRpcFallbackUrl).toBe("https://fallback.example/rpc?token=***");
    expect(JSON.stringify(details)).not.toContain("primary-secret");
    expect(JSON.stringify(details)).not.toContain("fallback-secret");
  });
});

describe("decodeSatBondStakingDistributor", () => {
  it("exposes rewards quarantined while no stake was active", () => {
    const bondProgram = new PublicKey("D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq"); // pragma: allowlist secret
    const mint = new PublicKey("2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"); // pragma: allowlist secret
    const [distributor] = PublicKey.findProgramAddressSync(
      [Buffer.from("sat_bond_staking_distributor")],
      bondProgram,
    );
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // pragma: allowlist secret
    const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"); // pragma: allowlist secret
    const [rewardVault] = PublicKey.findProgramAddressSync(
      [distributor.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
      associatedTokenProgram,
    );
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"; // pragma: allowlist secret
    process.env.FASED_SAT_BOND_PROGRAM_ID = bondProgram.toBase58();
    process.env.FASED_SAT_MINT_ADDRESS = mint.toBase58();
    process.env.FASED_SAT_MINT_PROGRAM_ID = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C"; // pragma: allowlist secret

    const data = Buffer.alloc(232);
    data[0] = 142;
    const body = data.subarray(8);
    body[0] = 1;
    body[2] = 1;
    body.writeBigUInt64LE(1n, 8);
    mint.toBuffer().copy(body, 16);
    rewardVault.toBuffer().copy(body, 48);
    new PublicKey("AB3FQHskSYuWVw4M9EpGdxNzrAjBNiYGpbH4CVzLFene") // pragma: allowlist secret
      .toBuffer()
      .copy(body, 80);
    body.writeBigUInt64LE(500_000_000_000n, 112);
    body.writeBigUInt64LE(0n, 120);
    body.writeBigUInt64LE(900_000_000_000n, 144);
    body.writeBigUInt64LE(77n, 152);
    body.writeBigUInt64LE(125_000_000_000n, 160);
    body.writeBigUInt64LE(500_000_000_000_000_000n, 168);

    const decoded = decodeSatBondStakingDistributor(data, distributor.toBase58());

    expect(decoded.unallocatedRewardRaw).toBe("125000000000");
    expect(decoded.totalActiveStakeRaw).toBe("0");
    expect(decoded.fractionalRemainderFp).toBe("500000000000000000");
    expect(decoded.vaultMatchesExpected).toBe(true);
  });
});

describe("decodeSatCycle", () => {
  it("marks the reserved entropy-unavailable seed as a cancelled cycle", () => {
    const data = Buffer.alloc(328);
    data[0] = 131;
    const body = data.subarray(8);
    body.writeBigUInt64LE(77n, 0);
    body.fill(0xff, 40, 72);

    expect(decodeSatCycle(data, "cycle-address")).toMatchObject({
      address: "cycle-address",
      cycleId: 77,
      cycleSeed: "ff".repeat(32),
      entropyUnavailable: true,
    });
  });
});

describe("decodeSatCycleSettlementProgressV2", () => {
  it("exposes paid and unpaid keeper bounty accounting", () => {
    const data = Buffer.alloc(1_048);
    data[0] = 137;
    const body = data.subarray(8);
    body.writeBigUInt64LE(77n, 0);
    body.writeBigUInt64LE(11_000n, 1_008);
    body.writeBigUInt64LE(22_000n, 1_016);

    expect(decodeSatCycleSettlementProgressV2(data, "progress-address")).toMatchObject({
      address: "progress-address",
      cycleId: 77,
      keeperBountyPaidLamports: "11000",
      keeperBountyUnpaidLamports: "22000",
    });
  });
});

describe("decodeSatCycleSettlementProgressV3", () => {
  it("decodes generation-2 cursors, windows, and unpaid duplicate accounting", () => {
    const data = Buffer.alloc(936);
    data[0] = 151;
    const body = data.subarray(8);
    body.writeBigUInt64LE(88n, 0);
    body.writeUInt16LE(4, 128);
    body.writeUInt16LE(2, 130);
    body.writeUInt16LE(1, 132);
    body.writeUInt16LE(1, 134);
    body.writeUInt16LE(3, 136);
    body.writeUInt16LE(0, 138);
    body.writeUInt16LE(2, 140);
    body[142] = 1;
    body.writeBigUInt64LE(1_020n, 856);
    body.writeBigUInt64LE(1_040n, 864);
    body.writeBigUInt64LE(1_060n, 872);
    body.writeBigUInt64LE(1_080n, 880);
    body.writeBigUInt64LE(50_000n, 888);
    body.writeBigUInt64LE(7_000n, 912);

    expect(decodeSatCycleSettlementProgressV3(data, "progress-v3")).toMatchObject({
      address: "progress-v3",
      cycleId: 88,
      expectedPageCount: 4,
      processedPageCount: 2,
      settleChunkIndex: 1,
      scoredPageCount: 1,
      scoreChunkIndex: 3,
      distributeChunkIndex: 2,
      finalized: true,
      settleExclusiveUntilSlot: 1020,
      finalizeExclusiveUntilSlot: 1040,
      scoreExclusiveUntilSlot: 1060,
      distributeExclusiveUntilSlot: 1080,
      keeperBountyPaidLamports: "50000",
      keeperBountyUnpaidLamports: "7000",
    });
  });
});

describe("decodeSatKeeperCapability", () => {
  it("keeps the keeper fee payer and payout authority separate", () => {
    const feePayer = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9"); // pragma: allowlist secret
    const payoutAuthority = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2"); // pragma: allowlist secret
    const data = Buffer.alloc(200);
    data[0] = 145;
    const body = data.subarray(8);
    body[1] = 1;
    body.writeUInt16LE(2, 4);
    body.writeBigUInt64LE(15n, 32);
    feePayer.toBuffer().copy(body, 96);
    payoutAuthority.toBuffer().copy(body, 128);

    expect(decodeSatKeeperCapability(data, "capability")).toMatchObject({
      address: "capability",
      status: 1,
      keeperGeneration: 2,
      capabilityMask: 15,
      feePayerPublicKey: feePayer.toBase58(),
      payoutAuthority: payoutAuthority.toBase58(),
    });
  });
});

async function startRpcServer(
  handler: (payload: { id?: string | number; method?: string; params?: unknown[] }) => {
    statusCode?: number;
    body?: string;
    result?: unknown;
    error?: { message?: string };
    hang?: boolean;
    reset?: boolean;
  },
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        id?: string | number;
        method?: string;
        params?: unknown[];
      };
      const response = handler(payload);
      if (response.hang) {
        return;
      }
      if (response.reset) {
        req.socket.destroy();
        return;
      }
      res.statusCode = response.statusCode ?? 200;
      if (response.body != null) {
        res.end(response.body);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? 1,
          ...(response.error ? { error: response.error } : { result: response.result ?? null }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  startedServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

class FetchBackedConnection {
  readonly rpcEndpoint: string;
  readonly fetchFn: typeof globalThis.fetch;

  constructor(rpcEndpoint: string, config?: { fetch?: typeof globalThis.fetch }) {
    this.rpcEndpoint = rpcEndpoint;
    this.fetchFn = config?.fetch ?? globalThis.fetch;
  }

  getAccountInfo = vi.fn();
  getProgramAccounts = vi.fn();
  getMinimumBalanceForRentExemption = async (_space: number): Promise<number> => {
    const response = await this.fetchFn(this.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMinimumBalanceForRentExemption" }),
    });
    const payload = (await response.json()) as {
      result?: number;
      error?: { message?: string };
    };
    if (payload.error) {
      throw new Error(payload.error.message ?? "RPC failed");
    }
    return Number(payload.result ?? 0);
  };
}

function configureReadRpc(primaryUrl: string, fallbackUrl?: string) {
  process.env.FASED_WALLET_SOLANA_READ_RPC_URL = primaryUrl;
  if (fallbackUrl) {
    process.env.FASED_WALLET_SOLANA_READ_RPC_FALLBACK_URL = fallbackUrl;
  }
}

describe("inspectSatRentExemptionLamports", () => {
  it("uses current account sizes and includes unlock interval rent in reveal funding", () => {
    expect(SAT_RENT_ACCOUNT_SPACES).toEqual({
      protocolVault: 0,
      cycleState: 376,
      cycleRegistryMeta: 88,
      cycleRegistryPage: 2_072,
      cycleSettlementProgressV2: 1_048,
      minerCycle: 352,
      unlockInterval: 80,
    });
    expect(
      calculateSatRevealSharedRentLamports({
        cycleSettlementProgressLamports: 2_048,
        cycleRegistryPageLamports: 3_072,
        unlockIntervalLamports: 1_080,
      }),
    ).toBe(6_200);
  });
});

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function encodeU128(value: bigint): Buffer {
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  out.writeBigUInt64LE(value >> 64n, 8);
  return out;
}

function encodeI64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function encodeMinerCycleAccount(authority: PublicKey, cycleId: number): string {
  return Buffer.concat([
    Buffer.from([132, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(64),
    authority.toBuffer(),
    encodeU64(cycleId),
    Buffer.alloc(8 * 9),
    Buffer.from([1, 0]),
    Buffer.alloc(6),
    Buffer.alloc(26 * 4),
  ]).toString("base64");
}

describe("decodeSatRoundBucket", () => {
  it("reads roundSeed and bucketHash after participation counters", () => {
    const roundSeed = "11".repeat(32);
    const bucketHash = "22".repeat(32);
    const buffer = Buffer.concat([
      Buffer.from([122, 0, 0, 0, 0, 0, 0, 0]),
      encodeU64(10),
      encodeU64(1),
      encodeU64(1),
      encodeI64(1234),
      encodeI64(1294),
      encodeU64(7),
      encodeU64(3),
      Buffer.from(roundSeed, "hex"),
      Buffer.from(bucketHash, "hex"),
      Buffer.alloc(25 * 4),
      Buffer.alloc(25 * 4),
    ]);

    expect(decodeSatRoundBucket(buffer, "bucket-address")).toMatchObject({
      address: "bucket-address",
      epochId: 10,
      microRoundId: 1,
      bucketVersion: 1,
      roundOpenTs: 1234,
      roundCloseTs: 1294,
      roundSeed,
      bucketHash,
    });
  });
});

describe("Solana pubkey decoding", () => {
  it("decodes the generation-2 permanent identity from miner capital", () => {
    const authority = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9"); // pragma: allowlist secret
    const permanentMiningId = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2"); // pragma: allowlist secret
    const data = Buffer.alloc(136);
    data[0] = 138;
    const body = data.subarray(8);
    body[0] = 2;
    authority.toBuffer().copy(body, 8);
    body.writeBigUInt64LE(1_000_000_000n, 40);
    permanentMiningId.toBuffer().copy(body, 88);

    expect(decodeSatMinerCapital(data, "capital-v2")).toMatchObject({
      version: 2,
      authority: authority.toBase58(),
      permanentMiningId: permanentMiningId.toBase58(),
    });
  });

  it("decodes miner cycle authority as base58", () => {
    const authority = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9"); // pragma: allowlist secret
    const buffer = Buffer.concat([
      Buffer.from([132, 0, 0, 0, 0, 0, 0, 0]),
      encodeU128(1_100_000n),
      encodeU128(1_000_000n),
      encodeU128(100_000n),
      encodeU128(1_250_000n),
      authority.toBuffer(),
      encodeU64(9862902),
      encodeU64(500_000_000),
      encodeI64(1_775_000_000),
      encodeU64(900_000),
      Buffer.alloc(8 * 6),
      Buffer.from([1, 0]),
      Buffer.alloc(6),
      Buffer.alloc(26 * 4),
    ]);

    expect(decodeSatMinerCycle(buffer, "miner-cycle-address")).toMatchObject({
      address: "miner-cycle-address",
      authority: authority.toBase58(),
      cycleId: 9862902,
      committedLamports: "500000000",
      submissionTs: 1775000000,
      powerWeightFp: "900000",
      placementReturnFp: "1100000",
      benchmarkReturnFp: "1000000",
      skillScoreFp: "100000",
      rewardWeightFp: "1250000",
      validParticipation: true,
      capitalLockReleased: false,
    });
  });

  it("decodes generation-2 miner authority and split rewards", () => {
    const authority = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9"); // pragma: allowlist secret
    const permanentMiningId = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2"); // pragma: allowlist secret
    const data = Buffer.alloc(416);
    data[0] = 150;
    const body = data.subarray(8);
    body.writeBigUInt64LE(1_100_000n, 0);
    body.writeBigUInt64LE(1_000_000n, 16);
    body.writeBigUInt64LE(100_000n, 32);
    body.writeBigUInt64LE(1_250_000n, 48);
    authority.toBuffer().copy(body, 64);
    permanentMiningId.toBuffer().copy(body, 96);
    body.writeBigUInt64LE(99n, 128);
    body.writeBigUInt64LE(1_000_000_000n, 136);
    body.writeBigUInt64LE(30n, 160);
    body.writeBigUInt64LE(20n, 168);
    body.writeBigUInt64LE(10n, 176);
    body.writeBigUInt64LE(5n, 184);
    body.writeBigUInt64LE(3n, 192);
    body.writeBigUInt64LE(2n, 200);
    body.writeBigUInt64LE(1n, 208);
    body.writeBigUInt64LE(1n, 216);
    body[224] = 1;
    body.writeBigUInt64LE(900_000_000n, 280);

    expect(decodeSatMinerCycleV2(data, "miner-v2")).toMatchObject({
      address: "miner-v2",
      authority: authority.toBase58(),
      permanentMiningId: permanentMiningId.toBase58(),
      cycleId: 99,
      committedLamports: "1000000000",
      claimableSatRaw: "50",
      claimableDetRebateLamports: "10",
      claimablePerfRebateLamports: "5",
      claimedSatRaw: "5",
      claimedDetRebateLamports: "1",
      claimedPerfRebateLamports: "1",
      validParticipation: true,
      lockedCollateralLamports: "900000000",
    });
  });

  it("decodes registry page participants as base58", () => {
    const participantA = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2"); // pragma: allowlist secret
    const participantB = new PublicKey("AfHgXjQ4E26hU3hq835ipbteeEXVgxm5ZMfUqdHqFBSt"); // pragma: allowlist secret
    const buffer = Buffer.concat([
      Buffer.from([135, 0, 0, 0, 0, 0, 0, 0]),
      encodeU64(9862902),
      Buffer.from([0, 0]),
      Buffer.from([2, 0]),
      Buffer.alloc(4),
      participantA.toBuffer(),
      participantB.toBuffer(),
      Buffer.alloc((64 - 2) * 32),
    ]);

    expect(decodeSatCycleRegistryPage(buffer, "registry-page-address")).toMatchObject({
      address: "registry-page-address",
      cycleId: 9862902,
      pageIndex: 0,
      participantCount: 2,
      participants: [participantA.toBase58(), participantB.toBase58()],
    });
  });
});

describe("decodeSatGlobalState", () => {
  it("reads issuance and unlock fields from the current SAT global layout", () => {
    const buffer = Buffer.concat([
      Buffer.from([130, 0, 0, 0, 0, 0, 0, 0]),
      encodeU64(2),
      Buffer.alloc(32),
      Buffer.alloc(32),
      encodeU64(420_000_000_000_000_000),
      encodeU64(1),
      encodeU64(84_000_000_000_000_000),
      encodeU64(1_234_567_890_000),
      encodeU64(5_000_000_000),
      encodeU64(2_500_000_000),
      encodeU64(25_000_000_000),
      encodeU64(6_400_000_000),
      encodeU64(5918079),
      encodeU64(300),
      encodeU64(250_000_000),
      encodeU64(5_920_000),
      encodeU64(1_234_567_890_000),
      encodeU64(4_000_000),
      encodeU64(50),
      Buffer.alloc(64),
    ]);

    expect(decodeSatGlobalState(buffer, "global-address")).toMatchObject({
      address: "global-address",
      version: 2,
      hardCapSatRaw: "420000000000000000",
      issuanceYearIndex: 1,
      yearBudgetSatRaw: "84000000000000000",
      yearIssuedSatRaw: "1234567890000",
      currentUnlockSolLamports: "6400000000",
      cycleSeconds: 300,
      minimumEntryLamports: "250000000",
      launchCycleId: "5920000",
      totalIssuedSatRaw: "1234567890000",
      cycleErosionPpm: 50,
    });
  });
});

describe("decodeSatBondPosition", () => {
  it("reads the canonical SAT bond position layout", () => {
    const authority = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9"); // pragma: allowlist secret
    const mint = new PublicKey("2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"); // pragma: allowlist secret
    const bondVault = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2"); // pragma: allowlist secret
    const bondPosition = new PublicKey("AfHgXjQ4E26hU3hq835ipbteeEXVgxm5ZMfUqdHqFBSt"); // pragma: allowlist secret
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"; // pragma: allowlist secret
    process.env.FASED_SAT_BOND_PROGRAM_ID = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_ADDRESS = mint.toBase58();
    process.env.FASED_SAT_MINT_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // pragma: allowlist secret
    const buffer = Buffer.concat([
      Buffer.from([140, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([1, 1, 2, 7, 1, 0, 0, 0]),
      authority.toBuffer(),
      mint.toBuffer(),
      bondVault.toBuffer(),
      encodeU64(10_000_000_000_000),
      encodeU64(123),
      encodeU64(456),
      encodeU64(789),
      encodeU64(999),
      Buffer.alloc(8 * 5),
    ]);

    expect(decodeSatBondPosition(buffer, bondPosition.toBase58())).toMatchObject({
      address: bondPosition.toBase58(),
      authority: authority.toBase58(),
      bondMint: mint.toBase58(),
      bondVault: bondVault.toBase58(),
      amountRaw: "10000000000000",
      bump: 7,
      policyVersion: 1,
      tier: 2,
      tierLabel: "operator-bond",
      status: 1,
      statusLabel: "active",
      createdAtSlot: 123,
      updatedAtSlot: 456,
      unlockRequestedAtSlot: 789,
      unlockAvailableAtSlot: 999,
      mintMatchesRuntime: true,
    });
  });
});

describe("secondary read rpc fallback", () => {
  it("decodes a confirmed signer-owned address lookup table", async () => {
    const methods: string[] = [];
    const authority = new PublicKey("8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW"); // pragma: allowlist secret
    const entry = new PublicKey("So11111111111111111111111111111111111111112"); // pragma: allowlist secret
    const data = Buffer.alloc(88);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(18_446_744_073_709_551_615n, 4);
    data.writeBigUInt64LE(100n, 12);
    data[20] = 0;
    data[21] = 1;
    authority.toBuffer().copy(data, 22);
    entry.toBuffer().copy(data, 56);
    const rpcUrl = await startRpcServer((payload) => {
      methods.push(String(payload.method ?? ""));
      if (payload.method === "getAccountInfo") {
        return {
          result: {
            context: { slot: 101 },
            value: {
              data: [data.toString("base64"), "base64"],
              executable: false,
              lamports: 1,
              owner: "AddressLookupTab1e1111111111111111111111111", // pragma: allowlist secret
              rentEpoch: 0,
              space: data.length,
            },
          },
        };
      }
      return { error: { message: `unexpected ${payload.method}` } };
    });
    configureReadRpc(rpcUrl);
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"; // pragma: allowlist secret
    process.env.FASED_SAT_BOND_PROGRAM_ID = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // pragma: allowlist secret

    const result = await inspectSatAddressLookupTable({ network: "devnet" } as never, {
      address: "4c8wadNoNVAJMpJtQnUAYbJgdE1YyfTpwBCNak1hBuPB", // pragma: allowlist secret
    });
    expect(methods).toEqual(["getAccountInfo"]);
    expect(result).toEqual({
      address: "4c8wadNoNVAJMpJtQnUAYbJgdE1YyfTpwBCNak1hBuPB", // pragma: allowlist secret
      authority: authority.toBase58(),
      addresses: [entry.toBase58()],
      active: true,
      lastExtendedSlot: 100,
    });
  });

  it("resolves Solana public fallbacks for configured networks", () => {
    expect(
      resolveDefaultSolanaPublicReadFallbackUrl({
        network: "devnet",
        primaryUrl: "https://devnet.helius-rpc.com/?api-key=test",
      }),
    ).toBe("https://api.devnet.solana.com");
    expect(
      resolveDefaultSolanaPublicReadFallbackUrl({
        network: "mainnet-beta",
        primaryUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      }),
    ).toBe("https://api.mainnet-beta.solana.com");
    expect(
      resolveDefaultSolanaPublicReadFallbackUrl({
        network: "devnet",
        primaryUrl: "https://api.devnet.solana.com",
      }),
    ).toBe("");
  });

  it("uses the fallback read RPC for chain time when the primary endpoint fails", async () => {
    const primaryUrl = await startRpcServer(() => ({
      statusCode: 503,
      body: "primary unavailable",
    }));
    const fallbackUrl = await startRpcServer((payload) => {
      if (payload.method === "getSlot") {
        return { result: 123 };
      }
      if (payload.method === "getBlockTime") {
        return { result: 1_775_487_000 };
      }
      return { error: { message: `unexpected ${payload.method}` } };
    });
    configureReadRpc(primaryUrl, fallbackUrl);

    await expect(inspectSatChainUnixTime({} as never)).resolves.toBe(1_775_487_000);
  });

  it("uses the fallback read RPC for connection-backed reads", async () => {
    const primaryGetAccountInfo = vi.fn(async (..._args: unknown[]) => {
      throw new Error("primary down");
    });
    const fallbackGetAccountInfo = vi.fn(async (..._args: unknown[]) => ({
      owner: { toBase58: () => "owner-address" },
      data: Buffer.alloc(0),
    }));

    class FakeConnection {
      rpcEndpoint: string;

      constructor(rpcEndpoint: string) {
        this.rpcEndpoint = rpcEndpoint;
      }

      getAccountInfo = (...args: unknown[]) =>
        this.rpcEndpoint === "http://primary.invalid"
          ? primaryGetAccountInfo(...args)
          : fallbackGetAccountInfo(...args);

      getProgramAccounts = vi.fn();

      getMinimumBalanceForRentExemption = vi.fn();
    }

    const connection = createReadConnection(
      {
        Connection: FakeConnection,
      } as never,
      {
        primaryUrl: "http://primary.invalid",
        secondaryUrl: "http://fallback.invalid",
      },
    );

    const result = await connection.getAccountInfo(
      "account-address" as never,
      "confirmed" as never,
    );
    expect(result).toMatchObject({
      owner: { toBase58: expect.any(Function) },
    });
    expect(primaryGetAccountInfo).toHaveBeenCalledTimes(1);
    expect(fallbackGetAccountInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps primary quota backoff through fallback success and restores it after a successful probe", async () => {
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const primaryGetAccountInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValue({
        owner: { toBase58: () => "owner-address" },
        data: Buffer.alloc(0),
      });
    const fallbackGetAccountInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error("fallback temporarily unavailable"))
      .mockResolvedValue({
        owner: { toBase58: () => "owner-address" },
        data: Buffer.alloc(0),
      });

    class FakeConnection {
      rpcEndpoint: string;

      constructor(rpcEndpoint: string) {
        this.rpcEndpoint = rpcEndpoint;
      }

      getAccountInfo = (...args: unknown[]) =>
        this.rpcEndpoint === "http://primary-quota.invalid"
          ? primaryGetAccountInfo(...args)
          : fallbackGetAccountInfo(...args);

      getProgramAccounts = vi.fn();

      getMinimumBalanceForRentExemption = vi.fn();
    }

    const connection = createReadConnection(
      {
        Connection: FakeConnection,
      } as never,
      {
        primaryUrl: "http://primary-quota.invalid",
        secondaryUrl: "http://fallback-quota.invalid",
      },
    );

    await expect(
      connection.getAccountInfo("account-address" as never, "confirmed" as never),
    ).rejects.toThrow("fallback temporarily unavailable");

    const result = await connection.getAccountInfo(
      "account-address" as never,
      "confirmed" as never,
    );

    expect(result).toMatchObject({
      owner: { toBase58: expect.any(Function) },
    });
    await expect(
      connection.getAccountInfo("account-address" as never, "confirmed" as never),
    ).resolves.toMatchObject({ owner: { toBase58: expect.any(Function) } });

    expect(primaryGetAccountInfo).toHaveBeenCalledTimes(1);
    expect(fallbackGetAccountInfo).toHaveBeenCalledTimes(3);

    nowMs += 30_001;
    await expect(
      connection.getAccountInfo("account-address" as never, "confirmed" as never),
    ).resolves.toMatchObject({ owner: { toBase58: expect.any(Function) } });
    await expect(
      connection.getAccountInfo("account-address" as never, "confirmed" as never),
    ).resolves.toMatchObject({ owner: { toBase58: expect.any(Function) } });

    expect(primaryGetAccountInfo).toHaveBeenCalledTimes(3);
    expect(fallbackGetAccountInfo).toHaveBeenCalledTimes(3);
  });

  it("aborts a hung raw JSON-RPC request and falls back within the configured timeout", async () => {
    const primaryRequests: string[] = [];
    const fallbackRequests: string[] = [];
    const primaryUrl = await startRpcServer((payload) => {
      primaryRequests.push(String(payload.method ?? ""));
      return { hang: true };
    });
    const fallbackUrl = await startRpcServer((payload) => {
      fallbackRequests.push(String(payload.method ?? ""));
      if (payload.method === "getSlot") {
        return { result: 123 };
      }
      if (payload.method === "getBlockTime") {
        return { result: 1_775_487_000 };
      }
      return { error: { message: `unexpected ${payload.method}` } };
    });
    process.env.FASED_SAT_RPC_REQUEST_TIMEOUT_MS = "50";
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"; // pragma: allowlist secret
    process.env.FASED_SAT_BOND_PROGRAM_ID = "8RYKuGb2k8hBcGX34QdYJXdXZkNvD3fKy85s63Pph2j7"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_PROGRAM_ID = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C"; // pragma: allowlist secret
    configureReadRpc(`${primaryUrl}?api-key=raw-timeout-secret`, fallbackUrl);

    const startedAt = Date.now();
    await expect(inspectSatChainUnixTime({} as never)).resolves.toBe(1_775_487_000);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(primaryRequests).toEqual(["getSlot", "getBlockTime"]);
    expect(fallbackRequests).toEqual(["getSlot", "getBlockTime"]);
    expect(JSON.stringify(inspectSatConnectionDetails())).not.toContain("raw-timeout-secret");
  });

  it("falls back once after a connection reset and records bounded request counts", async () => {
    const primaryRequests: string[] = [];
    const fallbackRequests: string[] = [];
    const primaryUrl = await startRpcServer((payload) => {
      primaryRequests.push(String(payload.method ?? ""));
      if (primaryRequests.length === 1) {
        return { reset: true };
      }
      return { result: 1_775_487_000 };
    });
    const fallbackUrl = await startRpcServer((payload) => {
      fallbackRequests.push(String(payload.method ?? ""));
      return { result: 123 };
    });
    configureReadRpc(primaryUrl, fallbackUrl);

    await expect(inspectSatChainUnixTime({} as never)).resolves.toBe(1_775_487_000);
    expect(primaryRequests).toEqual(["getSlot", "getBlockTime"]);
    expect(fallbackRequests).toEqual(["getSlot"]);
  });

  it("falls back once after malformed JSON and records bounded request counts", async () => {
    const primaryRequests: string[] = [];
    const fallbackRequests: string[] = [];
    const primaryUrl = await startRpcServer((payload) => {
      primaryRequests.push(String(payload.method ?? ""));
      if (primaryRequests.length === 1) {
        return { body: "{" };
      }
      return { result: 1_775_487_000 };
    });
    const fallbackUrl = await startRpcServer((payload) => {
      fallbackRequests.push(String(payload.method ?? ""));
      return { result: 123 };
    });
    configureReadRpc(primaryUrl, fallbackUrl);

    await expect(inspectSatChainUnixTime({} as never)).resolves.toBe(1_775_487_000);
    expect(primaryRequests).toEqual(["getSlot", "getBlockTime"]);
    expect(fallbackRequests).toEqual(["getSlot"]);
  });

  it("rejects an oversized response, falls back once, and records bounded request counts", async () => {
    const primaryRequests: string[] = [];
    const fallbackRequests: string[] = [];
    const primaryUrl = await startRpcServer((payload) => {
      primaryRequests.push(String(payload.method ?? ""));
      if (primaryRequests.length === 1) {
        return { body: "x".repeat(16 * 1024 * 1024 + 1) };
      }
      return { result: 1_775_487_000 };
    });
    const fallbackUrl = await startRpcServer((payload) => {
      fallbackRequests.push(String(payload.method ?? ""));
      return { result: 123 };
    });
    configureReadRpc(primaryUrl, fallbackUrl);

    await expect(inspectSatChainUnixTime({} as never)).resolves.toBe(1_775_487_000);
    expect(primaryRequests).toEqual(["getSlot", "getBlockTime"]);
    expect(fallbackRequests).toEqual(["getSlot"]);
  });

  it("aborts a hung web3 read and falls back without waiting for the abandoned fetch", async () => {
    const primaryUrl = "http://127.0.0.1:19001/rpc";
    const fallbackUrl = "http://127.0.0.1:19002/rpc";
    let primaryAborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === fallbackUrl) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 456 }), {
          headers: { "content-type": "application/json" },
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => {
          primaryAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (init?.signal?.aborted) {
          rejectAborted();
          return;
        }
        init?.signal?.addEventListener("abort", rejectAborted, { once: true });
      });
    });
    process.env.FASED_SAT_RPC_REQUEST_TIMEOUT_MS = "50";
    const connection = createReadConnection({ Connection: FetchBackedConnection } as never, {
      primaryUrl,
      secondaryUrl: fallbackUrl,
    });

    const startedAt = Date.now();
    await expect(connection.getMinimumBalanceForRentExemption(0)).resolves.toBe(456);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await vi.waitFor(() => expect(primaryAborted).toBe(true), { timeout: 1_000 });
  });

  it("redacts credentials from a timed-out web3 read", async () => {
    const rpcUrl = "http://127.0.0.1:19001/rpc?api-key=timeout-secret";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const rejectAborted = () => reject(new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted) {
            rejectAborted();
            return;
          }
          init?.signal?.addEventListener("abort", rejectAborted, { once: true });
        }),
    );
    process.env.FASED_SAT_RPC_REQUEST_TIMEOUT_MS = "50";
    const connection = createReadConnection({ Connection: FetchBackedConnection } as never, {
      primaryUrl: rpcUrl,
      secondaryUrl: null,
    });

    const error = await connection.getMinimumBalanceForRentExemption(0).catch((caught) => caught);
    expect(String(error)).toContain("api-key=***");
    expect(String(error)).not.toContain("timeout-secret");
  });

  it("caches missing account reads so absent cycle PDAs do not poll every refresh", async () => {
    const calls: string[] = [];
    const rpcUrl = await startRpcServer((payload) => {
      calls.push(String(payload.method ?? ""));
      if (payload.method === "getAccountInfo") {
        return { result: { value: null } };
      }
      return { error: { message: `unexpected ${payload.method}` } };
    });
    configureReadRpc(rpcUrl);
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"; // pragma: allowlist secret
    process.env.FASED_SAT_BOND_PROGRAM_ID = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"; // pragma: allowlist secret
    process.env.FASED_SAT_MINT_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // pragma: allowlist secret

    await expect(
      inspectSatCycleAccountExists({ network: "devnet" } as never, { cycleId: 123 }),
    ).resolves.toBe(false);
    await expect(
      inspectSatCycleAccountExists({ network: "devnet" } as never, { cycleId: 123 }),
    ).resolves.toBe(false);

    expect(calls.filter((method) => method === "getAccountInfo")).toHaveLength(1);
  });

  it("batches miner-cycle address reads and seeds decoded per-address cache", async () => {
    const authorityA = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9"); // pragma: allowlist secret
    const authorityB = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2"); // pragma: allowlist secret
    const minerCycleA = "AfHgXjQ4E26hU3hq835ipbteeEXVgxm5ZMfUqdHqFBSt"; // pragma: allowlist secret
    const minerCycleB = "9VxFj9AFGoqyPG2L9Rk84cDs82geZDV36h4udJ2Brph"; // pragma: allowlist secret
    const accounts = new Map<string, string>([
      [minerCycleA, encodeMinerCycleAccount(authorityA, 5932940)],
      [minerCycleB, encodeMinerCycleAccount(authorityB, 5932940)],
    ]);
    const calls: string[] = [];
    const rpcUrl = await startRpcServer((payload) => {
      calls.push(String(payload.method ?? ""));
      if (payload.method === "getMultipleAccounts") {
        const addresses = Array.isArray(payload.params?.[0])
          ? (payload.params?.[0] as string[])
          : [];
        return {
          result: {
            value: addresses.map((address) => {
              const encoded = accounts.get(address);
              return encoded ? { owner: "sat-program", data: [encoded, "base64"] } : null;
            }),
          },
        };
      }
      return { error: { message: `unexpected ${payload.method}` } };
    });
    configureReadRpc(rpcUrl);

    const views = await inspectSatMinerCyclesByAddress({ network: "devnet" } as never, {
      addresses: [minerCycleA, minerCycleB, minerCycleA],
    });

    expect(views.map((view) => view?.authority)).toEqual([
      authorityA.toBase58(),
      authorityB.toBase58(),
      authorityA.toBase58(),
    ]);
    await expect(
      inspectSatMinerCycleByAddress({ network: "devnet" } as never, { address: minerCycleA }),
    ).resolves.toMatchObject({
      authority: authorityA.toBase58(),
      cycleId: 5932940,
    });
    expect(calls.filter((method) => method === "getMultipleAccounts")).toHaveLength(1);
    expect(calls.filter((method) => method === "getAccountInfo")).toHaveLength(0);
  });
});
