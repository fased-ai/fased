import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { promptAuthChoiceGrouped } from "../commands/auth-choice-prompt.js";
import { applyAuthChoice, warnIfModelConfigLooksOff } from "../commands/auth-choice.js";
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
import { collectWalletSignerDoctorReport, walletSetupCommand } from "../commands/wallet.js";
import type { FasedAgentConfig } from "../config/config.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WalletNamedWallet } from "../wallet/wallet-provider-registry.js";
import { readWalletProviderRegistry } from "../wallet/wallet-provider-registry.js";
import {
  checkNamedWalletDeletionSafety,
  deleteNamedWallet,
  resolveWalletUserRole,
  setDefaultWallet,
  setNamedWalletRole,
  upsertNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import {
  ensureWalletStateDir,
  resolveLocalSignerBackendSocketPath,
  resolveLocalSignerMaterialRootDir,
  resolveLocalSignerRunAsUser,
  resolveLocalSignerSocketPath,
} from "../wallet/wallet-runtime-config.js";
import { isHostedSecurityCapableSession } from "./host-security-capability.js";
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
  migrateLocalSignerKeystoreToMaterialDir,
  restartLocalSocketSigner,
} from "./onboarding.wallet.js";
import type { WizardPrompter } from "./prompts.js";
import { normalizeHostedWalletPaths } from "./wallet-path-migration.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  void params;
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
  const normalizeWalletId = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  const rpcEnvKeyFor = (_chain: "solana", walletId?: string): string => {
    const suffix = walletIdEnvSuffix(walletId);
    if (suffix) {
      return `FASED_WALLET_SOLANA_RPC_URL__${suffix}`;
    }
    return "FASED_WALLET_SOLANA_RPC_URL";
  };
  const keystoreEnvKeyFor = (_chain: "solana", walletId?: string): string => {
    const suffix = walletIdEnvSuffix(walletId);
    if (suffix) {
      return `FASED_WALLET_SOLANA_KEYSTORE_PATH__${suffix}`;
    }
    return "FASED_WALLET_SOLANA_KEYSTORE_PATH";
  };
  const defaultKeystorePathFor = (_chain: "solana", walletId?: string): string => {
    const normalized = String(walletId ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const walletDir = ensureWalletStateDir(process.env).rootDir;
    if (!normalized || normalized === "default") {
      return path.join(walletDir, "keystore-solana.v1.enc");
    }
    return path.join(walletDir, `keystore-solana-${normalized}.v1.enc`);
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
  const jupiterApiKeyEnvKey = "FASED_JUPITER_API_KEY";
  const jupiterTriggerApiBaseUrlEnvKey = "FASED_JUPITER_TRIGGER_API_BASE_URL";
  const readJupiterLimitOrderApiKey = (): string =>
    String(
      process.env[jupiterApiKeyEnvKey] ??
        nextConfig.env?.vars?.[jupiterApiKeyEnvKey] ??
        process.env.JUPITER_API_KEY ??
        nextConfig.env?.vars?.JUPITER_API_KEY ??
        "",
    ).trim();
  const readJupiterTriggerApiBaseUrl = (): string =>
    String(
      process.env[jupiterTriggerApiBaseUrlEnvKey] ??
        nextConfig.env?.vars?.[jupiterTriggerApiBaseUrlEnvKey] ??
        "",
    ).trim();
  const promptAndStoreJupiterLimitOrders = async (): Promise<boolean> => {
    const existingKey = readJupiterLimitOrderApiKey();
    const enable = await prompter.confirm({
      message: existingKey
        ? "Keep Jupiter wallet-action support enabled?"
        : "Enable Jupiter support for policy-gated Agent wallet actions?",
      initialValue: Boolean(existingKey),
    });
    if (!enable) {
      nextConfig = setConfigEnvVar(nextConfig, jupiterApiKeyEnvKey, undefined);
      nextConfig = setConfigEnvVar(nextConfig, jupiterTriggerApiBaseUrlEnvKey, undefined);
      delete process.env[jupiterApiKeyEnvKey];
      delete process.env[jupiterTriggerApiBaseUrlEnvKey];
      await prompter.note(
        "Jupiter wallet-action support disabled. Other approved wallet actions still use the normal wallet flow.",
        "Wallet actions",
      );
      return false;
    }
    const keyPrompt = existingKey ? "Jupiter API key (blank keeps current)" : "Jupiter API key";
    const keyInput = (
      typeof prompter.secret === "function"
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
      throw new Error("Jupiter API key is required to enable Jupiter wallet-action support.");
    }
    nextConfig = setConfigEnvVar(nextConfig, jupiterApiKeyEnvKey, effectiveKey);
    process.env[jupiterApiKeyEnvKey] = effectiveKey;

    const existingBaseUrl = readJupiterTriggerApiBaseUrl();
    if (existingBaseUrl) {
      const baseUrlInput = (
        await prompter.text({
          message: "Jupiter Trigger API base URL (blank keeps current)",
          initialValue: existingBaseUrl,
        })
      ).trim();
      const effectiveBaseUrl = baseUrlInput || existingBaseUrl;
      nextConfig = setConfigEnvVar(nextConfig, jupiterTriggerApiBaseUrlEnvKey, effectiveBaseUrl);
      process.env[jupiterTriggerApiBaseUrlEnvKey] = effectiveBaseUrl;
    }

    await prompter.note(
      [
        "Jupiter wallet-action support enabled for Agent wallet actions.",
        `${jupiterApiKeyEnvKey} is stored in local config env vars and is never printed in chat.`,
      ].join("\n"),
      "Wallet actions",
    );
    return true;
  };
  const promptAndStoreWalletRpcUrl = async (params: {
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
        message: `${params.chain.toUpperCase()} RPC URL for ${params.walletName} (${params.walletId})`,
        initialValue,
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
    nextConfig = setConfigEnvVar(nextConfig, rpcKey, effectiveRpcUrl);
    process.env[rpcKey] = effectiveRpcUrl;
    return effectiveRpcUrl;
  };
  const inferSatMiningNetwork = (rpcUrl: string): "local" | "devnet" | "mainnet-beta" => {
    const value = rpcUrl.trim().toLowerCase();
    if (
      value.includes("127.0.0.1") ||
      value.includes("localhost") ||
      value.includes(":8899") ||
      value.includes("localnet")
    ) {
      return "local";
    }
    if (value.includes("mainnet")) {
      return "mainnet-beta";
    }
    return "devnet";
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
  const walletPurposeBase = (
    purpose: WalletOnboardingPurpose,
  ): { walletName: string; walletId: string } => {
    switch (purpose) {
      case "agent":
        return { walletName: "Agent", walletId: "agent" };
      case "mining":
        return { walletName: "Mining", walletId: "mining" };
      case "vault":
        return { walletName: "Vault", walletId: "vault" };
    }
  };
  const uniqueWalletId = (baseWalletId: string) => {
    const registry = readWalletProviderRegistry(process.env);
    const baseId = normalizeWalletId(baseWalletId) || "wallet";
    const hasId = (candidate: string) => registry.wallets.some((wallet) => wallet.id === candidate);
    if (!hasId(baseId)) {
      return baseId;
    }
    for (let index = 2; index < 1000; index += 1) {
      const candidateId = `${baseId}-${index}`;
      if (!hasId(candidateId)) {
        return candidateId;
      }
    }
    return `${baseId}-${Date.now()}`;
  };
  const nextWalletIdentity = (purpose: WalletOnboardingPurpose) => {
    const base = walletPurposeBase(purpose);
    if (purpose === "mining") {
      return base;
    }
    const walletId = uniqueWalletId(base.walletId);
    if (walletId === base.walletId) {
      return base;
    }
    const suffix = walletId.startsWith(`${base.walletId}-`)
      ? walletId.slice(base.walletId.length + 1)
      : "";
    return {
      walletName: suffix ? `${base.walletName} ${suffix}` : base.walletName,
      walletId,
    };
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
      return `${walletName} (${walletId})`;
    }
    return walletName || walletId || "not set";
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
        "if [ -x /usr/local/go/bin/go ]; then GOCMD=/usr/local/go/bin/go; " +
          "elif command -v go >/dev/null 2>&1; then GOCMD=$(command -v go); " +
          "else exit 1; fi; " +
          "v=$($GOCMD version 2>/dev/null | awk '{print $3}' | sed 's/^go//'); " +
          'maj=$(echo "$v" | cut -d. -f1); min=$(echo "$v" | cut -d. -f2); ' +
          '([ "${maj:-0}" -gt 1 ] || ([ "${maj:-0}" -eq 1 ] && [ "${min:-0}" -ge 21 ]))',
      ],
      { stdio: "ignore" },
    );
    return probe.status === 0;
  };
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
  const resolveHostSignerTarget = (): string => {
    const os =
      process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
    const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
    return os && arch ? `${os}/${arch}` : "linux/amd64";
  };
  const hashFile = (filePath: string): string | null => {
    try {
      const hash = createHash("sha256");
      hash.update(fs.readFileSync(filePath));
      return hash.digest("hex");
    } catch {
      return null;
    }
  };
  const resolveHostSignerReleaseAssetPath = (): string | null => {
    const [os, arch] = resolveHostSignerTarget().split("/");
    if (!os || !arch) {
      return null;
    }
    return path.resolve("dist-native", "release", `fased-signerd-${os}-${arch}`);
  };
  const resolveInstalledSignerdPath = (): string =>
    String(process.env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim() ||
    path.join(process.env.HOME ?? "/root", ".fased", "bin", "fased-signerd");
  const installedSignerMatchesRelease = (): boolean => {
    if (String(process.env.FASED_FORCE_NATIVE_SIGNER_BUILD ?? "").trim() === "1") {
      return false;
    }
    const releaseAssetPath = resolveHostSignerReleaseAssetPath();
    if (!releaseAssetPath) {
      return false;
    }
    const releaseHash = hashFile(releaseAssetPath);
    const installedHash = hashFile(resolveInstalledSignerdPath());
    return Boolean(releaseHash && installedHash && releaseHash === installedHash);
  };
  const maybeInstallGoForOnboarding = async (): Promise<boolean> => {
    if (goModernEnough()) {
      return true;
    }
    if (process.platform !== "linux" || !hasCommand("sudo")) {
      return false;
    }
    if (opts.nonInteractive === true) {
      return false;
    }
    const installNow = await prompter.confirm({
      message: "Go >=1.21 is required for native signer. Install/update Go now?",
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
          "goversion=${FASED_GO_VERSION:-1.23.6}; " +
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
  await prompter.intro("Setup");
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: FasedAgentConfig = snapshot.valid ? snapshot.config : {};
  baseConfig = normalizeHostedWalletPaths(baseConfig, process.env);
  let satMiningAttachment = readSatMiningConfig(baseConfig);
  let federationBondWalletId = readFederationBondWalletId(baseConfig);
  const displayWalletName = (wallet: WalletNamedWallet): string => {
    const rawName = wallet.name.trim();
    const generatedLegacyName = /^solana\s+\d+$/i.test(rawName);
    const purpose = resolveWalletUserRole(wallet);
    if (purpose === "agent") {
      return "Agent wallet";
    }
    if (purpose === "mining" || wallet.id === satMiningAttachment.walletId) {
      return "Mining wallet";
    }
    if (purpose === "vault" || wallet.id === federationBondWalletId) {
      return "Vault wallet";
    }
    if (readAgentDefaultWallet().walletId === wallet.id) {
      return "Agent wallet";
    }
    if (!generatedLegacyName) {
      return rawName;
    }
    return "Unassigned wallet";
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

  if (snapshot.exists && !snapshot.valid) {
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

  const quickstartHint = `Configure details later via ${formatCliCommand("fased configure")}.`;
  const manualHint = "Configure port, network, Tailscale, and auth options.";
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
        { value: "quickstart", label: "QuickStart", hint: quickstartHint },
        { value: "advanced", label: "Manual", hint: manualHint },
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

  await prompter.note(
    [
      "Choose the host setup profile for the machine you are configuring:",
      "- Local: this machine or laptop. Good for first chat and the local Control UI. Local on a VPS means no SSH/firewall hardening.",
      "- Hosting: VPS or always-on server. Applies the Tailscale-first hosting baseline. Hosting on personal Linux changes SSH/firewall behavior.",
    ].join("\n"),
    "Setup map",
  );

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
    `Rerun ${formatCliCommand("./install.sh")} from root on the VPS and choose a hosting profile there.`,
  ].join("\n");
  const hostedProfileHint =
    hostSecurityCapable || hostMaintenanceSession
      ? "VPS hardening; Tailscale required"
      : "Root session required; Tailscale required for hosting";
  const localProfileHint = "This machine and local dashboard; no VPS hardening";

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
                  hint: localProfileHint,
                },
                {
                  value: "hosting",
                  label: "Hosting",
                  hint: hostedProfileHint,
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

  if (hostProfile === "hosting") {
    await prompter.note(
      [
        "Hosting uses private access through Tailscale.",
        "",
        "Web dashboard: open the Tailscale HTTPS URL printed at the end.",
        "SSH terminal: use tailscale ssh app@YOUR_VPS_TAILSCALE_NAME for CLI commands.",
        "",
        "Public SSH and Gateway ports stay blocked. Root is only for first bootstrap or emergency repair.",
      ].join("\n"),
      "Hosting access",
    );
  }

  if (snapshot.exists) {
    await prompter.note(summarizeExistingConfig(baseConfig), "Existing config detected");

    const action = await prompter.select<"modify" | "repair">({
      message: "Config handling",
      options: [
        {
          value: "modify",
          label: "Update settings",
          hint: "Edit setup values.",
        },
        {
          value: "repair",
          label: "Repair auth/sessions",
          hint: "Clear auth/session state only.",
        },
      ],
    });

    if (action === "repair") {
      const repairAllowed = await confirmOnboardingRepair({ prompter });
      if (!repairAllowed) {
        await prompter.note("Continuing with current config values.", "Update settings");
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

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return "Loopback (127.0.0.1)";
      }
      if (value === "lan") {
        return "LAN";
      }
      if (value === "custom") {
        return "Custom IP";
      }
      if (value === "tailnet") {
        return "Tailnet (Tailscale IP)";
      }
      return "Auto";
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return "Token (default)";
      }
      return "Password";
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return "Off";
      }
      if (value === "serve") {
        return "Serve";
      }
      return "Funnel";
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? hostProfile === "hosting"
        ? [
            "Hosting quickstart:",
            "Private web dashboard through Tailscale.",
            "Private SSH terminal through Tailscale.",
            "Gateway uses token auth and stays behind localhost.",
          ]
        : [
            "Keeping your current gateway settings:",
            `Gateway port: ${quickstartGateway.port}`,
            `Gateway bind: ${formatBind(quickstartGateway.bind)}`,
            ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
              ? [`Gateway custom IP: ${quickstartGateway.customBindHost}`]
              : []),
            `Gateway auth: ${formatAuth(quickstartGateway.authMode)}`,
            `Tailscale exposure: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
            "Connect chat apps later in Control UI > Channels.",
          ]
      : hostProfile === "hosting"
        ? [
            "Hosting quickstart:",
            "Private web dashboard through Tailscale.",
            "Private SSH terminal through Tailscale.",
            "Gateway uses token auth and stays behind localhost.",
          ]
        : [
            `Gateway port: ${DEFAULT_GATEWAY_PORT}`,
            "Gateway bind: Loopback (127.0.0.1)",
            "Gateway auth: Token (default)",
            `Tailscale exposure: Off`,
            "Connect chat apps later in Control UI > Channels.",
          ];
    if (hostProfile === "hosting") {
      quickstartLines.push("Installer applies the Tailscale-only admin access baseline.");
    }
    await prompter.note(quickstartLines.join("\n"), "QuickStart");
  }

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
        "Operator path for this machine:",
        "1. secure admin access",
        "2. configure the right wallet roles",
        "3. join Fased Network",
        "4. enable hosted reachability only if needed",
        "5. enable SAT mining only if needed",
        "",
        "Fased Network join does not automatically mean public paid-task or marketplace readiness.",
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
    const authResult = await applyAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: opts.tokenProvider,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    nextConfig = authResult.config;
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
  const buildNativeSignerFromSource =
    String(process.env.FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE ?? "").trim() === "1";
  const skipNativeSignerBuild =
    String(process.env.FASED_SKIP_NATIVE_SIGNER_BUILD ?? "").trim() === "1";
  if (buildNativeSignerFromSource) {
    if (skipNativeSignerBuild) {
      if (flow !== "quickstart") {
        await prompter.note(
          "Skipping native signer build/install because FASED_SKIP_NATIVE_SIGNER_BUILD=1.",
          "Native signer",
        );
      }
    } else if (installedSignerMatchesRelease()) {
      if (flow !== "quickstart") {
        await prompter.note("Native signer already current.", "Native signer");
      }
    } else if (!(await maybeInstallGoForOnboarding())) {
      const detail = "Go >=1.21 is required for native signer build/install.";
      if (hostingMode && !opts.allowInsecure) {
        throw new Error(
          `${detail} Install Go and rerun onboarding, or unset FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE.`,
        );
      }
      await prompter.note(`${detail} Skipping signer build/install.`, "Native signer");
    } else {
      const hostTarget = resolveHostSignerTarget();
      const progress = prompter.progress("Native signer");
      try {
        progress.update(`Building native signer for ${hostTarget}…`);
        await runShell(`FASED_SIGNER_TARGETS="${hostTarget}" scripts/release-fased-signerd.sh`);
        progress.update("Installing native signer…");
        await runShell(
          'FASED_LOCAL_SIGNER_BASE_URL="file://$PWD/dist-native/release" FASED_LOCAL_SIGNER_LATEST_TAG="" scripts/install-fased-signerd.sh',
        );
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
  if (nextConfig.wallet?.provider?.id === "local-socket-signer") {
    const signerSocketPath = resolveLocalSignerSocketPath(process.env);
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = signerSocketPath;
    nextConfig = setConfigEnvVar(nextConfig, "FASED_WALLET_LOCAL_SIGNER_SOCKET", signerSocketPath);
    const backendSocketPath = resolveLocalSignerBackendSocketPath(process.env);
    if (backendSocketPath !== signerSocketPath) {
      process.env.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET = backendSocketPath;
      nextConfig = setConfigEnvVar(
        nextConfig,
        "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
        backendSocketPath,
      );
    } else {
      delete process.env.FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET;
      nextConfig = setConfigEnvVar(
        nextConfig,
        "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
        undefined,
      );
    }
    const signerStateDir = resolveLocalSignerMaterialRootDir(process.env);
    if (signerStateDir !== ensureWalletStateDir(process.env).rootDir) {
      process.env.FASED_WALLET_SIGNER_STATE_DIR = signerStateDir;
      nextConfig = setConfigEnvVar(nextConfig, "FASED_WALLET_SIGNER_STATE_DIR", signerStateDir);
    } else {
      delete process.env.FASED_WALLET_SIGNER_STATE_DIR;
      nextConfig = setConfigEnvVar(nextConfig, "FASED_WALLET_SIGNER_STATE_DIR", undefined);
    }
    const signerRunAsUser = resolveLocalSignerRunAsUser(process.env);
    if (signerRunAsUser) {
      process.env.FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER = signerRunAsUser;
      nextConfig = setConfigEnvVar(
        nextConfig,
        "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
        signerRunAsUser,
      );
    } else {
      delete process.env.FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER;
      nextConfig = setConfigEnvVar(nextConfig, "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER", undefined);
    }
    const signerBinPath = String(process.env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim();
    if (signerBinPath) {
      nextConfig = setConfigEnvVar(nextConfig, "FASED_WALLET_LOCAL_SIGNER_BIN", signerBinPath);
    } else {
      delete process.env.FASED_WALLET_LOCAL_SIGNER_BIN;
      nextConfig = setConfigEnvVar(nextConfig, "FASED_WALLET_LOCAL_SIGNER_BIN", undefined);
    }
  }

  let onboardingWalletSecurityFocus: {
    walletId: string;
    role: "agent" | "vault";
  } | null = null;

  if (nextConfig.wallet?.runtime?.enabled) {
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
          "self-hosted" | "manage-self-hosted" | "limit-orders" | "skip"
        >({
          message: "Wallet setup action",
          options: [
            { value: "self-hosted", label: "Create wallet" },
            { value: "manage-self-hosted", label: "Manage wallet" },
            {
              value: "limit-orders",
              label: "Limit orders",
              hint: readJupiterLimitOrderApiKey()
                ? "Jupiter key configured"
                : "Enable Jupiter Trigger limit orders for Agent wallets",
            },
            { value: "skip", label: "Done / skip" },
          ],
          initialValue: flow === "quickstart" ? "self-hosted" : "skip",
        });
        if (setupMode === "skip") {
          break;
        }

        if (setupMode === "limit-orders") {
          await promptAndStoreJupiterLimitOrders();
          addAnotherWallet = await prompter.confirm({
            message: "Run another wallet setup action?",
            initialValue: false,
          });
          continue;
        }

        if (setupMode === "manage-self-hosted") {
          const registry = readWalletProviderRegistry(process.env);
          const managedWallets = registry.wallets.filter(
            (wallet) =>
              wallet.providerId === "local-socket-signer" ||
              wallet.providerId === "embedded-keystore" ||
              wallet.metadata?.selfHosted === true,
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
              label: displayWalletName(wallet),
              hint: [wallet.id, wallet.addresses?.solana ?? wallet.providerId]
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
          const configuredSolanaKeystore =
            (nextConfig.env?.vars?.[keystoreEnvKeyFor("solana", walletId)] ?? "").trim() ||
            String(process.env[keystoreEnvKeyFor("solana", walletId)] ?? "").trim();
          const supportsSolanaWallet = Boolean(
            targetWallet.addresses?.solana || configuredSolanaKeystore,
          );
          const targetWalletPurpose = resolveWalletUserRole(targetWallet);
          const manageAction = await prompter.select<
            | "attach-federation-bond"
            | "detach-federation-bond"
            | "configure-solana-rpc"
            | "delete"
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
                        ? configuredSolanaRpcUrl
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
              {
                value: "delete",
                label: "Delete wallet",
                hint: "Remove this wallet registration and local keystore mapping.",
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
            const effectiveSolanaRpcUrl = await promptAndStoreWalletRpcUrl({
              chain: "solana",
              walletId,
              walletName: targetWallet.name,
              currentValue: configuredSolanaRpcUrl,
            });
            await restartLocalSocketSigner(ensureWalletStateDir(process.env).rootDir);
            await prompter.note(
              `Updated Solana RPC for ${targetWallet.name} (${walletId}): ${effectiveSolanaRpcUrl}`,
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
          if (manageAction === "attach-federation-bond") {
            const agentDefaultWallet = readAgentDefaultWallet();
            if (targetWalletPurpose !== "vault") {
              await prompter.note(
                [
                  `${targetWallet.name} (${walletId}) is a ${targetWalletPurpose} wallet.`,
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
                  `${targetWallet.name} (${walletId}) is already used by ${agentDefaultWallet.walletId === walletId ? "Agent" : "Mining"}.`,
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
              `Configured Vault wallet ${targetWallet.name} (${walletId}) as the Fased Network bond Vault.`,
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
              `Cleared ${targetWallet.name} (${walletId}) as the Fased Network bond Vault.`,
              "Fased Network bond",
            );
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          const deletionSafety = checkNamedWalletDeletionSafety({
            walletId: targetWallet.id,
            env: process.env,
          });
          if (!deletionSafety.ok) {
            await prompter.note(deletionSafety.message, "Delete blocked");
            addAnotherWallet = await prompter.confirm({
              message: "Run another wallet setup action?",
              initialValue: false,
            });
            continue;
          }
          const deleteWarnings = [
            `This deletes the local wallet registration and local keystore files for ${targetWallet.name} (${targetWallet.id}).`,
            "It does not transfer funds and it cannot recover funds if you did not save the seed/private key first.",
            "Move funds out, save recovery material, and clear active Mining/Fased Network use before deleting.",
          ];
          if (currentMiningWalletId === targetWallet.id || targetWalletPurpose === "mining") {
            deleteWarnings.push(
              "For @wallet:mining, stop mining first; move SAT/SOL out; save recovery material; then delete and recreate the singleton Mining wallet.",
            );
          }
          deleteWarnings.push(
            "If balances cannot be checked from this terminal, treat the balance as unknown and verify it from the Wallet or Mining page first.",
            "Use repair for auth/session recovery only; wallet deletion is always per-wallet.",
          );
          await prompter.note(deleteWarnings.join("\n"), "Delete wallet");
          const typedWalletId = await prompter.text({
            message: `Type wallet id "${targetWallet.id}" to delete this wallet`,
            validate: (value) =>
              value.trim() === targetWallet.id ? undefined : `Type ${targetWallet.id}`,
          });
          if (typedWalletId.trim() === targetWallet.id) {
            const walletId = targetWallet.id;
            const keystoreKeys = [keystoreEnvKeyFor("solana", walletId)];
            const defaultKeystorePaths = [defaultKeystorePathFor("solana", walletId)];
            const configuredPaths = keystoreKeys
              .map(
                (key) =>
                  (nextConfig.env?.vars?.[key] ?? "").trim() ||
                  String(process.env[key] ?? "").trim(),
              )
              .filter(Boolean);
            for (const file of new Set([...configuredPaths, ...defaultKeystorePaths])) {
              try {
                if (file && fs.existsSync(file)) {
                  fs.rmSync(file, { force: true });
                }
              } catch {}
            }
            for (const key of keystoreKeys) {
              nextConfig = setConfigEnvVar(nextConfig, key, undefined);
              delete process.env[key];
            }
            for (const key of [rpcEnvKeyFor("solana", walletId)]) {
              nextConfig = setConfigEnvVar(nextConfig, key, undefined);
              delete process.env[key];
            }
            if (satMiningAttachment.walletId === walletId) {
              satMiningAttachment = {};
              nextConfig = clearSatMiningAttachment(nextConfig);
            }
            if (federationBondWalletId === walletId) {
              federationBondWalletId = undefined;
              nextConfig = clearFederationBondWallet(nextConfig);
            }
            deleteNamedWallet({ walletId, env: process.env });
            await restartLocalSocketSigner(ensureWalletStateDir(process.env).rootDir);
            await prompter.note(
              `Deleted wallet ${targetWallet.name} (${walletId}) from onboarding-safe management.`,
              "Wallet setup",
            );
          } else {
            await prompter.note("Wallet deletion cancelled.", "Wallet setup");
          }
          addAnotherWallet = await prompter.confirm({
            message: "Run another wallet setup action?",
            initialValue: false,
          });
          continue;
        }

        attemptedSelfHostedSetupThisRun = true;
        const chain = "solana" as const;
        const walletPurpose =
          flow === "quickstart" && !snapshot.exists
            ? ("agent" as const)
            : await prompter.select<WalletOnboardingPurpose>({
                message: "Wallet purpose",
                options: [
                  { value: "agent", label: "Agent" },
                  { value: "mining", label: "Mining" },
                  { value: "vault", label: "Vault" },
                ],
                initialValue: "agent",
              });
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
                "Delete that Mining wallet from onboarding first if you want to replace it.",
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
        const mode = selfHostedAction === "create" ? "local-signer-create" : "local-signer-import";
        const walletIdentity = await resolveWalletIdentityForOnboarding({
          flow,
          purpose: walletPurpose,
        });
        const walletName = walletIdentity.walletName;
        const walletId: string | undefined = walletIdentity.walletId || undefined;
        const keystoreKey = keystoreEnvKeyFor(chain, walletId);
        const currentKeystoreValue =
          (nextConfig.env?.vars?.[keystoreKey] ?? "").trim() ||
          String(process.env[keystoreKey] ?? "").trim();
        const isolatedSignerRunAsUser = resolveLocalSignerRunAsUser(process.env);
        const stagingKeystorePath = defaultKeystorePathFor(chain, walletId);
        const effectiveKeystorePath = isolatedSignerRunAsUser
          ? stagingKeystorePath
          : currentKeystoreValue || stagingKeystorePath;
        const isolatedTargetKeystorePath = isolatedSignerRunAsUser
          ? path.join(
              resolveLocalSignerMaterialRootDir(process.env),
              path.basename(stagingKeystorePath),
            )
          : undefined;
        nextConfig = setConfigEnvVar(nextConfig, keystoreKey, effectiveKeystorePath);
        process.env[keystoreKey] = effectiveKeystorePath;
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
        nextConfig = setConfigEnvVar(nextConfig, rpcKey, effectiveRpcUrl);
        process.env[rpcKey] = effectiveRpcUrl;
        try {
          let moveToSignerDir = false;
          if (isolatedTargetKeystorePath && fs.existsSync(isolatedTargetKeystorePath)) {
            moveToSignerDir = await prompter.confirm({
              message: "Signer keystore already exists. Overwrite it?",
              initialValue: false,
            });
            if (!moveToSignerDir) {
              throw new Error(`Keystore already exists: ${isolatedTargetKeystorePath}`);
            }
          }
          const prevSignerStateDir = process.env.FASED_WALLET_SIGNER_STATE_DIR;
          const prevPassphraseFile = process.env.FASED_WALLET_PASSPHRASE_FILE;
          if (mode === "local-signer-create") {
            const showPrivateKeyOnce = await prompter.confirm({
              message: "Show generated private key once for offline backup?",
              initialValue: false,
            });
            const confirmPrivateKeyPrint = showPrivateKeyOnce ? "SHOW PRIVATE KEY" : undefined;
            try {
              if (isolatedSignerRunAsUser) {
                delete process.env.FASED_WALLET_SIGNER_STATE_DIR;
                delete process.env.FASED_WALLET_PASSPHRASE_FILE;
              }
              await walletSetupCommand(runtime, {
                mode,
                chain,
                walletId,
                walletName,
                rpcUrl: effectiveRpcUrl,
                showPrivateKeyOnce,
                confirmPrivateKeyPrint,
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
                moveToSignerDir = true;
                await walletSetupCommand(runtime, {
                  mode,
                  chain,
                  walletId,
                  walletName,
                  rpcUrl: effectiveRpcUrl,
                  showPrivateKeyOnce,
                  confirmPrivateKeyPrint,
                  force: true,
                  noDoctor: true,
                  noSignerHints: true,
                  nonInteractive: true,
                });
              } else {
                throw err;
              }
            } finally {
              if (isolatedSignerRunAsUser) {
                if (prevSignerStateDir == null) {
                  delete process.env.FASED_WALLET_SIGNER_STATE_DIR;
                } else {
                  process.env.FASED_WALLET_SIGNER_STATE_DIR = prevSignerStateDir;
                }
                if (prevPassphraseFile == null) {
                  delete process.env.FASED_WALLET_PASSPHRASE_FILE;
                } else {
                  process.env.FASED_WALLET_PASSPHRASE_FILE = prevPassphraseFile;
                }
              }
            }
          } else {
            const keyInput =
              typeof prompter.secret === "function"
                ? await prompter.secret({
                    message: "Solana private key (base58/json/base64/hex)",
                    validate: (value) => (value.trim() ? undefined : "Required"),
                  })
                : await prompter.text({
                    message: "Solana private key (base58/json/base64/hex)",
                    validate: (value) => (value.trim() ? undefined : "Required"),
                  });
            try {
              if (isolatedSignerRunAsUser) {
                delete process.env.FASED_WALLET_SIGNER_STATE_DIR;
                delete process.env.FASED_WALLET_PASSPHRASE_FILE;
              }
              await walletSetupCommand(runtime, {
                mode: "local-signer-import",
                chain,
                walletId,
                walletName,
                privateKey: keyInput.trim(),
                rpcUrl: effectiveRpcUrl,
                noDoctor: true,
                noSignerHints: true,
                nonInteractive: true,
              });
            } finally {
              if (isolatedSignerRunAsUser) {
                if (prevSignerStateDir == null) {
                  delete process.env.FASED_WALLET_SIGNER_STATE_DIR;
                } else {
                  process.env.FASED_WALLET_SIGNER_STATE_DIR = prevSignerStateDir;
                }
                if (prevPassphraseFile == null) {
                  delete process.env.FASED_WALLET_PASSPHRASE_FILE;
                } else {
                  process.env.FASED_WALLET_PASSPHRASE_FILE = prevPassphraseFile;
                }
              }
            }
          }
          let configuredKeystorePath = effectiveKeystorePath;
          if (isolatedSignerRunAsUser) {
            configuredKeystorePath = migrateLocalSignerKeystoreToMaterialDir({
              keystorePath: effectiveKeystorePath,
              force: moveToSignerDir,
            });
            nextConfig = setConfigEnvVar(nextConfig, keystoreKey, configuredKeystorePath);
            process.env[keystoreKey] = configuredKeystorePath;
          }
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
            const currentPrimary = String(agentDefaultBefore.walletId ?? "").trim();
            if (!currentPrimary || currentPrimary === walletId) {
              setDefaultWallet({ walletId: walletId ?? "default", env: process.env });
              await prompter.note(
                `Primary Agent wallet set to ${walletName} (${walletId ?? "default"}).`,
                "Wallet",
              );
            } else {
              await prompter.note(
                [
                  `Agent wallet created as ${walletName} (${walletId ?? "default"}).`,
                  `Primary Agent wallet remains ${describeWalletRef(agentDefaultBefore)}.`,
                  `Use @wallet:${walletId ?? "default"} when you want this wallet explicitly.`,
                ].join("\n"),
                "Wallet",
              );
            }
          }
          if (walletId) {
            setNamedWalletRole({
              walletId,
              role: walletPurpose,
              env: process.env,
            });
          }
          if (walletId) {
            onboardingWalletSecurityFocus =
              walletPurpose === "mining"
                ? null
                : {
                    walletId,
                    role: isAgentWallet ? "agent" : "vault",
                  };
          }
          if (chain === "solana" && walletId) {
            const currentMiningWalletId = satMiningAttachment.walletId ?? "";
            if (isAgentWallet) {
              await prompter.note(
                [
                  `${walletName} (${walletId}) is now the Agent wallet.`,
                  "Mining stays on a separate wallet.",
                  "Create or import one dedicated Mining wallet if you want SAT mining on this host.",
                ].join("\n"),
                "Mining",
              );
            } else {
              const shouldAttach = walletPurpose === "mining" && currentMiningWalletId !== walletId;
              if (shouldAttach) {
                const miningNetwork = inferSatMiningNetwork(effectiveRpcUrl);
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
                    `Mining wallet set to ${walletName} (${walletId}).`,
                    "Open the Mining page after onboarding to fund Mining capital and start worker automation.",
                  ].join("\n"),
                  "Mining",
                );
              } else if (currentMiningWalletId && currentMiningWalletId !== walletId) {
                await prompter.note(
                  `Keeping existing Mining wallet: ${currentMiningWalletId}`,
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
          "Wallet setup summary:",
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
            return `- ${label} [${scope}] ${evt.ok ? "ok" : "failed"}${evt.detail ? ` (${evt.detail})` : ""}`;
          }),
          "",
          `- Agent wallet: ${describeWalletRef(readAgentWalletSummary())}`,
          `- SAT mining wallet: ${describeWalletRef(readRoleWallet("mining"))}`,
          `- Vault wallet: ${describeWalletRef(readRoleWallet("vault"))}`,
          `- Fased Network bond Vault: ${
            federationBondWalletId
              ? describeWalletRef({
                  walletId: federationBondWalletId,
                  walletName: readWalletProviderRegistry(process.env).wallets.find(
                    (wallet) => wallet.id === federationBondWalletId,
                  )?.name,
                })
              : "not assigned"
          }`,
          `- Jupiter wallet actions: ${readJupiterLimitOrderApiKey() ? "configured" : "not configured"}`,
        ];
        const rpcKeys = Array.from(
          new Set(
            walletCeremonyEvents
              .map((evt) => evt.rpcEnvKey)
              .filter((key): key is string => Boolean(key)),
          ),
        );
        if (rpcKeys.length > 0) {
          summaryLines.push("", "RPC env keys:");
          for (const key of rpcKeys) {
            const configured = Boolean((nextConfig.env?.vars?.[key] ?? "").trim());
            summaryLines.push(`- ${key}${configured ? " (configured)" : " (unset)"}`);
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
          const authResult = await applyAuthChoice({
            authChoice: providerAuthChoice,
            config: nextConfig,
            prompter,
            runtime,
            setDefaultModel: true,
            opts: {},
          });
          nextConfig = authResult.config;
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
      "Hosting security checklist:",
      ...hostSecurity.checks.map(
        (check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`,
      ),
      hostSecurity.logPath ? `Detailed host hardening log: ${hostSecurity.logPath}` : undefined,
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
  if (launchedTui) {
    return;
  }
}
