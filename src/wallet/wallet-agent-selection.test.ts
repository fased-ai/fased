import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { parseWalletHandle, resolveAgentWalletSelection } from "./wallet-agent-selection.js";
import {
  setDefaultWallet,
  setAgentWalletAssignment,
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
    setNamedWalletRole({ walletId: "agent", role: "agent", env: process.env });
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

  it("falls back only to the optional Default Agent wallet", () => {
    const selection = resolveAgentWalletSelection({
      config: cfg,
      env: process.env,
    });

    expect(selection.walletId).toBe("agent");
    expect(selection.role).toBe("agent");
    expect(selection.source).toBe("default");
  });

  it("uses explicit action, skill, Agent, and default precedence in that order", () => {
    setAgentWalletAssignment({
      agentId: "research",
      walletId: "trading",
      env: process.env,
    });

    expect(
      resolveAgentWalletSelection({
        config: cfg,
        walletId: "agent",
        skillWalletId: "trading",
        agentId: "research",
        env: process.env,
      }),
    ).toMatchObject({ walletId: "agent", source: "explicit" });
    expect(
      resolveAgentWalletSelection({
        config: cfg,
        skillWalletId: "agent",
        agentId: "research",
        env: process.env,
      }),
    ).toMatchObject({ walletId: "agent", source: "skill" });
    expect(
      resolveAgentWalletSelection({
        config: cfg,
        agentId: "research",
        env: process.env,
      }),
    ).toMatchObject({ walletId: "trading", source: "agent" });
    expect(
      resolveAgentWalletSelection({
        config: cfg,
        agentId: "unassigned",
        env: process.env,
      }),
    ).toMatchObject({ walletId: "agent", source: "default" });
  });

  it("fails with Select an Agent wallet when no route is configured", () => {
    setDefaultWallet({ walletId: undefined, env: process.env });
    expect(() =>
      resolveAgentWalletSelection({ config: cfg, agentId: "unassigned", env: process.env }),
    ).toThrow("Select an Agent wallet");
  });

  it("rejects Mining and Vault Agent assignments", () => {
    expect(() =>
      setAgentWalletAssignment({ agentId: "research", walletId: "mining", env: process.env }),
    ).toThrow("only Agent wallets");
    expect(() =>
      setAgentWalletAssignment({ agentId: "research", walletId: "vault", env: process.env }),
    ).toThrow("only Agent wallets");
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
