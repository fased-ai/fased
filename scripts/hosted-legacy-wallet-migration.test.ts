import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateHostedLegacyWalletMigration,
  buildHostedLegacyWalletPlan,
  commitHostedLegacyWalletMigration,
  prepareHostedLegacyWalletMigration,
  rollbackHostedLegacyWalletMigration,
} from "./hosted-legacy-wallet-migration.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-hosted-legacy-"));
  roots.push(root);
  const appHome = path.join(root, "home", "app");
  const legacySignerHome = path.join(root, "home", "fased-signer");
  const walletDir = path.join(appHome, ".fased", "wallet");
  const legacyWalletDir = path.join(legacySignerHome, ".fased", "wallet");
  fs.mkdirSync(walletDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(legacyWalletDir, { recursive: true, mode: 0o700 });
  const registryPath = path.join(walletDir, "provider-registry.v1.json");
  const configPath = path.join(appHome, ".fased", "fased.json");
  const registry = {
    version: 1,
    providers: {
      "embedded-keystore": { enabled: true, updatedAt: "before" },
      "local-socket-signer": { enabled: false, updatedAt: "before" },
    },
    wallets: [
      {
        id: "agent-2",
        name: "Agent 2",
        providerId: "embedded-keystore",
        addresses: { solana: "11111111111111111111111111111111" },
        metadata: { role: "agent" },
        createdAt: "before",
        updatedAt: "before",
      },
      {
        id: "vault",
        name: "Vault",
        providerId: "embedded-keystore",
        addresses: { solana: "SysvarRent111111111111111111111111111111111" },
        metadata: { purpose: "vault" },
        createdAt: "before",
        updatedAt: "before",
      },
    ],
    assignments: {},
    defaultWalletId: "agent-2",
    updatedAt: "before",
  };
  const config = {
    wallet: { provider: "embedded-keystore", keystore: { passphraseFile: "legacy" } },
    env: {
      vars: {
        FASED_WALLET_PASSPHRASE: "fixture-passphrase",
        FASED_WALLET_SOLANA_RPC_URL__AGENT_2: "https://agent-rpc.example.test",
      },
    },
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(walletDir, "keystore-solana-agent-2.v1.enc"), "agent-encrypted", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(walletDir, "keystore-solana-vault.v1.enc"), "vault-encrypted", {
    mode: 0o600,
  });
  return {
    root,
    appHome,
    legacySignerHome,
    registryPath,
    configPath,
    policyPath: path.join(root, "etc", "fased", "migration-policy.json"),
    stateDir: path.join(root, "var", "migration-state"),
    originalRegistry: fs.readFileSync(registryPath, "utf8"),
    originalConfig: fs.readFileSync(configPath, "utf8"),
  };
}

describe("automatic hosted legacy-wallet migration", () => {
  it("derives registered roles, normalized IDs, passphrases, and RPCs without a policy ceremony", () => {
    const value = fixture();
    const plan = buildHostedLegacyWalletPlan(value);
    expect(
      plan.wallets.map((wallet) => [wallet.registryWalletId, wallet.walletId, wallet.role]),
    ).toEqual([
      ["agent-2", "agent_2", "agent"],
      ["vault", "vault", "vault"],
    ]);

    prepareHostedLegacyWalletMigration(value);
    const policy = JSON.parse(fs.readFileSync(value.policyPath, "utf8"));
    expect(policy.wallets).toEqual([
      expect.objectContaining({
        walletId: "agent_2",
        baselineRole: "agent",
        primaryRpcUrl: "https://agent-rpc.example.test",
      }),
      expect.objectContaining({ walletId: "vault", baselineRole: "vault" }),
    ]);
    expect(policy.wallets[0].passphrasePath).not.toBe(policy.wallets[1].passphrasePath);
    expect(fs.statSync(value.policyPath).mode & 0o777).toBe(0o600);
  });

  it("activates the signer registry transactionally and restores exact prior app state on rollback", () => {
    const value = fixture();
    prepareHostedLegacyWalletMigration(value);
    activateHostedLegacyWalletMigration(value.stateDir);

    const registry = JSON.parse(fs.readFileSync(value.registryPath, "utf8"));
    expect(registry.wallets.map((wallet: { providerId: string }) => wallet.providerId)).toEqual([
      "local-socket-signer",
      "local-socket-signer",
    ]);
    expect(registry.wallets[0].metadata.signerWalletId).toBe("agent_2");
    const config = JSON.parse(fs.readFileSync(value.configPath, "utf8"));
    expect(config.wallet.provider).toEqual({ id: "local-socket-signer" });
    expect(config.env.vars.FASED_WALLET_PASSPHRASE).toBeUndefined();

    expect(rollbackHostedLegacyWalletMigration(value.stateDir)).toEqual({ rolledBack: true });
    expect(fs.readFileSync(value.registryPath, "utf8")).toBe(value.originalRegistry);
    expect(fs.readFileSync(value.configPath, "utf8")).toBe(value.originalConfig);
    expect(fs.existsSync(value.policyPath)).toBe(false);
  });

  it("deletes successful temporary state instead of leaving a backup", () => {
    const value = fixture();
    prepareHostedLegacyWalletMigration(value);
    activateHostedLegacyWalletMigration(value.stateDir);
    expect(commitHostedLegacyWalletMigration(value.stateDir)).toEqual({ committed: true });
    expect(fs.existsSync(value.stateDir)).toBe(false);
    expect(fs.existsSync(value.policyPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(value.registryPath, "utf8")).wallets[0].providerId).toBe(
      "local-socket-signer",
    );
  });
});
