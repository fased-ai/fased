import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNER_PROTOCOL_V2 } from "../signer-protocol-v2.generated.js";
import {
  assertSecureLocalSignerSocket,
  callLocalSocketSigner,
  LocalSocketSignerAdapter,
  probeLocalSocketSignerHealth,
  requireLocalSocketSignerPath,
} from "./local-socket-signer-adapter.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
});

describe("requireLocalSocketSignerPath", () => {
  it("returns explicit signer socket when configured", () => {
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/tmp/fased-wallet.sock");
    expect(requireLocalSocketSignerPath(process.env)).toBe("/tmp/fased-wallet.sock");
  });

  it("falls back to wallet state dir socket when env var is absent", () => {
    vi.stubEnv("FASED_STATE_DIR", "/tmp/fased-state");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    expect(requireLocalSocketSignerPath(process.env)).toBe(
      path.join("/tmp/fased-state", "wallet", "local-signer.sock"),
    );
  });
});

async function createSocketDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

async function createSignerServer(params: {
  prefix: string;
  handle: (request: Record<string, unknown>) => unknown;
}): Promise<{
  socketPath: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const dir = await createSocketDir(params.prefix);
  const socketPath = path.join(dir, "signer.sock");
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      socket.end(`${JSON.stringify({ ok: true, result: params.handle(request) })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o660);
  return {
    socketPath,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("callLocalSocketSigner", () => {
  it.each(["operator.sock", "control.sock", "local-signer-control.sock"])(
    "refuses the privileged signer socket %s",
    async (socketName) => {
      await expect(
        callLocalSocketSigner(path.join("/run/fased-signerd", socketName), { op: "health" }),
      ).rejects.toThrow(/typed native signer client/);
    },
  );

  it("refuses a custom lifecycle socket named through protected configuration", async () => {
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_OPERATOR_SOCKET", "/tmp/fased/custom-admin.sock");
    await expect(
      callLocalSocketSigner("/tmp/fased/custom-admin.sock", { op: "health" }),
    ).rejects.toThrow(/typed native signer client/);
  });

  it("preserves only sanitized signer credential readiness in health", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-sanitized-health-",
      handle: () => ({
        details: "fased-signerd protocol-v2 ready",
        release: {
          version: "dev",
          commit: "unknown",
          buildInputDigest: "unknown",
          development: true,
        },
        webAuthn: {
          configured: true,
          credentialCount: 2,
          credentialVersion: 7,
          ready: true,
        },
        jupiter: { triggerConfigured: true, liveEnabled: false },
        state: {
          databaseBytes: 4096,
          wallets: 1,
          operations: 80_000,
          reviews: 0,
          triggerWorkflows: 0,
          dailyUsageBuckets: 1,
          capacityWarnings: ["operations signer state is at 80000/100000 records"],
        },
      }),
    });
    try {
      const health = await probeLocalSocketSignerHealth(signer.socketPath);
      expect(health).toMatchObject({
        ok: true,
        webAuthn: { credentialCount: 2, credentialVersion: 7, ready: true },
        jupiter: { triggerConfigured: true, liveEnabled: false },
      });
      expect(JSON.stringify(health)).not.toMatch(/api.?key|jwt|secret|\.key/iu);

      const providerHealth = await new LocalSocketSignerAdapter(signer.socketPath).health();
      expect(providerHealth.nativeSignerApproval).toEqual({
        configured: true,
        credentialCount: 2,
        credentialVersion: 7,
        ready: true,
      });
      expect(providerHealth.details).toContain("jupiter-trigger=configured");
      expect(providerHealth.details).toContain("jupiter-live=preview-only");
      expect(providerHealth.details).toContain("80000/100000");
    } finally {
      await signer.close();
    }
  });

  it("times out bounded signer calls", async () => {
    const dir = await createSocketDir("fased-signer-timeout-");
    const socketPath = path.join(dir, "signer.sock");
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        callLocalSocketSigner(socketPath, { op: "health" }, { timeoutMs: 25 }),
      ).rejects.toThrow(/timeout/);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects oversized signer responses", async () => {
    const dir = await createSocketDir("fased-signer-response-cap-");
    const socketPath = path.join(dir, "signer.sock");
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => {
        socket.end(`${JSON.stringify({ ok: true, result: { details: "x".repeat(128) } })}\n`);
      });
    });
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        callLocalSocketSigner(socketPath, { op: "health" }, { maxResponseBytes: 16 }),
      ).rejects.toThrow(/response exceeds 16 bytes/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("assertSecureLocalSignerSocket", () => {
  it("rejects world-accessible signer sockets before risky calls", async () => {
    const dir = await createSocketDir("fased-signer-socket-mode-");
    const socketPath = path.join(dir, "signer.sock");
    const server = net.createServer();
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await chmod(socketPath, 0o777);
      expect(() => assertSecureLocalSignerSocket(socketPath)).toThrow(/world-accessible/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("LocalSocketSignerAdapter protocol-v2 sends", () => {
  const policyHash = `sha256:${"a".repeat(64)}`;
  const capabilities = {
    details: "fased-signerd protocol-v2 ready",
    readOnly: false,
    keystoreType: "signer-owned-v2",
    chains: ["solana"] as const,
    ready: true,
    release: {
      version: "dev",
      commit: "unknown",
      buildInputDigest: "unknown",
      development: true,
    },
    capabilities: {
      protocol: SIGNER_PROTOCOL_V2.protocol,
      nativeFeeReservationLamports: SIGNER_PROTOCOL_V2.nativeFeeReservationLamports,
      intentTypes: [...SIGNER_PROTOCOL_V2.intentTypes],
      operationStates: [...SIGNER_PROTOCOL_V2.operationStates],
      features: [...SIGNER_PROTOCOL_V2.features],
    },
    policies: [],
  };
  const wallet = {
    walletId: "agent-wallet",
    publicKey: "Signer111111111111111111111111111111111",
    version: 1,
    createdAt: "2026-07-16T11:00:00.000Z",
  };
  const policy = {
    walletId: "agent-wallet",
    role: "agent" as const,
    version: 4,
    operations: ["solana.nativeTransfer"],
    programs: ["11111111111111111111111111111111"],
    assets: [
      {
        asset: "SOL",
        destinations: ["Destination11111111111111111111111111111"],
        maxPerTx: "1000",
        maxDaily: "5000",
      },
    ],
    hash: policyHash,
  };

  it("reads the exact wallet balance through signer-owned RPC without Gateway fetch", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-balance-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        if (request.op === "getBalance") {
          return {
            ok: true,
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            balance: "4242",
            unit: "lamports",
          };
        }
        throw new Error(`unexpected op=${String(request.op)}`);
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        rpcUrl: "https://gateway-rpc-must-not-be-used.invalid",
        scopedWalletId: "mining",
      });
      await expect(adapter.getBalance("solana")).resolves.toEqual({
        ok: true,
        chain: "solana",
        address: "So11111111111111111111111111111111111111112",
        balance: "4242",
        unit: "lamports",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(signer.requests).toEqual([
        { op: "v2.capabilities" },
        { op: "getBalance", chain: "solana", walletId: "mining" },
      ]);
    } finally {
      fetchSpy.mockRestore();
      await signer.close();
    }
  });

  it("rejects unscoped or malformed signer-owned balance reads", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-invalid-balance-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        return {
          ok: true,
          chain: "solana",
          address: wallet.publicKey,
          balance: "-1",
          unit: "lamports",
        };
      },
    });
    try {
      const unscoped = new LocalSocketSignerAdapter(signer.socketPath);
      await expect(unscoped.getBalance("solana")).rejects.toMatchObject({
        code: "wallet_provider_invalid_config",
      });
      expect(signer.requests).toHaveLength(0);

      const scoped = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      await expect(scoped.getBalance("solana")).rejects.toThrow(
        "invalid local socket signer result for op=getBalance",
      );
      expect(signer.requests.map((request) => request.op)).toEqual([
        "v2.capabilities",
        "getBalance",
      ]);
    } finally {
      await signer.close();
    }
  });

  it("acknowledges only the exact next durable signer policy version and hash", async () => {
    const nextPolicy = {
      ...policy,
      version: 5,
      assets: policy.assets.map((asset) => ({
        ...asset,
        maxPerTx: "500",
        maxDaily: "2500",
      })),
      hash: `sha256:${"b".repeat(64)}`,
    };
    let durablePolicy = policy;
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-policy-tighten-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        if (request.op === "v2.policy.get") {
          return durablePolicy;
        }
        if (request.op === "v2.policy.tighten") {
          expect(request).toEqual({
            op: "v2.policy.tighten",
            walletId: "agent-wallet",
            request: {
              expectedVersion: 4,
              policy: expect.objectContaining({
                walletId: "agent-wallet",
                role: "agent",
                assets: [expect.objectContaining({ maxPerTx: "500", maxDaily: "2500" })],
              }),
            },
          });
          durablePolicy = nextPolicy;
          return nextPolicy;
        }
        throw new Error(`unexpected op ${String(request.op)}`);
      },
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath);
      const current = await adapter.getSignerPolicy("agent-wallet");
      const acknowledged = await adapter.tightenSignerPolicy({
        walletId: "agent-wallet",
        expectedVersion: current.version,
        policy: {
          ...current,
          assets: current.assets.map((asset) => ({
            ...asset,
            maxPerTx: "500",
            maxDaily: "2500",
          })),
        },
      });
      expect(acknowledged).toEqual(nextPolicy);
      expect(signer.requests.map((request) => request.op)).toEqual([
        "v2.capabilities",
        "v2.policy.get",
        "v2.capabilities",
        "v2.policy.tighten",
        "v2.policy.get",
      ]);
    } finally {
      await signer.close();
    }
  });

  it("sends a typed native transfer with the stable request id and exact policy hash", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-send-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        if (request.op === "v2.wallet.get") {
          return wallet;
        }
        if (request.op === "v2.policy.get") {
          return policy;
        }
        if (request.op === "v2.execute") {
          return {
            requestId: "request-123",
            walletId: "agent-wallet",
            intentType: "solana.nativeTransfer",
            intentDigest: "sha256:intent",
            transactionDigest: "sha256:transaction",
            policyHash,
            asset: "SOL",
            amount: "900",
            state: "confirmed",
            reservationActive: false,
            usageBucket: "2026-07-16:SOL",
            reservedAt: "2026-07-16T12:00:00.000Z",
            broadcastAt: "2026-07-16T12:00:01.000Z",
            confirmedAt: "2026-07-16T12:00:02.000Z",
            updatedAt: "2026-07-16T12:00:02.000Z",
            signature: "solana-signature",
          };
        }
        throw new Error(`unexpected op=${String(request.op)}`);
      },
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      const result = await adapter.sendTx({
        chain: "solana",
        requestId: "request-123",
        walletId: "agent-wallet",
        to: "Destination11111111111111111111111111111",
        amount: "900",
      });

      expect(result.txHash).toBe("solana-signature");
      expect(result.metadata).toMatchObject({
        requestId: "request-123",
        policyHash,
        operationState: "confirmed",
      });
      expect(signer.requests).toEqual([
        { op: "v2.capabilities" },
        { op: "v2.wallet.get", walletId: "agent-wallet" },
        { op: "v2.policy.get", walletId: "agent-wallet" },
        {
          op: "v2.execute",
          walletId: "agent-wallet",
          request: {
            requestId: "request-123",
            policyHash,
            intent: {
              type: "solana.nativeTransfer",
              destination: "Destination11111111111111111111111111111",
              lamports: "900",
            },
          },
        },
      ]);
    } finally {
      await signer.close();
    }
  });

  it.each(["broadcast", "unknown"] as const)(
    "fails closed without retry when the signer reports %s",
    async (state) => {
      const signer = await createSignerServer({
        prefix: `fased-signer-v2-${state}-`,
        handle: (request) => {
          if (request.op === "v2.capabilities") {
            return capabilities;
          }
          if (request.op === "v2.wallet.get") {
            return wallet;
          }
          if (request.op === "v2.policy.get") {
            return policy;
          }
          return {
            requestId: "request-ambiguous",
            walletId: "agent-wallet",
            intentType: "solana.nativeTransfer",
            intentDigest: "sha256:intent",
            transactionDigest: "sha256:transaction",
            policyHash,
            asset: "SOL",
            amount: "900",
            state,
            reservationActive: true,
            usageBucket: "2026-07-16:SOL",
            reservedAt: "2026-07-16T12:00:00.000Z",
            updatedAt: "2026-07-16T12:00:02.000Z",
            signature: "possibly-broadcast-signature",
          };
        },
      });
      try {
        const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
          scopedWalletId: "agent-wallet",
        });
        await expect(
          adapter.sendTx({
            chain: "solana",
            requestId: "request-ambiguous",
            to: "Destination11111111111111111111111111111",
            amount: "900",
          }),
        ).rejects.toMatchObject({ code: "wallet_provider_ambiguous", retryable: false });
        expect(signer.requests.map((request) => request.op)).toEqual([
          "v2.capabilities",
          "v2.wallet.get",
          "v2.policy.get",
          "v2.execute",
        ]);
      } finally {
        await signer.close();
      }
    },
  );

  it("rejects missing idempotency and exposes no raw prepare/sign surface", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-reject-",
      handle: () => capabilities,
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      await expect(
        adapter.sendTx({
          chain: "solana",
          to: "Destination11111111111111111111111111111",
          amount: "900",
        }),
      ).rejects.toMatchObject({ code: "wallet_provider_invalid_config" });
      await expect(
        adapter.sendTx({
          chain: "solana",
          requestId: "request-raw",
          serializedTxBase64: "AQID",
        } as never),
      ).rejects.toMatchObject({ code: "wallet_provider_invalid_config" });
      expect((adapter as unknown as Record<string, unknown>).prepareTx).toBeUndefined();
      expect((adapter as unknown as Record<string, unknown>).signTx).toBeUndefined();
      expect(signer.requests).toHaveLength(0);
    } finally {
      await signer.close();
    }
  });

  it("fails closed when the signer omits a required protocol-v2 capability", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-capability-",
      handle: () => ({
        ...capabilities,
        capabilities: {
          ...capabilities.capabilities,
          features: capabilities.capabilities.features.filter(
            (feature) => feature !== "atomicIdempotency",
          ),
        },
      }),
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      await expect(
        adapter.sendTx({
          chain: "solana",
          requestId: "request-no-capability",
          to: "Destination11111111111111111111111111111",
          amount: "900",
        }),
      ).rejects.toMatchObject({ code: "wallet_provider_unavailable" });
      expect(signer.requests).toEqual([{ op: "v2.capabilities" }]);
    } finally {
      await signer.close();
    }
  });

  it("relays only request identity and opaque WebAuthn ceremony data", async () => {
    const intent = {
      type: "solana.jupiter.swap" as const,
      jupiter: {
        owner: wallet.publicKey,
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "Vote111111111111111111111111111111111111111",
        inputAmount: "100",
        maxInputAmount: "100",
        minimumOutputAmount: "90",
        maxFeeLamports: "5000",
        sourceTokenAccount: "Stake11111111111111111111111111111111111111",
        destinationTokenAccount: "Config1111111111111111111111111111111111111",
        programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      },
    };
    const binding = {
      requestId: "review-123",
      walletId: "agent-wallet",
      role: "agent" as const,
      walletPublicKey: wallet.publicKey,
      intentType: intent.type,
      intentDigest: `sha256:${"b".repeat(64)}`,
      semanticIntent: intent,
      artifactKind: "solana-transaction" as const,
      artifactDigest: `sha256:${"c".repeat(64)}`,
      transactionDigest: `sha256:${"c".repeat(64)}`,
      asset: "solana:spl:So11111111111111111111111111111111111111112",
      amount: "100",
      destination: "Config1111111111111111111111111111111111111",
      policyOperation: intent.type,
      requiredPrograms: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      policyHash,
      nonce: "d".repeat(64),
      issuedAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
    };
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-review-auth-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        if (request.op === "v2.review.authorization.begin") {
          return {
            challengeId: "challenge-123",
            expiresAt: binding.expiresAt,
            binding,
            options: { publicKey: { challenge: "opaque-challenge" } },
          };
        }
        if (request.op === "v2.review.authorization.finish") {
          return {
            authorization: { type: "webauthn", proof: { proofId: "proof-123" } },
            binding,
            credentialId: "credential-123",
            expiresAt: binding.expiresAt,
          };
        }
        throw new Error(`unexpected op=${String(request.op)}`);
      },
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      const begin = await adapter.beginJupiterReviewAuthorization({
        walletId: "agent-wallet",
        requestId: "review-123",
      });
      expect(begin.challengeId).toBe("challenge-123");
      const finish = await adapter.finishJupiterReviewAuthorization({
        walletId: "agent-wallet",
        challengeId: begin.challengeId,
        credential: { id: "credential-123", response: { signature: "opaque" } },
      });
      expect(finish.authorization).toEqual({
        type: "webauthn",
        proof: { proofId: "proof-123" },
      });
      expect(signer.requests).toEqual([
        { op: "v2.capabilities" },
        {
          op: "v2.review.authorization.begin",
          walletId: "agent-wallet",
          request: { requestId: "review-123" },
        },
        { op: "v2.capabilities" },
        {
          op: "v2.review.authorization.finish",
          walletId: "agent-wallet",
          request: {
            challengeId: "challenge-123",
            credential: { id: "credential-123", response: { signature: "opaque" } },
          },
        },
      ]);
    } finally {
      await signer.close();
    }
  });

  it("asks the signer to build native reviewed transfers and executes only the stored review", async () => {
    const requestId = "review-native-123";
    const destination = "Destination11111111111111111111111111111";
    const review = {
      requestId,
      walletId: "agent-wallet",
      intentType: "solana.nativeTransfer" as const,
      intentDigest: `sha256:${"b".repeat(64)}`,
      policyHash,
      mode: "reviewed" as const,
      nonce: "d".repeat(64),
      semanticIntent: {
        type: "solana.nativeTransfer" as const,
        destination,
        lamports: "900",
      },
      walletPublicKey: wallet.publicKey,
      artifactKind: "solana-transaction" as const,
      artifactDigest: `sha256:${"c".repeat(64)}`,
      transaction: {
        serializedTxBase64: "AA==",
        programs: ["11111111111111111111111111111111"],
        writableAccounts: [wallet.publicKey, destination],
        submission: "rpc" as const,
      },
      asset: "solana:native",
      amount: "900",
      destination,
      policyOperation: "solana.nativeTransfer",
      requiredPrograms: ["11111111111111111111111111111111"],
      issuedAt: "2026-07-16T12:00:00.000Z",
      state: "prepared" as const,
      preparedAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
      transactionDigest: `sha256:${"c".repeat(64)}`,
    };
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-native-review-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        if (request.op === "v2.policy.get") {
          return policy;
        }
        if (request.op === "v2.review.prepare") {
          return review;
        }
        if (request.op === "v2.review.get") {
          return review;
        }
        if (request.op === "v2.review.execute") {
          return {
            review: { ...review, state: "signed", signature: "review-signature" },
            signer: wallet.publicKey,
            operation: {
              requestId,
              walletId: "agent-wallet",
              intentType: "solana.nativeTransfer",
              intentDigest: review.intentDigest,
              transactionDigest: review.transactionDigest,
              policyHash,
              asset: "solana:native",
              amount: "900",
              state: "confirmed",
              reservationActive: false,
              usageBucket: "2026-07-16:solana:native",
              reservedAt: "2026-07-16T12:00:00.000Z",
              confirmedAt: "2026-07-16T12:00:02.000Z",
              updatedAt: "2026-07-16T12:00:02.000Z",
              signature: "review-signature",
            },
          };
        }
        throw new Error(`unexpected op=${String(request.op)}`);
      },
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      await adapter.prepareTypedTransferReview({
        walletId: "agent-wallet",
        requestId,
        destination,
        amount: "900",
        memo: `fased:a2a-refund:v1:${"a".repeat(64)}`,
      });
      await adapter.getSignerReview({ walletId: "agent-wallet", requestId });
      await adapter.executeSignerReview({
        walletId: "agent-wallet",
        requestId,
        authorization: { type: "webauthn", proof: { proofId: "proof-123" } },
      });

      expect(signer.requests).toEqual([
        { op: "v2.capabilities" },
        { op: "v2.policy.get", walletId: "agent-wallet" },
        {
          op: "v2.review.prepare",
          walletId: "agent-wallet",
          request: {
            requestId,
            policyHash,
            mode: "reviewed",
            intent: {
              type: "solana.nativeTransfer",
              destination,
              lamports: "900",
              memo: `fased:a2a-refund:v1:${"a".repeat(64)}`,
            },
          },
        },
        { op: "v2.capabilities" },
        {
          op: "v2.review.get",
          walletId: "agent-wallet",
          request: { requestId },
        },
        { op: "v2.capabilities" },
        {
          op: "v2.review.execute",
          walletId: "agent-wallet",
          request: {
            requestId,
            authorization: { type: "webauthn", proof: { proofId: "proof-123" } },
          },
        },
      ]);
    } finally {
      await signer.close();
    }
  });

  it("reads only sanitized signer-owned Jupiter Trigger history", async () => {
    const history = {
      orders: [
        {
          orderId: "order-1",
          orderState: "open",
          orderType: "single",
          inputMint: "So11111111111111111111111111111111111111112",
          initialInputAmount: "100",
          remainingInputAmount: "90",
          outputMint: "Vote111111111111111111111111111111111111111",
          triggerMint: "So11111111111111111111111111111111111111112",
          condition: "below",
          targetPriceUsd: "120.5",
          slippageBps: 100,
          expiresAt: "2026-07-20T00:00:00.000Z",
          cancel: {
            expectedOrderState: "open",
            refundMint: "So11111111111111111111111111111111111111112",
            refundAmount: "90",
            destinationTokenAccount: "11111111111111111111111111111111",
            program: "11111111111111111111111111111111",
          },
        },
      ],
    };
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-trigger-history-",
      handle: (request) => {
        if (request.op === "v2.capabilities") {
          return capabilities;
        }
        if (request.op === "v2.jupiter.trigger.history") {
          return history;
        }
        throw new Error(`unexpected op=${String(request.op)}`);
      },
    });
    try {
      const adapter = new LocalSocketSignerAdapter(signer.socketPath, {
        scopedWalletId: "agent-wallet",
      });
      await expect(
        adapter.listJupiterTriggerOrders({ walletId: "agent-wallet", state: "active" }),
      ).resolves.toEqual(history);
      expect(signer.requests).toEqual([
        { op: "v2.capabilities" },
        { op: "v2.jupiter.trigger.history", walletId: "agent-wallet" },
      ]);
      expect(JSON.stringify(history)).not.toMatch(/jwt|apiKey|vault|transaction|requestId/i);
    } finally {
      await signer.close();
    }
  });
});
