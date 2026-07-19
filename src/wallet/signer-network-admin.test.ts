import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  applyHostedSignerOwnedWalletPolicy,
  configureSignerOwnedWalletNetwork,
} from "./signer-network-admin.js";

const cleanupPaths: string[] = [];
const NETWORK_HASH = `hmac-sha256:${"a".repeat(64)}`;

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
      nativeFeeReservationLamports: 5_000_000,
      intentTypes: ["solana.nativeTransfer"],
      operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
      features: [
        "failClosedPolicies",
        "policyHashes",
        "signerOwnedKeys",
        "applicationNetworkBootstrap",
        "atomicMultiAssetCaps",
        "signerControlledNativeFeeCaps",
      ],
    },
    policies: [],
  };
}

async function createSignerServer(params: {
  current?: { walletId: string; configured: boolean; version: number; ready: boolean };
  updated?: {
    walletId: string;
    configured: boolean;
    version: number;
    hash: string;
    ready: boolean;
  };
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-network-admin-"));
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
      let result: unknown;
      if (request.op === "v2.capabilities") {
        result = capabilityResult();
      } else if (request.op === "v2.network.get") {
        result =
          params.current ??
          ({ walletId: "agent_2", configured: false, version: 0, ready: false } as const);
      } else if (request.op === "v2.network.bootstrap") {
        result =
          params.updated ??
          ({
            walletId: "agent_2",
            configured: true,
            version: 1,
            hash: NETWORK_HASH,
            ready: true,
          } as const);
      } else {
        socket.end(`${JSON.stringify({ ok: false, error: "unexpected operation" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
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

describe("signer-owned network administration", () => {
  it("uses the restricted application socket for the same one-RPC flow on Local and Hosting", async () => {
    for (const profile of ["local", "hosting"] as const) {
      const signer = await createSignerServer({});
      try {
        const rpcUrl = `https://${profile}.example/solana?api-key=secret`;
        const result = await configureSignerOwnedWalletNetwork({
          walletId: "Agent-2",
          primaryRpcUrl: rpcUrl,
          env: { FASED_HOST_PROFILE: profile },
          socketPath: signer.socketPath,
        });

        expect(result).toMatchObject({ walletId: "agent_2", version: 1, ready: true });
        expect(signer.requests).toEqual([
          { op: "v2.capabilities" },
          { op: "v2.network.get", walletId: "agent_2" },
          {
            op: "v2.network.bootstrap",
            walletId: "agent_2",
            request: { expectedVersion: 0, primaryRpcUrl: rpcUrl },
          },
        ]);
      } finally {
        await signer.close();
      }
    }
  });

  it("rejects advanced fallback fields from normal onboarding before contacting the signer", async () => {
    await expect(
      configureSignerOwnedWalletNetwork({
        walletId: "agent",
        primaryRpcUrl: "https://primary.example/solana",
        executionFallbackRpcUrl: "https://fallback.example/solana",
        socketPath: "/does/not/exist.sock",
      }),
    ).rejects.toThrow(/accepts one primary RPC/i);
    await expect(
      configureSignerOwnedWalletNetwork({
        walletId: "agent",
        primaryRpcUrl: "https://primary.example/solana",
        verificationRpcUrl: "https://witness.example/solana",
        socketPath: "/does/not/exist.sock",
      }),
    ).rejects.toThrow(/accepts one primary RPC/i);
  });

  it("rejects a wrong next version without retrying", async () => {
    const signer = await createSignerServer({
      current: { walletId: "agent", configured: false, version: 0, ready: false },
      updated: {
        walletId: "agent",
        configured: true,
        version: 2,
        hash: NETWORK_HASH,
        ready: true,
      },
    });
    try {
      await expect(
        configureSignerOwnedWalletNetwork({
          walletId: "agent",
          primaryRpcUrl: "https://rpc.example/solana",
          socketPath: signer.socketPath,
        }),
      ).rejects.toThrow(/exact next ready version/);
      expect(
        signer.requests.filter((request) => request.op === "v2.network.bootstrap"),
      ).toHaveLength(1);
    } finally {
      await signer.close();
    }
  });

  it("keeps the strict public-summary parser for native-admin compatibility", () => {
    expect(
      __testing.parseSignerNetworkSummary(
        JSON.stringify({
          walletId: "agent",
          configured: true,
          version: 1,
          hash: NETWORK_HASH,
          ready: true,
        }),
        "agent",
      ),
    ).toMatchObject({ walletId: "agent", version: 1, ready: true });
    expect(() =>
      __testing.parseSignerNetworkSummary(
        JSON.stringify({
          walletId: "agent",
          configured: true,
          version: 1,
          hash: NETWORK_HASH,
          ready: true,
          primaryRpcUrl: "https://secret.example",
        }),
        "agent",
      ),
    ).toThrow(/unsupported summary fields/);
  });

  it("refuses every app-side hosted policy mutation", () => {
    const policy = {
      role: "agent" as const,
      operations: [],
      programs: [],
      assets: [],
    };
    expect(() => applyHostedSignerOwnedWalletPolicy({ walletId: "agent", policy })).toThrow(
      /root-only \/usr\/local\/sbin\/fased-signer-policy/,
    );
    expect(() =>
      applyHostedSignerOwnedWalletPolicy({
        walletId: "agent",
        policy: { ...policy, operations: ["agentSendNativeSol"] },
      }),
    ).toThrow(/deny-all/);
  });
});
