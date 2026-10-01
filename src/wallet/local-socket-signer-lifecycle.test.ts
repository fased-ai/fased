import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindSignerOwnedRPCProfile,
  createSignerOwnedRPCProfile,
  createLockedSignerOwnedWallet,
  listSignerOwnedRPCProfiles,
} from "./local-socket-signer-lifecycle.js";

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
    release: {
      version: "dev",
      commit: "unknown",
      buildInputDigest: "unknown",
      development: true,
    },
    capabilities: {
      protocol: { current: 2, min: 2, max: 2 },
      nativeFeeReservationLamports: 6_500_000,
      intentTypes: ["solana.nativeTransfer"],
      operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
      features: [
        "failClosedPolicies",
        "policyHashes",
        "signerOwnedKeys",
        "liveWalletReadiness",
        "applicationNetworkBootstrap",
        "signerOwnedRPCProfiles",
        "atomicMultiAssetCaps",
        "signerControlledNativeFeeCaps",
      ],
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
  it("creates one signer-owned RPC profile and reuses its fenced identity", async () => {
    const hash = `hmac-sha256:${"a".repeat(64)}`;
    const networkHash = `hmac-sha256:${"b".repeat(64)}`;
    const profile = {
      profileId: "mainnet-primary",
      name: "Mainnet Primary",
      chain: "solana" as const,
      cluster: "mainnet-beta" as const,
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", // pragma: allowlist secret
      commitment: "finalized" as const,
      version: 1 as const,
      hash,
      endpointCount: 2,
      ready: true as const,
    };
    const server = await createServer((request) => {
      if (request.op === "v2.capabilities") {
        return { ok: true, result: capabilityResult() };
      }
      if (request.op === "v2.rpcProfile.create") {
        return { ok: true, result: profile };
      }
      if (request.op === "v2.rpcProfile.list") {
        return { ok: true, result: [profile] };
      }
      if (request.op === "v2.network.get") {
        return {
          ok: true,
          result: { walletId: "profile", configured: false, version: 0, ready: false },
        };
      }
      if (request.op === "v2.rpcProfile.bind") {
        return {
          ok: true,
          result: {
            walletId: "profile",
            profileId: profile.profileId,
            profileVersion: 1,
            profileHash: hash,
            networkVersion: 1,
            networkHash,
            genesisHash: profile.genesisHash,
            ready: true,
          },
        };
      }
      return { ok: false, error: "unexpected operation" };
    });
    try {
      const created = await createSignerOwnedRPCProfile({
        socketPath: server.socketPath,
        profileId: "mainnet-primary",
        name: "Mainnet Primary",
        primaryRpcUrl: "https://primary.example/rpc?token=secret",
        websocketRpcUrl: "wss://primary.example/ws?token=secret",
      });
      expect(created).toEqual(profile);
      expect(await listSignerOwnedRPCProfiles({ socketPath: server.socketPath })).toEqual([
        profile,
      ]);
      expect(
        await bindSignerOwnedRPCProfile({
          socketPath: server.socketPath,
          walletId: "profile",
          profile: created,
        }),
      ).toMatchObject({ walletId: "profile", profileId: "mainnet-primary", ready: true });
      expect(server.requests.at(-1)).toEqual({
        op: "v2.rpcProfile.bind",
        walletId: "profile",
        request: {
          profileId: "mainnet-primary",
          expectedProfileVersion: 1,
          expectedProfileHash: hash,
          expectedNetworkVersion: 0,
        },
      });
    } finally {
      await server.close();
    }
  });

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
              approvalMode: "read-only",
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
          policy: {
            role: "agent",
            approvalMode: "read-only",
            operations: [],
            programs: [],
            assets: [],
          },
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
            role: "agent",
            approvalMode: "read-only",
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
        role: "agent",
        allowExisting: true,
      });
      expect(result.wallet.publicKey).toBe("Vault1111111111111111111111111111111111");
      expect(server.requests.some((request) => request.op === "v2.wallet.create")).toBe(false);
    } finally {
      await server.close();
    }
  });
});

it.each([false, true])(
  "rejects a granting policy when creating or resuming an ordinary wallet (existing=%s)",
  async (existing) => {
    const wallet = {
      walletId: "wallet",
      publicKey: "11111111111111111111111111111111",
      version: 1,
      createdAt: "2026-09-30T00:00:00.000Z",
    };
    const policy = {
      walletId: "wallet",
      role: "agent",
      approvalMode: "manual",
      version: 1,
      operations: ["solana.nativeTransfer"],
      programs: ["11111111111111111111111111111111"],
      assets: [],
      hash: `sha256:${"a".repeat(64)}`,
    };
    const server = await createServer((request) => {
      if (request.op === "v2.capabilities") {
        return { ok: true, result: capabilityResult() };
      }
      if (existing && request.op === "v2.wallet.get") {
        return { ok: true, result: wallet };
      }
      if (existing && request.op === "v2.policy.get") {
        return { ok: true, result: policy };
      }
      if (request.op === "v2.wallet.create") {
        return { ok: true, result: { wallet, policy } };
      }
      return { ok: false, error: "wallet not found" };
    });
    try {
      await expect(
        createLockedSignerOwnedWallet({
          socketPath: server.socketPath,
          walletId: "wallet",
          role: "agent",
          allowExisting: existing,
        }),
      ).rejects.toThrow(/exact read-only policy/);
      if (existing) {
        expect(server.requests.some((request) => request.op === "v2.wallet.create")).toBe(false);
      }
    } finally {
      await server.close();
    }
  },
);
