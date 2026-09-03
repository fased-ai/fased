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
  nativeSignerApproval?: {
    configured: boolean;
    ready: boolean;
    credentialCount: number;
    credentialVersion: number;
  };
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

export type WalletProviderJupiterIntentType =
  | "solana.jupiter.swap"
  | "solana.jupiter.trigger.create"
  | "solana.jupiter.trigger.cancel";

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
      operation: "create" | "cancel";
      program: string;
      order?: string;
      triggerMint?: string;
      condition?: "above" | "below";
      targetPriceUsd?: string;
      slippageBps?: number;
      expiresAt?: string;
      expectedOrderState: "new" | "open";
    };
  };
};

export type WalletProviderJupiterTriggerOrderV2 = {
  orderId: string;
  orderState: string;
  orderType: "single";
  inputMint: string;
  initialInputAmount: string;
  remainingInputAmount: string;
  outputMint: string;
  triggerMint: string;
  condition: "above" | "below";
  targetPriceUsd: string;
  slippageBps: number;
  expiresAt: string;
  cancel?: {
    expectedOrderState: "open";
    refundMint: string;
    refundAmount: string;
    destinationTokenAccount: string;
    program: string;
  };
};

export type WalletProviderJupiterTriggerHistoryV2 = {
  orders: WalletProviderJupiterTriggerOrderV2[];
};

export type WalletProviderTypedTransferIntentV2 =
  | {
      type: "solana.nativeTransfer";
      destination: string;
      lamports: string;
      memo?: string;
    }
  | {
      type: "solana.splTransferChecked";
      tokenProgram: string;
      mint: string;
      destination: string;
      amount: string;
      memo?: string;
    };

export type WalletProviderVaultBondIntentV2 = {
  type: "solana.vaultBondAction";
  cluster: "local" | "devnet" | "mainnet-beta";
  action: string;
  programId: string;
  dataBase64: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  context?: {
    targetAuthority?: string;
    disputeAuthority?: string;
    intervalStartCycleId?: string;
    registryPageIndex?: string;
    minerAuthorities?: string[];
    frontCycleIds?: string[];
    backCycleIds?: string[];
  };
};

export type WalletProviderAgentCapitalIntentV2 = {
  type: "solana.agentCapitalAction";
  cluster: "local" | "devnet" | "mainnet-beta";
  action: string;
  programId: string;
  dataBase64: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
};

export type WalletProviderMoneyFoundationIntentV2 = {
  type: "solana.moneyFoundationAction";
  cluster: "devnet";
  moneyFoundation: {
    contractGeneration: 1;
    policyGeneration: string;
    policyDigestSha256: string;
    action: "ADD_POL" | "EMERGENCY_UNWIND";
    sourceClass: "OWNER_SEED" | "PROTOCOL_SURPLUS" | "EMERGENCY_TREASURY";
    sourceOwner: string;
    destinationOwner: string;
    lifecycle: "DISABLED" | "ENABLED" | "PAUSED" | "RETIRED";
    fundingAuthorized: boolean;
    publicEntryEnabled: boolean;
    liquidityTreasury: string;
    emergencyAuthority: string;
    emergencyUnwindNotBeforeSlot: string;
    satMint: string;
    satTokenProgram: string;
    wrappedSolMint: string;
    venueProgram: string;
    poolConfig: string;
    pool: string;
    positionMint: string;
    positionTokenAccount: string;
    satVault: string;
    solVault: string;
    initialSatRaw: string;
    initialSolLamports: string;
    inputRaw: string;
    minimumSatRaw: string;
    minimumSolLamports: string;
    maxSlippageBps: number;
    maxPriceImpactBps: number;
    maxCombinedFeeBps: number;
    simulationSlot: string;
    expiresSlot: string;
    sourceDescriptorSha256: string;
    protectedCapitalAddresses: string[];
  };
};

export type WalletProviderFederationBondChallengeIntentV2 = {
  type: "federation.bondChallenge";
  federation: {
    challengeId: string;
    federationOrigin: string;
    handle: string;
    nodeId: string;
    tokenId: string;
    bondId: string;
    tier: "none" | "basic-bond" | "operator-bond";
    amountRaw?: string;
    expiresAt: string;
    payloadBase64: string;
  };
};

export type WalletProviderSignerIntentV2 =
  | WalletProviderJupiterIntentV2
  | WalletProviderTypedTransferIntentV2
  | WalletProviderVaultBondIntentV2
  | WalletProviderAgentCapitalIntentV2
  | WalletProviderMoneyFoundationIntentV2
  | WalletProviderFederationBondChallengeIntentV2;

export type WalletProviderSignerIntentType = WalletProviderSignerIntentV2["type"];

export type WalletProviderJupiterReviewV2 = {
  requestId: string;
  walletId: string;
  intentType: WalletProviderSignerIntentType;
  intentDigest: string;
  policyHash: string;
  mode: "autonomous" | "reviewed";
  nonce: string;
  semanticIntent: WalletProviderSignerIntentV2;
  walletPublicKey?: string;
  artifactKind: "solana-transaction" | "domain-separated-message" | "jupiter-trigger-state";
  artifactDigest: string;
  transaction?: WalletProviderSignerTransactionEnvelopeV2;
  messageBase64?: string;
  stateDigest?: string;
  stateSlot?: number;
  asset: string;
  amount: string;
  reservations?: Array<{ asset: string; amount: string; usageBucket: string }>;
  destination: string;
  policyOperation: string;
  requiredPrograms: string[];
  requiredRole?: "agent" | "mining" | "vault" | "profile" | "strategy";
  issuedAt: string;
  state: "prepared" | "signed";
  preparedAt: string;
  expiresAt: string;
  updatedAt: string;
  transactionDigest?: string;
  signature?: string;
};

export type WalletProviderSignerTransactionEnvelopeV2 = {
  serializedTxBase64: string;
  programs: string[];
  writableAccounts: string[];
  submission: "rpc";
};

export type WalletProviderSignerReviewAuthorizationV2 = {
  type: "webauthn" | "control-ui";
  proof: { proofId: string };
};

export type WalletProviderSignerReviewBindingV2 = {
  requestId: string;
  walletId: string;
  role: "agent" | "mining" | "vault" | "profile" | "strategy";
  intentType: WalletProviderSignerIntentType;
  intentDigest: string;
  semanticIntent: WalletProviderSignerIntentV2;
  walletPublicKey?: string;
  artifactKind: "solana-transaction" | "domain-separated-message" | "jupiter-trigger-state";
  artifactDigest: string;
  transactionDigest?: string;
  stateDigest?: string;
  stateSlot?: number;
  asset: string;
  amount: string;
  destination: string;
  policyOperation: string;
  requiredPrograms: string[];
  policyHash: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

export type WalletProviderSignerReviewAuthorizationBeginV2 = {
  challengeId: string;
  expiresAt: string;
  binding: WalletProviderSignerReviewBindingV2;
  options: unknown;
};

export type WalletProviderSignerReviewAuthorizationFinishV2 = {
  authorization: WalletProviderSignerReviewAuthorizationV2;
  binding: WalletProviderSignerReviewBindingV2;
  credentialId: string;
  expiresAt: string;
};

export type WalletProviderSignerOperationV2 = {
  requestId: string;
  walletId: string;
  intentType: string;
  intentDigest: string;
  transactionDigest?: string;
  policyHash: string;
  asset: string;
  amount: string;
  reservations?: Array<{ asset: string; amount: string; usageBucket: string }>;
  state: "reserved" | "broadcast" | "confirmed" | "failed" | "unknown";
  signature?: string;
  error?: string;
  authorizationProof?: string;
  authorizedAt?: string;
  externalResult?: {
    provider: "jupiter-trigger-v2";
    action: "create" | "cancel";
    orderId: string;
    orderState: "open" | "cancelled";
  };
};

export type WalletProviderJupiterExecutionV2 = {
  review: WalletProviderJupiterReviewV2;
  operation: WalletProviderSignerOperationV2;
  signatureBase64?: string;
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

  prepareTx?(request: WalletProviderPrepareTxRequest): Promise<WalletProviderPrepareTxResult>;
  sendTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult>;
  prepareJupiterReview?(request: {
    walletId: string;
    requestId: string;
    mode: "autonomous" | "reviewed";
    intent: WalletProviderJupiterIntentV2;
    transaction?: WalletProviderSignerTransactionEnvelopeV2;
  }): Promise<WalletProviderJupiterReviewV2>;
  getSignerReview?(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderJupiterReviewV2>;
  prepareSignerReview?(request: {
    walletId: string;
    requestId: string;
    mode: "autonomous" | "reviewed";
    intent: WalletProviderSignerIntentV2;
    transaction?: WalletProviderSignerTransactionEnvelopeV2;
  }): Promise<WalletProviderJupiterReviewV2>;
  prepareTypedTransferReview?(request: {
    walletId: string;
    requestId: string;
    destination: string;
    amount: string;
    mint?: string;
    tokenProgram?: string;
    memo?: string;
  }): Promise<WalletProviderJupiterReviewV2>;
  executeSignerReview?(request: {
    walletId: string;
    requestId: string;
    authorization?: WalletProviderSignerReviewAuthorizationV2;
  }): Promise<WalletProviderJupiterExecutionV2>;
  executeJupiterReview?(request: {
    walletId: string;
    requestId: string;
    authorization?: WalletProviderSignerReviewAuthorizationV2;
  }): Promise<WalletProviderJupiterExecutionV2>;
  executeSignerIntent?(request: {
    walletId: string;
    requestId: string;
    intent: WalletProviderSignerIntentV2;
  }): Promise<WalletProviderSignerOperationV2>;
  listJupiterTriggerOrders?(request: {
    walletId: string;
    state?: "active" | "past";
  }): Promise<WalletProviderJupiterTriggerHistoryV2>;
  getSignerOperation?(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderSignerOperationV2>;
  reconcileSignerOperation?(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderSignerOperationV2>;
  beginSignerReviewAuthorization?(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderSignerReviewAuthorizationBeginV2>;
  beginJupiterReviewAuthorization?(request: {
    walletId: string;
    requestId: string;
  }): Promise<WalletProviderSignerReviewAuthorizationBeginV2>;
  finishSignerReviewAuthorization?(request: {
    walletId: string;
    challengeId: string;
    credential: unknown;
  }): Promise<WalletProviderSignerReviewAuthorizationFinishV2>;
  finishJupiterReviewAuthorization?(request: {
    walletId: string;
    challengeId: string;
    credential: unknown;
  }): Promise<WalletProviderSignerReviewAuthorizationFinishV2>;

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
