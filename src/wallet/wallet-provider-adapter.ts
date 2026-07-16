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
  /** Stable caller-owned idempotency key. Required by providers that can broadcast. */
  requestId?: string;
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

export type WalletProviderJupiterIntentType =
  | "solana.jupiter.swap"
  | "solana.jupiter.trigger.auth"
  | "solana.jupiter.trigger.create"
  | "solana.jupiter.trigger.deposit"
  | "solana.jupiter.trigger.cancel"
  | "solana.jupiter.trigger.withdraw";

export type WalletProviderJupiterIntentV2 = {
  type: WalletProviderJupiterIntentType;
  jupiter: {
    owner: string;
    inputMint?: string;
    outputMint?: string;
    inputAmount?: string;
    maxInputAmount?: string;
    minimumOutputAmount?: string;
    maxFeeLamports: string;
    sourceTokenAccount?: string;
    destinationTokenAccount?: string;
    programs: string[];
    trigger?: {
      program: string;
      vault?: string;
      order?: string;
      requestId?: string;
    };
  };
};

export type WalletProviderJupiterReviewV2 = {
  requestId: string;
  walletId: string;
  intentType: WalletProviderJupiterIntentType;
  intentDigest: string;
  policyHash: string;
  mode: "autonomous" | "reviewed";
  nonce: string;
  semanticIntent: WalletProviderJupiterIntentV2;
  issuedAt: string;
  state: "prepared" | "signed";
  preparedAt: string;
  expiresAt: string;
  updatedAt: string;
  transactionDigest?: string;
  signature?: string;
};

export type WalletProviderJupiterExecutionV2 = {
  review: WalletProviderJupiterReviewV2;
  operation: {
    requestId: string;
    walletId: string;
    intentType: string;
    intentDigest: string;
    transactionDigest?: string;
    policyHash: string;
    asset: string;
    amount: string;
    state: "reserved" | "broadcast" | "confirmed" | "failed" | "unknown";
    signature?: string;
    error?: string;
  };
  signedTxBase64?: string;
  signer: string;
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
  prepareJupiterReview?(request: {
    walletId: string;
    requestId: string;
    mode: "autonomous" | "reviewed";
    intent: WalletProviderJupiterIntentV2;
  }): Promise<WalletProviderJupiterReviewV2>;
  executeJupiterReview?(request: {
    walletId: string;
    requestId: string;
    policyHash: string;
    mode: "autonomous" | "reviewed";
    intent: WalletProviderJupiterIntentV2;
    transaction: {
      serializedTxBase64: string;
      programs: string[];
      writableAccounts: string[];
      submission: "rpc" | "returnSigned";
    };
    authorization?: { type: string; proof: unknown };
  }): Promise<WalletProviderJupiterExecutionV2>;

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
