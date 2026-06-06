import type { FasedAgentConfig } from "../../../config/config.js";
import type {
  WalletChain,
  WalletRuntimeConfig,
  WalletRuntimeMode,
  WalletRuntimeKind,
  WalletProviderId,
  WalletToolAccessMode,
} from "../../../config/types.wallet.js";
import type { RuntimeEnv } from "../../../runtime.js";
import {
  WALLET_PROVIDER_IDS,
  readWalletProviderRegistry,
  setWalletProvidersEnabled,
} from "../../../wallet/wallet-provider-registry.js";
import type { OnboardOptions } from "../../onboard-types.js";

const DEFAULT_WALLET_CHAINS: WalletChain[] = ["solana"];
const DEFAULT_WALLET_RUNTIME_HOST = "127.0.0.1";
const DEFAULT_WALLET_RUNTIME_PORT = 19444;
const DEFAULT_WALLET_RUNTIME_VERSION = "0.1.1";
const DEFAULT_SOLANA_MAX_PER_TX = "1000000000";
const DEFAULT_SOLANA_MAX_DAILY = "5000000000";

function isManagedGatewayMode(opts: OnboardOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.FASED_GATEWAY_MODE ?? "").trim().toLowerCase();
  if (mode === "managed") {
    return true;
  }
  if (mode === "local" || mode === "gateway") {
    return false;
  }
  if (opts.mode === "remote") {
    return false;
  }
  return opts.flow !== "advanced";
}

function splitCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChains(chains: WalletChain[] | undefined): WalletChain[] {
  const out = new Set<WalletChain>();
  for (const chain of chains ?? []) {
    if (chain === "solana") {
      out.add(chain);
    }
  }
  if (out.size === 0) {
    return [...DEFAULT_WALLET_CHAINS];
  }
  return [...out];
}

function applyWalletConfig(
  base: FasedAgentConfig,
  runtimeConfig: WalletRuntimeConfig & { defaultProviderId?: WalletProviderId },
): FasedAgentConfig {
  const { defaultProviderId, ...walletRuntimeConfig } = runtimeConfig;
  const providerId = defaultProviderId ?? parseWalletProviderId(base.wallet?.provider?.id);
  const provider = {
    ...base.wallet?.provider,
    ...(providerId ? { id: providerId } : {}),
  };
  if (!providerId) {
    delete provider.id;
  }
  return {
    ...base,
    wallet: {
      ...base.wallet,
      provider,
      runtime: {
        ...base.wallet?.runtime,
        ...walletRuntimeConfig,
      },
    },
  };
}

function parseWalletMode(raw: string | undefined): WalletRuntimeMode | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "managed" || normalized === "external") {
    return normalized;
  }
  return null;
}

function parseWalletRuntime(raw: string | undefined): WalletRuntimeKind | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "external-docker" || normalized === "external-custom") {
    return normalized;
  }
  return null;
}

function parseWalletProviderId(raw: string | undefined): WalletProviderId | null {
  switch ((raw ?? "").trim()) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "privy":
      return raw as WalletProviderId;
    default:
      return null;
  }
}

function parseToolAccessMode(raw: string | undefined): WalletToolAccessMode | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "owner-only" || normalized === "allowlist" || normalized === "all") {
    return normalized;
  }
  return null;
}

function hasConfiguredWalletMaterial(registry: ReturnType<typeof readWalletProviderRegistry>) {
  return registry.wallets.length > 0;
}

const LOCAL_SIGNER_ENV_KEYS = [
  "FASED_WALLET_LOCAL_SIGNER_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
  "FASED_WALLET_SIGNER_STATE_DIR",
  "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
  "FASED_WALLET_LOCAL_SIGNER_BIN",
  "FASED_WALLET_PASSPHRASE_FILE",
] as const;

function clearLocalSignerEnv(base: FasedAgentConfig): FasedAgentConfig {
  for (const key of LOCAL_SIGNER_ENV_KEYS) {
    delete process.env[key];
  }
  const vars = { ...base.env?.vars };
  for (const key of LOCAL_SIGNER_ENV_KEYS) {
    delete vars[key];
  }
  return {
    ...base,
    env: {
      ...base.env,
      vars,
    },
  };
}

export function applyNonInteractiveWalletConfig(params: {
  nextConfig: FasedAgentConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}) {
  const { nextConfig, opts, runtime } = params;
  const current = nextConfig.wallet?.runtime;
  const managedMode = isManagedGatewayMode(opts);
  const registry = readWalletProviderRegistry(process.env);
  const configuredWalletMaterial = hasConfiguredWalletMaterial(registry);
  const enabled =
    opts.walletEnabled ??
    (current?.enabled === false ? false : Boolean(current?.enabled && configuredWalletMaterial));

  if (!enabled) {
    setWalletProvidersEnabled({ enabledProviders: [], env: process.env });
    return applyWalletConfig(clearLocalSignerEnv(nextConfig), { enabled: false });
  }

  const providersFromOption =
    typeof opts.walletProviders === "string"
      ? opts.walletProviders
          .split(",")
          .map((entry) => parseWalletProviderId(entry.trim()))
          .filter((entry): entry is WalletProviderId => Boolean(entry))
      : null;
  const invalidProviders =
    typeof opts.walletProviders === "string"
      ? opts.walletProviders
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => Boolean(entry))
          .filter((entry) => !parseWalletProviderId(entry))
      : [];
  if (invalidProviders.length > 0) {
    runtime.error(
      `Invalid --wallet-providers values: ${invalidProviders.join(", ")} (use ${WALLET_PROVIDER_IDS.join(",")}).`,
    );
    runtime.exit(1);
    return nextConfig;
  }
  const defaultProviderFromOption = parseWalletProviderId(opts.walletDefaultProvider);
  if (opts.walletDefaultProvider && !defaultProviderFromOption) {
    runtime.error(
      `Invalid --wallet-default-provider value: ${opts.walletDefaultProvider} (use ${WALLET_PROVIDER_IDS.join("|")}).`,
    );
    runtime.exit(1);
    return nextConfig;
  }
  const existingEnabledProviders = WALLET_PROVIDER_IDS.filter(
    (providerId) => registry.providers[providerId]?.enabled,
  );
  const defaultProviderFromConfig = parseWalletProviderId(nextConfig.wallet?.provider?.id);
  const defaultProvider =
    defaultProviderFromOption ??
    (defaultProviderFromConfig === "embedded-keystore"
      ? "local-socket-signer"
      : defaultProviderFromConfig) ??
    providersFromOption?.[0] ??
    "local-socket-signer";
  const enabledProviders = providersFromOption
    ? [...providersFromOption]
    : existingEnabledProviders.length > 0
      ? [...existingEnabledProviders]
      : [defaultProvider];
  if (!enabledProviders.includes(defaultProvider)) {
    enabledProviders.unshift(defaultProvider);
  }
  setWalletProvidersEnabled({
    enabledProviders,
    env: process.env,
  });
  const selfHostEnabled = false;

  const runtimeSource: WalletRuntimeKind =
    parseWalletRuntime(opts.walletRuntime) ??
    (current?.runtime === "external-docker" || current?.runtime === "external-custom"
      ? current.runtime
      : parseWalletMode(opts.walletMode) === "external"
        ? "external-custom"
        : current?.mode === "external"
          ? "external-custom"
          : managedMode && selfHostEnabled
            ? "external-docker"
            : "external-custom");
  const mode: WalletRuntimeMode = "external";
  if (!mode) {
    runtime.error("Invalid --wallet-mode (use managed|external).");
    runtime.exit(1);
    return nextConfig;
  }

  const chainsInput = splitCsvList(opts.walletChains);
  const parsedChains = chainsInput.length
    ? chainsInput.map((chain) => chain.toLowerCase()).filter(Boolean)
    : (current?.chains ?? DEFAULT_WALLET_CHAINS);
  const invalidChains = parsedChains.filter((chain) => chain !== "solana");
  if (invalidChains.length > 0) {
    runtime.error(`Invalid --wallet-chains values: ${invalidChains.join(", ")} (use solana).`);
    runtime.exit(1);
    return nextConfig;
  }
  const chains = normalizeChains(parsedChains as WalletChain[]);

  const host =
    opts.walletHost?.trim() || current?.service?.host?.trim() || DEFAULT_WALLET_RUNTIME_HOST;
  const port = opts.walletPort ?? current?.service?.port ?? DEFAULT_WALLET_RUNTIME_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    runtime.error("Invalid --wallet-port (must be 1-65535).");
    runtime.exit(1);
    return nextConfig;
  }

  const installEnabled = selfHostEnabled
    ? (opts.walletInstallEnabled ??
      current?.install?.enabled ??
      (managedMode && runtimeSource === "external-docker"))
    : false;
  const installVersion =
    opts.walletInstallVersion?.trim() ||
    current?.install?.version?.trim() ||
    DEFAULT_WALLET_RUNTIME_VERSION;
  const authMode =
    current?.auth?.mode === "jwt-bootstrap" || current?.auth?.mode === "static-token-compat"
      ? current.auth.mode
      : selfHostEnabled && runtimeSource === "external-docker"
        ? "jwt-bootstrap"
        : "static-token-compat";
  const authBootstrapUrl = current?.auth?.bootstrapUrl?.trim() || undefined;
  const sourceRef = current?.source?.ref?.trim() || undefined;
  const directSigning = opts.walletDirectSigning ?? current?.policy?.directSigning ?? managedMode;

  const toolAccessMode =
    parseToolAccessMode(opts.walletToolAccessMode) ?? current?.toolAccess?.mode ?? "owner-only";
  if (!toolAccessMode) {
    runtime.error("Invalid --wallet-tool-access-mode (use owner-only|allowlist|all).");
    runtime.exit(1);
    return nextConfig;
  }
  const allowAgents =
    toolAccessMode === "allowlist"
      ? splitCsvList(opts.walletToolAccessAllowAgents).length > 0
        ? splitCsvList(opts.walletToolAccessAllowAgents)
        : (current?.toolAccess?.allowAgents ?? [])
      : [];

  const solanaAllowPrograms =
    splitCsvList(opts.walletSolanaAllowPrograms).length > 0
      ? splitCsvList(opts.walletSolanaAllowPrograms)
      : (current?.policy?.solana?.allowPrograms ?? []);
  const solanaMaxPerTx =
    opts.walletSolanaMaxPerTx?.trim() ||
    current?.policy?.solana?.maxPerTx?.trim() ||
    DEFAULT_SOLANA_MAX_PER_TX;
  const solanaMaxDaily =
    opts.walletSolanaMaxDaily?.trim() ||
    current?.policy?.solana?.maxDaily?.trim() ||
    DEFAULT_SOLANA_MAX_DAILY;

  return applyWalletConfig(nextConfig, {
    enabled: true,
    defaultProviderId: defaultProvider,
    mode,
    runtime: runtimeSource,
    external: {
      kind: runtimeSource === "external-docker" ? "docker" : "custom",
    },
    chains,
    service: {
      host,
      port: Math.floor(port),
    },
    install: {
      enabled: installEnabled,
      version: installVersion,
    },
    auth: {
      mode: selfHostEnabled && runtimeSource === "external-docker" ? "jwt-bootstrap" : authMode,
      bootstrapUrl: authBootstrapUrl,
    },
    source: sourceRef
      ? {
          ref: sourceRef,
        }
      : undefined,
    policy: {
      directSigning,
      solana: {
        allowPrograms: solanaAllowPrograms,
        maxPerTx: solanaMaxPerTx,
        maxDaily: solanaMaxDaily,
      },
    },
    toolAccess: {
      mode: toolAccessMode,
      allowAgents,
    },
  });
}
