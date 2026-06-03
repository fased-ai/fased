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

export type PrivyAdapterCredentials = {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  defaultSolanaAddress?: string;
};

export type PrivyAdapterOptions = {
  chains: WalletChain[];
  credentials: PrivyAdapterCredentials;
  service: {
    host: string;
    port: number;
  };
  requestTimeoutMs?: number;
};

export class PrivyAdapter implements WalletProviderAdapter {
  readonly id = "privy" as const;
  readonly displayName = "Privy Wallet";
  readonly capabilities: WalletProviderAdapter["capabilities"];
  private readonly credentials: PrivyAdapterCredentials;

  constructor(options: PrivyAdapterOptions) {
    this.credentials = options.credentials;
    this.capabilities = {
      custodyModel: "provider-managed",
      supportsCreateWallet: true,
      supportsPrepare: false,
      supportsSend: false,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      supportedExecutionModes: ["manual"],
      supportedChains: ["solana"],
    };
  }

  supportsChain(chain: WalletChain): boolean {
    return chain === "solana";
  }

  async health(): Promise<WalletProviderHealth> {
    const configured = Boolean(this.credentials.appId && this.credentials.appSecret);
    return {
      ok: configured,
      provider: this.id,
      configured,
      checkedAt: new Date().toISOString(),
      details: configured
        ? "Privy adapter configured for Solana wallet discovery."
        : "Privy adapter is missing app credentials.",
    };
  }

  async createWallet(): Promise<WalletProviderCreateWalletResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Privy wallet creation is not implemented in the Solana-only wallet runtime",
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
        message: "Privy adapter supports Solana only",
      });
    }
    const address = this.credentials.defaultSolanaAddress?.trim();
    if (!address) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Privy wallet has no Solana address configured",
      });
    }
    return { ok: true, chain: "solana", address, balance: "0", unit: "lamports" };
  }

  async prepareTx(
    _request: WalletProviderPrepareTxRequest,
  ): Promise<WalletProviderPrepareTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Privy transaction preparation is not implemented in the Solana-only wallet runtime",
    });
  }

  async sendTx(_request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Privy transaction sending is not implemented in the Solana-only wallet runtime",
    });
  }
}
