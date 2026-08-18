import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveFasedAgentAgentDir } from "../agents/agent-paths.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { promptAuthChoiceGrouped } from "../commands/auth-choice-prompt.js";
import {
  applyAuthChoice,
  resolvePreferredProviderForAuthChoice,
  warnIfModelConfigLooksOff,
} from "../commands/auth-choice.js";
import { applyPrimaryModel, resolveAuthenticatedDefaultModel } from "../commands/model-picker.js";
import { setupChannels } from "../commands/onboard-channels.js";
import { applyOnboardingLocalWorkspaceConfig } from "../commands/onboard-config.js";
import { promptCustomApiConfig } from "../commands/onboard-custom.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  handleOnboardingRepair,
  printWizardHeader,
  probeGatewayReachable,
  summarizeExistingConfig,
} from "../commands/onboard-helpers.js";
import { setupInternalHooks } from "../commands/onboard-hooks.js";
import { promptRemoteGatewayConfig } from "../commands/onboard-remote.js";
import { setupSkills } from "../commands/onboard-skills.js";
import type {
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  OnboardRepairScope,
} from "../commands/onboard-types.js";
import {
  collectWalletSignerDoctorReport,
  invokeNativeSignerNetworkSetPrimary,
  walletSetupCommand,
} from "../commands/wallet.js";
import type { FasedAgentConfig } from "../config/config.js";
import { readConfigFileSnapshot, resolveGatewayPort, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { lockSignerOwnedWalletForArchive } from "../wallet/local-socket-signer-archive.js";
import { readSignerOwnedWalletReadiness } from "../wallet/local-socket-signer-lifecycle.js";
import { resolveNativeSignerOperatorLifecycle } from "../wallet/native-signer-lifecycle-context.js";
import { resolveNativeSignerWalletId } from "../wallet/native-signer-wallet-id.js";
import { discoverSolanaNetworkFromRpc } from "../wallet/solana-network-discovery.js";
import type { WalletNamedWallet } from "../wallet/wallet-provider-registry.js";
import { readWalletProviderRegistry } from "../wallet/wallet-provider-registry.js";
import {
  checkNamedWalletDeletionSafety,
  deleteNamedWallet,
  nextRoleWalletIdentity,
  resolveWalletUserRole,
  setNamedWalletRole,
  upsertNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import { walletRecoveryFacade } from "../wallet/wallet-recovery-facade.js";
import {
  ensureWalletStateDir,
  resolveLocalSignerControlSocketPath,
  resolveLocalSignerMaterialRootDir,
  resolveLocalSignerSocketPath,
} from "../wallet/wallet-runtime-config.js";
import { isHostedSecurityCapableSession } from "./host-security-capability.js";
import { isProtectedLocalInstallerScaffold } from "./onboarding-existing-config.js";
import {
  noteBullet,
  noteCommand,
  noteHeading,
  noteLabel,
  noteStep,
  noteSuccess,
  noteWarn,
} from "./onboarding-note-format.js";
import { configureFederationForOnboarding } from "./onboarding.federation.js";
import { finalizeOnboardingWizard } from "./onboarding.finalize.js";
import { configureGatewayForOnboarding } from "./onboarding.gateway-config.js";
import { applyHostingSecurity } from "./onboarding.host-security.js";
import type {
  HostSetupProfile,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./onboarding.types.js";
import {
  configureWalletForOnboarding,
  installSignerdBinary,
  restartLocalSocketSigner,
  resolveSignerdBinaryPath,
} from "./onboarding.wallet.js";
import type { WizardPrompter } from "./prompts.js";
import { normalizeHostedWalletPaths } from "./wallet-path-migration.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  void params;
}

async function applyOnboardingAuthChoice(params: {
  authChoice: Exclude<OnboardOptions["authChoice"], "custom-api-key" | "skip" | undefined>;
  config: FasedAgentConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  opts?: Partial<OnboardOptions>;
}): Promise<FasedAgentConfig> {
  const agentDir = resolveFasedAgentAgentDir();
  const authResult = await applyAuthChoice({
    authChoice: params.authChoice,
    config: params.config,
    prompter: params.prompter,
    runtime: params.runtime,
    setDefaultModel: false,
    agentDir,
    opts: params.opts,
  });
  const preferredProvider = resolvePreferredProviderForAuthChoice(params.authChoice, {
    config: authResult.config,
  });
  const authenticatedDefault = await resolveAuthenticatedDefaultModel({
    config: authResult.config,
    agentDir,
    preferredProvider,
  });
  return authenticatedDefault
    ? applyPrimaryModel(authResult.config, authenticatedDefault)
    : authResult.config;
}

async function confirmOnboardingRepair(params: { prompter: WizardPrompter }): Promise<boolean> {
  await params.prompter.note(
    [
      "Repair is for bad auth/session state while keeping the instance configuration intact.",
      "",
      "It keeps gateway token/password, gateway settings, wallet assignments, SAT mining, Fased Network, plugins, Tailscale, and firewall state.",
      "It can remove model/OAuth credentials and chat/session history depending on the scope you choose.",
      "",
      "For destructive config reset, use the explicit admin command: fased reset.",
    ].join("\n"),
    "Repair safety",
  );

  const confirmed = await params.prompter.confirm({
    message: "Continue to repair scope selection?",
    initialValue: false,
  });
  if (!confirmed) {
    await params.prompter.note("Repair cancelled. Existing config is still active.", "Repair");
  }
  return confirmed;
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  const hostSecurityCapable = isHostedSecurityCapableSession(opts.hostSecurityCapable === true);
  const installUser = (process.env.FASED_INSTALL_USER?.trim() || "app").trim();
  const hostMaintenanceSession =
    opts.hostMaintenanceSession === true ||
    (installUser.length > 0 &&
      (process.env.USER?.trim() || process.env.LOGNAME?.trim()) === installUser);
  const walletIdEnvSuffix = (walletId?: string): string | undefined => {
    const normalized = String(walletId ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized ? normalized.toUpperCase() : undefined;
  };
  const rpcEnvKeyFor = (_chain: "solana", walletId?: string): string => {
    const suffix = walletIdEnvSuffix(walletId);
    if (suffix) {
      return `FASED_WALLET_SOLANA_RPC_URL__${suffix}`;
    }
    return "FASED_WALLET_SOLANA_RPC_URL";
  };
  const setConfigEnvVar = (
    cfg: FasedAgentConfig,
    key: string,
    value: string | undefined,
  ): FasedAgentConfig => {
    const vars = { ...cfg.env?.vars };
    if (value == null || value === "") {
      delete vars[key];
    } else {
      vars[key] = value;
    }
    return {
      ...cfg,
      env: {
        ...cfg.env,
        vars,
      },
    };
  };
  const hostedSignerAppSocket = "/run/fased-signerd/app.sock";
  const hostedSignerOwnedKeys = [
    "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
    "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
    "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
    "FASED_WALLET_LOCAL_SIGNER_BIN",
    "FASED_WALLET_SIGNER_STATE_DIR",
    "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
    "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
    "FASED_WALLET_PASSPHRASE_FILE",
    "FASED_WALLET_WEBAUTHN_RP_ID",
    "FASED_WALLET_WEBAUTHN_ORIGINS",
  ] as const;
  const clearHostedLocalSignerConfig = (cfg: FasedAgentConfig): FasedAgentConfig => {
    let next = cfg;
    for (const key of hostedSignerOwnedKeys) {
      next = setConfigEnvVar(next, key, undefined);
    }
    return setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_SOCKET", undefined);
  };
  const prepareHostedLocalSignerOnboarding = (cfg: FasedAgentConfig): FasedAgentConfig => {
    for (const key of hostedSignerOwnedKeys) {
      delete process.env[key];
    }
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = hostedSignerAppSocket;
    return clearHostedLocalSignerConfig(cfg);
  };
  const persistHostedLocalSignerRuntime = (cfg: FasedAgentConfig): FasedAgentConfig => {
    let next = clearHostedLocalSignerConfig(cfg);
    next = setConfigEnvVar(next, "FASED_HOST_PROFILE", "hosting");
    return setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_SOCKET", hostedSignerAppSocket);
  };
  const activateHostedLocalSignerRuntimeEnv = (): void => {
    for (const key of hostedSignerOwnedKeys) {
      delete process.env[key];
    }
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = hostedSignerAppSocket;
  };
  const syncLocalSignerRuntimeEnvIntoConfig = (cfg: FasedAgentConfig): FasedAgentConfig => {
    if (
      !(cfg.wallet?.runtime?.enabled === true && cfg.wallet?.provider?.id === "local-socket-signer")
    ) {
      return cfg;
    }
    let next = cfg;
    const signerSocketPath = resolveLocalSignerSocketPath(process.env);
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = signerSocketPath;
    next = setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_SOCKET", signerSocketPath);
    delete process.env.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET;
    next = setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET", undefined);
    const signerStateDir = resolveLocalSignerMaterialRootDir(process.env);
    if (signerStateDir !== ensureWalletStateDir(process.env).rootDir) {
      process.env.FASED_WALLET_SIGNER_STATE_DIR = signerStateDir;
      next = setConfigEnvVar(next, "FASED_WALLET_SIGNER_STATE_DIR", signerStateDir);
    } else {
      delete process.env.FASED_WALLET_SIGNER_STATE_DIR;
      next = setConfigEnvVar(next, "FASED_WALLET_SIGNER_STATE_DIR", undefined);
    }
    delete process.env.FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER;
    next = setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER", undefined);
    const signerBinPath = String(process.env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim();
    if (signerBinPath) {
      next = setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_BIN", signerBinPath);
    } else {
      delete process.env.FASED_WALLET_LOCAL_SIGNER_BIN;
      next = setConfigEnvVar(next, "FASED_WALLET_LOCAL_SIGNER_BIN", undefined);
    }
    return next;
  };
  const jupiterApiKeyEnvKey = "FASED_JUPITER_API_KEY"; // pragma: allowlist secret
  const legacyJupiterTriggerApiBaseUrlEnvKey = "FASED_JUPITER_TRIGGER_API_BASE_URL";
  const readJupiterSwapApiKey = (): string =>
    String(
      process.env[jupiterApiKeyEnvKey] ??
        nextConfig.env?.vars?.[jupiterApiKeyEnvKey] ??
        process.env.JUPITER_API_KEY ??
        nextConfig.env?.vars?.JUPITER_API_KEY ??
        "",
    ).trim();
  const promptAndStoreJupiterSwapApi = async (): Promise<boolean> => {
    const existingKey = readJupiterSwapApiKey();
    const enable = await prompter.confirm({
      message: existingKey
        ? "Keep Gateway Jupiter Swap API access enabled?"
        : "Enable Gateway Jupiter Swap API access? Trigger credentials remain signer-owned.",
      initialValue: Boolean(existingKey),
    });
    if (!enable) {
      nextConfig = setConfigEnvVar(nextConfig, jupiterApiKeyEnvKey, undefined);
      delete process.env[jupiterApiKeyEnvKey];
      await prompter.note(
        "Gateway Jupiter Swap API access disabled. Native signer Trigger configuration is unchanged.",
        "Jupiter swaps",
      );
      return false;
    }
    const keyPrompt = existingKey
      ? "Jupiter Swap API key (blank keeps current)"
      : "Jupiter Swap API key";
    const keyInput = (
      typeof prompter.secret === "function" // pragma: allowlist secret
        ? await prompter.secret({
            message: keyPrompt,
            validate: (value) =>
              value.trim() || existingKey ? undefined : "Jupiter API key is required",
          })
        : await prompter.text({
            message: keyPrompt,
            validate: (value) =>
              value.trim() || existingKey ? undefined : "Jupiter API key is required",
          })
    ).trim();
    const effectiveKey = keyInput || existingKey;
    if (!effectiveKey) {
      throw new Error("Jupiter API key is required to enable Gateway swap crafting.");
    }
    nextConfig = setConfigEnvVar(nextConfig, jupiterApiKeyEnvKey, effectiveKey);
    process.env[jupiterApiKeyEnvKey] = effectiveKey;

    await prompter.note(
      [
        "Gateway Jupiter Swap API access enabled for Agent wallet swap crafting.",
        `${jupiterApiKeyEnvKey} is stored in Gateway config for swaps only and is never printed in chat.`,
        "Jupiter Trigger credentials and production routing stay inside fased-signerd.",
      ].join("\n"),
      "Jupiter swaps",
    );
    return true;
  };
  const promptWalletRpcUrl = async (params: {
    chain: "solana";
    walletId: string;
    walletName: string;
    currentValue?: string;
  }): Promise<string> => {
    const rpcKey = rpcEnvKeyFor(params.chain, params.walletId);
    const initialValue =
      params.currentValue?.trim() ||
      (nextConfig.env?.vars?.[rpcKey] ?? "").trim() ||
      String(process.env[rpcKey] ?? "").trim();
    const rpcUrlInput = (
      await prompter.text({
        message: `${params.chain.toUpperCase()} RPC URL for ${params.walletName} · @wallet:${params.walletId}`,
        initialValue,
        placeholder: "https://your-solana-rpc-provider.example",
        validate: (value) =>
          value.trim() || initialValue
            ? undefined
            : `${params.chain.toUpperCase()} RPC URL is required`,
      })
    ).trim();
    const effectiveRpcUrl = rpcUrlInput || initialValue;
    if (!effectiveRpcUrl) {
      throw new Error(
        `${params.chain.toUpperCase()} RPC URL is required for ${params.walletName}.`,
      );
    }
    return effectiveRpcUrl;
  };
  const readSatMiningConfig = (
    cfg: FasedAgentConfig,
  ): {
    walletId?: string;
    network?: "local" | "devnet" | "mainnet-beta";
  } => {
    const config = cfg.plugins?.entries?.["sat-mining"]?.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return {};
    }
    const value = config as { walletId?: unknown; network?: unknown };
    const walletId =
      typeof value.walletId === "string" ? value.walletId.trim() || undefined : undefined;
    const network =
      value.network === "local" || value.network === "devnet" || value.network === "mainnet-beta"
        ? value.network
        : undefined;
    return { walletId, network };
  };
  const readFederationBondWalletId = (cfg: FasedAgentConfig): string | undefined => {
    const value = cfg.federation?.bond?.walletId;
    return typeof value === "string" ? value.trim() || undefined : undefined;
  };
  const assignFederationBondWallet = (
    cfg: FasedAgentConfig,
    params: { walletId: string },
  ): FasedAgentConfig => ({
    ...cfg,
    federation: {
      ...cfg.federation,
      bond: {
        ...cfg.federation?.bond,
        walletId: params.walletId,
      },
    },
  });
  const clearFederationBondWallet = (cfg: FasedAgentConfig): FasedAgentConfig => {
    const next = structuredClone(cfg);
    if (next.federation?.bond) {
      delete next.federation.bond.walletId;
      if (Object.keys(next.federation.bond).length === 0) {
        delete next.federation.bond;
      }
    }
    if (next.federation && Object.keys(next.federation).length === 0) {
      delete next.federation;
    }
    return next;
  };
  const assignWalletToSatMining = (
    cfg: FasedAgentConfig,
    params: { walletId: string; network: "local" | "devnet" | "mainnet-beta" },
  ): FasedAgentConfig => {
    const currentEntry = cfg.plugins?.entries?.["sat-mining"];
    const currentConfig =
      currentEntry?.config &&
      typeof currentEntry.config === "object" &&
      !Array.isArray(currentEntry.config)
        ? currentEntry.config
        : {};
    return {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        entries: {
          ...cfg.plugins?.entries,
          "sat-mining": {
            enabled: true,
            ...currentEntry,
            config: {
              ...currentConfig,
              walletId: params.walletId,
              role:
                currentConfig.role === "validator" ||
                currentConfig.role === "admin" ||
                currentConfig.role === "miner"
                  ? currentConfig.role
                  : "miner",
              network: params.network,
              riskMode:
                currentConfig.riskMode === "conservative" ||
                currentConfig.riskMode === "balanced" ||
                currentConfig.riskMode === "aggressive" ||
                currentConfig.riskMode === "swarm"
                  ? currentConfig.riskMode
                  : "balanced",
              claimMode:
                currentConfig.claimMode === "auto" ||
                currentConfig.claimMode === "manual" ||
                currentConfig.claimMode === "prompt"
                  ? currentConfig.claimMode
                  : "auto",
              payout: typeof currentConfig.payout === "boolean" ? currentConfig.payout : true,
              automation:
                currentConfig.automation &&
                typeof currentConfig.automation === "object" &&
                !Array.isArray(currentConfig.automation)
                  ? currentConfig.automation
                  : {
                      autoFinalizeEpoch: true,
                      autoClaim: true,
                    },
            },
          },
        },
      },
    };
  };
  const clearSatMiningAttachment = (cfg: FasedAgentConfig): FasedAgentConfig => {
    const currentEntry = cfg.plugins?.entries?.["sat-mining"];
    const currentConfig =
      currentEntry?.config &&
      typeof currentEntry.config === "object" &&
      !Array.isArray(currentEntry.config)
        ? currentEntry.config
        : {};
    const nextSatConfig = { ...currentConfig } as Record<string, unknown>;
    delete nextSatConfig.walletId;
    return {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        entries: {
          ...cfg.plugins?.entries,
          "sat-mining": {
            enabled: true,
            ...currentEntry,
            config: nextSatConfig,
          },
        },
      },
    };
  };
  const hasCommand = (name: string): boolean => {
    const probe = spawnSync("bash", ["-lc", `command -v ${name}`], { stdio: "ignore" });
    return probe.status === 0;
  };
  type WalletOnboardingPurpose = "agent" | "mining" | "vault";
  const nextWalletIdentity = (purpose: WalletOnboardingPurpose) => {
    const registry = readWalletProviderRegistry(process.env);
    return nextRoleWalletIdentity(purpose, registry.wallets);
  };
  const resolveWalletIdentityForOnboarding = async (params: {
    flow: WizardFlow;
    purpose: WalletOnboardingPurpose;
  }): Promise<{ walletName: string; walletId: string }> => {
    const generatedIdentity = nextWalletIdentity(params.purpose);
    if (params.flow === "quickstart") {
      return generatedIdentity;
    }
    const walletName = (
      await prompter.text({
        message: `Wallet name (display label only; handle will be @wallet:${generatedIdentity.walletId})`,
        initialValue: generatedIdentity.walletName,
        validate: (value) => (value.trim() ? undefined : "Wallet name is required"),
      })
    ).trim();
    return { walletName, walletId: generatedIdentity.walletId };
  };
  const describeWalletRef = (params: { walletId?: string; walletName?: string }): string => {
    const walletId = String(params.walletId ?? "").trim();
    const walletName = String(params.walletName ?? "").trim();
    if (walletName && walletId) {
      return `${walletName} · @wallet:${walletId}`;
    }
    return walletName || (walletId ? `@wallet:${walletId}` : "not set");
  };
  const readRoleWallet = (
    role: WalletOnboardingPurpose,
  ): { walletId?: string; walletName?: string } => {
    const registry = readWalletProviderRegistry(process.env);
    const wallet =
      registry.wallets.find((entry) => resolveWalletUserRole(entry) === role) ??
      registry.wallets.find((entry) => entry.id === role);
    return {
      walletId: wallet?.id,
      walletName: wallet?.name,
    };
  };
  const readAgentDefaultWallet = (): { walletId?: string; walletName?: string } => {
    const registry = readWalletProviderRegistry(process.env);
    const walletId = registry.defaultWalletId?.trim();
    if (!walletId) {
      return {};
    }
    const wallet = registry.wallets.find((entry) => entry.id === walletId);
    return {
      walletId,
      walletName: wallet?.name,
    };
  };
  const readAgentWalletSummary = (): { walletId?: string; walletName?: string } =>
    readAgentDefaultWallet().walletId ? readAgentDefaultWallet() : readRoleWallet("agent");
  const goModernEnough = (): boolean => {
    const probe = spawnSync(
      "bash",
      [
        "-lc",
        'if [ -n "${FASED_GO_BIN:-}" ] && [ -x "$FASED_GO_BIN" ]; then GOCMD="$FASED_GO_BIN"; ' +
          "elif [ -x /usr/local/go/bin/go ]; then GOCMD=/usr/local/go/bin/go; " +
          "elif command -v go >/dev/null 2>&1; then GOCMD=$(command -v go); " +
          "else exit 1; fi; " +
          "v=$($GOCMD version 2>/dev/null | awk '{print $3}' | sed 's/^go//'); " +
          'maj=$(echo "$v" | cut -d. -f1); min=$(echo "$v" | cut -d. -f2); patch=$(echo "$v" | cut -d. -f3 | sed "s/[^0-9].*$//"); ' +
          '([ "${maj:-0}" -gt 1 ] || ([ "${maj:-0}" -eq 1 ] && ([ "${min:-0}" -gt 25 ] || ([ "${min:-0}" -eq 25 ] && [ "${patch:-0}" -ge 12 ]))))',
      ],
      { stdio: "ignore" },
    );
    return probe.status === 0;
  };
  const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  const runShell = async (command: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("bash", ["-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      const appendTail = (current: string, chunk: Buffer | string): string =>
        `${current}${String(chunk)}`.slice(-8000);
      proc.stdout?.on("data", (chunk) => {
        stdout = appendTail(stdout, chunk);
      });
      proc.stderr?.on("data", (chunk) => {
        stderr = appendTail(stderr, chunk);
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if ((code ?? 1) === 0) {
          resolve();
          return;
        }
        const detail = String(stderr || stdout)
          .trim()
          .split("\n")
          .slice(-3)
          .join("\n");
        reject(new Error(detail ? `command failed: ${detail}` : `command failed: ${command}`));
      });
    });
  };
  const installPrivateGoForOnboarding = async (): Promise<"installed" | "unavailable"> => {
    if (process.platform !== "linux" || !hasCommand("curl") || !hasCommand("tar")) {
      return "unavailable";
    }
    const goVersion = String(process.env.FASED_GO_VERSION ?? "1.25.12").trim() || "1.25.12";
    const stateRoot =
      String(process.env.FASED_STATE_DIR ?? "").trim() ||
      path.join(String(process.env.HOME ?? "").trim() || process.cwd(), ".fased");
    const installRoot = path.join(stateRoot, "toolchains", `go${goVersion}`);
    const goBin = path.join(installRoot, "bin", "go");
    if (fs.existsSync(goBin)) {
      process.env.FASED_GO_BIN = goBin;
      return goModernEnough() ? "installed" : "unavailable";
    }
    const progress = prompter.progress("Installing private Go toolchain…");
    try {
      await runShell(
        [
          "set -euo pipefail",
          "arch=$(dpkg --print-architecture 2>/dev/null || uname -m)",
          'case "$arch" in amd64|x86_64) goarch=amd64 ;; arm64|aarch64) goarch=arm64 ;; *) echo "Unsupported arch: $arch"; exit 1 ;; esac',
          `goversion=${shellQuote(goVersion)}`,
          `install_root=${shellQuote(installRoot)}`,
          'tmpdir="$(mktemp -d)"',
          "trap 'rm -rf \"$tmpdir\"' EXIT",
          'curl -fsSL "https://go.dev/dl/go${goversion}.linux-${goarch}.tar.gz" -o "$tmpdir/go.tgz"',
          'tar -C "$tmpdir" -xzf "$tmpdir/go.tgz"',
          'mkdir -p "$(dirname "$install_root")"',
          'rm -rf "$install_root"',
          'mv "$tmpdir/go" "$install_root"',
          'chmod -R u+rwX "$install_root"',
        ].join("; "),
      );
      process.env.FASED_GO_BIN = goBin;
      progress.stop("Go toolchain ready.");
    } catch (error) {
      progress.stop("Go toolchain install failed.");
      throw error;
    }
    return goModernEnough() ? "installed" : "unavailable";
  };
  const signerdBinaryAlreadyInstalled = (): boolean => {
    if (String(process.env.FASED_FORCE_NATIVE_SIGNER_BUILD ?? "").trim() === "1") {
      return false;
    }
    return fs.existsSync(resolveSignerdBinaryPath(process.env));
  };
  const maybeInstallGoForOnboarding = async (): Promise<boolean> => {
    if (goModernEnough()) {
      return true;
    }
    const privateGoInstall = await installPrivateGoForOnboarding();
    if (privateGoInstall === "installed") {
      return true;
    }
    if (process.platform !== "linux" || !hasCommand("sudo")) {
      return false;
    }
    if (opts.nonInteractive === true) {
      return false;
    }
    const installNow = await prompter.confirm({
      message: "Go >=1.25.12 is required for a source-built native signer. Install/update Go now?",
      initialValue: true,
    });
    if (!installNow) {
      return false;
    }
    const progress = prompter.progress("Installing Go toolchain…");
    try {
      await runShell(
        "arch=$(dpkg --print-architecture 2>/dev/null || uname -m); " +
          'case "$arch" in amd64|x86_64) goarch=amd64 ;; arm64|aarch64) goarch=arm64 ;; *) echo "Unsupported arch: $arch"; exit 1 ;; esac; ' +
          "goversion=${FASED_GO_VERSION:-1.25.12}; " +
          "tmp=$(mktemp); " +
          'curl -fsSL "https://go.dev/dl/go${goversion}.linux-${goarch}.tar.gz" -o "$tmp"; ' +
          "sudo rm -rf /usr/local/go; " +
          'sudo tar -C /usr/local -xzf "$tmp"; ' +
          'rm -f "$tmp"; ' +
          "sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go",
      );
      progress.stop("Go toolchain ready.");
    } catch (error) {
      progress.stop("Go toolchain install failed.");
      throw error;
    }
    return goModernEnough();
  };
  printWizardHeader(runtime);
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readConfigFileSnapshot();
  const protectedLocalInstallerScaffold = isProtectedLocalInstallerScaffold(snapshot);
  let baseConfig: FasedAgentConfig = snapshot.valid ? snapshot.config : {};
  baseConfig = normalizeHostedWalletPaths(baseConfig, process.env);
  let satMiningAttachment = readSatMiningConfig(baseConfig);
  let federationBondWalletId = readFederationBondWalletId(baseConfig);
  const displayWalletName = (wallet: WalletNamedWallet): string => {
    return wallet.name.trim() || "Wallet";
  };
  const compactWalletAddress = (value: string | undefined): string | undefined => {
    const address = value?.trim() ?? "";
    return address.length > 6
      ? `${address.slice(0, 2)}..${address.slice(-2)}`
      : address || undefined;
  };
  const applySatMiningAttachment = (cfg: FasedAgentConfig): FasedAgentConfig => {
    if (!satMiningAttachment.walletId) {
      return cfg;
    }
    return assignWalletToSatMining(cfg, {
      walletId: satMiningAttachment.walletId,
      network: satMiningAttachment.network ?? "devnet",
    });
  };

  if (snapshot.exists && !protectedLocalInstallerScaffold && !snapshot.valid) {
    await prompter.note(summarizeExistingConfig(baseConfig), "Invalid config");
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.fased.ai/gateway/configuration",
        ].join("\n"),
        "Config issues",
      );
    }
    await prompter.outro(
      `Config invalid. Run \`${formatCliCommand("fased doctor")}\` to repair it, then re-run onboarding.`,
    );
    runtime.exit(1);
    return;
  }

  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error("Invalid --flow (use quickstart, manual, or advanced).");
    runtime.exit(1);
    return;
  }
  const explicitFlow: WizardFlow | undefined =
    normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
      ? normalizedExplicitFlow
      : undefined;
  let flow: WizardFlow =
    explicitFlow ??
    (await prompter.select({
      message: "Onboarding mode",
      options: [
        { value: "quickstart", label: "QuickStart" },
        { value: "advanced", label: "Manual" },
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(
      "QuickStart only supports local gateways. Switching to Manual mode.",
      "QuickStart",
    );
    flow = "advanced";
  }

  const rawHostProfile = typeof opts.hostProfile === "string" ? opts.hostProfile.trim() : "";
  const requestedHostProfile: HostSetupProfile | undefined =
    rawHostProfile === "local" || rawHostProfile === "hosting" ? rawHostProfile : undefined;
  if (rawHostProfile && !requestedHostProfile) {
    await prompter.note("Invalid host setup profile. Use local or hosting.", "Host setup profile");
    runtime.exit(1);
    return;
  }
  const interactiveHostProfileInitialValue =
    !hostSecurityCapable && requestedHostProfile === "hosting"
      ? "local"
      : requestedHostProfile || "local";
  const explicitHostProfileRequested = requestedHostProfile !== undefined;
  const hostedProfileUnavailableNote = [
    "This session cannot run hosting security setup.",
    "Start from the provider root console with the exact tagged, attested Hosting command and --release vX.Y.Z.",
    "Never run the app-owned checkout with sudo or as root.",
  ].join("\n");
  const hostProfile: HostSetupProfile =
    opts.mode === "remote"
      ? "local"
      : requestedHostProfile
        ? requestedHostProfile
        : await (async (): Promise<HostSetupProfile> => {
            const selected = await prompter.select<HostSetupProfile>({
              message: "Host setup profile",
              options: [
                {
                  value: "local",
                  label: "Local",
                  hint: "Current machine and account; no VPS hardening.",
                },
                {
                  value: "hosting",
                  label: "Hosting",
                  hint: "Verified root bootstrap; Tailscale required.",
                },
              ],
              initialValue: interactiveHostProfileInitialValue,
            });

            if (selected === "hosting" && !hostSecurityCapable && !hostMaintenanceSession) {
              await prompter.note(hostedProfileUnavailableNote, "Hosted setup unavailable");
              runtime.exit(1);
              return "local";
            }

            return selected;
          })();
  opts.hostProfile = hostProfile;

  if (
    explicitHostProfileRequested &&
    hostProfile === "hosting" &&
    !hostSecurityCapable &&
    !hostMaintenanceSession
  ) {
    await prompter.note(hostedProfileUnavailableNote, "Host setup profile");
    runtime.exit(1);
    return;
  }

  if (snapshot.exists && !protectedLocalInstallerScaffold) {
    await prompter.note(summarizeExistingConfig(baseConfig), "Existing config detected");

    const action = await prompter.select<"modify" | "repair">({
      message: "Existing setup",
      options: [
        {
          value: "modify",
          label: "Review settings",
          hint: "Keeps wallets, secrets, sessions, bonds, and mining data.",
        },
        {
          value: "repair",
          label: "Repair sign-in",
          hint: "Clears dashboard auth/session state only; keeps wallets and secrets.",
        },
      ],
    });

    if (action === "repair") {
      const repairAllowed = await confirmOnboardingRepair({ prompter });
      if (!repairAllowed) {
        await prompter.note("Continuing with current config values.", "Review settings");
      } else {
        const repairScope = (await prompter.select({
          message: "Repair scope",
          options: [
            {
              value: "sessions",
              label: "Sessions only",
              hint: "Clears chat/session history only.",
            },
            {
              value: "auth",
              label: "Auth only",
              hint: "Clears model/OAuth credential state only.",
            },
            {
              value: "auth+sessions",
              label: "Auth + sessions",
              hint: "Clears model/OAuth credential state and chat/session history.",
            },
          ],
        })) as OnboardRepairScope;
        const confirmedScope = await prompter.confirm({
          message: `Move ${repairScope} repair targets to Trash?`,
          initialValue: false,
        });
        if (!confirmedScope) {
          await prompter.note("Repair cancelled. Continuing with current config values.", "Repair");
        } else {
          await handleOnboardingRepair(repairScope, runtime);
        }
      }
    }
  }

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
      federationEnabled: false,
      federationHandle: undefined,
    };
  })();

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  const localProbe = await probeGatewayReachable({
    url: localUrl,
    token: baseConfig.gateway?.auth?.token ?? process.env.FASED_GATEWAY_TOKEN,
    password: baseConfig.gateway?.auth?.password ?? process.env.FASED_GATEWAY_PASSWORD,
  });
  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: "What do you want to set up?",
          options: [
            {
              value: "local",
              label: "Local gateway (this machine)",
              hint: localProbe.ok
                ? `Gateway reachable (${localUrl})`
                : `No gateway detected (${localUrl})`,
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro("Remote gateway configured.");
    return;
  }

  if (flow !== "quickstart") {
    await prompter.note(
      [
        noteStep(1, "Secure access"),
        noteStep(2, "Choose wallet roles"),
        noteStep(3, "Open Web UI"),
        "",
        noteHeading("Optional later"),
        noteBullet("Fased Network: enable only when you want network tasks."),
        noteBullet("SAT mining: enable only when you want mining on this host."),
      ].join("\n"),
      "Operator path",
    );
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE)
      : await prompter.text({
          message: "Workspace directory",
          initialValue: baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || DEFAULT_WORKSPACE);

  let nextConfig: FasedAgentConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);
  nextConfig = setConfigEnvVar(nextConfig, legacyJupiterTriggerApiBaseUrlEnvKey, undefined);
  delete process.env[legacyJupiterTriggerApiBaseUrlEnvKey];
  nextConfig = normalizeHostedWalletPaths(nextConfig, process.env);

  const authChoice = opts.authChoice;
  if (authChoice === "custom-api-key") {
    const customResult = await promptCustomApiConfig({
      prompter,
      runtime,
      config: nextConfig,
    });
    nextConfig = customResult.config;
    await warnIfModelConfigLooksOff(nextConfig, prompter);
  } else if (authChoice && authChoice !== "skip") {
    nextConfig = await applyOnboardingAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      opts: {
        tokenProvider: opts.tokenProvider,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    await warnIfModelConfigLooksOff(nextConfig, prompter);
  }

  const gateway = await configureGatewayForOnboarding({
    flow,
    hostProfile,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;
  if (hostProfile === "hosting" && settings.tailscaleMode === "off") {
    throw new Error(
      [
        "Hosting profile selected but Tailscale is off.",
        "Hosting requires Tailscale Serve for admin UI access.",
        "Enable Tailscale and rerun onboarding.",
      ].join("\n"),
    );
  }

  const federation = await configureFederationForOnboarding({
    flow,
    hostProfile,
    baseConfig,
    prompter,
  });
  nextConfig = setConfigEnvVar(
    nextConfig,
    "FASED_FEDERATION_AUTO_CONNECT",
    federation.enabled ? "1" : "0",
  );
  nextConfig = setConfigEnvVar(
    nextConfig,
    "FASED_FEDERATION_BASE_URL",
    federation.enabled ? federation.baseUrl : undefined,
  );
  nextConfig = setConfigEnvVar(
    nextConfig,
    "FASED_FEDERATION_HANDLE",
    federation.enabled ? federation.handle : undefined,
  );
  nextConfig = setConfigEnvVar(
    nextConfig,
    "FASED_A2A_HANDLE",
    federation.enabled ? federation.handle : undefined,
  );
  const managedGatewayRequired = hostProfile === "hosting" || federation.enabled;
  if (managedGatewayRequired) {
    // Federation-issued public URLs require the managed runtime to keep the hosted
    // tunnel/share layer alive. Persist managed mode here so onboarding, service
    // install, and later restarts all stay aligned.
    nextConfig = setConfigEnvVar(nextConfig, "FASED_GATEWAY_MODE", "managed");
  }

  const hostingMode = hostProfile === "hosting";
  if (hostingMode) {
    nextConfig = prepareHostedLocalSignerOnboarding(nextConfig);
  } else if (
    !String(process.env.FASED_WALLET_WEBAUTHN_RP_ID ?? "").trim() &&
    !String(process.env.FASED_WALLET_WEBAUTHN_ORIGINS ?? "").trim()
  ) {
    process.env.FASED_WALLET_WEBAUTHN_RP_ID = "localhost";
    process.env.FASED_WALLET_WEBAUTHN_ORIGINS = `http://localhost:${settings.port}`;
  }
  const buildNativeSignerFromSource =
    String(process.env.FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE ?? "").trim() === "1";
  const skipNativeSignerBuild =
    String(process.env.FASED_SKIP_NATIVE_SIGNER_BUILD ?? "").trim() === "1";
  if (buildNativeSignerFromSource && process.env.FASED_RUNTIME_SOURCE?.trim() === "go-lifecycle") {
    throw new Error(
      "A managed installation cannot replace its attested signer with a source build; run `fased repair` to restore the generation-bound signer.",
    );
  }
  if (buildNativeSignerFromSource) {
    if (skipNativeSignerBuild) {
      if (flow !== "quickstart") {
        await prompter.note(
          "Skipping native signer build/install because FASED_SKIP_NATIVE_SIGNER_BUILD=1.",
          "Native signer",
        );
      }
    } else if (signerdBinaryAlreadyInstalled()) {
      if (flow !== "quickstart") {
        await prompter.note("Native signer already current.", "Native signer");
      }
    } else if (!(await maybeInstallGoForOnboarding())) {
      const detail = "Go >=1.25.12 is required for a source-built native signer.";
      if (hostingMode && !opts.allowInsecure) {
        throw new Error(
          `${detail} Install Go and rerun onboarding, or unset FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE.`,
        );
      }
      await prompter.note(`${detail} Skipping signer build/install.`, "Native signer");
    } else {
      const progress = prompter.progress("Native signer");
      try {
        progress.update("Building native signer locally…");
        installSignerdBinary(resolveSignerdBinaryPath(process.env));
        progress.stop("Native signer installed.");
      } catch (error) {
        progress.stop("Native signer failed.");
        throw error;
      }
    }
  }

  nextConfig = await configureWalletForOnboarding({
    flow,
    hostProfile,
    nextConfig,
    prompter,
  });
  if (!hostingMode) {
    nextConfig = syncLocalSignerRuntimeEnvIntoConfig(nextConfig);
  }

  let onboardingWalletSecurityFocus: {
    walletId: string;
    role: "agent" | "mining" | "vault";
  } | null = null;

  const offerHostedWalletSetup =
    hostingMode && flow === "quickstart" && nextConfig.wallet?.runtime?.enabled !== true;
  if (nextConfig.wallet?.runtime?.enabled || offerHostedWalletSetup) {
    let attemptedSelfHostedSetupThisRun = false;
    let createdOrImportedSelfHostedWalletThisRun = false;
    const previousSuppressOverwrite = process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG;
    process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG = "1";
    try {
      const walletCeremonyEvents: Array<{
        mode: "local-signer-create" | "local-signer-import";
        chain?: "solana";
        walletId?: string;
        walletName?: string;
        rpcEnvKey?: string;
        rpcConfigured?: boolean;
        ok: boolean;
        detail?: string;
      }> = [];
      let addAnotherWallet = true;
      while (addAnotherWallet) {
        const setupMode = await prompter.select<
          "self-hosted" | "manage-self-hosted" | "jupiter-swaps" | "skip"
        >({
          message: "Wallet setup action",
          options: [
            { value: "self-hosted", label: "Create wallet" },
            { value: "manage-self-hosted", label: "Manage wallet" },
            {
              value: "jupiter-swaps",
              label: "Jupiter swaps",
              hint: readJupiterSwapApiKey()
                ? "Gateway swap key configured"
                : "Optional API key for Gateway swap crafting; Trigger is signer-owned",
            },
            {
              value: "skip",
              label: "Finish / set up later",
              hint: "Keeps existing wallets and lets hosting finish.",
            },
          ],
          initialValue: flow === "quickstart" ? "self-hosted" : "skip",
        });
        if (setupMode === "skip") {
          break;
        }

        if (setupMode === "jupiter-swaps") {
          await promptAndStoreJupiterSwapApi();
          addAnotherWallet = await prompter.confirm({
            message: "Run another wallet setup action?",
            initialValue: false,
          });
          continue;
        }

        if (setupMode === "manage-self-hosted") {
          const registry = readWalletProviderRegistry(process.env);
          const managedWallets = registry.wallets.filter(
            (wallet) => wallet.providerId !== "embedded-keystore",
          );
          if (managedWallets.length === 0) {
            await prompter.note(
              "No wallets are registered yet. Create or import one first.",
              "Wallet setup",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          const walletId = await prompter.select<string>({
            message: "Select wallet to manage",
            options: managedWallets.map((wallet) => ({
              value: wallet.id,
              label: `${displayWalletName(wallet)} · @wallet:${wallet.id}`,
              hint: [resolveWalletUserRole(wallet), compactWalletAddress(wallet.addresses?.solana)]
                .filter(Boolean)
                .join(" · "),
            })),
            initialValue: managedWallets[0]?.id,
          });
          const targetWallet = managedWallets.find((wallet) => wallet.id === walletId);
          if (!targetWallet) {
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          const currentMiningWalletId = satMiningAttachment.walletId ?? "";
          const currentBondWalletId = federationBondWalletId ?? "";
          const configuredSolanaRpcUrl =
            (nextConfig.env?.vars?.[rpcEnvKeyFor("solana", walletId)] ?? "").trim() ||
            String(process.env[rpcEnvKeyFor("solana", walletId)] ?? "").trim();
          const supportsSolanaWallet = Boolean(
            targetWallet.addresses?.solana || targetWallet.providerId === "local-socket-signer",
          );
          const targetWalletPurpose = resolveWalletUserRole(targetWallet);
          const manageAction = await prompter.select<
            | "attach-federation-bond"
            | "detach-federation-bond"
            | "configure-solana-rpc"
            | "retire-mining"
            | "archive"
            | "cancel"
          >({
            message: "Wallet action",
            options: [
              ...(supportsSolanaWallet
                ? [
                    {
                      value: "configure-solana-rpc" as const,
                      label: configuredSolanaRpcUrl ? "Update Solana RPC" : "Add Solana RPC",
                      hint: configuredSolanaRpcUrl
                        ? "Signer-owned RPC is configured; replace it without displaying credentials."
                        : "Restore the per-wallet Solana RPC used for balances, readiness, and SAT mining.",
                    },
                  ]
                : []),
              ...(supportsSolanaWallet && currentBondWalletId === walletId
                ? [
                    {
                      value: "detach-federation-bond" as const,
                      label: "Clear Fased Network bond",
                      hint: "Keep the wallet, but stop using it as the configured Fased Network bond Vault.",
                    },
                  ]
                : supportsSolanaWallet && targetWalletPurpose === "vault"
                  ? [
                      {
                        value: "attach-federation-bond" as const,
                        label:
                          currentBondWalletId && currentBondWalletId !== walletId
                            ? "Switch bond Vault here"
                            : "Use for Fased Network bond",
                        hint:
                          currentBondWalletId && currentBondWalletId !== walletId
                            ? `Current bond Vault: ${currentBondWalletId}`
                            : "Use this Vault wallet for longer-lived SAT bond authority.",
                      },
                    ]
                  : []),
              targetWalletPurpose === "mining"
                ? {
                    value: "retire-mining",
                    label: "Retire and replace Mining wallet",
                    hint: "Stop and drain Mining, verify recovery and balances, tombstone the old signer wallet, then attach a ready successor.",
                  }
                : {
                    value: "archive",
                    label: "Archive/remove from Fased",
                    hint: "Disable signer use first, then remove this wallet registration.",
                  },
              {
                value: "cancel",
                label: "Back",
              },
            ],
            initialValue: (() => {
              if (supportsSolanaWallet && !configuredSolanaRpcUrl) {
                return "configure-solana-rpc" as const;
              }
              if (currentBondWalletId === walletId) {
                return "detach-federation-bond" as const;
              }
              if (supportsSolanaWallet && targetWalletPurpose === "vault") {
                return "attach-federation-bond" as const;
              }
              return "cancel" as const;
            })(),
          });
          if (manageAction === "configure-solana-rpc") {
            const effectiveSolanaRpcUrl = await promptWalletRpcUrl({
              chain: "solana",
              walletId,
              walletName: targetWallet.name,
              currentValue: configuredSolanaRpcUrl,
            });
            let signerNetworkVersion: number | undefined;
            try {
              if (targetWallet.providerId === "local-socket-signer") {
                const effectiveEnv = {
                  ...process.env,
                  ...nextConfig.env?.vars,
                  FASED_HOST_PROFILE: hostProfile,
                } as NodeJS.ProcessEnv;
                const operatorLifecycle = resolveNativeSignerOperatorLifecycle(effectiveEnv);
                const signerWalletId = resolveNativeSignerWalletId(targetWallet);
                const current = await readSignerOwnedWalletReadiness({
                  walletId: signerWalletId,
                  socketPath: resolveLocalSignerSocketPath(effectiveEnv),
                });
                const network = invokeNativeSignerNetworkSetPrimary({
                  signerBinPath:
                    operatorLifecycle?.signerBinPath ?? resolveSignerdBinaryPath(effectiveEnv),
                  socketFlag: operatorLifecycle ? "--operator-socket" : "--control-socket",
                  socketPath:
                    operatorLifecycle?.operatorSocketPath ??
                    resolveLocalSignerControlSocketPath(effectiveEnv),
                  walletId: signerWalletId,
                  primaryRpcUrl: effectiveSolanaRpcUrl,
                  expectedVersion: current.networkVersion,
                  env: effectiveEnv,
                });
                signerNetworkVersion = network.version;
              } else {
                await restartLocalSocketSigner(ensureWalletStateDir(process.env).rootDir);
              }
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              const explanation = /does not match|no longer agrees|disagree/iu.test(detail)
                ? "That RPC is on a different Solana network. Use another provider for this wallet's current network."
                : /genesis|verification|invalid.*rpc|absolute HTTPS/iu.test(detail)
                  ? "That URL did not answer as a Solana RPC. Check the provider URL and API key, then try again."
                  : detail;
              await prompter.note(
                [
                  "RPC was not changed.",
                  explanation,
                  "Any HTTPS Solana RPC provider is supported when it responds to standard Solana JSON-RPC and matches this wallet's network.",
                ].join("\n"),
                "RPC not saved",
              );
              addAnotherWallet = await prompter.confirm({
                message: "Run another wallet setup action?",
                initialValue: true,
              });
              continue;
            }
            const rpcKey = rpcEnvKeyFor("solana", walletId);
            nextConfig = setConfigEnvVar(nextConfig, rpcKey, effectiveSolanaRpcUrl);
            process.env[rpcKey] = effectiveSolanaRpcUrl;
            await prompter.note(
              [
                `Saved RPC for ${targetWallet.name} · @wallet:${walletId}${signerNetworkVersion ? `; wallet network version ${signerNetworkVersion} is ready` : "."}`,
              ].join("\n"),
              "Wallet setup",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          if (manageAction === "cancel") {
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          if (manageAction === "retire-mining") {
            await prompter.note(
              [
                "Mining retirement is a coordinated replacement, never a registry-only delete.",
                `Run: fased wallet recovery export --wallet-id ${targetWallet.id} --output <absolute-recovery-path>`,
                `Then run: fased wallet retire --wallet-id ${targetWallet.id} --successor-wallet-id <new-id> --successor-wallet-name <name> --recovery-file <absolute-recovery-path> --rpc-url <url>`,
                "The command stops new jobs, waits for Clearing and reconciliation, records balances, commits the signer tombstone, and attaches the ready successor.",
              ].join("\n"),
              "Retire and replace Mining wallet",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          if (manageAction === "attach-federation-bond") {
            const agentDefaultWallet = readAgentDefaultWallet();
            if (targetWalletPurpose !== "vault") {
              await prompter.note(
                [
                  `${targetWallet.name} · @wallet:${walletId} is a ${targetWalletPurpose} wallet.`,
                  "Fased Network bond requires a Vault wallet. Create a Vault wallet first, then assign it to bond.",
                ].join("\n"),
                "Fased Network bond",
              );
              addAnotherWallet = await prompter.confirm({
                message: "Run another wallet setup action?",
                initialValue: false,
              });
              continue;
            }
            if (agentDefaultWallet.walletId === walletId || currentMiningWalletId === walletId) {
              await prompter.note(
                [
                  `${targetWallet.name} · @wallet:${walletId} is already used by ${agentDefaultWallet.walletId === walletId ? "Agent" : "Mining"}.`,
                  "Create or select a Vault wallet instead of reusing this wallet.",
                ].join("\n"),
                "Fased Network bond",
              );
              addAnotherWallet = await prompter.confirm({
                message: "Run another wallet setup action?",
                initialValue: false,
              });
              continue;
            }
            federationBondWalletId = walletId;
            nextConfig = assignFederationBondWallet(nextConfig, { walletId });
            const advisories: string[] = [
              noteHeading("Network bond"),
              noteBullet(`Vault wallet: ${targetWallet.name} · @wallet:${walletId}`),
            ];
            await prompter.note(advisories.join("\n"), "Fased Network bond");
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          if (manageAction === "detach-federation-bond") {
            federationBondWalletId = undefined;
            nextConfig = clearFederationBondWallet(nextConfig);
            await prompter.note(
              `Cleared ${targetWallet.name} · @wallet:${walletId} as the Fased Network bond Vault.`,
              "Fased Network bond",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          if (resolveWalletUserRole(targetWallet) === "mining") {
            await prompter.note(
              "Mining wallets cannot be archived or deleted directly. Use Retire and replace Mining wallet so the signer tombstone is committed before registry detachment.",
              "Mining retirement required",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          const archiveEnv = {
            ...process.env,
            ...nextConfig.env?.vars,
            FASED_HOST_PROFILE: hostProfile,
          } as NodeJS.ProcessEnv;
          const deletionSafety = checkNamedWalletDeletionSafety({
            walletId: targetWallet.id,
            env: archiveEnv,
          });
          if (!deletionSafety.ok) {
            await prompter.note(deletionSafety.message, "Archive blocked");
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          const signerOwned = targetWallet.providerId === "local-socket-signer";
          const archiveWarnings = [
            `This removes the Fased registration for ${targetWallet.name} (${targetWallet.id}); it does not transfer funds or erase provider custody.`,
            signerOwned
              ? "Before removal, Fased must durably replace the native signer policy with deny-all. The encrypted signer-owned key remains archived in signer storage for host-administrator recovery."
              : "The external provider or hardware wallet keeps its key; remove it there separately only if you intend to destroy that custody relationship.",
            "Move funds out or verify your recovery procedure, and clear active Mining/Fased Network use before archiving.",
          ];
          if (currentMiningWalletId === targetWallet.id || targetWalletPurpose === "mining") {
            archiveWarnings.push(
              "For @wallet:mining, stop mining first; move SAT/SOL out or verify recovery; then archive and re-register the singleton Mining wallet if needed.",
            );
          }
          archiveWarnings.push(
            "If balances cannot be checked from this terminal, treat the balance as unknown and verify it from the Wallet or Mining page first.",
            "Use repair for auth/session recovery only; wallet archive is always per-wallet.",
          );
          await prompter.note(archiveWarnings.join("\n"), "Archive wallet");
          const typedWalletId = await prompter.text({
            message: `Type wallet id "${targetWallet.id}" to archive/remove this wallet from Fased`,
            validate: (value) =>
              value.trim() === targetWallet.id ? undefined : `Type ${targetWallet.id}`,
          });
          if (typedWalletId.trim() === targetWallet.id) {
            const walletId = targetWallet.id;
            let archivedSignerPolicy:
              | Awaited<ReturnType<typeof lockSignerOwnedWalletForArchive>>
              | undefined;
            if (signerOwned) {
              try {
                archivedSignerPolicy = await lockSignerOwnedWalletForArchive({
                  wallet: targetWallet,
                  socketPath: resolveLocalSignerSocketPath(archiveEnv),
                });
              } catch (error) {
                await prompter.note(
                  [
                    "The native signer did not durably acknowledge deny-all, so no Fased registration or attachment was removed.",
                    `Detail: ${error instanceof Error ? error.message : String(error)}`,
                    "Repair the signer and retry the archive operation.",
                  ].join("\n"),
                  "Archive blocked",
                );
                addAnotherWallet = await prompter.confirm({
                  message: "Run another wallet setup action?",
                  initialValue: false,
                });
                continue;
              }
            }
            for (const key of [rpcEnvKeyFor("solana", walletId)]) {
              nextConfig = setConfigEnvVar(nextConfig, key, undefined);
            }
            if (satMiningAttachment.walletId === walletId) {
              satMiningAttachment = {};
              nextConfig = clearSatMiningAttachment(nextConfig);
            }
            if (federationBondWalletId === walletId) {
              federationBondWalletId = undefined;
              nextConfig = clearFederationBondWallet(nextConfig);
            }
            await writeConfigFile(nextConfig);
            deleteNamedWallet({ walletId, env: archiveEnv });
            delete process.env[rpcEnvKeyFor("solana", walletId)];
            await prompter.note(
              archivedSignerPolicy
                ? `Archived ${targetWallet.name} · @wallet:${walletId} from Fased. Native signer wallet ${archivedSignerPolicy.walletId} remains encrypted and locked by deny-all policy version ${archivedSignerPolicy.version}.`
                : `Removed ${targetWallet.name} · @wallet:${walletId} from Fased. Its external custody was not erased.`,
              "Wallet setup",
            );
          } else {
            await prompter.note("Wallet archive cancelled.", "Wallet setup");
          }
          addAnotherWallet = await prompter.confirm({
            message: "Run another wallet setup action?",
            initialValue: false,
          });
          continue;
        }

        if (nextConfig.wallet?.runtime?.enabled !== true) {
          if (hostingMode) {
            nextConfig = prepareHostedLocalSignerOnboarding(nextConfig);
          }
          nextConfig = await configureWalletForOnboarding({
            flow,
            forceEnable: true,
            hostProfile,
            nextConfig,
            prompter,
          });
          if (!hostingMode) {
            nextConfig = syncLocalSignerRuntimeEnvIntoConfig(nextConfig);
          }
        }

        attemptedSelfHostedSetupThisRun = true;
        const chain = "solana" as const;
        const walletPurpose = await prompter.select<WalletOnboardingPurpose>({
          message: "Wallet role (required)",
          options: [
            { value: "agent", label: "Agent" },
            { value: "mining", label: "Mining" },
            { value: "vault", label: "Vault" },
          ],
        });
        if (walletPurpose !== "agent" && walletPurpose !== "mining" && walletPurpose !== "vault") {
          throw new Error("Wallet role selection is required; Agent is never selected silently.");
        }
        const selfHostedAction = await prompter.select<"create" | "import">({
          message: "Wallet action",
          options: [
            { value: "create", label: "Create new key" },
            { value: "import", label: "Import wallet key" },
          ],
          initialValue: "create",
        });
        if (walletPurpose === "mining") {
          const existingMiningWalletId = satMiningAttachment.walletId ?? "";
          const existingMiningWallet = readWalletProviderRegistry(process.env).wallets.find(
            (wallet) => wallet.id === "mining",
          );
          if (existingMiningWalletId || existingMiningWallet) {
            await prompter.note(
              [
                `Mining wallet already exists: ${existingMiningWalletId || "mining"}.`,
                "Open it to continue, or use the reviewed Replace/Archive flow after mining is stopped, rewards and capital are settled, and backup/readiness checks pass.",
              ].join("\n"),
              "Mining",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
        }
        const mode =
          selfHostedAction === "import"
            ? ("local-signer-import" as const)
            : ("local-signer-create" as const);
        const walletIdentity = await resolveWalletIdentityForOnboarding({
          flow,
          purpose: walletPurpose,
        });
        const walletName = walletIdentity.walletName;
        const walletId: string | undefined = walletIdentity.walletId || undefined;
        const importFile =
          selfHostedAction === "import"
            ? (
                await prompter.text({
                  message: "Absolute path to owner-only Solana keypair JSON",
                  validate: (value) =>
                    value.trim().startsWith("/")
                      ? undefined
                      : "Enter an absolute path and run chmod 600 on the file first",
                })
              ).trim()
            : undefined;
        const rpcKey = rpcEnvKeyFor(chain, walletId);
        const currentRpcValue =
          (nextConfig.env?.vars?.[rpcKey] ?? "").trim() || String(process.env[rpcKey] ?? "").trim();
        const rpcUrlInput = (
          await prompter.text({
            message: `${chain.toUpperCase()} RPC URL (required for balances/readiness/send)`,
            initialValue: currentRpcValue,
            validate: (value) =>
              value.trim() || currentRpcValue
                ? undefined
                : `${chain.toUpperCase()} RPC URL is required`,
          })
        ).trim();
        const effectiveRpcUrl = rpcUrlInput || currentRpcValue;
        if (!effectiveRpcUrl) {
          throw new Error(`${chain.toUpperCase()} RPC URL is required for wallets.`);
        }
        try {
          if (mode === "local-signer-create") {
            try {
              await walletSetupCommand(runtime, {
                mode,
                chain,
                walletId,
                walletName,
                rpcUrl: effectiveRpcUrl,
                role: walletPurpose,
                // Onboarding is repairable after a signer wallet was durably created but a
                // later network/bootstrap step failed. The signer permits reuse only when the
                // existing wallet has the exact requested role; it never overwrites the key.
                force: true,
                noDoctor: true,
                noSignerHints: true,
                nonInteractive: true,
              });
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              if (detail.includes("Keystore already exists")) {
                const overwrite = await prompter.confirm({
                  message: "Keystore already exists. Overwrite it?",
                  initialValue: false,
                });
                if (!overwrite) {
                  throw err;
                }
                await walletSetupCommand(runtime, {
                  mode,
                  chain,
                  walletId,
                  walletName,
                  rpcUrl: effectiveRpcUrl,
                  role: walletPurpose,
                  force: true,
                  noDoctor: true,
                  noSignerHints: true,
                  nonInteractive: true,
                });
              } else {
                throw err;
              }
            }
          } else {
            await walletSetupCommand(runtime, {
              mode,
              chain,
              walletId,
              walletName,
              role: walletPurpose,
              rpcUrl: effectiveRpcUrl,
              importFile,
              noDoctor: true,
              noSignerHints: true,
              nonInteractive: true,
            });
          }
          // Commit the Gateway read endpoint only after the signer has accepted the
          // RPC and its genesis. A later successful wallet action must never cause a
          // rejected endpoint from an earlier action to leak into the final config.
          nextConfig = setConfigEnvVar(nextConfig, rpcKey, effectiveRpcUrl);
          process.env[rpcKey] = effectiveRpcUrl;
          walletCeremonyEvents.push({
            mode,
            chain,
            walletId: walletId ?? "default",
            walletName,
            rpcEnvKey: rpcKey,
            rpcConfigured: Boolean((nextConfig.env?.vars?.[rpcKey] ?? "").trim()),
            ok: true,
          });
          createdOrImportedSelfHostedWalletThisRun = true;
          if (hostProfile !== "hosting") {
            const exportRecovery = await prompter.confirm({
              message: "Create an encrypted recovery package now?",
              initialValue: true,
            });
            if (exportRecovery) {
              const defaultRecoveryPath = path.join(
                process.env.HOME || process.cwd(),
                `fased-${walletId ?? walletPurpose}-recovery.json`,
              );
              const recoveryOutput = (
                await prompter.text({
                  message: "New encrypted recovery package path",
                  initialValue: defaultRecoveryPath,
                  validate: (value) =>
                    path.isAbsolute(value.trim())
                      ? undefined
                      : "Enter an absolute path for a new file",
                })
              ).trim();
              await walletRecoveryFacade.exportEncrypted(runtime, {
                walletId: walletId ?? walletPurpose,
                output: recoveryOutput,
              });
              await prompter.note(
                [
                  `Encrypted recovery package: ${recoveryOutput}`,
                  "Keep the recovery password separately. The file contains ciphertext, wallet id, role, public address, and format metadata; it never contains plaintext key material.",
                ].join("\n"),
                "Wallet recovery",
              );
            }
          }
          const agentDefaultBefore = readAgentDefaultWallet();
          const existingWallet = readWalletProviderRegistry(process.env).wallets.find(
            (entry) => entry.id === walletId,
          );
          upsertNamedWallet({
            walletId,
            name: walletName,
            providerId: "local-socket-signer",
            addresses: existingWallet?.addresses,
            metadata: {
              ...existingWallet?.metadata,
              selfHosted: true,
            },
            env: process.env,
          });
          await restartLocalSocketSigner(ensureWalletStateDir(process.env).rootDir);
          const isAgentWallet = walletPurpose === "agent";
          if (walletPurpose === "agent") {
            await prompter.note(
              [
                `Agent wallet created as ${walletName} · @wallet:${walletId ?? "default"}.`,
                `Default Agent wallet fallback remains ${describeWalletRef(agentDefaultBefore)}.`,
                `Use @wallet:${walletId ?? "default"} explicitly, assign it to an Agent or skill, or set it as the optional fallback in Wallet.`,
              ].join("\n"),
              "Wallet",
            );
          }
          if (walletId) {
            setNamedWalletRole({
              walletId,
              role: walletPurpose,
              env: process.env,
            });
          }
          if (walletId) {
            onboardingWalletSecurityFocus = {
              walletId,
              role: walletPurpose,
            };
          }
          if (chain === "solana" && walletId) {
            const currentMiningWalletId = satMiningAttachment.walletId ?? "";
            if (isAgentWallet) {
              await prompter.note(
                [
                  noteHeading("Agent wallet"),
                  noteBullet(`${walletName} · @wallet:${walletId}`),
                  "",
                  noteHeading("Mining optional"),
                  noteBullet("Mining uses a separate wallet."),
                  noteBullet("Create/import a Mining wallet later if you want SAT mining."),
                ].join("\n"),
                "Mining",
              );
            } else {
              const shouldAttach = walletPurpose === "mining" && currentMiningWalletId !== walletId;
              if (shouldAttach) {
                const miningNetwork = await discoverSolanaNetworkFromRpc(effectiveRpcUrl);
                satMiningAttachment = {
                  walletId,
                  network: miningNetwork,
                };
                nextConfig = assignWalletToSatMining(nextConfig, {
                  walletId,
                  network: miningNetwork,
                });
                await prompter.note(
                  [
                    noteHeading("Mining wallet"),
                    noteBullet(`${walletName} · @wallet:${walletId}`),
                    noteBullet(
                      "Receive-only until the signer network and an owner-reviewed Mining policy are acknowledged.",
                    ),
                    noteBullet(
                      "Open Wallet > Policy after onboarding; fund and start workers only after it reports acknowledged.",
                    ),
                  ].join("\n"),
                  "Mining",
                );
              } else if (currentMiningWalletId && currentMiningWalletId !== walletId) {
                await prompter.note(
                  [
                    noteHeading("Mining wallet"),
                    noteBullet(`Keeping existing: ${currentMiningWalletId}`),
                  ].join("\n"),
                  "Mining",
                );
              }
            }
            const currentBondWallet = federationBondWalletId ?? "";
            if (currentBondWallet !== walletId) {
              if (currentBondWallet) {
                await prompter.note(`Keeping existing bond Vault: ${currentBondWallet}`, "Bond");
              }
            }
          }
        } catch (err) {
          walletCeremonyEvents.push({
            mode,
            chain,
            walletId: walletId ?? "default",
            walletName,
            rpcEnvKey: rpcKey,
            rpcConfigured: Boolean((nextConfig.env?.vars?.[rpcKey] ?? "").trim()),
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
          await prompter.note(
            `Wallet setup failed: ${err instanceof Error ? err.message : String(err)}`,
            "Wallet setup",
          );
        }

        addAnotherWallet = await prompter.confirm({
          message: "Run another wallet setup action?",
          initialValue: false,
        });
      }
      if (walletCeremonyEvents.length > 0) {
        const summaryLines = [
          noteHeading("Wallet actions"),
          ...walletCeremonyEvents.map((evt) => {
            const scope = evt.chain
              ? `${evt.chain}:${evt.walletName ?? evt.walletId ?? "default"}`
              : "global";
            const label =
              evt.mode === "local-signer-create"
                ? "self-hosted-create"
                : evt.mode === "local-signer-import"
                  ? "self-hosted-import"
                  : evt.mode;
            const status = evt.ok ? noteSuccess("ok") : noteWarn("failed");
            return noteBullet(
              `${label} [${scope}]: ${status}${evt.detail ? ` (${evt.detail})` : ""}`,
            );
          }),
          "",
          noteHeading("Assignments"),
          noteBullet(`Agent wallet: ${describeWalletRef(readAgentWalletSummary())}`),
          noteBullet(`SAT mining wallet: ${describeWalletRef(readRoleWallet("mining"))}`),
          noteBullet(`Vault wallet: ${describeWalletRef(readRoleWallet("vault"))}`),
          noteBullet(
            `Fased Network bond Vault: ${
              federationBondWalletId
                ? describeWalletRef({
                    walletId: federationBondWalletId,
                    walletName: readWalletProviderRegistry(process.env).wallets.find(
                      (wallet) => wallet.id === federationBondWalletId,
                    )?.name,
                  })
                : "not assigned"
            }`,
          ),
          noteBullet(
            `Gateway Jupiter swaps: ${readJupiterSwapApiKey() ? "configured" : "not configured"}; Trigger: signer-owned configuration`,
          ),
        ];
        const rpcKeys = Array.from(
          new Set(
            walletCeremonyEvents
              .map((evt) => evt.rpcEnvKey)
              .filter((key): key is string => Boolean(key)),
          ),
        );
        if (rpcKeys.length > 0) {
          summaryLines.push("", noteHeading("Optional env"));
          for (const key of rpcKeys) {
            const configured = Boolean((nextConfig.env?.vars?.[key] ?? "").trim());
            summaryLines.push(noteBullet(`${key}: ${configured ? "configured" : "unset"}`));
          }
        }
        await prompter.note(summaryLines.join("\n"), "Wallet summary");
      }
      if (attemptedSelfHostedSetupThisRun && !createdOrImportedSelfHostedWalletThisRun) {
        const firstFailure = walletCeremonyEvents.find(
          (evt) =>
            (evt.mode === "local-signer-create" || evt.mode === "local-signer-import") && !evt.ok,
        );
        if (firstFailure) {
          throw new Error(
            firstFailure.detail
              ? `Wallet setup failed: ${firstFailure.detail}`
              : "Wallet setup failed.",
          );
        }
      }
    } finally {
      if (typeof previousSuppressOverwrite === "string") {
        process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG = previousSuppressOverwrite;
      } else {
        delete process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG;
      }
    }
    const shouldEnforceSelfHostedDoctor = attemptedSelfHostedSetupThisRun;
    if (shouldEnforceSelfHostedDoctor) {
      try {
        const reportConfig: FasedAgentConfig = {
          ...nextConfig,
          wallet: {
            ...nextConfig.wallet,
            provider: {
              ...nextConfig.wallet?.provider,
              id: "local-socket-signer",
            },
            runtime: {
              ...nextConfig.wallet?.runtime,
              enabled: true,
            },
          },
        };
        const report = await collectWalletSignerDoctorReport(process.env, {
          config: reportConfig,
          json: true,
          checkRpc: false,
        });
        const requiredChecks = new Set(["socket.exists", "socket.health"]);
        const failed = report.checks.filter((check) => {
          if (!requiredChecks.has(check.check)) {
            return false;
          }
          return !check.ok;
        });
        if (failed.length > 0) {
          const summary = failed
            .slice(0, 6)
            .map((check) => `${check.check}${check.detail ? ` (${check.detail})` : ""}`)
            .join("; ");
          throw new Error(summary || "self-hosted wallet signer doctor reported failures");
        }
        const keyChecks = ["socket.exists", "socket.health"]
          .map((id) => report.checks.find((check) => check.check === id))
          .filter((check): check is { check: string; ok: boolean; detail?: string } =>
            Boolean(check),
          )
          .map(
            (check) =>
              `- ${check.check}: ${check.ok ? "ok" : "failed"}${check.detail ? ` (${check.detail})` : ""}`,
          );
        await prompter.note(
          ["Self-hosted signer checks passed.", ...keyChecks].join("\n"),
          "Wallet signer",
        );
      } catch (err) {
        throw new Error(
          `Self-hosted wallet signer + RPC checks must pass: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
  }

  const shouldOfferAdvancedUiOwnedSetup = !opts.nonInteractive;
  if (shouldOfferAdvancedUiOwnedSetup) {
    if (!authChoice) {
      const setupProvidersInOnboarding = await prompter.confirm({
        message: "Set up model providers?",
        initialValue: false,
      });
      if (setupProvidersInOnboarding) {
        const providerAuthChoice = await promptAuthChoiceGrouped({
          prompter,
          store: ensureAuthProfileStore(undefined, { allowKeychainPrompt: false }),
          includeSkip: true,
        });
        if (providerAuthChoice === "custom-api-key") {
          const customResult = await promptCustomApiConfig({
            prompter,
            runtime,
            config: nextConfig,
          });
          nextConfig = customResult.config;
          await warnIfModelConfigLooksOff(nextConfig, prompter);
        } else if (providerAuthChoice !== "skip") {
          nextConfig = await applyOnboardingAuthChoice({
            authChoice: providerAuthChoice,
            config: nextConfig,
            prompter,
            runtime,
            opts: {},
          });
          await warnIfModelConfigLooksOff(nextConfig, prompter);
        }
      }
    }

    const setupChannelsInOnboarding =
      !opts.skipChannels &&
      !opts.skipProviders &&
      (await prompter.confirm({
        message: "Set up chat channels?",
        initialValue: false,
      }));
    if (setupChannelsInOnboarding) {
      nextConfig = await setupChannels(nextConfig, runtime, prompter, {
        allowDisable: true,
        allowSignalInstall: true,
        skipConfirm: true,
        skipPrimerNote: true,
        skipStatusNote: true,
      });
    }

    if (!opts.skipSkills) {
      const setupSkillsInOnboarding = await prompter.confirm({
        message: "Set up skills?",
        initialValue: false,
      });
      if (setupSkillsInOnboarding) {
        nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter, {
          skipConfirm: true,
        });
      }
    }

    const setupHooksInOnboarding = await prompter.confirm({
      message: "Set up hooks?",
      initialValue: false,
    });
    if (setupHooksInOnboarding) {
      nextConfig = await setupInternalHooks(nextConfig, runtime, prompter, {
        skipIntroNote: true,
      });
    }
  }

  const previousSuppressOverwrite = process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG;
  process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG = "1";
  try {
    if (hostingMode) {
      nextConfig = persistHostedLocalSignerRuntime(nextConfig);
    }
    nextConfig = applySatMiningAttachment(nextConfig);
    await writeConfigFile(nextConfig);
    if (flow !== "quickstart") {
      logConfigUpdated(runtime);
    }
    await ensureWorkspaceAndSessions(workspaceDir, runtime, {
      skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
      quietLogs: true,
    });
  } finally {
    if (previousSuppressOverwrite == null) {
      delete process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG;
    } else {
      process.env.FASED_SUPPRESS_CONFIG_OVERWRITE_LOG = previousSuppressOverwrite;
    }
  }

  nextConfig = applySatMiningAttachment(nextConfig);

  const hostSecurity =
    hostProfile === "hosting"
      ? await applyHostingSecurity({ opts, runtime, prompter })
      : { profile: hostProfile, checks: [], enforced: false };
  if (hostSecurity.profile === "hosting" && hostSecurity.checks.length > 0) {
    const lines = [
      noteHeading("Checks"),
      ...hostSecurity.checks.map(
        (check) =>
          `${check.ok ? noteSuccess("✓") : noteWarn("!")} ${noteLabel(check.name)}: ${
            check.ok ? check.detail : noteWarn(check.detail)
          }`,
      ),
      hostSecurity.logPath ? "" : undefined,
      hostSecurity.logPath ? noteHeading("Log") : undefined,
      hostSecurity.logPath ? noteCommand(hostSecurity.logPath) : undefined,
    ];
    await prompter.note(lines.filter(Boolean).join("\n"), "Host security");
  }

  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    federation,
    prompter,
    runtime,
    walletSecurityFocus: nextConfig.wallet?.runtime?.enabled
      ? (onboardingWalletSecurityFocus ?? null)
      : null,
  });
  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  nextConfig = applySatMiningAttachment(nextConfig);
  await writeConfigFile(nextConfig);
  if (hostingMode) {
    activateHostedLocalSignerRuntimeEnv();
  }
  if (launchedTui) {
    return;
  }
}
