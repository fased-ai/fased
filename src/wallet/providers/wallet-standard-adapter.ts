import type { WalletChain } from "../../config/types.wallet.js";
import { fetchSolanaRpc } from "../solana-assets.js";
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

export type WalletStandardAdapterOptions = {
  address?: string;
  rpcUrl?: string;
};

/**
 * Server-side discovery half of a Wallet Standard Vault.
 *
 * Signing deliberately cannot be invoked through this adapter. The Control UI
 * uses the browser-only Wallet Standard flow and the Gateway only validates and
 * broadcasts the returned signed transaction.
 */
export class WalletStandardAdapter implements WalletProviderAdapter {
  readonly id = "wallet-standard" as const;
  readonly displayName = "Wallet Standard";
  readonly capabilities: WalletProviderAdapter["capabilities"] = {
    custodyModel: "self-hosted",
    supportsCreateWallet: false,
    supportsPrepare: false,
    supportsSend: false,
    supportsRotateKeys: false,
    supportsResetKeys: false,
    supportsPasskeyGate: false,
    signingLocation: "browser",
    supportsSignTransaction: true,
    supportsSignMessage: false,
    supportedExecutionModes: ["manual"],
    supportedChains: ["solana"],
  };

  private readonly address?: string;
  private readonly rpcUrl?: string;

  constructor(options: WalletStandardAdapterOptions = {}) {
    this.address = options.address?.trim() || undefined;
    this.rpcUrl = options.rpcUrl?.trim() || undefined;
  }

  supportsChain(chain: WalletChain): boolean {
    return chain === "solana";
  }

  async health(): Promise<WalletProviderHealth> {
    const configured = Boolean(this.address && this.rpcUrl);
    return {
      ok: configured,
      provider: this.id,
      configured,
      checkedAt: new Date().toISOString(),
      details: configured
        ? "Wallet Standard account registered. Signing capability is checked in the local browser before every operation; Wallet Standard does not prove that the account is hardware-backed."
        : "Attach a Wallet Standard account and configure Solana RPC. For reserve funds, select and verify a hardware-backed account on its device.",
    };
  }

  async createWallet(): Promise<WalletProviderCreateWalletResult> {
    throw new WalletProviderError({
      code: "wallet_provider_browser_required",
      message:
        "Attach a Solana Wallet Standard account from Fased Control. For reserve funds, use and verify a hardware-backed account on its device",
    });
  }

  async getAddresses(): Promise<WalletProviderAddressMap> {
    return this.address ? { solana: this.address } : {};
  }

  async getBalance(chain: WalletChain): Promise<WalletProviderBalanceResult> {
    if (chain !== "solana") {
      throw new WalletProviderError({
        code: "wallet_provider_unsupported_chain",
        message: "Wallet Standard Vault supports Solana only",
      });
    }
    if (!this.address || !this.rpcUrl) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "Wallet Standard Vault requires a registered Solana address and RPC URL",
      });
    }
    const result = await fetchSolanaRpc<{ value?: number | string }>(this.rpcUrl, "getBalance", [
      this.address,
      { commitment: "confirmed" },
    ]);
    const balance = result?.value;
    if (typeof balance !== "number" && typeof balance !== "string") {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "Solana RPC did not return a Wallet Standard Vault balance",
        retryable: true,
      });
    }
    return {
      ok: true,
      chain: "solana",
      address: this.address,
      balance: String(balance),
      unit: "lamports",
    };
  }

  async prepareTx(
    _request: WalletProviderPrepareTxRequest,
  ): Promise<WalletProviderPrepareTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_browser_required",
      message:
        "Wallet Standard Vault transactions must be prepared through the reviewed browser flow",
    });
  }

  async sendTx(_request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    throw new WalletProviderError({
      code: "wallet_provider_browser_required",
      message: "Gateway cannot sign for a Wallet Standard Vault",
    });
  }
}
