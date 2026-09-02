import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import type { RuntimeEnv } from "../runtime.js";
import { runOnboardingWizard } from "./onboarding.js";
import type { WizardPrompter } from "./prompts.js";

const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const handleOnboardingRepair = vi.hoisted(() => vi.fn(async () => {}));
const writeConfigFile = vi.hoisted(() => vi.fn<(config: unknown) => Promise<void>>(async () => {}));
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({ exists: false, valid: true, config: {} })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const ensureControlUiAssetsBuilt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const runTui = vi.hoisted(() => vi.fn(async () => {}));
const configureGatewayForOnboarding = vi.hoisted(() =>
  vi.fn(async ({ hostProfile, nextConfig, localPort }) => ({
    nextConfig: {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        port: localPort,
      },
    },
    settings: {
      port: localPort,
      tailscaleMode: hostProfile === "hosting" ? "serve" : "off",
    },
  })),
);
const configureFederationForOnboarding = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>(async () => ({
    enabled: false,
    baseUrl: undefined,
    handle: undefined,
  })),
);
const applyHostingSecurity = vi.hoisted(() =>
  vi.fn(async ({ opts }) => ({ profile: opts.hostProfile ?? "local", checks: [] })),
);
const walletSetupCommand = vi.hoisted(() =>
  vi.fn<(runtime: unknown, options: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const collectWalletSignerDoctorReport = vi.hoisted(() =>
  vi.fn(async () => ({
    checks: [
      { check: "socket.exists", ok: true },
      { check: "socket.health", ok: true },
    ],
  })),
);
const readWalletProviderRegistry = vi.hoisted(() =>
  vi.fn<() => unknown>(() => ({
    version: 1,
    providers: {
      "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
      "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
      alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
    },
    wallets: [],
    assignments: {},
    updatedAt: "2026-03-15T00:00:00.000Z",
  })),
);
const upsertNamedWallet = vi.hoisted(() => vi.fn(() => ({ id: "wallet-1" })));
const deleteNamedWallet = vi.hoisted(() => vi.fn());
const checkNamedWalletDeletionSafety = vi.hoisted(() => vi.fn(() => ({ ok: true, details: null })));
const checkNamedWalletFinancialAuthority = vi.hoisted(() => vi.fn(() => null));
const setDefaultWallet = vi.hoisted(() => vi.fn());
const setNamedWalletRole = vi.hoisted(() => vi.fn());
const resolveWalletUserRole = vi.hoisted(() => vi.fn<() => unknown>(() => undefined));
const nextRoleWalletIdentity = vi.hoisted(() =>
  vi.fn((role: "agent" | "mining" | "vault", wallets: Array<{ id: string }> = []) => {
    const walletName = role === "agent" ? "Agent" : role === "mining" ? "Mining" : "Vault";
    if (role === "mining") {
      return { walletName, walletId: role };
    }
    const existing = new Set(wallets.map((wallet) => wallet.id));
    if (!existing.has(role)) {
      return { walletName, walletId: role };
    }
    for (let index = 2; index < 1000; index += 1) {
      const walletId = `${role}-${index}`;
      if (!existing.has(walletId)) {
        return { walletName: `${walletName} ${index}`, walletId };
      }
    }
    throw new Error("test wallet allocator exhausted");
  }),
);
const lockSignerOwnedWalletForArchive = vi.hoisted(() =>
  vi.fn(async () => ({
    walletId: "mining",
    role: "mining" as const,
    version: 5,
    operations: [],
    programs: [],
    assets: [],
    hash: `sha256:${"a".repeat(64)}`,
  })),
);
const restartLocalSocketSigner = vi.hoisted(() => vi.fn(async () => {}));
const installSignerdBinary = vi.hoisted(() => vi.fn());
const resolveSignerdBinaryPath = vi.hoisted(() => vi.fn(() => "/tmp/fased-signerd"));
const configureSignerOwnedWalletNetwork = vi.hoisted(() =>
  vi.fn(() => ({
    walletId: "wallet_1",
    configured: true,
    version: 2,
    hash: `hmac-sha256:${"a".repeat(64)}`,
    ready: true,
  })),
);
const invokeNativeSignerNetworkSetPrimary = vi.hoisted(() =>
  vi.fn(() => ({
    walletId: "wallet_1",
    configured: true,
    version: 2,
    hash: `hmac-sha256:${"a".repeat(64)}`,
    ready: true,
  })),
);
const readSignerOwnedWalletReadiness = vi.hoisted(() => vi.fn(async () => ({ networkVersion: 1 })));
const resolveNativeSignerOperatorLifecycle = vi.hoisted(() =>
  vi.fn<() => { signerBinPath: string; operatorSocketPath: string } | null>(() => null),
);
const configureWalletForOnboarding = vi.hoisted(() =>
  vi.fn(async ({ nextConfig }) => ({
    ...nextConfig,
    wallet: {
      ...nextConfig.wallet,
      provider: { ...nextConfig.wallet?.provider, id: "local-socket-signer" },
      runtime: { ...nextConfig.wallet?.runtime, enabled: true },
    },
  })),
);
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn(async () => "skip"));
const applyAuthChoice = vi.hoisted(() => vi.fn(async ({ config }) => ({ config })));
const resolvePreferredProviderForAuthChoice = vi.hoisted(() =>
  vi.fn<() => unknown>(() => undefined),
);
const warnIfModelConfigLooksOff = vi.hoisted(() => vi.fn(async () => {}));
const promptDefaultModel = vi.hoisted(() => vi.fn(async () => ({})));
const resolveAuthenticatedDefaultModel = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(async () => undefined),
);
const setupChannels = vi.hoisted(() => vi.fn(async (config) => config));
const setupSkills = vi.hoisted(() => vi.fn(async (config) => config));
const setupInternalHooks = vi.hoisted(() => vi.fn(async (config) => config));
const readManagedFederationTokenSummary = vi.hoisted(() =>
  vi.fn(() => ({
    path: "/tmp/federation/access-token.json",
    exists: false,
    hasZrokToken: false,
  })),
);
const readManagedReservationSummaries = vi.hoisted(() => vi.fn(() => []));
const loadPersistedFederationToken = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>(async () => null),
);
const runFederationAutoConnectOnce = vi.hoisted(() =>
  vi.fn(async () => ({ enabled: true, reason: undefined })),
);
const readWalletStatusSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    approvalAuth: {
      mode: "none",
      ready: false,
      passkeyCount: 0,
    },
  })),
);

vi.mock("../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot,
    writeConfigFile,
  };
});

vi.mock("../commands/wallet.js", () => ({
  walletSetupCommand,
  collectWalletSignerDoctorReport,
  invokeNativeSignerNetworkSetPrimary,
}));

vi.mock("../wallet/local-socket-signer-lifecycle.js", () => ({
  readSignerOwnedWalletReadiness,
}));

vi.mock("../wallet/native-signer-lifecycle-context.js", () => ({
  resolveNativeSignerOperatorLifecycle,
}));

vi.mock("../wallet/wallet-provider-registry.js", () => ({
  checkNamedWalletFinancialAuthority,
  checkNamedWalletDeletionSafety,
  readWalletProviderRegistry,
  upsertNamedWallet,
  deleteNamedWallet,
  setDefaultWallet,
  setNamedWalletRole,
  resolveWalletUserRole,
  nextRoleWalletIdentity,
}));

vi.mock("../wallet/signer-network-admin.js", () => ({
  configureSignerOwnedWalletNetwork,
}));

vi.mock("../wallet/local-socket-signer-archive.js", () => ({
  lockSignerOwnedWalletForArchive,
}));

vi.mock("./onboarding.wallet.js", () => ({
  configureWalletForOnboarding,
  installSignerdBinary,
  restartLocalSocketSigner,
  resolveSignerdBinaryPath,
}));

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    ensureWorkspaceAndSessions,
    handleOnboardingRepair,
    detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
    openUrl: vi.fn(async () => true),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(async () => ({ ok: true })),
    waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
    resolveControlUiLinks: vi.fn(() => ({
      httpUrl: "http://localhost:18789",
      wsUrl: "ws://127.0.0.1:18789",
    })),
  };
});

vi.mock("../commands/auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice,
  resolvePreferredProviderForAuthChoice,
  warnIfModelConfigLooksOff,
}));

vi.mock("../commands/onboard-channels.js", () => ({
  setupChannels,
}));

vi.mock("../commands/onboard-skills.js", () => ({
  setupSkills,
}));

vi.mock("../commands/onboard-hooks.js", () => ({
  setupInternalHooks,
}));

vi.mock("../commands/model-picker.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/model-picker.js")>();
  return {
    ...actual,
    promptDefaultModel,
    resolveAuthenticatedDefaultModel,
  };
});

vi.mock("../managed/federation.js", async (importActual) => {
  const actual = await importActual<typeof import("../managed/federation.js")>();
  return {
    ...actual,
    readManagedFederationTokenSummary,
  };
});

vi.mock("../managed/tunnel.js", async (importActual) => {
  const actual = await importActual<typeof import("../managed/tunnel.js")>();
  return {
    ...actual,
    readManagedReservationSummaries,
  };
});

vi.mock("../federation/access-token.js", async (importActual) => {
  const actual = await importActual<typeof import("../federation/access-token.js")>();
  return {
    ...actual,
    loadPersistedFederationToken,
  };
});

vi.mock("../federation/auto-connect.js", async (importActual) => {
  const actual = await importActual<typeof import("../federation/auto-connect.js")>();
  return {
    ...actual,
    runFederationAutoConnectOnce,
  };
});

vi.mock("../wallet/wallet-status.js", async (importActual) => {
  const actual = await importActual<typeof import("../wallet/wallet-status.js")>();
  return {
    ...actual,
    readWalletStatusSnapshot,
  };
});

vi.mock("../commands/systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt,
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./onboarding.gateway-config.js", () => ({
  configureGatewayForOnboarding,
}));

vi.mock("./onboarding.federation.js", () => ({
  configureFederationForOnboarding,
}));

vi.mock("./host-security-capability.js", () => ({
  isHostedSecurityCapableSession: vi.fn(() => false),
}));

vi.mock("./onboarding.host-security.js", () => ({
  applyHostingSecurity,
}));

function createWizardPrompter(overrides?: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

function createRuntime(opts?: { throwsOnExit?: boolean }): RuntimeEnv {
  if (opts?.throwsOnExit) {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };
  }

  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("runOnboardingWizard", () => {
  beforeEach(() => {
    vi.stubEnv("FASED_SKIP_NATIVE_SIGNER_BUILD", "1");
    promptAuthChoiceGrouped.mockReset();
    promptAuthChoiceGrouped.mockResolvedValue("skip");
    applyAuthChoice.mockReset();
    applyAuthChoice.mockImplementation(async ({ config }) => ({ config }));
    resolvePreferredProviderForAuthChoice.mockReset();
    resolvePreferredProviderForAuthChoice.mockReturnValue(undefined);
    warnIfModelConfigLooksOff.mockReset();
    setupChannels.mockReset();
    setupChannels.mockImplementation(async (config) => config);
    setupSkills.mockReset();
    setupSkills.mockImplementation(async (config) => config);
    setupInternalHooks.mockReset();
    setupInternalHooks.mockImplementation(async (config) => config);
    promptDefaultModel.mockReset();
    promptDefaultModel.mockResolvedValue({});
    readManagedFederationTokenSummary.mockReset();
    readManagedFederationTokenSummary.mockReturnValue({
      path: "/tmp/federation/access-token.json",
      exists: false,
      hasZrokToken: false,
    });
    readManagedReservationSummaries.mockReset();
    readManagedReservationSummaries.mockReturnValue([]);
    loadPersistedFederationToken.mockReset();
    loadPersistedFederationToken.mockResolvedValue(null);
    runFederationAutoConnectOnce.mockReset();
    runFederationAutoConnectOnce.mockResolvedValue({ enabled: true, reason: undefined });
    readWalletStatusSnapshot.mockReset();
    readWalletStatusSnapshot.mockResolvedValue({
      approvalAuth: {
        mode: "none",
        ready: false,
        passkeyCount: 0,
      },
    });
    walletSetupCommand.mockClear();
    lockSignerOwnedWalletForArchive.mockReset();
    lockSignerOwnedWalletForArchive.mockResolvedValue({
      walletId: "mining",
      role: "mining",
      version: 5,
      operations: [],
      programs: [],
      assets: [],
      hash: `sha256:${"a".repeat(64)}`,
    });
    configureSignerOwnedWalletNetwork.mockClear();
    invokeNativeSignerNetworkSetPrimary.mockClear();
    readSignerOwnedWalletReadiness.mockClear();
    readSignerOwnedWalletReadiness.mockResolvedValue({ networkVersion: 1 });
    resolveNativeSignerOperatorLifecycle.mockClear();
    resolveNativeSignerOperatorLifecycle.mockReturnValue(null);
    configureGatewayForOnboarding.mockClear();
    configureFederationForOnboarding.mockClear();
    configureWalletForOnboarding.mockClear();
    handleOnboardingRepair.mockClear();
    writeConfigFile.mockClear();
    ensureSystemdUserLingerInteractive.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.FASED_WALLET_SOLANA_RPC_URL__WALLET_1;
    delete process.env.FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1;
    delete process.env.FASED_WALLET_WEBAUTHN_RP_ID;
    delete process.env.FASED_WALLET_WEBAUTHN_ORIGINS;
  });

  it("does not open model selection when interactive model/auth setup is skipped", async () => {
    promptAuthChoiceGrouped.mockResolvedValue("skip");
    const prompter = createWizardPrompter();

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(promptDefaultModel).not.toHaveBeenCalled();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
  });

  it("offers setup profiles without a redundant setup-map note", async () => {
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Host setup profile") {
        return "local";
      }
      if (message === "What do you want to set up?") {
        return "local";
      }
      if (message === "Wallet setup action") {
        return "skip";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "advanced";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(prompter.note).not.toHaveBeenCalledWith(expect.anything(), "Setup map");
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Remote Gateway is a later connection mode"),
      expect.anything(),
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Onboarding now handles machine/security setup only."),
      expect.anything(),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Host setup profile",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "local",
            hint: expect.stringContaining("no VPS hardening"),
          }),
          expect.objectContaining({
            value: "hosting",
            hint: expect.stringContaining("Tailscale required"),
          }),
        ]),
      }),
    );
  });

  it("does not run model, channel, skill, or hook setup in the default onboarding path", async () => {
    const selectMock = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Host setup profile") {
        return "local";
      }
      if (message === "What do you want to set up?") {
        return "local";
      }
      if (message === "Wallet setup action") {
        return "skip";
      }
      return "advanced";
    });
    const select = selectMock as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(promptAuthChoiceGrouped).not.toHaveBeenCalled();
    expect(applyAuthChoice).not.toHaveBeenCalled();
    expect(promptDefaultModel).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(setupInternalHooks).not.toHaveBeenCalled();
    const setupChoice = selectMock.mock.calls.find(([params]) => {
      const message = (params as { message?: unknown })?.message;
      return typeof message === "string" && message === "What do you want to set up?";
    })?.[0] as { options?: Array<{ value?: unknown }> } | undefined;
    expect((setupChoice?.options ?? []).map((option) => option.value)).toEqual(["local"]);
    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Set up model providers?",
        initialValue: false,
      }),
    );
    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Set up chat channels?",
        initialValue: false,
      }),
    );
    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Set up skills?",
        initialValue: false,
      }),
    );
    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Set up hooks?",
        initialValue: false,
      }),
    );
    expect(prompter.multiselect).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enable hooks?" }),
    );
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select channel (QuickStart)" }),
    );
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Configure skills now? (recommended)" }),
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Skipped model/provider setup in onboarding."),
      expect.anything(),
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Skipped chat app channel setup in onboarding."),
      expect.anything(),
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Skipped skills setup in onboarding."),
      expect.anything(),
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Skipped hook setup in onboarding."),
      expect.anything(),
    );
  });

  it("runs UI-owned setup sections only after explicit advanced onboarding opt-in", async () => {
    promptAuthChoiceGrouped.mockResolvedValue("openai-codex");
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Host setup profile") {
        return "local";
      }
      if (message === "What do you want to set up?") {
        return "local";
      }
      if (message === "Wallet setup action") {
        return "skip";
      }
      return "advanced";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      return [
        "Set up model providers?",
        "Set up chat channels?",
        "Set up skills?",
        "Set up hooks?",
      ].includes(message);
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(promptAuthChoiceGrouped).toHaveBeenCalled();
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "openai-codex",
        setDefaultModel: false,
      }),
    );
    expect(setupChannels).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      prompter,
      expect.objectContaining({
        allowDisable: true,
        allowSignalInstall: true,
        skipConfirm: true,
        skipPrimerNote: true,
        skipStatusNote: true,
      }),
    );
    expect(setupSkills).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      prompter,
      expect.objectContaining({ skipConfirm: true }),
    );
    expect(setupInternalHooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      prompter,
      expect.objectContaining({ skipIntroNote: true }),
    );
  });

  it("keeps QuickStart self-hosted wallet naming fully non-interactive", async () => {
    walletSetupCommand.mockClear();
    upsertNamedWallet.mockClear();
    setNamedWalletRole.mockClear();
    resolveWalletUserRole.mockReset();
    resolveWalletUserRole.mockReturnValue(undefined);
    writeConfigFile.mockClear();
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet chain") {
        return "solana";
      }
      if (message === "Wallet action") {
        return "create";
      }
      if (message === "Wallet role (required)") {
        return "agent";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message.includes("RPC URL")) {
        return "https://api.devnet.solana.com";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Wallet name (used in UI + skill/plugin selection)" }),
    );
    expect(text).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Wallet ID (stable key for routing; letters/numbers/-/_)",
      }),
    );
    expect(walletSetupCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "local-signer-create",
        walletName: "Agent",
        walletId: "agent",
        force: true,
      }),
    );
    expect(upsertNamedWallet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Agent", walletId: "agent" }),
    );
    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wallet: expect.objectContaining({
          provider: expect.objectContaining({ id: "local-socket-signer" }),
          runtime: expect.objectContaining({ enabled: true }),
        }),
      }),
    );
  });

  it("does not retain a signer-rejected RPC when another wallet succeeds", async () => {
    walletSetupCommand.mockReset();
    walletSetupCommand.mockResolvedValueOnce(undefined);
    walletSetupCommand.mockRejectedValueOnce(new Error("RPC genesis verification failed"));
    writeConfigFile.mockClear();
    readWalletProviderRegistry.mockReturnValue({
      version: 1,
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    let rolePromptCount = 0;
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet action") {
        return "create";
      }
      if (message === "Wallet role (required)") {
        rolePromptCount += 1;
        return rolePromptCount === 1 ? "agent" : "mining";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    let rpcPromptCount = 0;
    const text = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message.includes("RPC URL")) {
        rpcPromptCount += 1;
        return rpcPromptCount === 1
          ? "https://accepted.example/solana"
          : "https://rejected.example/solana";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    let anotherPromptCount = 0;
    const confirm = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Run another wallet setup action?") {
        anotherPromptCount += 1;
        return anotherPromptCount === 1;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    try {
      await runOnboardingWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipHealth: true,
          skipUi: true,
        },
        createRuntime({ throwsOnExit: true }),
        prompter,
      );

      expect(rolePromptCount).toBe(2);
      expect(walletSetupCommand).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({ role: "agent", rpcUrl: "https://accepted.example/solana" }),
      );
      expect(walletSetupCommand).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ role: "mining", rpcUrl: "https://rejected.example/solana" }),
      );
      expect(process.env.FASED_WALLET_SOLANA_RPC_URL__AGENT).toBe(
        "https://accepted.example/solana",
      );
      expect(process.env.FASED_WALLET_SOLANA_RPC_URL__MINING).toBeUndefined();
      for (const [written] of writeConfigFile.mock.calls) {
        expect(
          (written as { env?: { vars?: Record<string, string> } }).env?.vars
            ?.FASED_WALLET_SOLANA_RPC_URL__MINING,
        ).toBeUndefined();
      }
    } finally {
      delete process.env.FASED_WALLET_SOLANA_RPC_URL__AGENT;
      delete process.env.FASED_WALLET_SOLANA_RPC_URL__MINING;
    }
  });

  it("never asks Node to print signer-owned private keys", async () => {
    walletSetupCommand.mockClear();
    readWalletProviderRegistry.mockReturnValue({
      version: 1,
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet chain") {
        return "solana";
      }
      if (message === "Wallet action") {
        return "create";
      }
      if (message === "Wallet role (required)") {
        return "agent";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message.includes("RPC URL")) {
        return "https://api.devnet.solana.com";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Show generated private key once for offline backup?") {
        return true;
      }
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(text).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("SHOW PRIVATE KEY"),
      }),
    );
    expect(walletSetupCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "local-signer-create" }),
    );
    const setupOptions = walletSetupCommand.mock.calls[0]?.[1];
    expect(setupOptions).not.toHaveProperty("showPrivateKeyOnce");
    expect(setupOptions).not.toHaveProperty("confirmPrivateKeyPrint");
  });

  it("keeps onboarding wallet id role-based when display name is edited", async () => {
    walletSetupCommand.mockClear();
    upsertNamedWallet.mockClear();
    setNamedWalletRole.mockClear();
    setDefaultWallet.mockClear();
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "agent",
          name: "Agent",
          providerId: "local-socket-signer",
          addresses: { solana: "agent-sol-1" },
          metadata: { selfHosted: true, role: "agent" },
        },
      ],
      assignments: {},
      defaultWalletId: "agent",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet action") {
        return "create";
      }
      if (message === "Wallet role (required)") {
        return "agent";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "advanced";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message.startsWith("Wallet name")) {
        return "Trading";
      }
      if (message.includes("RPC URL")) {
        return "https://api.devnet.solana.com";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(walletSetupCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "local-signer-create",
        walletName: "Trading",
        walletId: "agent-2",
      }),
    );
    expect(upsertNamedWallet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Trading", walletId: "agent-2" }),
    );
  });

  it("still honors explicit provider setup while skipping interactive provider prompts", async () => {
    applyAuthChoice.mockResolvedValue({
      config: {
        models: {
          providers: {
            "acme-cloud": {
              baseUrl: "https://api.acme.example/v1",
              api: "openai-completions",
              models: [{ id: "acme-pro", name: "Acme Pro" }],
            },
          },
        },
      },
    });
    resolvePreferredProviderForAuthChoice.mockReturnValue("acme-cloud");
    const prompter = createWizardPrompter();

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "acme-cloud-oauth",
        installDaemon: false,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(promptAuthChoiceGrouped).not.toHaveBeenCalled();
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "acme-cloud-oauth",
        setDefaultModel: false,
      }),
    );
    expect(resolvePreferredProviderForAuthChoice).toHaveBeenCalledWith(
      "acme-cloud-oauth",
      expect.objectContaining({ config: expect.any(Object) }),
    );
    expect(promptDefaultModel).not.toHaveBeenCalled();
  });

  it("does not offer SAT mining attach or switch for an existing self-hosted Solana wallet", async () => {
    writeConfigFile.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__WALLET_1: "https://api.devnet.solana.com",
          },
        },
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                network: "devnet",
                riskMode: "balanced",
              },
            },
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "wallet-1",
          name: "Wallet 1",
          providerId: "local-socket-signer",
          addresses: { solana: "miner-sol-1" },
          metadata: { selfHosted: true },
        },
        {
          id: "agent-2",
          name: "Agent 2",
          providerId: "local-socket-signer",
          addresses: { solana: "agent-two-solana-address" },
          metadata: { selfHosted: true, role: "agent", purpose: "agent" },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        expect((opts as { options?: unknown }).options).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              value: "wallet-1",
              label: "Wallet 1 · @wallet:wallet-1",
              hint: "mi..-1",
            }),
            expect.objectContaining({
              value: "agent-2",
              label: "Agent 2 · @wallet:agent-2",
              hint: "ag..ss",
            }),
          ]),
        );
        return "wallet-1";
      }
      if (message === "Wallet action") {
        const actionOptions = Array.isArray((opts as { options?: unknown[] }).options)
          ? ((opts as { options?: Array<{ value?: unknown }> }).options ?? []).flatMap((option) =>
              typeof option.value === "string" && option.value.length > 0 ? [option.value] : [],
            )
          : [];
        expect(actionOptions).toContain("configure-solana-rpc");
        expect(actionOptions).not.toContain("attach-sat-mining");
        expect(actionOptions).not.toContain("detach-sat-mining");
        return "cancel";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        plugins: {
          entries: {
            "sat-mining": expect.objectContaining({
              config: expect.not.objectContaining({
                walletId: "wallet-1",
              }),
            }),
          },
        },
      }),
    );
  });

  it("routes the singleton Mining wallet to coordinated retirement instead of archive", async () => {
    deleteNamedWallet.mockClear();
    lockSignerOwnedWalletForArchive.mockClear();
    restartLocalSocketSigner.mockClear();
    resolveWalletUserRole.mockReset();
    resolveWalletUserRole.mockReturnValue("mining");
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__MINING: "https://api.devnet.solana.com",
            FASED_WALLET_SOLANA_KEYSTORE_PATH__MINING: "/tmp/fased-test-mining-wallet.enc",
          },
        },
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                walletId: "mining",
                network: "devnet",
                riskMode: "balanced",
              },
            },
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "mining",
          name: "Mining",
          providerId: "local-socket-signer",
          addresses: { solana: "mining-sol-1" },
          metadata: { selfHosted: true, role: "mining", signerWalletId: "mining" },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "mining";
      }
      if (message === "Wallet action") {
        return "retire-mining";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === 'Type wallet id "mining" to archive/remove this wallet from Fased') {
        return "mining";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("fased wallet retire --wallet-id mining"),
      "Retire and replace Mining wallet",
    );
    expect(lockSignerOwnedWalletForArchive).not.toHaveBeenCalled();
    expect(deleteNamedWallet).not.toHaveBeenCalled();
    expect(restartLocalSocketSigner).not.toHaveBeenCalled();
    resolveWalletUserRole.mockReset();
    resolveWalletUserRole.mockReturnValue(undefined);
  });

  it("keeps a hyphenated signer wallet registered when deny-all is not acknowledged", async () => {
    deleteNamedWallet.mockClear();
    restartLocalSocketSigner.mockClear();
    lockSignerOwnedWalletForArchive.mockRejectedValueOnce(
      new Error("signer policy version conflict"),
    );
    resolveWalletUserRole.mockReset();
    resolveWalletUserRole.mockReturnValue("agent");
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__AGENT_2: "https://api.devnet.solana.com",
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "agent-2",
          name: "Agent 2",
          providerId: "local-socket-signer",
          addresses: { solana: "agent-sol-2" },
          metadata: { selfHosted: true, role: "agent", signerWalletId: "agent_2" },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "agent-2";
      }
      if (message === "Wallet action") {
        return "archive";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === 'Type wallet id "agent-2" to archive/remove this wallet from Fased') {
        return "agent-2";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async () => false) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(lockSignerOwnedWalletForArchive).toHaveBeenCalledWith({
      wallet: expect.objectContaining({
        id: "agent-2",
        metadata: expect.objectContaining({ signerWalletId: "agent_2" }),
      }),
      socketPath: expect.any(String),
    });
    expect(deleteNamedWallet).not.toHaveBeenCalled();
    expect(restartLocalSocketSigner).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("no Fased registration or attachment was removed"),
      "Archive blocked",
    );
    resolveWalletUserRole.mockReset();
    resolveWalletUserRole.mockReturnValue(undefined);
  });

  it("offers only Solana RPC repair for an existing self-hosted Solana wallet without RPC", async () => {
    writeConfigFile.mockClear();
    restartLocalSocketSigner.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                network: "devnet",
                riskMode: "balanced",
              },
            },
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "wallet-1",
          name: "Wallet 1",
          providerId: "local-socket-signer",
          addresses: { solana: "miner-sol-1" },
          metadata: { selfHosted: true },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    let actionOptions: string[] = [];
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "wallet-1";
      }
      if (message === "Wallet action") {
        actionOptions = Array.isArray((opts as { options?: unknown[] }).options)
          ? ((opts as { options?: Array<{ value?: unknown }> }).options ?? []).flatMap((option) =>
              typeof option.value === "string" && option.value.length > 0 ? [option.value] : [],
            )
          : [];
        return "cancel";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(actionOptions).toContain("configure-solana-rpc");
    expect(actionOptions).not.toContain("attach-sat-mining");
    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        plugins: {
          entries: {
            "sat-mining": expect.objectContaining({
              config: expect.not.objectContaining({
                walletId: expect.anything(),
              }),
            }),
          },
        },
      }),
    );
    expect(restartLocalSocketSigner).not.toHaveBeenCalled();
  });

  it("does not offer SAT mining attachment for an existing self-hosted Solana wallet during onboarding", async () => {
    writeConfigFile.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                network: "devnet",
                riskMode: "balanced",
              },
            },
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "solana-1",
          name: "Solana 1",
          providerId: "local-socket-signer",
          addresses: { solana: "So11111111111111111111111111111111111111112" },
          metadata: { selfHosted: true },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    let actionOptions: string[] = [];
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "solana-1";
      }
      if (message === "Wallet action") {
        actionOptions = Array.isArray((opts as { options?: unknown[] }).options)
          ? ((opts as { options?: Array<{ value?: unknown }> }).options ?? []).flatMap((option) =>
              typeof option.value === "string" && option.value.length > 0 ? [option.value] : [],
            )
          : [];
        return "cancel";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(actionOptions).toContain("configure-solana-rpc");
    expect(actionOptions).not.toContain("attach-sat-mining");
    expect(actionOptions).not.toContain("detach-sat-mining");
  });

  it("can update Solana RPC for an existing self-hosted wallet during onboarding management", async () => {
    writeConfigFile.mockClear();
    restartLocalSocketSigner.mockClear();
    resolveNativeSignerOperatorLifecycle.mockReturnValue({
      signerBinPath: "/opt/fased/current/payload/bin/fased-signerd",
      operatorSocketPath: "/run/fased-local/instance-1/operator/operator.sock",
    });
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__WALLET_1: "https://old-rpc.example",
            FASED_WALLET_SOLANA_EXECUTION_FALLBACK_RPC_URL__WALLET_1: "",
            FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL__WALLET_1:
              "https://advanced-execution.example/solana",
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "wallet-1",
          name: "Wallet 1",
          providerId: "local-socket-signer",
          addresses: { solana: "miner-sol-1" },
          metadata: { selfHosted: true },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "wallet-1";
      }
      if (message === "Wallet action") {
        return "configure-solana-rpc";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message.includes("SOLANA RPC URL for Wallet 1 · @wallet:wallet-1")) {
        return "https://new-rpc.example";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          vars: expect.objectContaining({
            FASED_WALLET_SOLANA_RPC_URL__WALLET_1: "https://new-rpc.example",
          }),
        }),
      }),
    );
    expect(restartLocalSocketSigner).not.toHaveBeenCalled();
    expect(invokeNativeSignerNetworkSetPrimary).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "wallet_1",
        primaryRpcUrl: "https://new-rpc.example",
        expectedVersion: 1,
        signerBinPath: "/opt/fased/current/payload/bin/fased-signerd",
        socketFlag: "--operator-socket",
        socketPath: "/run/fased-local/instance-1/operator/operator.sock",
      }),
    );
    expect(configureSignerOwnedWalletNetwork).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      "Saved RPC for Wallet 1 · @wallet:wallet-1; wallet network version 2 is ready",
      "Wallet setup",
    );
  });

  it("keeps the current RPC and stays in onboarding when a replacement cannot be verified", async () => {
    invokeNativeSignerNetworkSetPrimary.mockImplementationOnce(() => {
      throw new Error("signer-owned Solana RPC genesis verification failed");
    });
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__WALLET_1: "https://old-rpc.example",
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "wallet-1",
          name: "Wallet 1",
          providerId: "local-socket-signer",
          addresses: { solana: "miner-sol-1" },
          metadata: { selfHosted: true },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown }).message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "wallet-1";
      }
      if (message === "Wallet action") {
        return "configure-solana-rpc";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown }).message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      return message.includes("RPC URL") ? "https://not-an-rpc.example" : "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async () => false) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("RPC was not changed."),
      "RPC not saved",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Any HTTPS Solana RPC provider is supported"),
      "RPC not saved",
    );
    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          vars: expect.objectContaining({
            FASED_WALLET_SOLANA_RPC_URL__WALLET_1: "https://old-rpc.example",
          }),
        }),
      }),
    );
    expect(process.env.FASED_WALLET_SOLANA_RPC_URL__WALLET_1).not.toBe(
      "https://not-an-rpc.example",
    );
  });

  it("does not offer SAT mining detach from onboarding manage-self-hosted flow", async () => {
    writeConfigFile.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      config: {
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                enabled: true,
                network: "devnet",
                riskMode: "balanced",
                walletId: "wallet-1",
              },
            },
          },
        },
      },
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "wallet-1",
          name: "Wallet 1",
          providerId: "local-socket-signer",
          addresses: { solana: "miner-sol-1" },
          metadata: { selfHosted: true },
        },
      ],
      assignments: {},
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    let actionOptions: string[] = [];
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "manage-self-hosted";
      }
      if (message === "Select wallet to manage") {
        return "wallet-1";
      }
      if (message === "Wallet action") {
        actionOptions = Array.isArray((opts as { options?: unknown[] }).options)
          ? ((opts as { options?: Array<{ value?: unknown }> }).options ?? []).flatMap((option) =>
              typeof option.value === "string" && option.value.length > 0 ? [option.value] : [],
            )
          : [];
        return "cancel";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        plugins: {
          entries: {
            "sat-mining": expect.objectContaining({
              config: expect.objectContaining({
                walletId: "wallet-1",
              }),
            }),
          },
        },
      }),
    );
    expect(actionOptions).toContain("configure-solana-rpc");
    expect(actionOptions).not.toContain("attach-sat-mining");
    expect(actionOptions).not.toContain("detach-sat-mining");
  });

  it("exits when config is invalid", async () => {
    (
      readConfigFileSnapshot as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      path: "/tmp/.fased/fased.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
      legacyIssues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });

    const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await expect(
      runOnboardingWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("exit:1");

    expect(prompter.outro).toHaveBeenCalled();
  });

  it("persists managed gateway mode when local onboarding enables federation", async () => {
    configureFederationForOnboarding.mockResolvedValueOnce({
      enabled: true,
      baseUrl: "https://ff1.fased.app",
      handle: "@ready-node@ff1.fased.app",
    });

    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        allowInsecure: true,
        flow: "quickstart",
        mode: "local",
        hostProfile: "local",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(writeConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          vars: expect.objectContaining({
            FASED_FEDERATION_AUTO_CONNECT: "1",
            FASED_GATEWAY_MODE: "managed",
          }),
        }),
      }),
    );
  });

  it("skips prompts and setup steps when flags are set", async () => {
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const multiselect = vi.fn(async () => []) as unknown as WizardPrompter["multiselect"];
    const prompter = createWizardPrompter({ select, multiselect });
    const runtime = createRuntime({ throwsOnExit: true });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });

  it("allows hosted profile selection in app maintenance sessions", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fased-app-home-"));
    vi.stubEnv("USER", "app");
    vi.stubEnv("HOME", tempHome);

    try {
      configureGatewayForOnboarding.mockImplementationOnce(async () => {
        throw new Error("gateway-config-reached");
      });
      const select = vi.fn(async (opts: unknown) => {
        const rawMessage = (opts as { message?: unknown })?.message;
        const message = typeof rawMessage === "string" ? rawMessage : "";
        if (message === "Host setup profile") {
          return "hosting";
        }
        if (message === "Wallet setup action") {
          return "skip";
        }
        if (message === "How do you want to hatch your bot?") {
          return "skip";
        }
        return "quickstart";
      }) as unknown as WizardPrompter["select"];
      const prompter = createWizardPrompter({ select });
      const runtime = createRuntime({ throwsOnExit: true });

      await expect(
        runOnboardingWizard(
          {
            acceptRisk: true,
            flow: "quickstart",
            authChoice: "skip",
            installDaemon: false,
            skipProviders: true,
            skipSkills: true,
            skipHealth: true,
            skipUi: true,
          },
          runtime,
          prompter,
        ),
      ).rejects.toThrow("gateway-config-reached");

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Host setup profile",
        }),
      );
      expect(prompter.note).not.toHaveBeenCalledWith(
        expect.stringContaining("This session cannot run hosting security setup."),
        expect.any(String),
      );
      expect(runtime.exit).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("offers wallet setup during hosted quickstart even before wallet runtime exists", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-wallet-skip-"));
    vi.stubEnv("USER", "app");
    vi.stubEnv("HOME", tempHome);
    configureWalletForOnboarding.mockImplementationOnce(async ({ nextConfig }) => ({
      ...nextConfig,
      wallet: {
        ...nextConfig.wallet,
        runtime: { ...nextConfig.wallet?.runtime, enabled: false },
      },
    }));
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "skip";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    writeConfigFile.mockImplementationOnce(async () => {
      throw new Error("write-reached");
    });

    try {
      await expect(
        runOnboardingWizard(
          {
            acceptRisk: true,
            flow: "quickstart",
            authChoice: "skip",
            hostProfile: "hosting",
            installDaemon: false,
            skipProviders: true,
            skipSkills: true,
            skipHealth: true,
            skipUi: true,
          },
          createRuntime({ throwsOnExit: true }),
          prompter,
        ),
      ).rejects.toThrow("write-reached");

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Wallet setup action",
          initialValue: "skip",
        }),
      );
      expect(ensureSystemdUserLingerInteractive).not.toHaveBeenCalled();
      expect(configureWalletForOnboarding).toHaveBeenCalledTimes(1);
      expect(walletSetupCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("defaults local quickstart wallet setup to finish later", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fased-local-wallet-skip-"));
    vi.stubEnv("USER", "fc");
    vi.stubEnv("HOME", tempHome);
    configureWalletForOnboarding.mockImplementationOnce(async ({ nextConfig }) => ({
      ...nextConfig,
      wallet: {
        ...nextConfig.wallet,
        runtime: { ...nextConfig.wallet?.runtime, enabled: true },
      },
    }));
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "skip";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    writeConfigFile.mockImplementationOnce(async () => {
      throw new Error("write-reached");
    });

    try {
      await expect(
        runOnboardingWizard(
          {
            acceptRisk: true,
            flow: "quickstart",
            authChoice: "skip",
            hostProfile: "local",
            installDaemon: false,
            skipProviders: true,
            skipSkills: true,
            skipHealth: true,
            skipUi: true,
          },
          createRuntime({ throwsOnExit: true }),
          prompter,
        ),
      ).rejects.toThrow("write-reached");

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Wallet setup action",
          initialValue: "skip",
        }),
      );
      expect(walletSetupCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps the Gateway on app.sock while native Hosting lifecycle calls derive operator.sock", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-wallet-create-"));
    const appSocket = "/run/fased-signerd/app.sock";
    const observedSignerSockets: string[] = [];
    vi.stubEnv("USER", "app");
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", appSocket);
    configureWalletForOnboarding
      .mockImplementationOnce(async ({ nextConfig }) => {
        observedSignerSockets.push(String(process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? ""));
        delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
        return {
          ...nextConfig,
          wallet: {
            ...nextConfig.wallet,
            runtime: { ...nextConfig.wallet?.runtime, enabled: false },
          },
        };
      })
      .mockImplementationOnce(async ({ nextConfig }) => {
        observedSignerSockets.push(String(process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? ""));
        return {
          ...nextConfig,
          wallet: {
            ...nextConfig.wallet,
            provider: { ...nextConfig.wallet?.provider, id: "local-socket-signer" },
            runtime: { ...nextConfig.wallet?.runtime, enabled: true },
          },
        };
      });
    walletSetupCommand.mockImplementationOnce(async () => {
      observedSignerSockets.push(String(process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? ""));
    });
    collectWalletSignerDoctorReport.mockImplementationOnce(async () => {
      observedSignerSockets.push(String(process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? ""));
      return {
        checks: [
          { check: "socket.exists", ok: true },
          { check: "socket.health", ok: true },
        ],
      };
    });
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet action") {
        return "create";
      }
      if (message === "Wallet role (required)") {
        return "agent";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message.includes("RPC URL")) {
        return "https://api.devnet.solana.com";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const prompter = createWizardPrompter({ select, text });
    writeConfigFile.mockImplementationOnce(async (config) => {
      expect(
        (config as { env?: { vars?: Record<string, string> } }).env?.vars
          ?.FASED_WALLET_LOCAL_SIGNER_SOCKET,
      ).toBe(appSocket);
      expect(
        (config as { env?: { vars?: Record<string, string> } }).env?.vars?.FASED_HOST_PROFILE,
      ).toBe("hosting");
      throw new Error("write-reached");
    });

    try {
      await expect(
        runOnboardingWizard(
          {
            acceptRisk: true,
            flow: "quickstart",
            authChoice: "skip",
            hostProfile: "hosting",
            installDaemon: false,
            skipProviders: true,
            skipSkills: true,
            skipHealth: true,
            skipUi: true,
          },
          createRuntime({ throwsOnExit: true }),
          prompter,
        ),
      ).rejects.toThrow("write-reached");

      expect(configureWalletForOnboarding).toHaveBeenCalledTimes(2);
      expect(configureWalletForOnboarding).toHaveBeenLastCalledWith(
        expect.objectContaining({
          forceEnable: true,
          hostProfile: "hosting",
        }),
      );
      expect(walletSetupCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          mode: "local-signer-create",
          rpcUrl: "https://api.devnet.solana.com",
        }),
      );
      expect(observedSignerSockets).toEqual([appSocket, appSocket, appSocket, appSocket]);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("routes hosted signer import through the normal native operator lifecycle", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-wallet-import-"));
    vi.stubEnv("USER", "app");
    vi.stubEnv("HOME", tempHome);
    const select = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet action") {
        return "import";
      }
      if (message === "Wallet role (required)") {
        return "agent";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message.includes("keypair JSON")) {
        return path.join(tempHome, "wallet.json");
      }
      if (message.includes("RPC URL")) {
        return "https://api.devnet.solana.com";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const rawMessage = (opts as { message?: unknown })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "";
      if (message === "Run another wallet setup action?") {
        return false;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createWizardPrompter({ select, text, confirm, note });
    try {
      await expect(
        runOnboardingWizard(
          {
            acceptRisk: true,
            flow: "quickstart",
            authChoice: "skip",
            hostProfile: "hosting",
            installDaemon: false,
            skipProviders: true,
            skipSkills: true,
            skipHealth: true,
            skipUi: true,
          },
          createRuntime({ throwsOnExit: true }),
          prompter,
        ),
      ).rejects.toThrow(/Hosting requires the root-managed fased-gateway/);
      expect(walletSetupCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          mode: "local-signer-import",
          importFile: path.join(tempHome, "wallet.json"),
          role: "agent",
          rpcUrl: "https://api.devnet.solana.com",
        }),
      );
      expect(note).not.toHaveBeenCalledWith(
        expect.stringMatching(/provider root console/),
        expect.anything(),
      );
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("shows the operator readiness summary at onboarding completion", async () => {
    configureFederationForOnboarding.mockResolvedValueOnce({
      enabled: true,
      baseUrl: "https://ff1.fased.app",
      handle: "@ready-node",
    });
    readWalletProviderRegistry.mockReturnValue({
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-03-15T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "wallet-agent",
          name: "Agent Wallet",
          providerId: "embedded-keystore",
        },
        {
          id: "wallet-1",
          name: "Wallet 1",
          providerId: "local-socket-signer",
        },
      ],
      assignments: {},
      defaultWalletId: "wallet-agent",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    readWalletStatusSnapshot.mockResolvedValue({
      approvalAuth: {
        mode: "webauthn",
        ready: true,
        passkeyCount: 1,
      },
    });
    loadPersistedFederationToken.mockResolvedValue({
      tokenId: "fed-token-1",
      nodeId: "node-1",
      handle: "@ready-node",
      issuedAt: "2026-04-08T00:00:00.000Z",
      expiresAt: "2027-04-08T00:00:00.000Z",
      scopes: ["tasks.create"],
      signature: "sig",
      trustState: "verified",
      hostedState: "ready",
      publicUrl: "https://ready.example.com",
    });
    const select = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Wallet setup action") {
        return "self-hosted";
      }
      if (message === "Wallet chain") {
        return "solana";
      }
      if (message === "Wallet action") {
        return "create";
      }
      if (message === "Wallet role (required)") {
        return "agent";
      }
      if (message === "How do you want to hatch your bot?") {
        return "skip";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message.includes("RPC URL")) {
        return "https://api.devnet.solana.com";
      }
      return "";
    }) as unknown as WizardPrompter["text"];
    const confirm = vi.fn(async (opts: unknown) => {
      const message =
        typeof (opts as { message?: unknown })?.message === "string"
          ? String((opts as { message?: unknown }).message)
          : "";
      if (message === "Use Wallet 1 (wallet-1) as the Agent wallet?") {
        return false;
      }
      if (message === "Attach Wallet 1 (wallet-1) as the SAT Mining wallet now?") {
        return true;
      }
      return false;
    }) as unknown as WizardPrompter["confirm"];
    const prompter = createWizardPrompter({ select, text, confirm });

    await runOnboardingWizard(
      {
        acceptRisk: true,
        allowInsecure: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime({ throwsOnExit: true }),
      prompter,
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("READINESS"),
      "Operator readiness",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("PASSKEY: Passkey approval ready (1)"),
      "Operator readiness",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("AGENT WALLET: Agent Wallet"),
      "Operator readiness",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("MINING WALLET:"),
      "Operator readiness",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("NETWORK TRUST: Verified"),
      "Operator readiness",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("NETWORK REACHABILITY: Ready"),
      "Operator readiness",
    );
  });

  async function runDefaultHatchTest(params: { writeBootstrapFile: boolean }) {
    runTui.mockClear();

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-onboard-"));
    try {
      if (params.writeBootstrapFile) {
        await fs.writeFile(path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME), "{}");
      }

      const select = vi.fn(async (opts: unknown) => {
        const rawMessage = (opts as { message?: unknown })?.message;
        const message = typeof rawMessage === "string" ? rawMessage : "";
        if (message === "Wallet setup action") {
          return "skip";
        }
        if (message === "Host setup profile") {
          return "local";
        }
        return "quickstart";
      }) as unknown as WizardPrompter["select"];

      const prompter = createWizardPrompter({ select });
      const runtime = createRuntime({ throwsOnExit: true });

      await runOnboardingWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          mode: "local",
          hostProfile: "local",
          workspace: workspaceDir,
          authChoice: "skip",
          skipProviders: true,
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
        },
        runtime,
        prompter,
      );

      expect(runTui).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }

  it("defaults local onboarding to the Web UI without launching TUI", async () => {
    await runDefaultHatchTest({ writeBootstrapFile: true });
  });

  it("does not require BOOTSTRAP.md for the default Web UI hatch path", async () => {
    await runDefaultHatchTest({ writeBootstrapFile: false });
  });
});
