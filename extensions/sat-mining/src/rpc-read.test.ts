import http from "node:http";
import type { AddressInfo } from "node:net";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReadConnection,
  decodeSatBondPosition,
  decodeSatRoundBucket,
  decodeSatCycleRegistryPage,
  decodeSatGlobalState,
  decodeSatMinerCycle,
  inspectSatCycleAccountExists,
  inspectSatChainUnixTime,
  inspectSatMinerCycleByAddress,
  inspectSatMinerCyclesByAddress,
  invalidateSatReadCaches,
  resolveDefaultSolanaPublicReadFallbackUrl,
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
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startRpcServer(
  handler: (payload: { method?: string; params?: unknown[] }) => {
    statusCode?: number;
    body?: string;
    result?: unknown;
    error?: { message?: string };
  },
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        method?: string;
        params?: unknown[];
      };
      const response = handler(payload);
      res.statusCode = response.statusCode ?? 200;
      if (response.body != null) {
        res.end(response.body);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
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

function configureReadRpc(primaryUrl: string, fallbackUrl?: string) {
  process.env.FASED_WALLET_SOLANA_READ_RPC_URL = primaryUrl;
  if (fallbackUrl) {
    process.env.FASED_WALLET_SOLANA_READ_RPC_FALLBACK_URL = fallbackUrl;
  }
}

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
  it("decodes miner cycle authority as base58", () => {
    const authority = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9");
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

  it("decodes registry page participants as base58", () => {
    const participantA = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2");
    const participantB = new PublicKey("AfHgXjQ4E26hU3hq835ipbteeEXVgxm5ZMfUqdHqFBSt");
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
    const authority = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9");
    const mint = new PublicKey("2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa");
    const bondVault = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2");
    const bondPosition = new PublicKey("AfHgXjQ4E26hU3hq835ipbteeEXVgxm5ZMfUqdHqFBSt");
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
    process.env.FASED_SAT_BOND_PROGRAM_ID = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq";
    process.env.FASED_SAT_MINT_ADDRESS = mint.toBase58();
    process.env.FASED_SAT_MINT_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
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

  it("skips the primary endpoint during quota backoff when a fallback endpoint exists", async () => {
    const primaryGetAccountInfo = vi.fn(async (..._args: unknown[]) => {
      throw new Error("429 Too Many Requests");
    });
    const fallbackGetAccountInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error("fallback temporarily unavailable"))
      .mockResolvedValueOnce({
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
    expect(primaryGetAccountInfo).toHaveBeenCalledTimes(1);
    expect(fallbackGetAccountInfo).toHaveBeenCalledTimes(2);
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
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";

    await expect(
      inspectSatCycleAccountExists({ network: "devnet" } as never, { cycleId: 123 }),
    ).resolves.toBe(false);
    await expect(
      inspectSatCycleAccountExists({ network: "devnet" } as never, { cycleId: 123 }),
    ).resolves.toBe(false);

    expect(calls.filter((method) => method === "getAccountInfo")).toHaveLength(1);
  });

  it("batches miner-cycle address reads and seeds decoded per-address cache", async () => {
    const authorityA = new PublicKey("Cow9a67QyCQ1kpJRcq4cc8PDvfiosom7iu9A8U6W52T9");
    const authorityB = new PublicKey("8LvCPwWWBjdQpMX8wZYu2LAvjZmy3t8QKc6yR1Q2MJp2");
    const minerCycleA = "AfHgXjQ4E26hU3hq835ipbteeEXVgxm5ZMfUqdHqFBSt";
    const minerCycleB = "9VxFj9AFGoqyPG2L9Rk84cDs82geZDV36h4udJ2Brph";
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
