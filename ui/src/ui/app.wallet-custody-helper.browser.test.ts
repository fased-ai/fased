import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./app-lifecycle.ts", () => ({
  handleConnected: vi.fn(),
  handleDisconnected: vi.fn(),
  handleFirstUpdated: vi.fn(),
  handleUpdated: vi.fn(),
}));

const walletApi = vi.hoisted(() => ({
  initializeWalletCustody: vi.fn(),
  unlockWalletCustody: vi.fn(),
  refreshWalletCustody: vi.fn(),
  recoverWalletCustody: vi.fn(),
  enrollWalletCustodyDevice: vi.fn(),
  revokeWalletCustodyDevice: vi.fn(),
}));

const browserStorage = vi.hoisted(() => ({
  buildWalletCustodyStorageBinding: vi.fn(() => "binding"),
  clearStoredWalletCustodyDeviceShare: vi.fn(),
  decryptStoredWalletCustodyDeviceShare: vi.fn(async (): Promise<string> => {
    throw new Error("browser storage should not be used when native helper is available");
  }),
  getStoredWalletCustodyDeviceShareCredentialId: vi.fn(() => ""),
  hasStoredWalletCustodyDeviceShare: vi.fn(() => false),
  loadStoredWalletCustodyDeviceShare: vi.fn(() => ""),
  saveStoredWalletCustodyDeviceShare: vi.fn(async (): Promise<void> => {
    throw new Error("browser storage should not be used when native helper is available");
  }),
}));

vi.mock("./wallet-api.ts", async () => {
  const actual = await vi.importActual<typeof import("./wallet-api.ts")>("./wallet-api.ts");
  return {
    ...actual,
    ...walletApi,
  };
});

vi.mock("./wallet-custody-storage.ts", async () => {
  const actual = await vi.importActual<typeof import("./wallet-custody-storage.ts")>(
    "./wallet-custody-storage.ts",
  );
  return {
    ...actual,
    ...browserStorage,
  };
});

type StoredShareRecord = {
  gatewayOrigin: string;
  walletId: string;
  deviceShare: string;
};

function createMockCompanionHelper() {
  const shares = new Map<string, StoredShareRecord>();
  const baseUrl = "http://127.0.0.1:18795";
  const key = (gatewayOrigin: string, walletId: string) =>
    `${gatewayOrigin.trim().toLowerCase()}::${walletId.trim()}`;
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const resolveRequestUrl = (input: RequestInfo | URL): string =>
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const parseJsonBody = (body: RequestInit["body"]): Record<string, unknown> => {
    if (typeof body !== "string" || !body.trim()) {
      return {};
    }
    return JSON.parse(body) as Record<string, unknown>;
  };
  const stringField = (value: unknown): string => (typeof value === "string" ? value : "");
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = resolveRequestUrl(input);
    if (!requestUrl.startsWith(baseUrl)) {
      throw new Error(`unexpected helper fetch: ${requestUrl}`);
    }
    const url = new URL(requestUrl);
    const method = String(init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/v1/custody/health") {
      return json(200, {
        ok: true,
        protocolVersion: 1,
        helper: "fased-wallet-custody-companion-mock",
        platform: "mock",
        storageMode: "mock-memory",
        availableRoutes: [
          "/v1/custody/health",
          "/v1/custody/device-share/status",
          "/v1/custody/device-share/store",
          "/v1/custody/device-share/load",
          "/v1/custody/device-share/delete",
        ],
        storedWalletCount: shares.size,
      });
    }

    if (method === "GET" && url.pathname === "/v1/custody/device-share/status") {
      const gatewayOrigin = url.searchParams.get("gatewayOrigin") || "";
      const walletId = url.searchParams.get("walletId") || "";
      return json(200, {
        ok: true,
        stored: shares.has(key(gatewayOrigin, walletId)),
      });
    }

    const body = parseJsonBody(init?.body);

    if (method === "POST" && url.pathname === "/v1/custody/device-share/store") {
      const gatewayOrigin = stringField(body.gatewayOrigin);
      const walletId = stringField(body.walletId);
      const deviceShare = stringField(body.deviceShare);
      shares.set(key(gatewayOrigin, walletId), {
        gatewayOrigin,
        walletId,
        deviceShare,
      });
      return json(200, { ok: true, stored: true, storageMode: "mock-memory" });
    }

    if (method === "POST" && url.pathname === "/v1/custody/device-share/load") {
      const gatewayOrigin = stringField(body.gatewayOrigin);
      const walletId = stringField(body.walletId);
      const stored = shares.get(key(gatewayOrigin, walletId));
      if (!stored) {
        return json(404, { ok: false });
      }
      return json(200, { ok: true, deviceShare: stored.deviceShare });
    }

    if (method === "POST" && url.pathname === "/v1/custody/device-share/delete") {
      const gatewayOrigin = stringField(body.gatewayOrigin);
      const walletId = stringField(body.walletId);
      const removed = shares.delete(key(gatewayOrigin, walletId));
      return json(200, { ok: true, removed });
    }

    return json(404, { ok: false });
  });
  return {
    baseUrl,
    shares,
    fetchMock,
  };
}

function createCustody(params: {
  walletId: string;
  role: "agent" | "vault";
  mode: "single-key" | "split-key-active";
  active?: boolean;
}): import("./wallet-api.ts").WalletStatus["custody"] {
  return {
    mode: params.mode,
    target: {
      walletId: params.walletId,
      role: params.role,
    },
    scope: {
      chains: ["solana"],
      allowPrograms: ["EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"],
      solana: {
        maxPerTx: "1000000000",
        maxDaily: "5000000000",
      },
    },
    unlock: params.active
      ? {
          active: true,
          sessionId: "session-live",
          host: "127.0.0.1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      : { active: false },
    phase2: {
      complete: true,
      splitKeyEnabled: true,
      passkeyCeremonyEnabled: true,
      ephemeralReconstructionEnabled: true,
      notes: [],
    },
    ceremony: {
      initialized: params.mode !== "single-key",
      scheme: params.mode === "single-key" ? undefined : "2-of-3",
      secretBytes: params.mode === "single-key" ? undefined : 32,
      devices:
        params.mode === "single-key"
          ? []
          : [{ id: "device-primary", label: "Primary", createdAt: new Date().toISOString() }],
      path: "/tmp/wallet-custody.json",
      updatedAt: new Date().toISOString(),
    },
  };
}

describe("wallet custody helper path (browser)", () => {
  let helper: ReturnType<typeof createMockCompanionHelper>;
  type TestFasedAgentApp = {
    settings: Record<string, unknown> & { gatewayUrl?: string };
    walletActionMessage?: string;
    walletCustodyClientCompatibility?: unknown;
    walletCustodyDeviceShare?: string;
    walletCustodyDeviceShareStored?: boolean;
    walletCustodyEnrollLabel?: string;
    walletCustodyRecoveryInput?: string;
    walletCustodyRefreshTimer?: number | null;
    walletCustodyRememberDeviceShare?: boolean;
    walletDetailsWalletId?: string;
    walletStatus?: Record<string, unknown>;
    handleWalletEnrollCustodyDevice: () => Promise<void>;
    handleWalletInitializeCustody: () => Promise<void>;
    handleWalletRecoverCustody: () => Promise<void>;
    handleWalletRefreshCustody: (silent?: boolean) => Promise<void>;
    handleWalletRevokeCustodyDevice: (deviceId: string) => Promise<void>;
    handleWalletUnlockCustody: () => Promise<void>;
  };
  let app: TestFasedAgentApp | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = "";
    helper = createMockCompanionHelper();
    vi.stubGlobal("fetch", helper.fetchMock);
    (
      globalThis as typeof globalThis & {
        __FASED_WALLET_CUSTODY_COMPANION_BASE_URL__?: string;
      }
    ).__FASED_WALLET_CUSTODY_COMPANION_BASE_URL__ = helper.baseUrl;
  });

  afterEach(async () => {
    delete (
      globalThis as typeof globalThis & {
        __FASED_WALLET_CUSTODY_COMPANION_BASE_URL__?: string;
      }
    ).__FASED_WALLET_CUSTODY_COMPANION_BASE_URL__;
    if (app?.walletCustodyRefreshTimer != null) {
      clearTimeout(app.walletCustodyRefreshTimer);
      app.walletCustodyRefreshTimer = null;
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    app = null;
  });

  it("drives init, unlock, refresh, recover, enroll, and revoke through helper-backed storage when browser storage is unavailable", async () => {
    const { FasedAgentApp } = await import("./app.ts");

    app = new FasedAgentApp() as unknown as TestFasedAgentApp;
    const walletId = "wallet-agent";
    const gatewayOrigin = "http://127.0.0.1:18789";
    const custodySingle = createCustody({ walletId, role: "agent", mode: "single-key" });
    const custodyActive = createCustody({ walletId, role: "agent", mode: "split-key-active" });

    app.settings = { ...app.settings, gatewayUrl: gatewayOrigin };
    app.walletDetailsWalletId = walletId;
    app.walletCustodyRememberDeviceShare = true;
    app.walletStatus = {
      managedMode: false,
      enabled: true,
      mode: "managed",
      runtime: "external-custom",
      settlement: { class: "real-chain", realChainReady: true, summary: "ready" },
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 18789, healthy: true },
      policy: {
        executionMode: "manual",
        directSigning: true,
        toolAccessMode: "owner-only",
        allowAgents: [],
        solana: { allowPrograms: [], maxPerTx: "0", maxDaily: "0" },
      },
      approvalAuth: {
        mode: "webauthn",
        ready: true,
        passkeyCount: 1,
        notes: [],
        passkeys: [],
        statePath: "/tmp/passkeys.json",
      },
      custody: custodySingle,
      paths: { rootDir: "/tmp", keysPath: "/tmp/keys", pidPath: "/tmp/pid" },
      checkedAt: new Date().toISOString(),
      startupState: "healthy",
      authState: "ok",
    };
    app.walletCustodyClientCompatibility = {
      secureContext: true,
      webauthn: true,
      webCrypto: true,
      localStorage: true,
      platformAuthenticator: "supported",
      conditionalMediation: "supported",
      prf: "unsupported",
      storageMode: "manual-share-only",
      nativeHelper: {
        status: "available",
        helper: "fased-wallet-custody-companion-mock",
        platform: "mock",
        storageMode: "mock-memory",
        protocolVersion: 1,
        storedWalletCount: 0,
        availableRoutes: [
          "/v1/custody/health",
          "/v1/custody/device-share/status",
          "/v1/custody/device-share/store",
          "/v1/custody/device-share/load",
          "/v1/custody/device-share/delete",
        ],
      },
      notes: [],
    };

    (app as unknown as { handleWalletLoad: () => Promise<void> }).handleWalletLoad = vi.fn(
      async () => undefined,
    );
    (
      app as unknown as {
        resolveWalletCustodyApproval: (params: {
          operation:
            | "wallet.custody-init"
            | "wallet.custody-unlock"
            | "wallet.custody-recover"
            | "wallet.custody-enroll-device"
            | "wallet.custody-revoke-device";
          walletId: string;
          includeStorageKey: boolean;
        }) => Promise<{ approvalToken: string; credentialId: string }>;
      }
    ).resolveWalletCustodyApproval = vi.fn(async () => ({
      approvalToken: "approval-token",
      credentialId: "cred-123",
    }));

    walletApi.initializeWalletCustody.mockResolvedValue({
      ok: true,
      walletId,
      role: "agent",
      deviceShare: "device-share-1",
      recoveryShare: "recovery-share-1",
      custody: custodyActive,
    });
    walletApi.unlockWalletCustody.mockResolvedValue({
      ok: true,
      session: {
        id: "session-1",
        host: "127.0.0.1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      custody: custodyActive,
    });
    walletApi.refreshWalletCustody.mockResolvedValue({
      ok: true,
      session: {
        id: "session-1",
        host: "127.0.0.1",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      custody: createCustody({
        walletId,
        role: "agent",
        mode: "split-key-active",
        active: true,
      }),
    });
    walletApi.recoverWalletCustody.mockResolvedValue({
      ok: true,
      walletId,
      role: "agent",
      deviceShare: "device-share-2",
      recoveryShare: "recovery-share-2",
      custody: custodyActive,
    });
    walletApi.enrollWalletCustodyDevice.mockResolvedValue({
      ok: true,
      walletId,
      role: "agent",
      deviceId: "device-2",
      label: "Laptop 2",
      deviceShare: "device-share-enrolled",
      custody: custodyActive,
    });
    walletApi.revokeWalletCustodyDevice.mockResolvedValue({
      ok: true,
      walletId,
      role: "agent",
      removedDeviceId: "device-2",
      removedDeviceLabel: "Laptop 2",
      custody: custodyActive,
    });

    await app.handleWalletInitializeCustody();
    expect(walletApi.initializeWalletCustody).toHaveBeenCalledWith("approval-token", walletId);
    expect(helper.shares.get(`${gatewayOrigin.toLowerCase()}::${walletId}`)?.deviceShare).toBe(
      "device-share-1",
    );
    expect(app.walletCustodyDeviceShareStored).toBe(true);
    expect(browserStorage.saveStoredWalletCustodyDeviceShare).not.toHaveBeenCalled();
    expect(app.walletActionMessage).toContain("Wallet security enabled");

    app.walletStatus = {
      ...app.walletStatus,
      custody: custodyActive,
    };
    app.walletCustodyDeviceShare = "";

    await app.handleWalletUnlockCustody();
    expect(walletApi.unlockWalletCustody).toHaveBeenCalledWith(
      "approval-token",
      "device-share-1",
      walletId,
      0,
    );
    expect(browserStorage.loadStoredWalletCustodyDeviceShare).not.toHaveBeenCalled();

    app.walletCustodyDeviceShare = "";
    await app.handleWalletRefreshCustody();
    expect(walletApi.refreshWalletCustody).toHaveBeenCalledWith("device-share-1", walletId, 0);
    expect(browserStorage.decryptStoredWalletCustodyDeviceShare).not.toHaveBeenCalled();

    app.walletCustodyRecoveryInput = "recovery-share-old";
    await app.handleWalletRecoverCustody();
    expect(walletApi.recoverWalletCustody).toHaveBeenCalledWith(
      "approval-token",
      "recovery-share-old",
      walletId,
    );
    expect(helper.shares.get(`${gatewayOrigin.toLowerCase()}::${walletId}`)?.deviceShare).toBe(
      "device-share-2",
    );

    app.walletCustodyDeviceShare = "";
    app.walletCustodyEnrollLabel = "Laptop 2";
    await app.handleWalletEnrollCustodyDevice();
    expect(walletApi.enrollWalletCustodyDevice).toHaveBeenCalledWith({
      approvalToken: "approval-token",
      walletId,
      deviceShare: "device-share-2",
      label: "Laptop 2",
    });

    app.walletCustodyDeviceShare = "";
    await app.handleWalletRevokeCustodyDevice("device-2");
    expect(walletApi.revokeWalletCustodyDevice).toHaveBeenCalledWith({
      approvalToken: "approval-token",
      walletId,
      deviceId: "device-2",
      deviceShare: "device-share-2",
    });

    expect(browserStorage.clearStoredWalletCustodyDeviceShare).not.toHaveBeenCalled();
  });

  it("keeps browser storage as the primary path when both browser storage and helper are available", async () => {
    const { FasedAgentApp } = await import("./app.ts");

    browserStorage.saveStoredWalletCustodyDeviceShare.mockResolvedValue(undefined);
    browserStorage.loadStoredWalletCustodyDeviceShare.mockReturnValue("device-share-1");
    browserStorage.decryptStoredWalletCustodyDeviceShare.mockResolvedValue("device-share-1");
    browserStorage.getStoredWalletCustodyDeviceShareCredentialId.mockReturnValue("cred-123");
    browserStorage.hasStoredWalletCustodyDeviceShare.mockReturnValue(false);

    app = new FasedAgentApp() as unknown as TestFasedAgentApp;
    const walletId = "wallet-agent";
    const gatewayOrigin = "http://127.0.0.1:18789";
    const custodySingle = createCustody({ walletId, role: "agent", mode: "single-key" });
    const custodyActive = createCustody({ walletId, role: "agent", mode: "split-key-active" });

    app.settings = { ...app.settings, gatewayUrl: gatewayOrigin };
    app.walletDetailsWalletId = walletId;
    app.walletCustodyRememberDeviceShare = true;
    app.walletStatus = {
      managedMode: false,
      enabled: true,
      mode: "managed",
      runtime: "external-custom",
      settlement: { class: "real-chain", realChainReady: true, summary: "ready" },
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 18789, healthy: true },
      policy: {
        executionMode: "manual",
        directSigning: true,
        toolAccessMode: "owner-only",
        allowAgents: [],
        solana: { allowPrograms: [], maxPerTx: "0", maxDaily: "0" },
      },
      approvalAuth: {
        mode: "webauthn",
        ready: true,
        passkeyCount: 1,
        notes: [],
        passkeys: [],
        statePath: "/tmp/passkeys.json",
      },
      custody: custodySingle,
      paths: { rootDir: "/tmp", keysPath: "/tmp/keys", pidPath: "/tmp/pid" },
      checkedAt: new Date().toISOString(),
      startupState: "healthy",
      authState: "ok",
    };
    app.walletCustodyClientCompatibility = {
      secureContext: true,
      webauthn: true,
      webCrypto: true,
      localStorage: true,
      platformAuthenticator: "supported",
      conditionalMediation: "supported",
      prf: "supported",
      storageMode: "encrypted-browser-storage",
      nativeHelper: {
        status: "available",
        helper: "fased-wallet-custody-companion-mock",
        platform: "mock",
        storageMode: "mock-memory",
        protocolVersion: 1,
        storedWalletCount: 0,
        availableRoutes: [
          "/v1/custody/health",
          "/v1/custody/device-share/status",
          "/v1/custody/device-share/store",
          "/v1/custody/device-share/load",
          "/v1/custody/device-share/delete",
        ],
      },
      notes: [],
    };

    (app as unknown as { handleWalletLoad: () => Promise<void> }).handleWalletLoad = vi.fn(
      async () => undefined,
    );
    (
      app as unknown as {
        resolveWalletCustodyApproval: (params: {
          operation:
            | "wallet.custody-init"
            | "wallet.custody-unlock"
            | "wallet.custody-recover"
            | "wallet.custody-enroll-device"
            | "wallet.custody-revoke-device";
          walletId: string;
          includeStorageKey: boolean;
        }) => Promise<{ approvalToken: string; credentialId: string; storageKeyBase64?: string }>;
      }
    ).resolveWalletCustodyApproval = vi.fn(async ({ includeStorageKey }) => ({
      approvalToken: "approval-token",
      credentialId: "cred-123",
      storageKeyBase64: includeStorageKey ? "storage-key" : undefined,
    }));

    walletApi.initializeWalletCustody.mockResolvedValue({
      ok: true,
      walletId,
      role: "agent",
      deviceShare: "device-share-1",
      recoveryShare: "recovery-share-1",
      custody: custodyActive,
    });
    walletApi.unlockWalletCustody.mockResolvedValue({
      ok: true,
      session: {
        id: "session-1",
        host: "127.0.0.1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      custody: createCustody({
        walletId,
        role: "agent",
        mode: "split-key-active",
        active: true,
      }),
    });

    await app.handleWalletInitializeCustody();
    expect(browserStorage.saveStoredWalletCustodyDeviceShare).toHaveBeenCalled();
    expect(helper.shares.size).toBe(0);

    app.walletStatus = {
      ...app.walletStatus,
      custody: custodyActive,
    };
    app.walletCustodyDeviceShare = "";
    browserStorage.hasStoredWalletCustodyDeviceShare.mockReturnValue(true);

    await app.handleWalletUnlockCustody();
    expect(browserStorage.decryptStoredWalletCustodyDeviceShare).toHaveBeenCalled();
    expect(walletApi.unlockWalletCustody).toHaveBeenCalledWith(
      "approval-token",
      "device-share-1",
      walletId,
      0,
    );
    expect(helper.shares.size).toBe(0);
  });
});
