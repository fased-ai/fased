import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { SIGNER_PROTOCOL_V2 } from "./signer-protocol-v2.generated.js";
import { WenBondClaimStoredReviewSchema } from "./wen-bond-claim-review-contract.js";
import { WenBondPurchaseStoredReviewSchema } from "./wen-bond-purchase-review-contract.js";
import {
  WenBtcClaimIntentSchema,
  validateWenBtcClaimIntent,
  isWenBtcClaimPreparation,
} from "./wen-btc-claim-preparation-contract.js";
import { isWenBtcInspection } from "./wen-btc-inspection-contract.js";
import { WenBtcIntentCandidateSchema, validateWenBtcIntentCandidate } from "./wen-btc-intent.js";
import { isWenBtcPreparation } from "./wen-btc-preparation-contract.js";
import { isWenBtcRoutePreview } from "./wen-btc-route-preview-contract.js";
import {
  isWenCampaignAuthorizationBegin,
  isWenCampaignAuthorizationFinish,
} from "./wen-campaign-authorization-contract.js";
import { WenCampaignStoredReviewSchema } from "./wen-campaign-review-contract.js";
import {
  WenCampaignJourneyRequestSchema,
  WenCampaignReviewRequestSchema,
  WenCampaignJourneyResultSchema,
  validateWenCampaignJourneyRequest,
  validateWenCampaignReviewRequest,
} from "./wen-campaign-service-contract.js";
import { WenMarketStoredReviewSchema } from "./wen-market-review-contract.js";
import {
  WenMiningClaimProposalRequestSchema,
  validateWenMiningClaimProposalRequest,
  isWenMiningClaimProposal,
} from "./wen-mining-claim-proposal-contract.js";
import {
  WenMiningFundingIntentSchema,
  validateWenMiningFundingIntent,
  isWenMiningFundingPreparation,
} from "./wen-mining-funding-preparation-contract.js";
import {
  WenMiningIntentCandidateSchema,
  validateWenMiningIntentCandidate,
} from "./wen-mining-intent.js";
import { isWenMiningPreparation } from "./wen-mining-preparation-contract.js";
import {
  WenMiningRecoveryRequestSchema,
  validateWenMiningRecoveryRequest,
  isWenMiningRecoveryResult,
} from "./wen-mining-recovery-contract.js";
import {
  isWenMiningAuthorizationBegin,
  isWenMiningAuthorizationFinish,
} from "./wen-mining-review-authorization-contract.js";
import {
  WenMiningReviewPrepareRequestSchema,
  validateWenMiningReviewPrepareRequest,
  isWenMiningStoredReview,
} from "./wen-mining-review-preparation-contract.js";
import {
  WenNativeClaimIntentSchema,
  validateWenNativeClaimIntent,
  isWenNativeClaimPreparation,
} from "./wen-native-claim-preparation-contract.js";
import {
  WenWithdrawalIntentSchema,
  validateWenWithdrawalIntent,
  isWenWithdrawalPreparation,
} from "./wen-withdrawal-preparation-contract.js";

const WalletChainSchema = Type.Literal("solana");

export const LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2 =
  SIGNER_PROTOCOL_V2.nativeFeeReservationLamports;

const SignerWalletRoleSchema = Type.Literal("agent");

const SignerProtocolRangeV2Schema = Type.Object(
  {
    current: Type.Literal(2),
    min: Type.Integer({ minimum: 2 }),
    max: Type.Integer({ minimum: 2 }),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerCapabilitiesV2Schema = Type.Object(
  {
    protocol: SignerProtocolRangeV2Schema,
    nativeFeeReservationLamports: Type.Literal(LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2),
    intentTypes: Type.Array(Type.String()),
    operationStates: Type.Array(Type.String()),
    features: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerReleaseIdentityV2Schema = Type.Union([
  Type.Object(
    {
      version: Type.String({
        pattern: "^(?:dev|[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)$",
      }),
      commit: Type.String({ pattern: "^(?:unknown|[a-f0-9]{40})$" }),
      buildInputDigest: Type.String({ pattern: "^(?:unknown|sha256:[a-f0-9]{64})$" }),
      development: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.String({
        pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
      }),
      commit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
      buildInputDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
      development: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
]);

const SignerPolicyAssetV2Schema = Type.Object(
  {
    asset: Type.String(),
    destinations: Type.Array(Type.String()),
    maxPerTx: Type.String(),
    maxDaily: Type.String(),
    reviewedDestinations: Type.Optional(Type.Boolean()),
    typedSatDestinations: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SignerPolicyInputV2Schema = Type.Object(
  {
    approvalMode: Type.Optional(
      Type.Union([Type.Literal("read-only"), Type.Literal("manual"), Type.Literal("automatic")]),
    ),
    requirePasskey: Type.Optional(Type.Boolean()),
    delegation: Type.Optional(
      Type.Object(
        {
          executorUid: Type.Integer({ minimum: 1 }),
          notBefore: Type.String(),
          expiresAt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),

    walletId: Type.Optional(Type.String()),
    role: SignerWalletRoleSchema,
    version: Type.Optional(Type.Integer({ minimum: 0 })),
    baselineVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    operations: Type.Array(Type.String()),
    programs: Type.Array(Type.String()),
    typedSatPrograms: Type.Optional(Type.Boolean()),
    assets: Type.Array(SignerPolicyAssetV2Schema),
    hash: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerPolicyV2Schema = Type.Object(
  {
    approvalMode: Type.Optional(
      Type.Union([Type.Literal("read-only"), Type.Literal("manual"), Type.Literal("automatic")]),
    ),
    requirePasskey: Type.Optional(Type.Boolean()),
    delegation: Type.Optional(
      Type.Object(
        {
          executorUid: Type.Integer({ minimum: 1 }),
          notBefore: Type.String(),
          expiresAt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),

    walletId: Type.String(),
    role: SignerWalletRoleSchema,
    version: Type.Integer({ minimum: 1 }),
    baselineVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    operations: Type.Array(Type.String()),
    programs: Type.Array(Type.String()),
    typedSatPrograms: Type.Optional(Type.Boolean()),
    assets: Type.Array(SignerPolicyAssetV2Schema),
    hash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

const SignerJupiterTriggerIntentV2Schema = Type.Object(
  {
    operation: Type.Union([Type.Literal("create"), Type.Literal("cancel")]),
    program: Type.String(),
    order: Type.Optional(Type.String()),
    triggerMint: Type.Optional(Type.String()),
    condition: Type.Optional(Type.Union([Type.Literal("above"), Type.Literal("below")])),
    targetPriceUsd: Type.Optional(Type.String({ pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" })),
    slippageBps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    expiresAt: Type.Optional(
      Type.String({
        pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
      }),
    ),
    expectedOrderState: Type.Union([Type.Literal("new"), Type.Literal("open")]),
  },
  { additionalProperties: false },
);

const SignerJupiterIntentV2Schema = Type.Object(
  {
    owner: Type.String(),
    inputMint: Type.Optional(Type.String()),
    outputMint: Type.Optional(Type.String()),
    inputAmount: Type.Optional(Type.String()),
    maxInputAmount: Type.Optional(Type.String()),
    minimumOutputAmount: Type.Optional(Type.String()),
    maxFeeLamports: Type.String(),
    sourceTokenAccount: Type.Optional(Type.String()),
    destinationTokenAccount: Type.Optional(Type.String()),
    programs: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
    trigger: Type.Optional(SignerJupiterTriggerIntentV2Schema),
  },
  { additionalProperties: false },
);

export const SignerIntentV2Schema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("solana.nativeTransfer"),
      destination: Type.String(),
      lamports: Type.String(),
      memo: Type.Optional(
        Type.String({ pattern: "^fased:a2a-(?:payment|refund):v1:[0-9a-f]{64}$" }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("solana.splTransferChecked"),
      destination: Type.String(),
      tokenProgram: Type.Optional(Type.String()),
      mint: Type.String(),
      amount: Type.String(),
      memo: Type.Optional(
        Type.String({ pattern: "^fased:a2a-(?:payment|refund):v1:[0-9a-f]{64}$" }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Union([
        Type.Literal("solana.jupiter.swap"),
        Type.Literal("solana.jupiter.trigger.create"),
        Type.Literal("solana.jupiter.trigger.cancel"),
      ]),
      jupiter: SignerJupiterIntentV2Schema,
    },
    { additionalProperties: false },
  ),
]);

export type SignerIntentV2 = Static<typeof SignerIntentV2Schema>;

const SignerReviewModeV2Schema = Type.Union([Type.Literal("autonomous"), Type.Literal("reviewed")]);

const SignerSolanaTransactionEnvelopeV2Schema = Type.Object(
  {
    serializedTxBase64: Type.String(),
    programs: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
    writableAccounts: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
    submission: Type.Literal("rpc"),
  },
  { additionalProperties: false },
);

const SignerReviewAuthorizationV2Schema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("webauthn"),
      proof: Type.Object(
        { proofId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("control-ui"),
      proof: Type.Object(
        { proofId: Type.String({ pattern: "^[0-9a-f]{64}$" }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

export const LocalSocketSignerJupiterTriggerHistoryV2Schema = Type.Object(
  {
    orders: Type.Array(
      Type.Object(
        {
          orderId: Type.String({ minLength: 1 }),
          orderState: Type.String({ minLength: 1 }),
          orderType: Type.Literal("single"),
          inputMint: Type.String({ minLength: 1 }),
          initialInputAmount: Type.String({ pattern: "^[1-9][0-9]*$" }),
          remainingInputAmount: Type.String({ pattern: "^(?:0|[1-9][0-9]*)$" }),
          outputMint: Type.String({ minLength: 1 }),
          triggerMint: Type.String({ minLength: 1 }),
          condition: Type.Union([Type.Literal("above"), Type.Literal("below")]),
          targetPriceUsd: Type.String({ pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" }),
          slippageBps: Type.Integer({ minimum: 1, maximum: 1000 }),
          expiresAt: Type.String({
            pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
          }),
          cancel: Type.Optional(
            Type.Object(
              {
                expectedOrderState: Type.Literal("open"),
                refundMint: Type.String({ minLength: 1 }),
                refundAmount: Type.String({ pattern: "^[1-9][0-9]*$" }),
                destinationTokenAccount: Type.String({ minLength: 1 }),
                program: Type.String({ minLength: 1 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerJupiterTriggerHistoryV2 = Static<
  typeof LocalSocketSignerJupiterTriggerHistoryV2Schema
>;

const SignerWalletPolicyCreateV2Schema = Type.Union([
  Type.Object(
    {
      expectedPolicyVersion: Type.Literal(0),
      policy: SignerPolicyInputV2Schema,
    },
    { additionalProperties: false },
  ),
]);

const SignerOperationLookupV2Schema = Type.Object(
  { requestId: Type.String() },
  { additionalProperties: false },
);

export const LocalSocketSignerNetworkSummaryV2Schema = Type.Object(
  {
    walletId: Type.String({ minLength: 1, maxLength: 64 }),
    configured: Type.Boolean(),
    version: Type.Integer({ minimum: 0 }),
    hash: Type.Optional(Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" })),
    ready: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerNetworkSummaryV2 = Static<
  typeof LocalSocketSignerNetworkSummaryV2Schema
>;

export const LocalSocketSignerRPCProfileSummaryV1Schema = Type.Object(
  {
    profileId: Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    chain: Type.Literal("solana"),
    cluster: Type.Union([
      Type.Literal("mainnet-beta"),
      Type.Literal("devnet"),
      Type.Literal("custom"),
    ]),
    genesisHash: Type.String({ minLength: 32, maxLength: 64 }),
    commitment: Type.Literal("finalized"),
    version: Type.Literal(1),
    hash: Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" }),
    endpointCount: Type.Integer({ minimum: 1, maximum: 4 }),
    ready: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerRPCProfileSummaryV1 = Static<
  typeof LocalSocketSignerRPCProfileSummaryV1Schema
>;

export const LocalSocketSignerRPCProfileBindingV1Schema = Type.Object(
  {
    walletId: Type.String({ minLength: 1, maxLength: 64 }),
    profileId: Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
    profileVersion: Type.Literal(1),
    profileHash: Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" }),
    networkVersion: Type.Integer({ minimum: 1 }),
    networkHash: Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" }),
    genesisHash: Type.String({ minLength: 32, maxLength: 64 }),
    ready: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerRPCProfileBindingV1 = Static<
  typeof LocalSocketSignerRPCProfileBindingV1Schema
>;

export const LocalSocketSignerRequestSchema = Type.Union(
  [
    Type.Object({ op: Type.Literal("health") }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("v2.capabilities") }, { additionalProperties: false }),
    Type.Object(
      { op: Type.Literal("v2.jupiter.trigger.history"), walletId: Type.String() },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("v2.policy.get"), walletId: Type.String() },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("v2.network.get"), walletId: Type.String() },
      { additionalProperties: false },
    ),
    Type.Object({ op: Type.Literal("v2.rpcProfile.list") }, { additionalProperties: false }),
    Type.Object(
      {
        op: Type.Literal("v2.rpcProfile.get"),
        request: Type.Object(
          { profileId: Type.String({ minLength: 1, maxLength: 64 }) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.rpcProfile.create"),
        request: Type.Object(
          {
            profileId: Type.String({ minLength: 1, maxLength: 64 }),
            name: Type.String({ minLength: 1, maxLength: 80 }),
            primaryRpcUrl: Type.String({ minLength: 1, maxLength: 2048 }),
            websocketRpcUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
            executionFallbackRpcUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
            verificationRpcUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
            commitment: Type.Literal("finalized"),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.rpcProfile.bind"),
        walletId: Type.String(),
        request: Type.Object(
          {
            profileId: Type.String({ minLength: 1, maxLength: 64 }),
            expectedProfileVersion: Type.Literal(1),
            expectedProfileHash: Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" }),
            expectedNetworkVersion: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.network.bootstrap"),
        walletId: Type.String(),
        request: Type.Object(
          {
            expectedVersion: Type.Integer({ minimum: 0 }),
            primaryRpcUrl: Type.String({ minLength: 1, maxLength: 2048 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.policy.put"),
        walletId: Type.String(),
        request: Type.Object(
          {
            expectedVersion: Type.Integer({ minimum: 0 }),
            policy: SignerPolicyInputV2Schema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.policy.tighten"),
        walletId: Type.String(),
        request: Type.Object(
          {
            expectedVersion: Type.Integer({ minimum: 1 }),
            policy: SignerPolicyInputV2Schema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("v2.wallet.get"), walletId: Type.String() },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("v2.wallet.readiness"), walletId: Type.String() },
      { additionalProperties: false },
    ),

    Type.Object(
      {
        op: Type.Literal("v2.wallet.create"),
        walletId: Type.String(),
        request: SignerWalletPolicyCreateV2Schema,
      },
      { additionalProperties: false },
    ),

    Type.Object(
      {
        op: Type.Literal("v2.wallet.import"),
        walletId: Type.String(),
        request: Type.Object(
          {
            expectedPolicyVersion: Type.Literal(0),
            policy: SignerPolicyInputV2Schema,
            path: Type.String(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wallet.importLegacy"),
        walletId: Type.String(),
        request: Type.Object(
          {
            expectedPolicyVersion: Type.Literal(0),
            policy: SignerPolicyInputV2Schema,
            path: Type.String(),
            passphrasePath: Type.String(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("v2.wallet.reencrypt"), walletId: Type.String() },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.execute"),
        walletId: Type.String(),
        request: Type.Object(
          {
            requestId: Type.String(),
            policyHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
            intent: SignerIntentV2Schema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.review.get"),
        walletId: Type.String(),
        request: SignerOperationLookupV2Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.review.prepare"),
        walletId: Type.String(),
        request: Type.Object(
          {
            requestId: Type.String(),
            policyHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
            mode: SignerReviewModeV2Schema,
            intent: SignerIntentV2Schema,
            transaction: Type.Optional(SignerSolanaTransactionEnvelopeV2Schema),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.review.execute"),
        walletId: Type.String(),
        request: Type.Object(
          {
            requestId: Type.String(),
            authorization: Type.Optional(SignerReviewAuthorizationV2Schema),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.review.authorization.begin"),
        walletId: Type.String(),
        request: Type.Object({ requestId: Type.String() }, { additionalProperties: false }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.review.authorization.finish"),
        walletId: Type.String(),
        request: Type.Object(
          { challengeId: Type.String(), credential: Type.Unknown() },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([Type.Literal("v2.operation.get"), Type.Literal("v2.operation.reconcile")]),
        walletId: Type.String(),
        request: SignerOperationLookupV2Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenBTCClaim.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenBtcClaimIntentSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMiningFunding.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenMiningFundingIntentSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenNativeClaim.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenNativeClaimIntentSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenWithdrawal.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenWithdrawalIntentSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([
          Type.Literal("v2.wenMarket.journey"),
          Type.Literal("v2.wenBondPurchase.journey"),
          Type.Literal("v2.wenBondClaim.journey"),
        ]),
        walletId: Type.String({ minLength: 1 }),
        request: WenCampaignJourneyRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([
          Type.Literal("v2.wenMarket.review.prepare"),
          Type.Literal("v2.wenBondPurchase.review.prepare"),
          Type.Literal("v2.wenBondClaim.review.prepare"),
        ]),
        walletId: Type.String({ minLength: 1 }),
        request: WenCampaignReviewRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMarket.ownerProof.inspect"),
        walletId: Type.String({ minLength: 1 }),
        request: Type.Object(
          {
            requestId: Type.String({ minLength: 1 }),
            proofId: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenCampaign.journey"),
        walletId: Type.String({ minLength: 1 }),
        request: WenCampaignJourneyRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenCampaign.review.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenCampaignReviewRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMining.claim.journey"),
        walletId: Type.String({ minLength: 1 }),
        request: Type.Union([
          Type.Object(
            {
              requestId: Type.String({ pattern: "^[A-Za-z0-9_:.-]{8,128}$" }),
              action: Type.Literal("execute"),
              proof: Type.Object(
                { proofId: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              requestId: Type.String({ pattern: "^[A-Za-z0-9_:.-]{8,128}$" }),
              action: Type.Literal("recover"),
            },
            { additionalProperties: false },
          ),
        ]),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMining.claim.review.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenMiningReviewPrepareRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMining.claim.propose"),
        walletId: Type.String({ minLength: 1 }),
        request: WenMiningClaimProposalRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMining.claim.recover"),
        walletId: Type.String({ minLength: 1 }),
        request: WenMiningRecoveryRequestSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wenMining.prepare"),
        walletId: Type.String({ minLength: 1 }),
        request: WenMiningIntentCandidateSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([
          Type.Literal("v2.wenBtc.inspect"),
          Type.Literal("v2.wenBtc.prepare"),
          Type.Literal("v2.wenBtc.route.preview"),
        ]),
        walletId: Type.String({ minLength: 1 }),
        request: WenBtcIntentCandidateSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("getAddresses"), walletId: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("getBalance"),
        chain: WalletChainSchema,
        walletId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);

export type LocalSocketSignerRequest = Static<typeof LocalSocketSignerRequestSchema>;
export type LocalSocketSignerPolicyV2 = Static<typeof LocalSocketSignerPolicyV2Schema>;
export type LocalSocketSignerOperationV2 = Static<typeof LocalSocketSignerOperationV2Schema>;

export const LocalSocketSignerResponseEnvelopeSchema = Type.Object(
  {
    ok: Type.Boolean(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerResponseEnvelope = Static<
  typeof LocalSocketSignerResponseEnvelopeSchema
>;

export const LocalSocketSignerHealthResultSchema = Type.Object(
  {
    details: Type.Optional(Type.String()),
    readOnly: Type.Optional(Type.Boolean()),
    keystoreType: Type.Optional(Type.String()),
    chains: Type.Optional(Type.Array(WalletChainSchema)),
    ready: Type.Optional(Type.Boolean()),
    release: LocalSocketSignerReleaseIdentityV2Schema,
    schema: Type.Optional(
      Type.Object(
        {
          version: Type.Integer({ minimum: 0 }),
          supported: Type.Integer({ minimum: 1 }),
          ready: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    network: Type.Optional(
      Type.Object(
        {
          ready: Type.Boolean(),
          wallets: Type.Array(
            Type.Object(
              {
                walletId: Type.String(),
                configured: Type.Boolean(),
                version: Type.Integer({ minimum: 0 }),
                hash: Type.Optional(Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" })),
                ready: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    capabilities: Type.Optional(LocalSocketSignerCapabilitiesV2Schema),
    policies: Type.Optional(
      Type.Array(
        Type.Object(
          {
            walletId: Type.String(),
            role: SignerWalletRoleSchema,
            version: Type.Integer({ minimum: 1 }),
            hash: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    webAuthn: Type.Optional(
      Type.Object(
        {
          configured: Type.Boolean(),
          rpId: Type.Optional(Type.String()),
          origins: Type.Optional(Type.Array(Type.String())),
          credentialCount: Type.Integer({ minimum: 0 }),
          credentialVersion: Type.Integer({ minimum: 0 }),
          ready: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    jupiter: Type.Optional(
      Type.Object(
        {
          triggerConfigured: Type.Boolean(),
          liveEnabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    audit: Type.Optional(
      Type.Object(
        {
          configured: Type.Boolean(),
          healthy: Type.Boolean(),
          lastError: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    state: Type.Optional(
      Type.Object(
        {
          databaseBytes: Type.Integer({ minimum: 0 }),
          wallets: Type.Integer({ minimum: 0 }),
          operations: Type.Integer({ minimum: 0 }),
          operationReplayArchive: Type.Optional(Type.Integer({ minimum: 0 })),
          reviews: Type.Integer({ minimum: 0 }),
          triggerWorkflows: Type.Integer({ minimum: 0 }),
          dailyUsageBuckets: Type.Integer({ minimum: 0 }),
          capacities: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Object(
                {
                  used: Type.Integer({ minimum: 0 }),
                  maximum: Type.Integer({ minimum: 1 }),
                  warnAt: Type.Integer({ minimum: 1 }),
                  warning: Type.Boolean(),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          capacityWarnings: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerAddressMapSchema = Type.Object(
  {
    solana: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerBalanceResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    chain: WalletChainSchema,
    address: Type.String({ pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" }),
    balance: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
    unit: Type.Literal("lamports"),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerBalanceResult = Static<typeof LocalSocketSignerBalanceResultSchema>;

export const LocalSocketSignerWalletV2Schema = Type.Object(
  {
    walletId: Type.String(),
    publicKey: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    rotatedAt: Type.Optional(Type.String()),
    nonce: Type.Optional(Type.Literal("")),
    secret: Type.Optional(Type.Literal("")),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerOperationV2Schema = Type.Object(
  {
    requestId: Type.String(),
    walletId: Type.String(),
    intentType: Type.String(),
    intentDigest: Type.String(),
    transactionDigest: Type.Optional(Type.String()),
    policyHash: Type.String(),
    asset: Type.String(),
    amount: Type.String(),
    reservations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            asset: Type.String(),
            amount: Type.String(),
            usageBucket: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    state: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("broadcast"),
      Type.Literal("confirmed"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
    reservationActive: Type.Boolean(),
    usageBucket: Type.String(),
    reservedAt: Type.String(),
    broadcastAt: Type.Optional(Type.String()),
    confirmedAt: Type.Optional(Type.String()),
    updatedAt: Type.String(),
    signature: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    executionAttempt: Type.Optional(Type.Integer({ minimum: 1 })),
    executionLeaseUntil: Type.Optional(Type.String()),
    authorizationProof: Type.Optional(Type.String()),
    authorizedAt: Type.Optional(Type.String()),
    externalResult: Type.Optional(
      Type.Object(
        {
          provider: Type.Literal("jupiter-trigger-v2"),
          action: Type.Union([Type.Literal("create"), Type.Literal("cancel")]),
          orderId: Type.String({ minLength: 1 }),
          orderState: Type.Union([Type.Literal("open"), Type.Literal("cancelled")]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerReviewV2Schema = Type.Object(
  {
    requestId: Type.String(),
    walletId: Type.String(),
    intentType: Type.String(),
    intentDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    policyHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    mode: SignerReviewModeV2Schema,
    nonce: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    semanticIntent: SignerIntentV2Schema,
    walletPublicKey: Type.Optional(Type.String()),
    artifactKind: Type.Union([
      Type.Literal("solana-transaction"),
      Type.Literal("domain-separated-message"),
      Type.Literal("jupiter-trigger-state"),
    ]),
    artifactDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    transaction: Type.Optional(SignerSolanaTransactionEnvelopeV2Schema),
    messageBase64: Type.Optional(Type.String()),
    stateDigest: Type.Optional(Type.String({ pattern: "^sha256:[0-9a-f]{64}$" })),
    stateSlot: Type.Optional(Type.Integer({ minimum: 1 })),
    asset: Type.String({ minLength: 1 }),
    amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
    destination: Type.String({ minLength: 1 }),
    policyOperation: Type.String({ minLength: 1 }),
    requiredPrograms: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    requiredRole: Type.Optional(SignerWalletRoleSchema),
    issuedAt: Type.String(),
    state: Type.Union([Type.Literal("prepared"), Type.Literal("signed")]),
    preparedAt: Type.String(),
    expiresAt: Type.String(),
    updatedAt: Type.String(),
    transactionDigest: Type.Optional(Type.String({ pattern: "^sha256:[0-9a-f]{64}$" })),
    signature: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerReviewExecutionV2Schema = Type.Object(
  {
    review: LocalSocketSignerReviewV2Schema,
    operation: LocalSocketSignerOperationV2Schema,
    signatureBase64: Type.Optional(Type.String()),
    signer: Type.String(),
  },
  { additionalProperties: false },
);

const LocalSocketSignerReviewBindingV2Schema = Type.Object(
  {
    requestId: Type.String(),
    walletId: Type.String(),
    role: SignerWalletRoleSchema,
    walletPublicKey: Type.Optional(Type.String()),
    intentType: Type.String(),
    intentDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    semanticIntent: SignerIntentV2Schema,
    artifactKind: Type.Union([
      Type.Literal("solana-transaction"),
      Type.Literal("domain-separated-message"),
      Type.Literal("jupiter-trigger-state"),
    ]),
    artifactDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    transactionDigest: Type.Optional(Type.String({ pattern: "^sha256:[0-9a-f]{64}$" })),
    stateDigest: Type.Optional(Type.String({ pattern: "^sha256:[0-9a-f]{64}$" })),
    stateSlot: Type.Optional(Type.Integer({ minimum: 1 })),
    asset: Type.String({ minLength: 1 }),
    amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
    destination: Type.String({ minLength: 1 }),
    policyOperation: Type.String({ minLength: 1 }),
    requiredPrograms: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    policyHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    nonce: Type.String(),
    issuedAt: Type.String(),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerReviewAuthorizationBeginV2Schema = Type.Object(
  {
    challengeId: Type.String(),
    expiresAt: Type.String(),
    binding: LocalSocketSignerReviewBindingV2Schema,
    options: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerReviewAuthorizationFinishV2Schema = Type.Object(
  {
    authorization: SignerReviewAuthorizationV2Schema,
    binding: LocalSocketSignerReviewBindingV2Schema,
    credentialId: Type.String(),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);

const LocalSocketSignerWalletPolicyResultV2Schema = Type.Object(
  {
    wallet: LocalSocketSignerWalletV2Schema,
    policy: LocalSocketSignerPolicyV2Schema,
  },
  { additionalProperties: false },
);

export const LocalSocketSignerWalletReadinessV2Schema = Type.Object(
  {
    walletId: Type.String({ minLength: 1 }),
    publicKey: Type.String({ minLength: 1 }),
    walletVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    role: SignerWalletRoleSchema,
    baselineVersion: Type.Integer({ minimum: 0 }),
    policyVersion: Type.Integer({ minimum: 1 }),
    policyHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    networkVersion: Type.Integer({ minimum: 0 }),
    networkHash: Type.Optional(Type.String({ pattern: "^hmac-sha256:[0-9a-f]{64}$" })),
    keyReady: Type.Boolean(),
    policyReady: Type.Boolean(),
    networkReady: Type.Boolean(),
    operationLane: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("agent-reviewed-and-autonomous"),
    ]),
    ready: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerWalletReadinessV2 = Static<
  typeof LocalSocketSignerWalletReadinessV2Schema
>;

function isPositiveUnsignedInteger(value: string | undefined): boolean {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isExactSignerOwnedTriggerIntent(intent: SignerIntentV2): boolean {
  if (
    intent.type !== "solana.jupiter.trigger.create" &&
    intent.type !== "solana.jupiter.trigger.cancel"
  ) {
    return true;
  }
  const jupiter = intent.jupiter;
  const trigger = jupiter.trigger;
  if (!trigger || !jupiter.programs.includes(trigger.program)) {
    return false;
  }
  if (intent.type === "solana.jupiter.trigger.create") {
    return (
      trigger.operation === "create" &&
      trigger.order === undefined &&
      Boolean(trigger.triggerMint) &&
      (trigger.condition === "above" || trigger.condition === "below") &&
      Boolean(trigger.targetPriceUsd) &&
      trigger.slippageBps !== undefined &&
      Boolean(trigger.expiresAt) &&
      trigger.expectedOrderState === "new" &&
      Boolean(jupiter.inputMint) &&
      Boolean(jupiter.outputMint) &&
      jupiter.inputMint !== jupiter.outputMint &&
      isPositiveUnsignedInteger(jupiter.inputAmount) &&
      jupiter.maxInputAmount === jupiter.inputAmount &&
      jupiter.minimumOutputAmount === "0" &&
      jupiter.sourceTokenAccount === undefined &&
      jupiter.destinationTokenAccount === undefined
    );
  }
  return (
    trigger.operation === "cancel" &&
    Boolean(trigger.order) &&
    trigger.triggerMint === undefined &&
    trigger.condition === undefined &&
    trigger.targetPriceUsd === undefined &&
    trigger.slippageBps === undefined &&
    trigger.expiresAt === undefined &&
    trigger.expectedOrderState === "open" &&
    jupiter.inputMint === undefined &&
    jupiter.inputAmount === undefined &&
    jupiter.maxInputAmount === undefined &&
    Boolean(jupiter.outputMint) &&
    isPositiveUnsignedInteger(jupiter.minimumOutputAmount) &&
    Boolean(jupiter.destinationTokenAccount) &&
    jupiter.sourceTokenAccount === undefined
  );
}

export function parseLocalSocketSignerRequest(input: unknown): LocalSocketSignerRequest {
  if (!Value.Check(LocalSocketSignerRequestSchema, input)) {
    throw new Error("invalid signer request");
  }
  if (input.op === "v2.wenBTCClaim.prepare") {
    validateWenBtcClaimIntent(input.request);
  }
  if (input.op === "v2.wenMiningFunding.prepare") {
    validateWenMiningFundingIntent(input.request);
  }
  if (input.op === "v2.wenNativeClaim.prepare") {
    validateWenNativeClaimIntent(input.request);
  }
  if (input.op === "v2.wenWithdrawal.prepare") {
    validateWenWithdrawalIntent(input.request);
  }
  if (
    input.op === "v2.wenCampaign.journey" ||
    input.op === "v2.wenMarket.journey" ||
    input.op === "v2.wenBondPurchase.journey" ||
    input.op === "v2.wenBondClaim.journey"
  ) {
    validateWenCampaignJourneyRequest(input.request);
  }
  if (
    input.op === "v2.wenCampaign.review.prepare" ||
    input.op === "v2.wenMarket.review.prepare" ||
    input.op === "v2.wenBondPurchase.review.prepare" ||
    input.op === "v2.wenBondClaim.review.prepare"
  ) {
    validateWenCampaignReviewRequest(input.request);
  }
  if (input.op === "v2.wenMining.claim.review.prepare") {
    validateWenMiningReviewPrepareRequest(input.request);
  }
  if (input.op === "v2.wenMining.claim.propose") {
    validateWenMiningClaimProposalRequest(input.request);
  }
  if (input.op === "v2.wenMining.claim.recover") {
    validateWenMiningRecoveryRequest(input.request);
  }
  if (input.op === "v2.wenMining.prepare") {
    validateWenMiningIntentCandidate(input.request);
  }
  if (
    input.op === "v2.wenBtc.inspect" ||
    input.op === "v2.wenBtc.prepare" ||
    input.op === "v2.wenBtc.route.preview"
  ) {
    validateWenBtcIntentCandidate(input.request);
  }
  if (
    input.op === "v2.review.prepare" &&
    (input.request.intent.type === "solana.jupiter.trigger.create" ||
      input.request.intent.type === "solana.jupiter.trigger.cancel") &&
    input.request.transaction !== undefined
  ) {
    throw new Error("invalid signer request: Jupiter Trigger transaction bytes are signer-owned");
  }
  if (
    (input.op === "v2.review.prepare" || input.op === "v2.execute") &&
    !isExactSignerOwnedTriggerIntent(input.request.intent)
  ) {
    throw new Error("invalid signer request: Jupiter Trigger terms are not exact and signer-owned");
  }
  return input;
}

export function parseLocalSocketSignerResponseEnvelope(
  input: unknown,
): LocalSocketSignerResponseEnvelope {
  if (!Value.Check(LocalSocketSignerResponseEnvelopeSchema, input)) {
    throw new Error("invalid signer response envelope");
  }
  return input;
}

export function validateLocalSocketSignerResult(
  op: LocalSocketSignerRequest["op"],
  result: unknown,
): boolean {
  switch (op) {
    case "health":
    case "v2.capabilities":
      return Value.Check(LocalSocketSignerHealthResultSchema, result);
    case "v2.jupiter.trigger.history":
      return Value.Check(LocalSocketSignerJupiterTriggerHistoryV2Schema, result);
    case "v2.network.get":
    case "v2.network.bootstrap":
      return Value.Check(LocalSocketSignerNetworkSummaryV2Schema, result);
    case "v2.rpcProfile.list":
      return Value.Check(Type.Array(LocalSocketSignerRPCProfileSummaryV1Schema), result);
    case "v2.rpcProfile.get":
    case "v2.rpcProfile.create":
      return Value.Check(LocalSocketSignerRPCProfileSummaryV1Schema, result);
    case "v2.rpcProfile.bind":
      return Value.Check(LocalSocketSignerRPCProfileBindingV1Schema, result);
    case "v2.policy.get":
    case "v2.policy.put":
    case "v2.policy.tighten":
      return Value.Check(LocalSocketSignerPolicyV2Schema, result);
    case "v2.wallet.get":
    case "v2.wallet.reencrypt":
      return Value.Check(LocalSocketSignerWalletV2Schema, result);
    case "v2.wallet.readiness":
      return Value.Check(LocalSocketSignerWalletReadinessV2Schema, result);
    case "v2.wallet.create":
    case "v2.wallet.import":
    case "v2.wallet.importLegacy":
      return Value.Check(LocalSocketSignerWalletPolicyResultV2Schema, result);
    case "v2.execute":
    case "v2.operation.get":
    case "v2.operation.reconcile":
      return Value.Check(LocalSocketSignerOperationV2Schema, result);
    case "v2.wenBtc.route.preview":
      return isWenBtcRoutePreview(result);
    case "v2.wenBTCClaim.prepare":
      return isWenBtcClaimPreparation(result);
    case "v2.wenMiningFunding.prepare":
      return isWenMiningFundingPreparation(result);
    case "v2.wenNativeClaim.prepare":
      return isWenNativeClaimPreparation(result);
    case "v2.wenWithdrawal.prepare":
      return isWenWithdrawalPreparation(result);
    case "v2.wenBondClaim.review.prepare":
      return Value.Check(WenBondClaimStoredReviewSchema, result);
    case "v2.wenBondPurchase.review.prepare":
      return Value.Check(WenBondPurchaseStoredReviewSchema, result);
    case "v2.wenMarket.ownerProof.inspect":
      return Value.Check(
        Type.Object(
          {
            proofId: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
            requestId: Type.String({ minLength: 1 }),
            walletId: Type.String({ minLength: 1 }),
            artifactDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
            expiresAt: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        result,
      );
    case "v2.wenMarket.review.prepare":
      return Value.Check(WenMarketStoredReviewSchema, result);
    case "v2.wenCampaign.review.prepare":
      return Value.Check(WenCampaignStoredReviewSchema, result);
    case "v2.wenBondClaim.journey":
    case "v2.wenBondPurchase.journey":
    case "v2.wenMarket.journey":
    case "v2.wenCampaign.journey":
      return Value.Check(WenCampaignJourneyResultSchema, result);
    case "v2.wenMining.claim.review.prepare":
      return isWenMiningStoredReview(result);
    case "v2.wenMining.claim.propose":
      return isWenMiningClaimProposal(result);
    case "v2.wenMining.claim.recover":
      return isWenMiningRecoveryResult(result);
    case "v2.wenMining.prepare":
      return isWenMiningPreparation(result);
    case "v2.wenBtc.prepare":
      return isWenBtcPreparation(result);
    case "v2.wenBtc.inspect":
      return isWenBtcInspection(result);
    case "v2.review.get":
    case "v2.review.prepare":
      return Value.Check(LocalSocketSignerReviewV2Schema, result);
    case "v2.review.execute":
      return Value.Check(LocalSocketSignerReviewExecutionV2Schema, result);
    case "v2.review.authorization.begin":
      return (
        Value.Check(LocalSocketSignerReviewAuthorizationBeginV2Schema, result) ||
        isWenMiningAuthorizationBegin(result) ||
        isWenCampaignAuthorizationBegin(result)
      );
    case "v2.wenMining.claim.journey":
      return isWenClaimJourneyResult(result);
    case "v2.review.authorization.finish":
      return (
        Value.Check(LocalSocketSignerReviewAuthorizationFinishV2Schema, result) ||
        isWenMiningAuthorizationFinish(result) ||
        isWenCampaignAuthorizationFinish(result)
      );
    case "getAddresses":
      return Value.Check(LocalSocketSignerAddressMapSchema, result);
    case "getBalance":
      return Value.Check(LocalSocketSignerBalanceResultSchema, result);
  }
}
import { isWenClaimJourneyResult } from "./wen-claim-journey-contract.js";
