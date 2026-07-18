import { describe, expect, it, vi } from "vitest";
import { lockSignerOwnedWalletForArchive } from "./local-socket-signer-archive.js";
import type { LocalSocketSignerPolicyV2 } from "./local-socket-signer-protocol.js";
import {
  normalizeNativeSignerWalletId,
  resolveNativeSignerWalletId,
} from "./native-signer-wallet-id.js";

const currentPolicy: LocalSocketSignerPolicyV2 = {
  walletId: "agent_2",
  role: "agent",
  version: 7,
  operations: ["solana.nativeTransfer"],
  programs: ["11111111111111111111111111111111"],
  assets: [
    {
      asset: "solana:native",
      destinations: ["Destination11111111111111111111111111111"],
      maxPerTx: "1000",
      maxDaily: "5000",
    },
  ],
  hash: `sha256:${"a".repeat(64)}`,
};

const lockedPolicy: LocalSocketSignerPolicyV2 = {
  walletId: "agent_2",
  role: "agent",
  version: 8,
  operations: [],
  programs: [],
  assets: [],
  hash: `sha256:${"b".repeat(64)}`,
};

describe("native signer wallet archive", () => {
  it("uses the canonical signer ID and requests exact deny-all with a version fence", async () => {
    const signer = {
      getSignerPolicy: vi.fn(async () => currentPolicy),
      tightenSignerPolicy: vi.fn(async () => lockedPolicy),
    };

    await expect(
      lockSignerOwnedWalletForArchive({
        wallet: {
          id: "agent-2",
          providerId: "local-socket-signer",
          metadata: { signerWalletId: "agent_2" },
        },
        socketPath: "/run/fased-signerd/app.sock",
        signer,
      }),
    ).resolves.toEqual(lockedPolicy);

    expect(signer.getSignerPolicy).toHaveBeenCalledWith("agent_2");
    expect(signer.tightenSignerPolicy).toHaveBeenCalledWith({
      walletId: "agent_2",
      expectedVersion: 7,
      policy: {
        walletId: "agent_2",
        role: "agent",
        operations: [],
        programs: [],
        assets: [],
      },
    });
  });

  it("rejects a signer acknowledgement that retains any permission", async () => {
    const signer = {
      getSignerPolicy: vi.fn(async () => currentPolicy),
      tightenSignerPolicy: vi.fn(async () => ({
        ...lockedPolicy,
        operations: ["solana.nativeTransfer"],
      })),
    };

    await expect(
      lockSignerOwnedWalletForArchive({
        wallet: {
          id: "agent-2",
          providerId: "local-socket-signer",
          metadata: { signerWalletId: "agent_2" },
        },
        socketPath: "/run/fased-signerd/app.sock",
        signer,
      }),
    ).rejects.toThrow(/exact deny-all archive policy/);
  });

  it("does not tighten when the signer returns policy state for another wallet", async () => {
    const signer = {
      getSignerPolicy: vi.fn(async () => ({ ...currentPolicy, walletId: "agent_3" })),
      tightenSignerPolicy: vi.fn(async () => lockedPolicy),
    };

    await expect(
      lockSignerOwnedWalletForArchive({
        wallet: {
          id: "agent-2",
          providerId: "local-socket-signer",
          metadata: { signerWalletId: "agent_2" },
        },
        socketPath: "/run/fased-signerd/app.sock",
        signer,
      }),
    ).rejects.toThrow(/different wallet/);
    expect(signer.tightenSignerPolicy).not.toHaveBeenCalled();
  });

  it("normalizes a legacy hyphenated registry ID when signer metadata is absent", () => {
    expect(normalizeNativeSignerWalletId(" Agent---2 ")).toBe("agent_2");
    expect(
      resolveNativeSignerWalletId({
        id: "agent-2",
        providerId: "local-socket-signer",
      }),
    ).toBe("agent_2");
  });

  it("fails closed for a non-canonical recorded signer ID", () => {
    expect(() =>
      resolveNativeSignerWalletId({
        id: "agent-2",
        providerId: "local-socket-signer",
        metadata: { signerWalletId: "agent-2" },
      }),
    ).toThrow(/non-canonical native signer wallet ID/);
  });
});
