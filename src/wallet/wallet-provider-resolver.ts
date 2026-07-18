import type { FasedAgentConfig } from "../config/config.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import {
  hasLegacyEmbeddedKeystoreConfig,
  hasLegacyEmbeddedKeystoreMaterialHint,
  throwLegacyEmbeddedKeystoreMigrationRequired,
} from "./legacy-embedded-keystore.js";
import { AlchemyAdapter } from "./providers/alchemy-adapter.js";
import {
  LocalSocketSignerAdapter,
  requireLocalSocketSignerPath,
} from "./providers/local-socket-signer-adapter.js";
import { TurnkeyAdapter } from "./providers/turnkey-adapter.js";
import { WalletStandardAdapter } from "./providers/wallet-standard-adapter.js";
import type { WalletProviderAdapter } from "./wallet-provider-adapter.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";
import { loadWalletProviderSecret } from "./wallet-secrets-store.js";

function parseProviderId(input: string | undefined): WalletProviderId | null {
  switch ((input ?? "").trim()) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "wallet-standard":
    case "privy":
      return input as WalletProviderId;
    default:
      return null;
  }
}

function throwPrivyProviderUnavailable(): never {
  throw new Error(
    "Privy wallet creation and signing are unavailable; no Privy provider selection or credentials are accepted.",
  );
}

function pickCredentialValue(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeWalletIdForEnvSuffix(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function inferWalletChainFromRegistry(env: NodeJS.ProcessEnv, walletId?: string): "solana" | null {
  const id = String(walletId ?? "").trim();
  if (!id) {
    return null;
  }
  const registry = readWalletProviderRegistry(env);
  const wallet = registry.wallets.find((entry) => entry.id === id);
  const sourceId = String(wallet?.id ?? id)
    .trim()
    .toLowerCase();
  const sourceName = String(wallet?.name ?? "")
    .trim()
    .toLowerCase();
  if (sourceId.startsWith("solana-") || sourceName.startsWith("solana ")) {
    return "solana";
  }
  if (wallet?.addresses?.solana) {
    return "solana";
  }
  return null;
}

function resolveWalletRpcUrlFromEnv(
  env: NodeJS.ProcessEnv,
  chain: "solana",
  walletId?: string,
): string {
  const suffix = normalizeWalletIdForEnvSuffix(walletId)?.toUpperCase();
  const perWalletKey = suffix ? `FASED_WALLET_SOLANA_RPC_URL__${suffix}` : "";
  const perChainKey = "FASED_WALLET_SOLANA_RPC_URL";
  const scopedOrChain =
    (perWalletKey ? String(env[perWalletKey] ?? "").trim() : "") ||
    String(env[perChainKey] ?? "").trim();
  return scopedOrChain || String(env.FASED_WALLET_RPC_URL ?? "").trim();
}

export function resolveScopedRpcUrlForWallet(params: {
  env: NodeJS.ProcessEnv;
  chains: Array<"solana">;
  walletId?: string;
}): string | undefined {
  const preferred = inferWalletChainFromRegistry(params.env, params.walletId);
  if (preferred && params.chains.includes(preferred)) {
    const preferredRpc = resolveWalletRpcUrlFromEnv(params.env, preferred, params.walletId);
    if (preferredRpc) {
      return preferredRpc;
    }
  }
  for (const chain of params.chains) {
    const rpcUrl = resolveWalletRpcUrlFromEnv(params.env, chain, params.walletId);
    if (rpcUrl) {
      return rpcUrl;
    }
  }
  return undefined;
}

function inferSelfHostedProviderId(env: NodeJS.ProcessEnv): WalletProviderId | null {
  if (String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim()) {
    return "local-socket-signer";
  }
  return null;
}

export function resolveWalletProviderId(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderId {
  const effectiveEnv = {
    ...env,
    ...cfg.env?.vars,
  } as NodeJS.ProcessEnv;
  const envProvider = parseProviderId(effectiveEnv.FASED_WALLET_PROVIDER);
  if (hasLegacyEmbeddedKeystoreConfig(cfg, effectiveEnv)) {
    throwLegacyEmbeddedKeystoreMigrationRequired("legacy wallet provider selection detected");
  }
  if (hasLegacyEmbeddedKeystoreMaterialHint(effectiveEnv)) {
    throwLegacyEmbeddedKeystoreMigrationRequired("legacy wallet material configuration detected");
  }
  const configProvider = parseProviderId(cfg.wallet?.provider?.id);
  const inferredSelfHostedProvider = inferSelfHostedProviderId(effectiveEnv);
  let registryProvider: WalletProviderId | null = null;
  let registryHasLegacyEmbeddedWallet = false;
  try {
    const registry = readWalletProviderRegistry(effectiveEnv);
    registryHasLegacyEmbeddedWallet =
      Boolean(registry.providers["embedded-keystore"]?.enabled) ||
      registry.wallets.some((entry) => entry.providerId === "embedded-keystore");
    const satWalletId =
      typeof cfg.plugins?.entries?.["sat-mining"]?.config?.walletId === "string"
        ? cfg.plugins.entries["sat-mining"]?.config?.walletId.trim()
        : "";
    const satWallet = satWalletId
      ? registry.wallets.find((entry) => entry.id === satWalletId)
      : undefined;
    if (satWallet?.providerId) {
      registryProvider = satWallet.providerId;
    } else {
      const defaultWallet = registry.defaultWalletId?.trim()
        ? registry.wallets.find((entry) => entry.id === registry.defaultWalletId?.trim())
        : undefined;
      if (defaultWallet?.providerId) {
        registryProvider = defaultWallet.providerId;
      } else {
        const distinctProviders = [...new Set(registry.wallets.map((entry) => entry.providerId))];
        if (distinctProviders.length === 1) {
          registryProvider = distinctProviders[0] ?? null;
        } else if (
          registry.providers["local-socket-signer"]?.enabled &&
          !registry.providers["embedded-keystore"]?.enabled
        ) {
          registryProvider = "local-socket-signer";
        }
      }
    }
  } catch {
    registryProvider = null;
  }
  if (registryHasLegacyEmbeddedWallet || registryProvider === "embedded-keystore") {
    throwLegacyEmbeddedKeystoreMigrationRequired("legacy wallet registry selection detected");
  }
  if (envProvider === "privy") {
    throwPrivyProviderUnavailable();
  }
  if (envProvider) {
    return envProvider;
  }
  if (registryProvider === "privy") {
    throwPrivyProviderUnavailable();
  }
  if (registryProvider && !configProvider) {
    return registryProvider;
  }
  if (inferredSelfHostedProvider && !configProvider) {
    return inferredSelfHostedProvider;
  }
  if (configProvider) {
    if (configProvider === "privy") {
      throwPrivyProviderUnavailable();
    }
    return configProvider;
  }
  return inferredSelfHostedProvider ?? "local-socket-signer";
}

export function createWalletProviderAdapter(params: {
  cfg: FasedAgentConfig;
  wallet: ResolvedWalletRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  providerIdOverride?: WalletProviderId;
  walletId?: string;
}): WalletProviderAdapter {
  const env = {
    ...(params.env ?? process.env),
    ...params.cfg.env?.vars,
  } as NodeJS.ProcessEnv;
  const providerId = params.providerIdOverride ?? resolveWalletProviderId(params.cfg, env);

  if (providerId === "embedded-keystore") {
    throwLegacyEmbeddedKeystoreMigrationRequired("legacy wallet adapter selection detected");
  }

  if (providerId === "local-socket-signer") {
    return new LocalSocketSignerAdapter(requireLocalSocketSignerPath(env), {
      rpcUrl: resolveScopedRpcUrlForWallet({
        env,
        chains: params.wallet.chains,
        walletId: params.walletId,
      }),
      scopedWalletId: params.walletId,
    });
  }

  if (providerId === "alchemy") {
    const secret = loadWalletProviderSecret("alchemy", env);
    const secretCredentials = secret?.credentials ?? {};
    return new AlchemyAdapter({
      chains: params.wallet.chains,
      credentials: {
        apiKey:
          String(secretCredentials.apiKey ?? "").trim() ||
          String(env.FASED_WALLET_ALCHEMY_API_KEY ?? "").trim(),
        serverSignerAccessKey:
          String(secretCredentials.serverSignerAccessKey ?? "").trim() ||
          String(env.FASED_WALLET_ALCHEMY_ACCESS_KEY ?? "").trim(),
        serverSignerAccountId:
          String(secretCredentials.serverSignerAccountId ?? "").trim() ||
          String(env.FASED_WALLET_ALCHEMY_ACCOUNT_ID ?? "").trim() ||
          undefined,
        walletApiBaseUrl:
          String(secretCredentials.walletApiBaseUrl ?? "").trim() ||
          String(env.FASED_WALLET_ALCHEMY_WALLET_API_BASE_URL ?? "").trim() ||
          undefined,
        signerApiBaseUrl:
          String(secretCredentials.signerApiBaseUrl ?? "").trim() ||
          String(env.FASED_WALLET_ALCHEMY_SIGNER_API_BASE_URL ?? "").trim() ||
          undefined,
        rpcUrl: String(secretCredentials.rpcUrl ?? "").trim() || undefined,
        defaultSolanaAddress:
          String(secretCredentials.defaultSolanaAddress ?? "").trim() ||
          String(env.FASED_WALLET_ALCHEMY_DEFAULT_SOLANA_ADDRESS ?? "").trim() ||
          undefined,
      },
    });
  }
  if (providerId === "turnkey") {
    const secret = loadWalletProviderSecret(providerId, env);
    const secretCredentials = secret?.credentials ?? {};
    const registeredWallet = params.walletId
      ? readWalletProviderRegistry(env).wallets.find((entry) => entry.id === params.walletId)
      : undefined;
    const registeredProviderWalletId =
      typeof registeredWallet?.metadata?.turnkeyWalletId === "string"
        ? registeredWallet.metadata.turnkeyWalletId.trim()
        : "";
    const registeredSolanaAddress = registeredWallet?.addresses?.solana?.trim() ?? "";
    const configuredSolanaAddress =
      pickCredentialValue(secretCredentials, ["defaultSolanaAddress", "solanaAddress"]) ||
      String(env.FASED_WALLET_TURNKEY_DEFAULT_SOLANA_ADDRESS ?? "").trim();
    const configuredProviderWalletId =
      pickCredentialValue(secretCredentials, ["providerWalletId", "turnkeyWalletId"]) || "";
    if (
      registeredWallet &&
      ((registeredSolanaAddress &&
        configuredSolanaAddress &&
        registeredSolanaAddress !== configuredSolanaAddress) ||
        (registeredProviderWalletId &&
          configuredProviderWalletId &&
          registeredProviderWalletId !== configuredProviderWalletId))
    ) {
      throw new Error(
        `Turnkey wallet ${registeredWallet.name} does not match the configured provider wallet identity`,
      );
    }
    return new TurnkeyAdapter({
      chains: params.wallet.chains,
      service: params.wallet.service,
      walletName: registeredWallet?.name,
      stateEnv: env,
      credentials: {
        apiPublicKey:
          pickCredentialValue(secretCredentials, ["apiPublicKey", "api_public_key", "publicKey"]) ||
          String(env.FASED_WALLET_TURNKEY_API_PUBLIC_KEY ?? "").trim(),
        apiPrivateKey:
          pickCredentialValue(secretCredentials, [
            "apiPrivateKey",
            "api_private_key",
            "privateKey",
          ]) || String(env.FASED_WALLET_TURNKEY_API_PRIVATE_KEY ?? "").trim(),
        organizationId:
          pickCredentialValue(secretCredentials, ["organizationId", "organizationID", "orgId"]) ||
          String(env.FASED_WALLET_TURNKEY_ORGANIZATION_ID ?? "").trim() ||
          undefined,
        policyId:
          pickCredentialValue(secretCredentials, ["policyId", "policyID"]) ||
          String(env.FASED_WALLET_TURNKEY_POLICY_ID ?? "").trim() ||
          undefined,
        baseUrl:
          pickCredentialValue(secretCredentials, ["baseUrl", "url", "endpoint"]) ||
          String(env.FASED_WALLET_TURNKEY_BASE_URL ?? "").trim() ||
          undefined,
        rpcUrl:
          pickCredentialValue(secretCredentials, ["rpcUrl", "rpc_url"]) ||
          resolveScopedRpcUrlForWallet({
            env,
            chains: params.wallet.chains,
            walletId: params.walletId,
          }) ||
          undefined,
        defaultSolanaAddress: registeredSolanaAddress || configuredSolanaAddress || undefined,
        providerWalletId: registeredProviderWalletId || configuredProviderWalletId || undefined,
      },
    });
  }

  if (providerId === "wallet-standard") {
    const registeredWallet = params.walletId
      ? readWalletProviderRegistry(env).wallets.find((entry) => entry.id === params.walletId)
      : undefined;
    return new WalletStandardAdapter({
      address: registeredWallet?.addresses?.solana,
      rpcUrl: resolveScopedRpcUrlForWallet({
        env,
        chains: params.wallet.chains,
        walletId: params.walletId,
      }),
    });
  }

  if (providerId === "privy") {
    throwPrivyProviderUnavailable();
  }

  throw new Error("unsupported wallet provider");
}
