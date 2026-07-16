import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLockedSignerOwnedWallet } from "./local-socket-signer-lifecycle.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function capabilityResult() {
  return {
    details: "fased-signerd protocol-v2 ready",
    readOnly: false,
    keystoreType: "signer-owned-v2",
    chains: ["solana"],
    ready: true,
    capabilities: {
      protocol: { current: 2, min: 2, max: 2 },
      intentTypes: ["solana.nativeTransfer"],
      operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
      features: ["failClosedPolicies", "policyHashes", "signerOwnedKeys"],
    },
    policies: [],
  };
}

async function createServer(
  handler: (request: Record<string, unknown>) => { ok: boolean; result?: unknown; error?: string },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-signer-lifecycle-"));
  cleanupPaths.push(dir);
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
      socket.end(`${JSON.stringify(handler(request))}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
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

describe("signer-owned wallet lifecycle", () => {
  it("creates keys only inside Go with an explicit deny-all policy", async () => {
    const server = await createServer((request) => {
      if (request.op === "v2.capabilities") {
        return { ok: true, result: capabilityResult() };
      }
      if (request.op === "v2.wallet.create") {
        return {
          ok: true,
          result: {
            wallet: {
              walletId: "agent",
              publicKey: "Agent1111111111111111111111111111111111",
              version: 1,
              createdAt: "2026-07-16T12:00:00.000Z",
            },
            policy: {
              walletId: "agent",
              role: "agent",
              version: 1,
              operations: [],
              programs: [],
              assets: [],
              hash: `sha256:${"a".repeat(64)}`,
            },
          },
        };
      }
      return { ok: false, error: "wallet not found" };
    });
    try {
      const result = await createLockedSignerOwnedWallet({
        socketPath: server.socketPath,
        walletId: "agent",
        role: "agent",
      });
      expect(result.wallet.publicKey).toBe("Agent1111111111111111111111111111111111");
      expect(server.requests).toContainEqual({
        op: "v2.wallet.create",
        walletId: "agent",
        request: {
          expectedPolicyVersion: 0,
          policy: { role: "agent", operations: [], programs: [], assets: [] },
        },
      });
      expect(JSON.stringify(server.requests)).not.toMatch(/private|secret|seed|passphrase/i);
    } finally {
      await server.close();
    }
  });

  it("resumes an identical existing wallet without replacing its key", async () => {
    const server = await createServer((request) => {
      if (request.op === "v2.capabilities") {
        return { ok: true, result: capabilityResult() };
      }
      if (request.op === "v2.wallet.get") {
        return {
          ok: true,
          result: {
            walletId: "vault",
            publicKey: "Vault1111111111111111111111111111111111",
            version: 1,
            createdAt: "2026-07-16T12:00:00.000Z",
          },
        };
      }
      if (request.op === "v2.policy.get") {
        return {
          ok: true,
          result: {
            walletId: "vault",
            role: "vault",
            version: 1,
            operations: [],
            programs: [],
            assets: [],
            hash: `sha256:${"b".repeat(64)}`,
          },
        };
      }
      return { ok: false, error: "unexpected create" };
    });
    try {
      const result = await createLockedSignerOwnedWallet({
        socketPath: server.socketPath,
        walletId: "vault",
        role: "vault",
        allowExisting: true,
      });
      expect(result.wallet.publicKey).toBe("Vault1111111111111111111111111111111111");
      expect(server.requests.some((request) => request.op === "v2.wallet.create")).toBe(false);
    } finally {
      await server.close();
    }
  });
});
