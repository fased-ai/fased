import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { parseWalletHandle, resolveAgentWalletSelection } from "./wallet-agent-selection.js";
import {
  setDefaultWallet,
  setNamedWalletRole,
  upsertNamedWallet,
} from "./wallet-provider-registry.js";

const cfg: FasedAgentConfig = {
  plugins: {
    entries: {
      "sat-mining": {
        config: {
          walletId: "mining",
        },
      },
    },
  },
};

describe("wallet-agent-selection", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-agent-wallet-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    upsertNamedWallet({
      walletId: "agent",
      name: "Agent",
      providerId: "local-socket-signer",
      env: process.env,
    });
    upsertNamedWallet({
      walletId: "mining",
      name: "Mining",
      providerId: "local-socket-signer",
      env: process.env,
    });
    upsertNamedWallet({
      walletId: "vault",
      name: "Vault",
      providerId: "local-socket-signer",
      env: process.env,
    });
    upsertNamedWallet({
      walletId: "trading",
      name: "Trading",
      providerId: "local-socket-signer",
      env: process.env,
    });
    setNamedWalletRole({ walletId: "trading", role: "agent", env: process.env });
    setNamedWalletRole({ walletId: "vault", role: "vault", env: process.env });
    setDefaultWallet({ walletId: "agent", env: process.env });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses exact wallet handles", () => {
    expect(parseWalletHandle("@wallet:agent")).toBe("agent");
  });

  it("resolves an explicit Agent wallet handle", () => {
    const selection = resolveAgentWalletSelection({
      config: cfg,
      walletHandle: "@wallet:agent",
      env: process.env,
    });

    expect(selection).toMatchObject({
      walletId: "agent",
      walletName: "Agent",
      role: "agent",
      walletHandle: "@wallet:agent",
    });
  });

  it("falls back only to the default Agent wallet", () => {
    const selection = resolveAgentWalletSelection({
      config: cfg,
      env: process.env,
    });

    expect(selection.walletId).toBe("agent");
    expect(selection.role).toBe("agent");
  });

  it("resolves a second Agent wallet by explicit handle", () => {
    const selection = resolveAgentWalletSelection({
      config: cfg,
      walletHandle: "@wallet:trading",
      env: process.env,
    });

    expect(selection).toMatchObject({
      walletId: "trading",
      walletName: "Trading",
      role: "agent",
      walletHandle: "@wallet:trading",
    });
  });

  it("does not treat plain wallet names as executable risky selectors", () => {
    expect(() =>
      resolveAgentWalletSelection({
        config: cfg,
        walletName: "Agent",
        env: process.env,
      }),
    ).toThrow("walletName is display-only");
  });

  it("rejects mining wallets for agent actions", () => {
    expect(() =>
      resolveAgentWalletSelection({
        config: cfg,
        walletHandle: "@wallet:mining",
        env: process.env,
      }),
    ).toThrow("wallet_role_not_allowed");
  });

  it("rejects vault wallets for agent actions", () => {
    expect(() =>
      resolveAgentWalletSelection({
        config: cfg,
        walletHandle: "@wallet:vault",
        env: process.env,
      }),
    ).toThrow("wallet_role_not_allowed");
  });

  it("rejects missing handles", () => {
    expect(() =>
      resolveAgentWalletSelection({
        config: cfg,
        walletHandle: "@wallet:nope",
        env: process.env,
      }),
    ).toThrow("walletId not found");
  });
});
