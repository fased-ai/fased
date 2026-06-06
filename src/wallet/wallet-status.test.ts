import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("./wallet-provider-resolver.js", () => ({
  createWalletProviderAdapter: vi.fn(),
  resolveWalletProviderId: vi.fn(),
}));

vi.mock("./wallet-runtime-config.js", () => ({
  ensureWalletStateDir: vi.fn(),
  resolveWalletRuntimeConfig: vi.fn(),
  resolveWalletStatePaths: vi.fn(),
}));

vi.mock("./wallet-approval-auth.js", () => ({
  readWalletApprovalAuthSnapshot: vi.fn(),
}));

vi.mock("./wallet-custody.js", () => ({
  readWalletCustodyStatus: vi.fn(),
}));

vi.mock("./wallet-policy.js", () => ({
  resolveWalletPolicyConfig: vi.fn(),
}));

import { loadConfig } from "../config/config.js";
import { readWalletApprovalAuthSnapshot } from "./wallet-approval-auth.js";
import { readWalletCustodyStatus } from "./wallet-custody.js";
import { resolveWalletPolicyConfig } from "./wallet-policy.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import {
  ensureWalletStateDir,
  resolveWalletRuntimeConfig,
  resolveWalletStatePaths,
} from "./wallet-runtime-config.js";
import { readWalletStatusSnapshot } from "./wallet-status.js";

describe("readWalletStatusSnapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(loadConfig).mockReturnValue({
      wallet: {
        provider: { id: "local-socket-signer" },
      },
    } as never);

    vi.mocked(resolveWalletProviderId).mockReturnValue("local-socket-signer");
    vi.mocked(resolveWalletRuntimeConfig).mockReturnValue({
      enabled: true,
      mode: "managed",
      runtime: "external-custom",
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 18789 },
      execution: { mode: "manual" },
      policy: {
        directSigning: false,
        solana: { allowPrograms: [], caps: { maxPerTx: 0n, maxDaily: 0n } },
      },
      toolAccess: { mode: "owner-only", allowAgents: [] },
    } as never);
    vi.mocked(resolveWalletPolicyConfig).mockReturnValue({
      enabled: true,
      mode: "managed",
      runtime: "external-custom",
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 18789 },
      execution: { mode: "manual" },
      policy: {
        directSigning: false,
        solana: { allowPrograms: [], caps: { maxPerTx: 0n, maxDaily: 0n } },
      },
      toolAccess: { mode: "owner-only", allowAgents: [] },
    } as never);
    vi.mocked(ensureWalletStateDir).mockReturnValue({
      rootDir: "/tmp/fased-wallet",
    } as never);
    vi.mocked(resolveWalletStatePaths).mockReturnValue({
      keysPath: "/tmp/fased-wallet/keys.json",
      sidecarPidPath: "/tmp/fased-wallet/wallet-service.pid",
    } as never);
    vi.mocked(readWalletApprovalAuthSnapshot).mockReturnValue({
      mode: "none",
      ready: true,
      passkeyCount: 0,
      notes: [],
      passkeys: [],
      statePath: "/tmp/fased-wallet/approval.json",
    } as never);
    vi.mocked(readWalletCustodyStatus).mockReturnValue({
      owner: null,
      ready: false,
      summary: "unconfigured",
    } as never);
  });

  it("keeps service healthy when address lookup fails after provider health passes", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockRejectedValue(new Error("missing default wallet")),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.service.healthy).toBe(true);
    expect(status.startupState).toBe("healthy");
    expect(status.error).toContain("address probe warning:");
    expect(status.error).toContain("missing default wallet");
  });

  it("redacts secret-bearing provider diagnostics from status errors", async () => {
    vi.mocked(resolveWalletProviderId).mockReturnValue("embedded-keystore");
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({
        ok: false,
        details: "rpc failed at https://rpc.example.com/?api_key=super-secret-rpc-key&ok=1",
      }),
      getAddresses: vi.fn(),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.error).toContain("api_key=***");
    expect(status.error).not.toContain("super-secret-rpc-key");
  });

  it("treats fresh local-signer installs with no wallets as setup pending", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({
        ok: false,
        details:
          "local-socket-signer socket is unavailable: ENOENT: no such file or directory, stat '/home/app/.fased/wallet/local-signer.sock'",
      }),
      getAddresses: vi.fn(),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.service.healthy).toBe(true);
    expect(status.startupState).toBe("healthy");
    expect(status.error).toBeUndefined();
  });

  it("uses config env vars when probing wallet provider health", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/from-config.sock",
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
      },
    } as never);
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockResolvedValue({ solana: "abc" }),
    } as never);

    await readWalletStatusSnapshot({ env: {} as NodeJS.ProcessEnv });

    expect(createWalletProviderAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/from-config.sock",
        }),
      }),
    );
  });

  it("passes the current approval host into custody status", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockResolvedValue({ solana: "abc" }),
    } as never);

    await readWalletStatusSnapshot({
      env: {} as NodeJS.ProcessEnv,
      walletId: "solana-2",
      approvalHost: "fased.tailnet.local:8787",
    });

    expect(readWalletCustodyStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "solana-2",
        approvalHost: "fased.tailnet.local:8787",
      }),
    );
  });
});
