import type { WalletChain, WalletProviderId } from "../config/types.wallet.js";
import type { WalletProviderAdapter } from "./wallet-provider-adapter.js";

export type WalletProviderChainOps = {
  receiveAddress: boolean;
  getBalance: boolean;
  prepare: boolean;
  send: boolean;
};

export type WalletProviderCapabilityMatrix = {
  providerId: WalletProviderId;
  supportedChains: WalletChain[];
  integrationMode: "native" | "bridge";
  signingLocation: "server" | "browser" | "unavailable";
  signing: {
    transaction: boolean;
    message: boolean;
    interactiveSend: boolean;
  };
  operations: {
    createWallet: boolean;
    receiveAddress: boolean;
    getBalance: boolean;
    prepare: boolean;
    send: boolean;
    deposit: boolean;
    withdraw: boolean;
    rotateKeys: boolean;
    resetKeys: boolean;
  };
  chains: {
    solana: WalletProviderChainOps;
  };
  requiresCredentials: boolean;
  requiresRpcSecret: boolean;
};

export type KnownRpcProviderProfile = {
  id: string;
  displayName: string;
  supportedChains: Array<"solana">;
  features: string[];
};

type ProviderChainOperationProfile = {
  solana: WalletProviderChainOps;
};

const FULL_CHAIN_OPS: WalletProviderChainOps = {
  receiveAddress: true,
  getBalance: true,
  prepare: true,
  send: true,
};

const PROVIDER_CHAIN_OPERATION_PROFILES: Record<WalletProviderId, ProviderChainOperationProfile> = {
  "embedded-keystore": {
    solana: { receiveAddress: false, getBalance: false, prepare: false, send: false },
  },
  "local-socket-signer": {
    solana: { ...FULL_CHAIN_OPS },
  },
  alchemy: {
    solana: {
      receiveAddress: true,
      getBalance: true,
      prepare: false,
      send: false,
    },
  },
  turnkey: {
    solana: { ...FULL_CHAIN_OPS },
  },
  privy: {
    solana: {
      receiveAddress: true,
      getBalance: false,
      prepare: false,
      send: false,
    },
  },
  "wallet-standard": {
    solana: {
      receiveAddress: true,
      getBalance: true,
      prepare: false,
      send: false,
    },
  },
};

const KNOWN_RPC_PROVIDER_PROFILES: Record<string, KnownRpcProviderProfile> = {
  alchemy: {
    id: "alchemy",
    displayName: "Alchemy",
    supportedChains: ["solana"],
    features: ["HTTPS RPC", "WebSocket RPC", "Solana"],
  },
  drpc: {
    id: "drpc",
    displayName: "dRPC",
    supportedChains: ["solana"],
    features: ["HTTPS RPC", "WebSocket RPC", "Solana"],
  },
  quicknode: {
    id: "quicknode",
    displayName: "QuickNode",
    supportedChains: ["solana"],
    features: ["HTTPS RPC", "WebSocket RPC", "Solana"],
  },
  helius: {
    id: "helius",
    displayName: "Helius",
    supportedChains: ["solana"],
    features: ["HTTPS RPC", "WebSocket RPC", "Solana only"],
  },
};

function emptyChainOps(): WalletProviderChainOps {
  return {
    receiveAddress: false,
    getBalance: false,
    prepare: false,
    send: false,
  };
}

function supported(adapter: WalletProviderAdapter, chain: WalletChain): boolean {
  return adapter.capabilities.supportedChains.includes(chain);
}

function resolveIntegrationMode(providerId: WalletProviderId): "native" | "bridge" {
  switch (providerId) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "wallet-standard":
    case "privy":
      return "native";
  }
}

export function buildWalletProviderCapabilityMatrix(
  adapter: WalletProviderAdapter,
): WalletProviderCapabilityMatrix {
  const signingLocation = adapter.capabilities.signingLocation ?? "unavailable";
  const chains = {
    solana: emptyChainOps(),
  };

  const defaultChainFlags = {
    receiveAddress: true,
    getBalance: true,
    prepare: adapter.capabilities.supportsPrepare,
    send: adapter.capabilities.supportsSend,
  };

  if (supported(adapter, "solana")) {
    chains.solana = { ...defaultChainFlags };
  }
  // Strict runtime profile: clamp adapter-advertised ops by known provider+chain policy.
  const profile = PROVIDER_CHAIN_OPERATION_PROFILES[adapter.id];
  chains.solana = {
    receiveAddress: chains.solana.receiveAddress && profile.solana.receiveAddress,
    getBalance: chains.solana.getBalance && profile.solana.getBalance,
    prepare: chains.solana.prepare && profile.solana.prepare,
    send: chains.solana.send && profile.solana.send,
  };

  const receiveAny = chains.solana.receiveAddress;
  const balanceAny = chains.solana.getBalance;
  const prepareAny = chains.solana.prepare;
  const sendAny = chains.solana.send;

  return {
    providerId: adapter.id,
    supportedChains: [...adapter.capabilities.supportedChains],
    integrationMode: resolveIntegrationMode(adapter.id),
    signingLocation,
    signing: {
      transaction: adapter.capabilities.supportsSignTransaction === true,
      message: adapter.capabilities.supportsSignMessage === true,
      interactiveSend:
        signingLocation === "browser" && adapter.capabilities.supportsSignTransaction === true,
    },
    operations: {
      createWallet: adapter.capabilities.supportsCreateWallet,
      receiveAddress: receiveAny,
      getBalance: balanceAny,
      prepare: prepareAny,
      send: sendAny,
      // Deposit = external funds sent to wallet receive address.
      deposit: receiveAny,
      // Withdraw = outbound transfer from wallet.
      withdraw: sendAny,
      rotateKeys: adapter.capabilities.supportsRotateKeys,
      resetKeys: adapter.capabilities.supportsResetKeys,
    },
    chains,
    requiresCredentials: adapter.id !== "local-socket-signer" && adapter.id !== "wallet-standard",
    requiresRpcSecret: false,
  };
}

export function providerSupportsChainOperation(params: {
  matrix: WalletProviderCapabilityMatrix;
  chain: WalletChain;
  operation: keyof WalletProviderChainOps;
}): boolean {
  const row = params.matrix.chains.solana;
  return Boolean(row[params.operation]);
}

export function validateRpcProviderChainCompatibility(params: {
  provider: string;
  chain: "solana" | "multi";
}): { ok: boolean; message: string } {
  const provider = params.provider.trim().toLowerCase();
  const chain = params.chain;
  if (!provider) {
    return { ok: true, message: "RPC provider not specified" };
  }

  const profile = KNOWN_RPC_PROVIDER_PROFILES[provider];
  if (!profile) {
    // Unknown providers are accepted by default to avoid false negatives.
    return { ok: true, message: "RPC provider/chain compatibility check passed" };
  }

  if (chain === "multi") {
    return {
      ok: false,
      message: `${profile.displayName} RPC is Solana-only in Fased wallet runtime; use chain=solana`,
    };
  }

  if (!profile.supportedChains.includes(chain)) {
    return {
      ok: false,
      message: `${profile.displayName} RPC does not support chain=${chain}`,
    };
  }

  return {
    ok: true,
    message: `${profile.displayName} RPC compatibility check passed for chain=${chain}`,
  };
}

export function listKnownRpcProviderProfiles(): KnownRpcProviderProfile[] {
  return Object.values(KNOWN_RPC_PROVIDER_PROFILES);
}

export function inferRpcProviderFromUrl(rpcUrl: string): string | undefined {
  const trimmed = rpcUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (!host) {
    return undefined;
  }
  if (host.includes("alchemy.com")) {
    return "alchemy";
  }
  if (host.includes("helius")) {
    return "helius";
  }
  if (host.includes("quiknode.pro") || host.includes("quicknode.com")) {
    return "quicknode";
  }
  if (host.includes("drpc.org") || host.includes("drpc.network")) {
    return "drpc";
  }
  return undefined;
}

export function extractRpcApiKeyFromUrl(rpcUrl: string): string | undefined {
  const trimmed = rpcUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  const queryKeyNames = [
    "api-key",
    "api_key",
    "apikey",
    "key",
    "token",
    "access-token",
    "access_token",
  ];
  for (const keyName of queryKeyNames) {
    const value = parsed.searchParams.get(keyName)?.trim();
    if (value) {
      return value;
    }
  }

  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (pathParts.length >= 2) {
    const v2Index = pathParts.findIndex((part) => part.toLowerCase() === "v2");
    if (v2Index >= 0 && v2Index < pathParts.length - 1) {
      const candidate = pathParts[v2Index + 1]?.trim();
      if (candidate && candidate.length >= 8) {
        return candidate;
      }
    }
  }
  return undefined;
}
