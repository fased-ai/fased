import type { WalletChain } from "../../config/types.wallet.js";
import {
  WalletProviderError,
  type WalletProviderAdapter,
  type WalletProviderAddressMap,
  type WalletProviderBalanceResult,
  type WalletProviderCreateWalletResult,
  type WalletProviderHealth,
  type WalletProviderPrepareTxRequest,
  type WalletProviderPrepareTxResult,
  type WalletProviderSendTxRequest,
  type WalletProviderSendTxResult,
} from "../wallet-provider-adapter.js";

export type AlchemyAdapterCredentials = {
  apiKey: string;
  serverSignerAccessKey: string;
  serverSignerAccountId?: string;
  walletApiBaseUrl?: string;
  signerApiBaseUrl?: string;
  rpcUrl?: string;
  defaultSolanaAddress?: string;
};

export type AlchemyAdapterOptions = {
  chains: WalletChain[];
  credentials: AlchemyAdapterCredentials;
};

function normalizeChainList(chains: WalletChain[]): WalletChain[] {
  return chains.includes("solana") ? ["solana"] : ["solana"];
}

export class AlchemyAdapter implements WalletProviderAdapter {
  readonly id = "alchemy" as const;
  readonly displayName = "Alchemy Wallet";
  readonly capabilities: WalletProviderAdapter["capabilities"];
  private readonly credentials: AlchemyAdapterCredentials;

  constructor(options: AlchemyAdapterOptions) {
    const chains = normalizeChainList(options.chains);
    this.credentials = options.credentials;
    this.capabilities = {
      custodyModel: "provider-managed",
      supportsCreateWallet: false,
      supportsPrepare: false,
      supportsSend: false,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      signingLocation: "unavailable",
      supportsSignTransaction: false,
      supportsSignMessage: false,
      supportedExecutionModes: ["manual"],
      supportedChains: chains,
    };
  }

  supportsChain(chain: WalletChain): boolean {
    return chain === "solana" && this.capabilities.supportedChains.includes(chain);
  }

  async health(): Promise<WalletProviderHealth> {
    const configured = Boolean(this.credentials.apiKey || this.credentials.rpcUrl);
    return {
      ok: configured,
      provider: this.id,
      configured,
      checkedAt: new Date().toISOString(),
      details: configured
        ? "Alchemy wallet adapter configured for Solana address/balance discovery."
        : "Alchemy wallet adapter is missing apiKey or rpcUrl.",
    };
  }

  async createWallet(): Promise<WalletProviderCreateWalletResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Alchemy wallet creation is not implemented in the Solana-only wallet runtime",
    });
  }

  async getAddresses(): Promise<WalletProviderAddressMap> {
    return this.credentials.defaultSolanaAddress
      ? { solana: this.credentials.defaultSolanaAddress }
      : {};
  }

  async getBalance(chain: WalletChain): Promise<WalletProviderBalanceResult> {
    if (!this.supportsChain(chain)) {
      throw new WalletProviderError({
        code: "wallet_provider_unsupported_chain",
        message: "Alchemy adapter supports Solana only",
      });
    }
    const address = this.credentials.defaultSolanaAddress?.trim();
    if (!address) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Alchemy wallet has no Solana address configured",
      });
    }
    return { ok: true, chain: "solana", address, balance: "0", unit: "lamports" };
  }

  async prepareTx(
    _request: WalletProviderPrepareTxRequest,
  ): Promise<WalletProviderPrepareTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message:
        "Alchemy transaction preparation is not implemented in the Solana-only wallet runtime",
    });
  }

  async sendTx(_request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Alchemy transaction sending is not implemented in the Solana-only wallet runtime",
    });
  }
}
