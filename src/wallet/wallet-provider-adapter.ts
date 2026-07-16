import type { WalletChain, WalletExecutionMode, WalletProviderId } from "../config/types.wallet.js";

export type WalletProviderCustodyModel = "self-hosted" | "provider-managed";
export type WalletProviderSigningLocation = "server" | "browser" | "unavailable";

export type WalletProviderCapabilities = {
  custodyModel: WalletProviderCustodyModel;
  supportsCreateWallet: boolean;
  supportsPrepare: boolean;
  supportsSend: boolean;
  supportsRotateKeys: boolean;
  supportsResetKeys: boolean;
  supportsPasskeyGate: boolean;
  /** Where transaction signatures are produced. Browser signers never expose keys to Gateway. */
  /** Omitted by legacy adapters; capability negotiation treats omission as unavailable. */
  signingLocation?: WalletProviderSigningLocation;
  supportsSignTransaction?: boolean;
  supportsSignMessage?: boolean;
  supportedExecutionModes: WalletExecutionMode[];
  supportedChains: WalletChain[];
};

export type WalletProviderHealth = {
  ok: boolean;
  provider: WalletProviderId;
  configured: boolean;
  checkedAt: string;
  details?: string;
};

export type WalletProviderAddressMap = {
  solana?: string;
};

export type WalletProviderRequestScope = {
  walletId?: string;
};

export type WalletProviderCreateWalletResult = {
  ok: boolean;
  walletId: string;
  addresses: WalletProviderAddressMap;
  metadata?: Record<string, unknown>;
};

export type WalletProviderPrepareTxRequest = {
  chain: WalletChain;
  to?: string;
  amount?: string;
  contract?: string;
  program?: string;
  tokenMint?: string;
  source?: string;
  destination?: string;
  allowSplInstructions?: string[];
  memo?: string;
  serializedTxBase64?: string;
  preparedId?: string;
};

export type WalletProviderPrepareTxResult = {
  ok: boolean;
  chain: WalletChain;
  preparedId: string;
  signer?: string;
  unsignedTxBase64?: string;
  messageBase64?: string;
  intentDigest?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
};

export type WalletProviderSendTxRequest = WalletProviderPrepareTxRequest &
  WalletProviderRequestScope & {
    preparedId?: string;
  };

export type WalletProviderSendTxResult = {
  ok: boolean;
  chain: WalletChain;
  txHash: string;
  signer?: string;
  metadata?: Record<string, unknown>;
};

export type WalletProviderSignTxResult = {
  ok: boolean;
  chain: WalletChain;
  signedTxBase64: string;
  signer?: string;
  metadata?: Record<string, unknown>;
};

export type WalletProviderBalanceResult = {
  ok: boolean;
  chain: WalletChain;
  address: string;
  balance: string;
  unit?: string;
};

export type WalletProviderErrorCode =
  | "wallet_provider_invalid_config"
  | "wallet_provider_not_implemented"
  | "wallet_provider_browser_required"
  | "wallet_provider_ambiguous"
  | "wallet_provider_unsupported_chain"
  | "wallet_provider_unavailable";

export class WalletProviderError extends Error {
  readonly code: WalletProviderErrorCode;
  readonly retryable: boolean;

  constructor(params: {
    code: WalletProviderErrorCode;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "WalletProviderError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
  }
}

export interface WalletProviderAdapter {
  readonly id: WalletProviderId;
  readonly displayName: string;
  readonly capabilities: WalletProviderCapabilities;

  supportsChain(chain: WalletChain): boolean;
  health(): Promise<WalletProviderHealth>;

  createWallet?(): Promise<WalletProviderCreateWalletResult>;
  getAddresses(options?: WalletProviderRequestScope): Promise<WalletProviderAddressMap>;
  getBalance(
    chain: WalletChain,
    options?: WalletProviderRequestScope,
  ): Promise<WalletProviderBalanceResult>;

  prepareTx(request: WalletProviderPrepareTxRequest): Promise<WalletProviderPrepareTxResult>;
  signTx?(request: WalletProviderSendTxRequest): Promise<WalletProviderSignTxResult>;
  sendTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult>;

  rotateKeys?(): Promise<{
    ok: boolean;
    addresses?: WalletProviderAddressMap;
    metadata?: Record<string, unknown>;
  }>;
  resetKeys?(): Promise<{
    ok: boolean;
    addresses?: WalletProviderAddressMap;
    metadata?: Record<string, unknown>;
  }>;
}
