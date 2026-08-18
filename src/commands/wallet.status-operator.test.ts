import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));

const { walletStatusCommand } = await import("./wallet.js");

const cleanup: string[] = [];

describe("walletStatusCommand operator evidence", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    spawnSync.mockReset();
    for (const root of cleanup.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports canonical native handles, addresses, roles, and routing only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-status-operator-"));
    cleanup.push(root);
    const stateDir = path.join(root, ".fased");
    const walletDir = path.join(stateDir, "wallet");
    const instanceId = "0123456789abcdef";
    await fs.mkdir(walletDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "fased.json"),
      `${JSON.stringify({
        env: {
          vars: {
            FASED_HOST_PROFILE: "local",
            FASED_PROTECTED_LOCAL: "1",
            FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
            FASED_LIFECYCLE_INSTALL_ROOT: `/opt/fased/local/${instanceId}`,
            FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
            FASED_WALLET_LOCAL_SIGNER_BIN: `/opt/fased/local/${instanceId}/current/payload/bin/fased-signerd`,
            FASED_WALLET_LOCAL_SIGNER_SOCKET: `/run/fased-local/${instanceId}/application/app.sock`,
          },
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(walletDir, "provider-registry.v1.json"),
      `${JSON.stringify({
        version: 1,
        providers: {
          "embedded-keystore": { enabled: false, updatedAt: "2026-07-29T00:00:00.000Z" },
          "local-socket-signer": { enabled: true, updatedAt: "2026-07-29T00:00:00.000Z" },
          "wallet-standard": { enabled: true, updatedAt: "2026-07-29T00:00:00.000Z" },
          alchemy: { enabled: false, updatedAt: "2026-07-29T00:00:00.000Z" },
          turnkey: { enabled: false, updatedAt: "2026-07-29T00:00:00.000Z" },
          privy: { enabled: false, updatedAt: "2026-07-29T00:00:00.000Z" },
        },
        wallets: [
          {
            id: "agent",
            name: "Agent",
            providerId: "local-socket-signer",
            addresses: { solana: "11111111111111111111111111111111" },
            metadata: { purpose: "agent", signerWalletId: "agent" },
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
          {
            id: "browser-vault",
            name: "Browser Vault",
            providerId: "wallet-standard",
            addresses: { solana: "So11111111111111111111111111111111111111112" },
            metadata: { purpose: "vault" },
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
        assignments: { main: "agent", browser: "browser-vault" },
        defaultWalletId: "agent",
        updatedAt: "2026-07-29T00:00:00.000Z",
      })}\n`,
    );
    vi.stubEnv("HOME", root);
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_CONFIG_PATH", path.join(stateDir, "fased.json"));
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        walletId: "agent",
        publicKey: "11111111111111111111111111111111",
        walletVersion: 1,
        role: "agent",
        operationLane: "agent-reviewed-and-autonomous",
        baselineVersion: 1,
        keyReady: true,
        policyReady: true,
        policyVersion: 1,
        policyHash: `sha256:${"a".repeat(64)}`,
        networkReady: true,
        networkVersion: 1,
        networkHash: `hmac-sha256:${"b".repeat(64)}`,
        ready: true,
      }),
      stderr: "",
    });
    const logs: string[] = [];

    await walletStatusCommand(
      {
        log: (...args: unknown[]) => {
          const message = args[0];
          logs.push(typeof message === "string" ? message : JSON.stringify(message));
        },
        error: vi.fn(),
        exit: vi.fn(),
      },
      { json: true },
    );

    expect(JSON.parse(logs.join("\n"))).toEqual({
      ok: true,
      status: {
        mode: "protected-local-operator",
        defaultWalletId: "agent",
        assignments: { main: "agent" },
        wallets: [
          expect.objectContaining({
            id: "agent",
            handle: "@wallet:agent",
            publicAddress: "11111111111111111111111111111111",
            role: "agent",
            signer: expect.objectContaining({ walletId: "agent", ready: true }),
          }),
        ],
      },
    });
  });
});
