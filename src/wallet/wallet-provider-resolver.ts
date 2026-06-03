import type { FasedAgentConfig } from "../config/config.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { AlchemyAdapter } from "./providers/alchemy-adapter.js";
import { EmbeddedKeystoreAdapter } from "./providers/embedded-keystore-adapter.js";
import {
  LocalSocketSignerAdapter,
  requireLocalSocketSignerPath,
} from "./providers/local-socket-signer-adapter.js";
import { PrivyAdapter } from "./providers/privy-adapter.js";
import { TurnkeyAdapter } from "./providers/turnkey-adapter.js";
import type { WalletProviderAdapter } from "./wallet-provider-adapter.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import {
  resolveLocalSignerBackendSocketPath,
  type ResolvedWalletRuntimeConfig,
} from "./wallet-runtime-config.js";
import { loadWalletProviderSecret } from "./wallet-secrets-store.js";

function parseProviderId(input: string | undefined): WalletProviderId | null {
  switch ((input ?? "").trim()) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "privy":
      return input as WalletProviderId;
    default:
      return null;
  }
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
  return scopedOrChain || String(env.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim();
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
  for (const [key, rawValue] of Object.entries(env)) {
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    if (
      key === "FASED_WALLET_SOLANA_KEYSTORE_PATH" ||
      key === "FASED_WALLET_PASSPHRASE_FILE" ||
      key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
    ) {
      return "local-socket-signer";
    }
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
  if (envProvider) {
    return envProvider;
  }
  const configProvider = parseProviderId(cfg.wallet?.provider?.id);
  const inferredSelfHostedProvider = inferSelfHostedProviderId(effectiveEnv);
  let registryProvider: WalletProviderId | null = null;
  try {
    const registry = readWalletProviderRegistry(effectiveEnv);
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
  if (registryProvider && (!configProvider || configProvider === "embedded-keystore")) {
    return registryProvider;
  }
  if (inferredSelfHostedProvider && (!configProvider || configProvider === "embedded-keystore")) {
    return inferredSelfHostedProvider;
  }
  if (configProvider) {
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
    const secret = loadWalletProviderSecret(providerId, env);
    const secretCredentials = secret?.credentials ?? {};
    return new EmbeddedKeystoreAdapter({
      chains: params.wallet.chains,
      credentials: {
        keystorePath:
          pickCredentialValue(secretCredentials, ["keystorePath", "path"]) ||
          params.cfg.wallet?.keystore?.path?.trim() ||
          String(env.FASED_WALLET_KEYSTORE_PATH ?? "").trim() ||
          undefined,
        passphrase:
          pickCredentialValue(secretCredentials, ["passphrase"]) ||
          String(env.FASED_WALLET_PASSPHRASE ?? "").trim() ||
          undefined,
        rpcUrl:
          pickCredentialValue(secretCredentials, ["rpcUrl", "rpc_url"]) ||
          resolveScopedRpcUrlForWallet({
            env,
            chains: params.wallet.chains,
            walletId: params.walletId,
          }) ||
          undefined,
      },
      env,
    });
  }

  if (providerId === "local-socket-signer") {
    return new LocalSocketSignerAdapter(requireLocalSocketSignerPath(env), {
      backendSocketPath: resolveLocalSignerBackendSocketPath(env),
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
    return new TurnkeyAdapter({
      chains: params.wallet.chains,
      service: params.wallet.service,
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
        stamp:
          pickCredentialValue(secretCredentials, ["stamp", "xStamp", "x_stamp", "apiStamp"]) ||
          String(env.FASED_WALLET_TURNKEY_STAMP ?? "").trim() ||
          undefined,
        baseUrl:
          pickCredentialValue(secretCredentials, ["baseUrl", "url", "endpoint"]) ||
          String(env.FASED_WALLET_TURNKEY_BASE_URL ?? "").trim() ||
          undefined,
        defaultSolanaAddress:
          pickCredentialValue(secretCredentials, ["defaultSolanaAddress", "solanaAddress"]) ||
          String(env.FASED_WALLET_TURNKEY_DEFAULT_SOLANA_ADDRESS ?? "").trim() ||
          undefined,
      },
    });
  }

  if (providerId === "privy") {
    const secret = loadWalletProviderSecret(providerId, env);
    const secretCredentials = secret?.credentials ?? {};
    return new PrivyAdapter({
      chains: params.wallet.chains,
      service: params.wallet.service,
      credentials: {
        appId:
          pickCredentialValue(secretCredentials, ["appId", "app_id", "applicationId"]) ||
          String(env.FASED_WALLET_PRIVY_APP_ID ?? "").trim(),
        appSecret:
          pickCredentialValue(secretCredentials, ["appSecret", "app_secret", "secret"]) ||
          String(env.FASED_WALLET_PRIVY_APP_SECRET ?? "").trim(),
        baseUrl:
          pickCredentialValue(secretCredentials, ["baseUrl", "url", "endpoint"]) ||
          String(env.FASED_WALLET_PRIVY_BASE_URL ?? "").trim() ||
          undefined,
        defaultSolanaAddress:
          pickCredentialValue(secretCredentials, ["defaultSolanaAddress", "solanaAddress"]) ||
          String(env.FASED_WALLET_PRIVY_DEFAULT_SOLANA_ADDRESS ?? "").trim() ||
          undefined,
      },
    });
  }

  throw new Error("unsupported wallet provider");
}
