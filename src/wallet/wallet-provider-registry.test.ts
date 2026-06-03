import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteNamedWallet,
  readWalletProviderRegistry,
  setDefaultWallet,
  setNamedWalletRole,
  upsertNamedWallet,
} from "./wallet-provider-registry.js";

describe("wallet-provider-registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("supports multiple Agent wallets while keeping one primary fallback", async () => {
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
      expect(registry.defaultWalletId).toBe("trading");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy self-hosted embedded keystore wallets to local socket signer", async () => {
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
      expect(registry.wallets[0]?.providerId).toBe("local-socket-signer");
      expect(registry.providers["local-socket-signer"]?.enabled).toBe(true);

      const persisted = JSON.parse(
        await fs.readFile(path.join(walletRoot, "provider-registry.v1.json"), "utf8"),
      ) as {
        wallets: Array<{ providerId?: string; metadata?: Record<string, unknown> }>;
      };
      expect(persisted.wallets[0]?.providerId).toBe("local-socket-signer");
      expect(persisted.wallets[0]?.metadata?.selfHosted).toBe(true);
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

  it("allows deleting a mining wallet after mining state is fully clear", async () => {
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

      expect(deleteNamedWallet({ walletId: "mining", env: process.env }).removed).toBe(true);
      expect(
        readWalletProviderRegistry(process.env).wallets.some((wallet) => wallet.id === "mining"),
      ).toBe(false);
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
