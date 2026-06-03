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

export type TurnkeyAdapterCredentials = {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId?: string;
  baseUrl?: string;
  stamp?: string;
  defaultSolanaAddress?: string;
};

export type TurnkeyAdapterOptions = {
  chains: WalletChain[];
  credentials: TurnkeyAdapterCredentials;
  service: {
    host: string;
    port: number;
  };
  requestTimeoutMs?: number;
};

export class TurnkeyAdapter implements WalletProviderAdapter {
  readonly id = "turnkey" as const;
  readonly displayName = "Turnkey Wallet";
  readonly capabilities: WalletProviderAdapter["capabilities"];
  private readonly credentials: TurnkeyAdapterCredentials;

  constructor(options: TurnkeyAdapterOptions) {
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
    const configured = Boolean(this.credentials.apiPublicKey && this.credentials.apiPrivateKey);
    return {
      ok: configured,
      provider: this.id,
      configured,
      checkedAt: new Date().toISOString(),
      details: configured
        ? "Turnkey adapter configured for Solana wallet discovery."
        : "Turnkey adapter is missing API credentials.",
    };
  }

  async createWallet(): Promise<WalletProviderCreateWalletResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Turnkey wallet creation is not implemented in the Solana-only wallet runtime",
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
        message: "Turnkey adapter supports Solana only",
      });
    }
    const address = this.credentials.defaultSolanaAddress?.trim();
    if (!address) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Turnkey wallet has no Solana address configured",
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
        "Turnkey transaction preparation is not implemented in the Solana-only wallet runtime",
    });
  }

  async sendTx(_request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Turnkey transaction sending is not implemented in the Solana-only wallet runtime",
    });
  }
}
