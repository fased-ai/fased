import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSecureLocalSignerSocket,
  callLocalSocketSigner,
  LocalSocketSignerAdapter,
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
    capabilities: {
      protocol: { current: 2 as const, min: 2, max: 2 },
      intentTypes: ["solana.nativeTransfer", "solana.splTransferChecked"],
      operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
      features: [
        "failClosedPolicies",
        "policyHashes",
        "durableCaps",
        "atomicIdempotency",
        "ambiguousBroadcastReconciliation",
        "signerOwnedKeys",
        "typedSolanaTransactions",
      ],
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

  it("rejects missing idempotency and all raw transaction signing before contacting the signer", async () => {
    const signer = await createSignerServer({
      prefix: "fased-signer-v2-reject-",
      handle: () => {
        throw new Error("the signer must not be contacted");
      },
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
        }),
      ).rejects.toMatchObject({ code: "wallet_provider_invalid_config" });
      await expect(
        adapter.signTx({
          chain: "solana",
          requestId: "request-sign",
          serializedTxBase64: "AQID",
        }),
      ).rejects.toMatchObject({ code: "wallet_provider_not_implemented" });
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
});
