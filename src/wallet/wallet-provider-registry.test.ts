import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WALLET_PROVIDER_IDS,
  deleteNamedWallet,
  nextRoleWalletIdentity,
  readWalletProviderRegistry,
  setAgentWalletAssignment,
  replaceRetiredMiningWallet,
  setDefaultWallet,
  setNamedWalletRole,
  setWalletProviderEnabled,
  setWalletProvidersEnabled,
  upsertNamedWallet,
} from "./wallet-provider-registry.js";

describe("wallet-provider-registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allocates stable role wallet identities without asking users for internal IDs", () => {
    expect(nextRoleWalletIdentity("agent", [])).toEqual({
      walletName: "Agent",
      walletId: "agent",
    });
    expect(nextRoleWalletIdentity("agent", [{ id: "agent" }, { id: "agent-2" }])).toEqual({
      walletName: "Agent 3",
      walletId: "agent-3",
    });
    expect(nextRoleWalletIdentity("vault", [{ id: "vault" }])).toEqual({
      walletName: "Vault 2",
      walletId: "vault-2",
    });
    expect(nextRoleWalletIdentity("mining", [{ id: "mining" }])).toEqual({
      walletName: "Mining",
      walletId: "mining",
    });
    expect(nextRoleWalletIdentity("profile", [{ id: "profile" }])).toEqual({
      walletName: "Profile",
      walletId: "profile",
    });
    expect(nextRoleWalletIdentity("strategy", [], "solana")).toEqual({
      walletName: "Strategy Solana",
      walletId: "strategy-solana",
    });
    expect(nextRoleWalletIdentity("strategy", [], "evm")).toEqual({
      walletName: "Strategy EVM",
      walletId: "strategy-evm",
    });
  });

  it("enforces singleton Profile and per-chain Strategy cardinality at registry writes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      upsertNamedWallet({
        walletId: "profile",
        name: "Profile",
        providerId: "local-socket-signer",
        metadata: { role: "profile", roleChain: "solana" },
      });
      expect(() =>
        upsertNamedWallet({
          walletId: "profile-2",
          name: "Other Profile",
          providerId: "local-socket-signer",
          metadata: { role: "profile", roleChain: "solana" },
        }),
      ).toThrow(/only one Profile wallet/i);

      upsertNamedWallet({
        walletId: "strategy-solana",
        name: "Strategy Solana",
        providerId: "local-socket-signer",
        metadata: { role: "strategy", roleChain: "solana" },
      });
      expect(() =>
        upsertNamedWallet({
          walletId: "strategy-solana-2",
          name: "Other Strategy Solana",
          providerId: "local-socket-signer",
          metadata: { role: "strategy", roleChain: "solana" },
        }),
      ).toThrow(/one Strategy wallet per chain/i);

      upsertNamedWallet({
        walletId: "strategy-evm",
        name: "Strategy EVM",
        providerId: "local-socket-signer",
        metadata: { role: "strategy", roleChain: "evm" },
      });
      expect(readWalletProviderRegistry(process.env).wallets.map((wallet) => wallet.id)).toEqual([
        "profile",
        "strategy-solana",
        "strategy-evm",
      ]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves caller-supplied walletId without making it Agent by default", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      const created = upsertNamedWallet({
        walletId: "trading-main",
        name: "Trading Main",
        providerId: "local-socket-signer",
      });
      expect(created.id).toBe("trading-main");
      const registry = readWalletProviderRegistry(process.env);
      expect(registry.wallets.find((wallet) => wallet.id === "trading-main")?.name).toBe(
        "Trading Main",
      );
      expect(registry.defaultWalletId).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps the Default Agent wallet optional and never selects a replacement silently", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      upsertNamedWallet({
        walletId: "agent",
        name: "Agent",
        providerId: "local-socket-signer",
        metadata: { role: "agent" },
      });
      upsertNamedWallet({
        walletId: "trading",
        name: "Trading",
        providerId: "local-socket-signer",
      });
      setNamedWalletRole({ walletId: "trading", role: "agent" });
      setDefaultWallet({ walletId: "agent" });
      setAgentWalletAssignment({ agentId: "research", walletId: "agent" });

      let registry = readWalletProviderRegistry(process.env);
      expect(registry.defaultWalletId).toBe("agent");
      expect(registry.wallets.find((wallet) => wallet.id === "agent")?.metadata?.role).toBe(
        "agent",
      );
      expect(registry.wallets.find((wallet) => wallet.id === "trading")?.metadata?.role).toBe(
        "agent",
      );

      setNamedWalletRole({ walletId: "agent", role: "vault" });
      registry = readWalletProviderRegistry(process.env);
      expect(registry.defaultWalletId).toBeUndefined();
      expect(registry.assignments.research).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("offers only supported providers for fresh selection", () => {
    expect(WALLET_PROVIDER_IDS).toEqual([
      "local-socket-signer",
      "alchemy",
      "turnkey",
      "wallet-standard",
    ]);
    expect(WALLET_PROVIDER_IDS).not.toContain("embedded-keystore");
    expect(WALLET_PROVIDER_IDS).not.toContain("privy");
  });

  it("retains legacy embedded registry rows for explicit one-way migration", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      const walletRoot = path.join(stateDir, "wallet");
      await fs.mkdir(walletRoot, { recursive: true });
      await fs.writeFile(
        path.join(walletRoot, "provider-registry.v1.json"),
        `${JSON.stringify(
          {
            version: 1,
            providers: {
              "embedded-keystore": { enabled: true, updatedAt: "2026-03-14T00:00:00.000Z" },
              "local-socket-signer": { enabled: false, updatedAt: "2026-03-14T00:00:00.000Z" },
              alchemy: { enabled: false, updatedAt: "2026-03-14T00:00:00.000Z" },
              turnkey: { enabled: false, updatedAt: "2026-03-14T00:00:00.000Z" },
              privy: { enabled: false, updatedAt: "2026-03-14T00:00:00.000Z" },
            },
            wallets: [
              {
                id: "solana-1",
                name: "Solana 1",
                providerId: "embedded-keystore",
                addresses: { solana: "miner-1" },
                createdAt: "2026-03-14T00:00:00.000Z",
                updatedAt: "2026-03-14T00:00:00.000Z",
              },
            ],
            assignments: {},
            updatedAt: "2026-03-14T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const registry = readWalletProviderRegistry(process.env);
      expect(registry.wallets[0]?.providerId).toBe("embedded-keystore");
      expect(registry.providers["embedded-keystore"]?.enabled).toBe(true);
      expect(registry.providers["embedded-keystore"]?.label).toMatch(/migration required/i);

      const persisted = JSON.parse(
        await fs.readFile(path.join(walletRoot, "provider-registry.v1.json"), "utf8"),
      ) as {
        wallets: Array<{ providerId?: string; metadata?: Record<string, unknown> }>;
      };
      expect(persisted.wallets[0]?.providerId).toBe("embedded-keystore");
      expect(persisted.wallets[0]?.metadata?.selfHosted).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("cannot enable or register embedded-keystore or Privy", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      expect(() =>
        setWalletProviderEnabled({ providerId: "embedded-keystore", enabled: true }),
      ).toThrow(/import-legacy/i);
      expect(() => setWalletProviderEnabled({ providerId: "privy", enabled: true })).toThrow(
        /Privy.*unavailable/i,
      );
      expect(() =>
        upsertNamedWallet({
          walletId: "legacy",
          name: "Legacy",
          providerId: "embedded-keystore",
        }),
      ).toThrow(/import-legacy/i);
      expect(() =>
        upsertNamedWallet({ walletId: "privy", name: "Privy", providerId: "privy" }),
      ).toThrow(/Privy.*unavailable/i);

      const registry = setWalletProvidersEnabled({
        enabledProviders: ["embedded-keystore", "privy", "local-socket-signer"],
      });
      expect(registry.providers["embedded-keystore"]?.enabled).toBe(false);
      expect(registry.providers.privy?.enabled).toBe(false);
      expect(registry.providers["local-socket-signer"]?.enabled).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks deleting a wallet while SAT mining capital or pending work remains", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      upsertNamedWallet({
        walletId: "mining",
        name: "Mining",
        providerId: "local-socket-signer",
        metadata: { role: "mining", purpose: "mining" },
      });
      const runtimeDir = path.join(stateDir, "sat-mining", "wallets", "mining");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        path.join(runtimeDir, "runtime-store.json"),
        `${JSON.stringify(
          {
            version: 10,
            recentActions: [],
            enabledWanted: false,
            workers: {
              claim: {
                enabled: true,
                running: false,
              },
            },
            claimBacklog: [{ cycleId: 100 }],
            lastKnownStatus: {
              walletId: "mining",
              currentCapitalFundedLamports: "2495000000",
              currentCapitalLockedLamports: "2475000000",
              currentCapitalFreeLamports: "20000000",
              currentCapitalPendingCycleCount: 9,
            },
          },
          null,
          2,
        )}\n`,
      );

      expect(() => deleteNamedWallet({ walletId: "mining", env: process.env })).toThrow(
        /Cannot delete this wallet while SAT mining still has active state/,
      );
      expect(
        readWalletProviderRegistry(process.env).wallets.some((wallet) => wallet.id === "mining"),
      ).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("requires coordinated replacement even after Mining state is fully clear", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      upsertNamedWallet({
        walletId: "mining",
        name: "Mining",
        providerId: "local-socket-signer",
        metadata: { role: "mining", purpose: "mining" },
      });
      const runtimeDir = path.join(stateDir, "sat-mining", "wallets", "mining");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        path.join(runtimeDir, "runtime-store.json"),
        `${JSON.stringify(
          {
            version: 10,
            recentActions: [],
            enabledWanted: false,
            workers: {
              claim: {
                enabled: true,
                running: false,
              },
            },
            claimBacklog: [],
            currentRunStartedAt: "2026-05-26T13:50:14.048Z",
            lastKnownStatus: {
              walletId: "mining",
              currentCapitalFundedLamports: "0",
              currentCapitalLockedLamports: "0",
              currentCapitalFreeLamports: "0",
              currentCapitalPendingCycleCount: 0,
            },
          },
          null,
          2,
        )}\n`,
      );

      expect(() => deleteNamedWallet({ walletId: "mining", env: process.env })).toThrow(
        /Retire and replace Mining wallet/u,
      );
      expect(
        readWalletProviderRegistry(process.env).wallets.some((wallet) => wallet.id === "mining"),
      ).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects deleting a wallet that is a finalized financial Agent authority", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      const controller = Keypair.generate().publicKey.toBase58();
      const recovery = Keypair.generate().publicKey.toBase58();
      const record = Keypair.generate().publicKey.toBase58();
      upsertNamedWallet({
        walletId: "profile",
        name: "Profile",
        providerId: "local-socket-signer",
        addresses: { solana: controller },
        metadata: { role: "profile", purpose: "profile" },
      });
      const bindingDir = path.join(stateDir, "financial-agents");
      await fs.mkdir(bindingDir, { recursive: true });
      await fs.writeFile(
        path.join(bindingDir, "bindings.v1.json"),
        `${JSON.stringify({
          version: 1,
          bindings: {
            [record]: {
              programId: "FasEdZ9BAsboUPF2TUQjLaapC8arcAkV5fRnMtV2G1Ev", // pragma: allowlist secret
              genesisHash: Keypair.generate().publicKey.toBase58(),
              fasedAgentRecord: record,
              status: "active",
              controller,
              recoveryAuthority: recovery,
              authorityGeneration: "1",
              finalizedSlot: 5,
              updatedAt: new Date().toISOString(),
              attachments: [],
            },
          },
          pendingChallenges: {},
          consumedChallengeDigests: [],
          updatedAt: new Date().toISOString(),
        })}\n`,
      );

      expect(() => setNamedWalletRole({ walletId: "profile", role: "agent" })).toThrow(
        /finalize and read back the authority rotation/u,
      );
      expect(() =>
        upsertNamedWallet({
          walletId: "profile",
          name: "Profile",
          providerId: "local-socket-signer",
          addresses: { solana: Keypair.generate().publicKey.toBase58() },
          metadata: { role: "profile", purpose: "profile" },
        }),
      ).toThrow(/finalize and read back the authority rotation/u);
      expect(() => deleteNamedWallet({ walletId: "profile", env: process.env })).toThrow(
        /finalize and read back the authority rotation/u,
      );
      expect(
        readWalletProviderRegistry(process.env).wallets.some((wallet) => wallet.id === "profile"),
      ).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replaces the retired Mining registration in one registry write", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      upsertNamedWallet({
        walletId: "mining",
        name: "Mining",
        providerId: "local-socket-signer",
        addresses: { solana: "source-address" },
        metadata: { role: "mining", purpose: "mining" },
      });
      const runtimeDir = path.join(stateDir, "sat-mining", "wallets", "mining");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        path.join(runtimeDir, "runtime-store.json"),
        `${JSON.stringify({
          version: 12,
          enabledWanted: false,
          workers: { claim: { running: false } },
          claimBacklog: [],
          lastKnownStatus: {
            currentCapitalFundedLamports: "0",
            currentCapitalLockedLamports: "0",
            currentCapitalFreeLamports: "0",
            currentCapitalPendingCycleCount: 0,
          },
        })}\n`,
      );
      const successor = replaceRetiredMiningWallet({
        sourceWalletId: "mining",
        signerAcknowledgement: {
          rotationId: `sha256:${"a".repeat(64)}`,
          sourceRetiredPolicyHash: `sha256:${"b".repeat(64)}`,
          successorPublicKey: "successor-address",
          successorPolicyHash: `sha256:${"c".repeat(64)}`,
        },
        successor: {
          id: "mining-next",
          name: "Mining Next",
          providerId: "local-socket-signer",
          addresses: { solana: "successor-address" },
          metadata: {
            role: "mining",
            purpose: "mining",
            rotationId: `sha256:${"a".repeat(64)}`,
            policyHash: `sha256:${"c".repeat(64)}`,
          },
        },
      });
      expect(successor.id).toBe("mining-next");
      const registry = readWalletProviderRegistry(process.env);
      expect(registry.wallets.map((wallet) => wallet.id)).toEqual(["mining-next"]);
      expect(registry.wallets.filter((wallet) => wallet.metadata?.role === "mining")).toHaveLength(
        1,
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("explains exact free miner capital dust before deleting a mining wallet", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-registry-"));
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    try {
      upsertNamedWallet({
        walletId: "mining",
        name: "Mining",
        providerId: "local-socket-signer",
        metadata: { role: "mining", purpose: "mining" },
      });
      const runtimeDir = path.join(stateDir, "sat-mining", "wallets", "mining");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        path.join(runtimeDir, "runtime-store.json"),
        `${JSON.stringify(
          {
            version: 10,
            recentActions: [],
            enabledWanted: false,
            workers: {
              claim: {
                enabled: true,
                running: false,
              },
            },
            claimBacklog: [],
            lastKnownStatus: {
              walletId: "mining",
              currentCapitalFundedLamports: "5229774",
              currentCapitalLockedLamports: "0",
              currentCapitalFreeLamports: "5229774",
              currentCapitalPendingCycleCount: 0,
            },
          },
          null,
          2,
        )}\n`,
      );

      expect(() => deleteNamedWallet({ walletId: "mining", env: process.env })).toThrow(
        /Withdraw exactly 0\.005229774 SOL/,
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
