import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import {
  HexColorSchema,
  ModelsConfigSchema,
  SecretInputSchema,
  SecretsConfigSchema,
  TranscribeAudioSchema,
} from "./zod-schema.core.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { InstallRecordShape } from "./zod-schema.installs.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { sensitive } from "./zod-schema.sensitive.js";
import {
  CommandsSchema,
  MessagesSchema,
  SessionSchema,
  SessionSendPolicySchema,
} from "./zod-schema.session.js";

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const MemoryQmdPathSchema = z
  .object({
    path: z.string(),
    name: z.string().optional(),
    pattern: z.string().optional(),
  })
  .strict();

const MemoryQmdSessionSchema = z
  .object({
    enabled: z.boolean().optional(),
    exportDir: z.string().optional(),
    retentionDays: z.number().int().nonnegative().optional(),
  })
  .strict();

const TalkProviderConfigSchema = z
  .object({
    voiceId: z.string().optional(),
    voiceAliases: z.record(z.string(), z.string()).optional(),
    modelId: z.string().optional(),
    outputFormat: z.string().optional(),
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(z.unknown());

const LegacyAudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();

const MemoryQmdUpdateSchema = z
  .object({
    interval: z.string().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    onBoot: z.boolean().optional(),
    waitForBootSync: z.boolean().optional(),
    embedInterval: z.string().optional(),
    commandTimeoutMs: z.number().int().nonnegative().optional(),
    updateTimeoutMs: z.number().int().nonnegative().optional(),
    embedTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdLimitsSchema = z
  .object({
    maxResults: z.number().int().positive().optional(),
    maxSnippetChars: z.number().int().positive().optional(),
    maxInjectedChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdSchema = z
  .object({
    command: z.string().optional(),
    searchMode: z.union([z.literal("query"), z.literal("search"), z.literal("vsearch")]).optional(),
    includeDefaultMemory: z.boolean().optional(),
    paths: z.array(MemoryQmdPathSchema).optional(),
    sessions: MemoryQmdSessionSchema.optional(),
    update: MemoryQmdUpdateSchema.optional(),
    limits: MemoryQmdLimitsSchema.optional(),
    scope: SessionSendPolicySchema.optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
    citations: z.union([z.literal("auto"), z.literal("on"), z.literal("off")]).optional(),
    qmd: MemoryQmdSchema.optional(),
  })
  .strict()
  .optional();

const AcpSchema = z
  .object({
    enabled: z.boolean().optional(),
    dispatch: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    backend: z.string().optional(),
    defaultAgent: z.string().optional(),
    allowedAgents: z.array(z.string()).optional(),
    maxConcurrentSessions: z.number().int().positive().optional(),
    stream: z
      .object({
        coalesceIdleMs: z.number().int().nonnegative().optional(),
        maxChunkChars: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        ttlMinutes: z.number().int().positive().optional(),
        installCommand: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const DurationStringSchema = z.string().refine(
  (value) => {
    try {
      parseDurationMs(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid duration (use ms, s, m, h, d)" },
);

const ByteSizeSchema = z.union([z.number().int().positive(), z.string()]).refine(
  (value) => {
    try {
      return parseByteSize(String(value).trim(), { defaultUnit: "b" }) > 0;
    } catch {
      return false;
    }
  },
  { message: "invalid byte size" },
);

const CronRunLogSchema = z
  .object({
    maxBytes: ByteSizeSchema.optional(),
    keepLines: z.number().int().positive().optional(),
  })
  .strict();

const LastTouchedAtSchema = z.union([
  z.string(),
  z.number().transform((value, ctx) => {
    const date = new Date(value);
    if (!Number.isFinite(value) || Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid timestamp",
      });
      return z.NEVER;
    }
    return date.toISOString();
  }),
]);

const FederationMarketplacePriceUnitSchema = z.union([
  z.literal("per-job"),
  z.literal("per-hour"),
  z.literal("per-1k-rows"),
  z.literal("per-api-call"),
  z.literal("per-day"),
  z.literal("per-month"),
  z.literal("custom"),
]);

const FederationOfferPricingSchema = z
  .object({
    currency: z.string().optional(),
    model: z.string().optional(),
    amount: z.number().positive().optional(),
    unit: FederationMarketplacePriceUnitSchema.optional(),
    unitLabel: z.string().optional(),
  })
  .strict()
  .optional();

const FederationMarketplaceFulfillmentModeSchema = z.union([
  z.literal("human"),
  z.literal("agent"),
  z.literal("agent-approval"),
  z.literal("api"),
  z.literal("dataset"),
  z.literal("hybrid"),
]);

const FederationMarketplaceReceiptRuleSchema = z
  .object({
    kind: z
      .union([
        z.literal("result"),
        z.literal("artifact"),
        z.literal("invoice"),
        z.literal("receipt"),
        z.literal("tx"),
        z.literal("signature"),
        z.literal("manual"),
      ])
      .optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

const FederationMarketplaceAutomationPolicySchema = z
  .object({
    allowed: z.boolean().optional(),
    humanApprovalRequired: z.boolean().optional(),
    allowedSkills: z.array(z.string()).optional(),
    allowedPlugins: z.array(z.string()).optional(),
    maxRuntimeSeconds: z.number().int().positive().optional(),
    maxSpendAmount: z.number().positive().optional(),
    maxSpendCurrency: z.string().optional(),
  })
  .strict()
  .optional();

const FederationOfferAssetSchema = z
  .object({
    kind: z.union([z.literal("native"), z.literal("spl-token")]).optional(),
    address: z.string().optional(),
  })
  .strict()
  .optional();

const FederationOfferPayeeSchema = z
  .object({
    chain: z.literal("solana").optional(),
    address: z.string().optional(),
  })
  .strict()
  .optional();

const FederationOfferPaymentDefaultsSchema = z
  .object({
    currency: z.string().optional(),
    chain: z.literal("solana").optional(),
    assetDecimals: z.number().int().min(0).max(18).optional(),
    asset: FederationOfferAssetSchema,
    payee: FederationOfferPayeeSchema,
  })
  .strict()
  .optional();

const FederationOfferSchema = z
  .object({
    id: z.string().optional(),
    source: z.union([z.literal("builtin"), z.literal("manual"), z.literal("skill")]).optional(),
    enabled: z.boolean().optional(),
    title: z.string(),
    summary: z.string().optional(),
    serviceKind: z.string(),
    inputShape: z.string().optional(),
    deliveryShape: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    pricing: FederationOfferPricingSchema,
    fulfillmentMode: FederationMarketplaceFulfillmentModeSchema.optional(),
    performer: FederationMarketplaceFulfillmentModeSchema.optional(),
    receiptRules: z.array(FederationMarketplaceReceiptRuleSchema).optional(),
    automation: FederationMarketplaceAutomationPolicySchema,
    paymentRails: z.array(z.string()).optional(),
    acceptedAssets: z.array(z.string()).optional(),
    paymentDefaults: FederationOfferPaymentDefaultsSchema,
    availability: z.string().optional(),
    visibility: z.string().optional(),
    requiredTrustOrBondTier: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceRequestStatusSchema = z.union([
  z.literal("draft"),
  z.literal("open"),
  z.literal("matched"),
  z.literal("closed"),
]);

const FederationMarketplaceOrderStatusSchema = z.union([
  z.literal("draft"),
  z.literal("accepted"),
  z.literal("funded"),
  z.literal("running"),
  z.literal("delivered"),
  z.literal("disputed"),
  z.literal("closed"),
  z.literal("cancelled"),
]);

const FederationMarketplaceSellerSyncStatusSchema = z.union([
  z.literal("not_submitted"),
  z.literal("pending"),
  z.literal("accepted"),
  z.literal("failed"),
]);

const FederationMarketplacePaymentIntentStatusSchema = z.union([
  z.literal("draft"),
  z.literal("requires_payment"),
  z.literal("submitted"),
  z.literal("verified"),
  z.literal("failed"),
  z.literal("cancelled"),
]);

const FederationMarketplaceSettlementModeSchema = z.union([
  z.literal("direct"),
  z.literal("escrow"),
]);

const FederationMarketplaceSettlementStatusSchema = z.union([
  z.literal("not_required"),
  z.literal("requires_payment"),
  z.literal("submitted"),
  z.literal("verified"),
  z.literal("settled"),
  z.literal("held"),
  z.literal("released"),
  z.literal("failed"),
  z.literal("disputed"),
  z.literal("cancelled"),
]);

const FederationMarketplaceEscrowStatusSchema = z.union([
  z.literal("not_applicable"),
  z.literal("required"),
  z.literal("funded"),
  z.literal("held"),
  z.literal("released"),
  z.literal("refunded"),
  z.literal("cancelled"),
  z.literal("blocked"),
]);

const FederationMarketplaceDeliveryStatusSchema = z.union([
  z.literal("pending"),
  z.literal("ready"),
  z.literal("running"),
  z.literal("delivered"),
  z.literal("failed"),
  z.literal("blocked"),
]);

const FederationMarketplaceReceiptStatusSchema = z.union([
  z.literal("pending"),
  z.literal("issued"),
  z.literal("verified"),
  z.literal("rejected"),
]);

const FederationMarketplaceBillingPeriodSchema = z.union([
  z.literal("one-time"),
  z.literal("per-job"),
  z.literal("per-hour"),
  z.literal("per-1k-rows"),
  z.literal("per-api-call"),
  z.literal("per-day"),
  z.literal("per-week"),
  z.literal("per-month"),
  z.literal("custom"),
]);

const FederationMarketplaceSubscriptionStatusSchema = z.union([
  z.literal("not_applicable"),
  z.literal("draft"),
  z.literal("active"),
  z.literal("past_due"),
  z.literal("paused"),
  z.literal("expired"),
  z.literal("cancelled"),
  z.literal("blocked"),
]);

const FederationMarketplaceRenewalPolicySchema = z.union([
  z.literal("none"),
  z.literal("manual"),
  z.literal("auto-renew"),
  z.literal("auto-renew-with-approval"),
]);

const FederationMarketplaceDeliveryStopStatusSchema = z.union([
  z.literal("not_required"),
  z.literal("scheduled"),
  z.literal("stopped"),
  z.literal("blocked"),
]);

const FederationMarketplaceSubscriptionSchema = z
  .object({
    status: FederationMarketplaceSubscriptionStatusSchema.optional(),
    billingPeriod: FederationMarketplaceBillingPeriodSchema.optional(),
    maxBuyers: z.number().int().positive().optional(),
    remainingSlots: z.number().int().min(0).optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    renewalPolicy: FederationMarketplaceRenewalPolicySchema.optional(),
    paymentExpiresAt: z.string().optional(),
    deliveryStop: z
      .object({
        status: FederationMarketplaceDeliveryStopStatusSchema.optional(),
        reason: z.string().optional(),
        scheduledAt: z.string().optional(),
        stoppedAt: z.string().optional(),
        updatedAt: z.string().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceDeliveryTargetKindSchema = z.union([
  z.literal("app-inbox"),
  z.literal("channel"),
  z.literal("webhook"),
  z.literal("websocket"),
  z.literal("federation"),
  z.literal("api"),
  z.literal("artifact"),
]);

const FederationMarketplaceDeliveryTargetStatusSchema = z.union([
  z.literal("draft"),
  z.literal("ready"),
  z.literal("revoked"),
  z.literal("expired"),
  z.literal("blocked"),
]);

const FederationMarketplaceDeliveryTargetSchema = z
  .object({
    targetId: z.string().optional(),
    source: z
      .union([z.literal("order"), z.literal("subscription"), z.literal("manual")])
      .optional(),
    owner: z.union([z.literal("buyer"), z.literal("seller")]).optional(),
    kind: FederationMarketplaceDeliveryTargetKindSchema.optional(),
    status: FederationMarketplaceDeliveryTargetStatusSchema.optional(),
    label: z.string().optional(),
    descriptor: z.string().optional(),
    maskedTarget: z.string().optional(),
    scope: z
      .object({
        orderId: z.string().optional(),
        subscriptionId: z.string().optional(),
        serviceKind: z.string().optional(),
        expiresAt: z.string().optional(),
        maxDeliveries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    channel: z
      .object({
        provider: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
        threadId: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .optional(),
    webhook: z
      .object({
        url: z.string().optional(),
        method: z.literal("POST").optional(),
        secretRef: z.string().optional(),
      })
      .strict()
      .optional(),
    websocket: z
      .object({
        url: z.string().optional(),
        tokenRef: z.string().optional(),
      })
      .strict()
      .optional(),
    federation: z
      .object({
        handle: z.string().optional(),
        nodeEndpoint: z.string().optional(),
      })
      .strict()
      .optional(),
    api: z
      .object({
        url: z.string().optional(),
        tokenRef: z.string().optional(),
      })
      .strict()
      .optional(),
    artifact: z
      .object({
        artifactRef: z.string().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    revokedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplacePaymentIntentSchema = z
  .object({
    intentId: z.string().optional(),
    status: FederationMarketplacePaymentIntentStatusSchema.optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    unit: FederationMarketplacePriceUnitSchema.optional(),
    method: z.string().optional(),
    chain: z.literal("solana").optional(),
    assetKind: z.union([z.literal("native"), z.literal("spl-token")]).optional(),
    assetAddress: z.string().optional(),
    assetDecimals: z.number().int().min(0).max(18).optional(),
    expiresInMinutes: z.number().int().positive().optional(),
    acceptedAssets: z.array(z.string()).optional(),
    payerWalletId: z.string().optional(),
    payeeHandle: z.string().optional(),
    payeeAddress: z.string().optional(),
    txRef: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceEscrowSchema = z
  .object({
    status: FederationMarketplaceEscrowStatusSchema.optional(),
    holdPolicy: z
      .union([z.literal("none"), z.literal("release_on_delivery"), z.literal("manual_release")])
      .optional(),
    releaseRequired: z.boolean().optional(),
    vaultWalletId: z.string().optional(),
    vaultWalletName: z.string().optional(),
    vaultAddress: z.string().optional(),
    fundingRequestId: z.string().optional(),
    fundingTxRef: z.string().optional(),
    fundedAt: z.string().optional(),
    releaseRequestId: z.string().optional(),
    releaseTxRef: z.string().optional(),
    releasedAt: z.string().optional(),
    refundRequestId: z.string().optional(),
    refundTxRef: z.string().optional(),
    refundedAt: z.string().optional(),
    cancelledAt: z.string().optional(),
    notes: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceSettlementRecordSchema = z
  .object({
    mode: FederationMarketplaceSettlementModeSchema.optional(),
    status: FederationMarketplaceSettlementStatusSchema.optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    chain: z.literal("solana").optional(),
    assetKind: z.union([z.literal("native"), z.literal("spl-token")]).optional(),
    assetAddress: z.string().optional(),
    assetDecimals: z.number().int().min(0).max(18).optional(),
    invoiceId: z.string().optional(),
    receiptId: z.string().optional(),
    txRef: z.string().optional(),
    evidenceRef: z.string().optional(),
    payerWalletId: z.string().optional(),
    payeeAddress: z.string().optional(),
    escrow: FederationMarketplaceEscrowSchema.optional(),
    notes: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    verifiedAt: z.string().optional(),
    settledAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceDeliveryRecordSchema = z
  .object({
    status: FederationMarketplaceDeliveryStatusSchema.optional(),
    fulfillmentMode: FederationMarketplaceFulfillmentModeSchema.optional(),
    inputShape: z.string().optional(),
    deliveryShape: z.string().optional(),
    targetId: z.string().optional(),
    targetKind: FederationMarketplaceDeliveryTargetKindSchema.optional(),
    targetStatus: FederationMarketplaceDeliveryTargetStatusSchema.optional(),
    targetLabel: z.string().optional(),
    targetMasked: z.string().optional(),
    target: FederationMarketplaceDeliveryTargetSchema.optional(),
    resultRef: z.string().optional(),
    artifactRef: z.string().optional(),
    notes: z.string().optional(),
    deliveredAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceReceiptRecordSchema = z
  .object({
    status: FederationMarketplaceReceiptStatusSchema.optional(),
    invoiceId: z.string().optional(),
    receiptId: z.string().optional(),
    txRef: z.string().optional(),
    resultRef: z.string().optional(),
    disputeCaseId: z.string().optional(),
    notes: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceRequestSchema = z
  .object({
    id: z.string().optional(),
    source: z.union([z.literal("manual"), z.literal("chat")]).optional(),
    enabled: z.boolean().optional(),
    status: FederationMarketplaceRequestStatusSchema.optional(),
    title: z.string(),
    summary: z.string().optional(),
    serviceKind: z.string(),
    inputShape: z.string().optional(),
    deliveryShape: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    pricing: FederationOfferPricingSchema,
    fulfillmentMode: FederationMarketplaceFulfillmentModeSchema.optional(),
    receiptRules: z.array(FederationMarketplaceReceiptRuleSchema).optional(),
    paymentRails: z.array(z.string()).optional(),
    acceptedAssets: z.array(z.string()).optional(),
    requiredTrustOrBondTier: z.string().optional(),
    visibility: z.string().optional(),
    expiresAt: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const FederationMarketplaceOrderSchema = z
  .object({
    id: z.string().optional(),
    source: z.union([z.literal("local"), z.literal("federation")]).optional(),
    status: FederationMarketplaceOrderStatusSchema.optional(),
    offerId: z.string().optional(),
    requestId: z.string().optional(),
    buyerHandle: z.string().optional(),
    sellerHandle: z.string().optional(),
    sellerEndpoint: z.string().optional(),
    sellerOrderId: z.string().optional(),
    sellerSyncStatus: FederationMarketplaceSellerSyncStatusSchema.optional(),
    sellerSyncError: z.string().optional(),
    sellerSyncedAt: z.string().optional(),
    sellerAcceptedAt: z.string().optional(),
    peerNodeId: z.string().optional(),
    peerRemoteOrderId: z.string().optional(),
    peerRequestDigest: z.string().optional(),
    peerDeliveryDigest: z.string().optional(),
    serviceKind: z.string().optional(),
    title: z.string().optional(),
    pricing: FederationOfferPricingSchema,
    fulfillmentMode: FederationMarketplaceFulfillmentModeSchema.optional(),
    receiptRules: z.array(FederationMarketplaceReceiptRuleSchema).optional(),
    paymentIntent: FederationMarketplacePaymentIntentSchema.optional(),
    settlement: FederationMarketplaceSettlementRecordSchema.optional(),
    delivery: FederationMarketplaceDeliveryRecordSchema.optional(),
    subscription: FederationMarketplaceSubscriptionSchema.optional(),
    receipt: FederationMarketplaceReceiptRecordSchema.optional(),
    invoiceId: z.string().optional(),
    receiptId: z.string().optional(),
    txRef: z.string().optional(),
    resultRef: z.string().optional(),
    disputeCaseId: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const WalletChainPolicySchema = z
  .object({
    allowPrograms: z.array(z.string()).optional(),
    tokenCaps: z
      .record(
        z.string(),
        z
          .object({
            maxPerTx: z.string().optional(),
            maxDaily: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    maxPerTx: z.string().optional(),
    maxDaily: z.string().optional(),
  })
  .strict();

const WalletSchema = z
  .object({
    provider: z
      .object({
        id: z
          .union([
            z.literal("embedded-keystore"),
            z.literal("local-socket-signer"),
            z.literal("alchemy"),
            z.literal("turnkey"),
            z.literal("wallet-standard"),
            z.literal("privy"),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    execution: z
      .object({
        mode: z.union([z.literal("manual"), z.literal("autonomous")]).optional(),
      })
      .strict()
      .optional(),
    approvalAuth: z
      .object({
        mode: z.union([z.literal("none"), z.literal("webauthn")]).optional(),
        challengeTtlSeconds: z.number().int().positive().optional(),
        grantTtlSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    keystore: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        chainSupport: z.array(z.literal("solana")).optional(),
        autoLockSeconds: z.number().int().nonnegative().optional(),
        requirePasskeyForUnlock: z.boolean().optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.union([z.literal("managed"), z.literal("external")]).optional(),
        runtime: z.union([z.literal("external-docker"), z.literal("external-custom")]).optional(),
        external: z
          .object({
            kind: z.union([z.literal("docker"), z.literal("custom")]).optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z
              .union([z.literal("jwt-bootstrap"), z.literal("static-token-compat")])
              .optional(),
            bootstrapUrl: z.string().optional(),
          })
          .strict()
          .optional(),
        source: z.object({ ref: z.string().optional() }).strict().optional(),
        chains: z.array(z.literal("solana")).optional(),
        service: z
          .object({
            host: z.string().optional(),
            port: z.number().int().min(1).max(65535).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            enabled: z.boolean().optional(),
            version: z.string().optional(),
          })
          .strict()
          .optional(),
        policy: z
          .object({
            capsEnabled: z.boolean().optional(),
            directSigning: z.boolean().optional(),
            skillsEnabled: z.boolean().optional(),
            solana: WalletChainPolicySchema.optional(),
          })
          .strict()
          .optional(),
        toolAccess: z
          .object({
            mode: z
              .union([z.literal("owner-only"), z.literal("allowlist"), z.literal("all")])
              .optional(),
            allowAgents: z.array(z.string()).optional(),
            allowSkills: z.array(z.string()).optional(),
            denySkills: z.array(z.string()).optional(),
            allowSources: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const FasedAgentSchema = z
  .object({
    $schema: z.string().optional(),
    meta: z
      .object({
        lastTouchedVersion: z.string().optional(),
        lastTouchedAt: LastTouchedAtSchema.optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunVersion: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        prometheus: z
          .object({
            enabled: z.boolean().optional(),
            path: z.string().optional(),
            requireAuth: z.boolean().optional(),
            includeRuntime: z.boolean().optional(),
          })
          .strict()
          .optional(),
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        file: z.string().optional(),
        maxFileBytes: z.number().int().positive().optional(),
        consoleLevel: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        channel: z.union([z.literal("stable"), z.literal("beta"), z.literal("dev")]).optional(),
        checkOnStart: z.boolean().optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        cdpUrl: z.string().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        defaultProfile: z.string().optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        profiles: z
          .record(
            z
              .string()
              .regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                driver: z.union([z.literal("clawd"), z.literal("extension")]).optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine((value) => value.cdpPort || value.cdpUrl, {
                message: "Profile must set cdpPort or cdpUrl",
              }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([z.literal("api_key"), z.literal("oauth"), z.literal("token")]),
                email: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
            overloadedBackoffMs: z.number().positive().optional(),
            overloadedProfileRotations: z.number().nonnegative().optional(),
            rateLimitedProfileRotations: z.number().nonnegative().optional(),
            billingMaxHours: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    acp: AcpSchema,
    models: ModelsConfigSchema,
    nodeHost: NodeHostSchema,
    agents: AgentsSchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: LegacyAudioSchema,
    media: z
      .object({
        preserveFilenames: z.boolean().optional(),
      })
      .strict()
      .optional(),
    messages: MessagesSchema,
    commands: CommandsSchema,
    approvals: ApprovalsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
        webhook: z
          .string()
          .url()
          .refine((value) => /^https?:\/\//iu.test(value), "Must be an http(s) URL")
          .optional(),
        webhookToken: z.string().optional().register(sensitive),
        sessionRetention: z.union([DurationStringSchema, z.literal(false)]).optional(),
        runLog: CronRunLogSchema.optional(),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional().register(sensitive),
        defaultSessionKey: z.string().optional(),
        allowRequestSessionKey: z.boolean().optional(),
        allowedSessionKeyPrefixes: z.array(z.string()).optional(),
        allowedAgentIds: z.array(z.string()).optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
      })
      .strict()
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    channels: ChannelsSchema,
    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
            domain: z.string().optional(),
          })
          .strict()
          .optional(),
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    federation: z
      .object({
        offers: z
          .object({
            manual: z.array(FederationOfferSchema).optional(),
            skill: z
              .array(
                FederationOfferSchema.extend({
                  source: z.union([z.literal("skill")]).optional(),
                  skillId: z.string().optional(),
                }).strict(),
              )
              .optional(),
          })
          .strict()
          .optional(),
        marketplace: z
          .object({
            requests: z
              .object({
                manual: z.array(FederationMarketplaceRequestSchema).optional(),
              })
              .strict()
              .optional(),
            deliveryTargets: z
              .object({
                local: z.array(FederationMarketplaceDeliveryTargetSchema).optional(),
              })
              .strict()
              .optional(),
            orders: z
              .object({
                local: z.array(FederationMarketplaceOrderSchema).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        bond: z
          .object({
            walletId: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    canvasHost: z
      .object({
        enabled: z.boolean().optional(),
        root: z.string().optional(),
        port: z.number().int().positive().optional(),
        liveReload: z.boolean().optional(),
      })
      .strict()
      .optional(),
    talk: z
      .object({
        provider: z.string().optional(),
        providers: z.record(z.string(), TalkProviderConfigSchema).optional(),
        voiceId: z.string().optional(),
        voiceAliases: z.record(z.string(), z.string()).optional(),
        modelId: z.string().optional(),
        outputFormat: z.string().optional(),
        apiKey: SecretInputSchema.optional().register(sensitive),
        interruptOnSpeech: z.boolean().optional(),
      })
      .strict()
      .optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        channelHealthCheckMinutes: z.number().int().min(0).optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            root: z.string().optional(),
            allowedOrigins: z.array(z.string()).optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
            dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z
              .union([z.literal("token"), z.literal("password"), z.literal("trusted-proxy")])
              .optional(),
            token: z.string().optional().register(sensitive),
            password: z.string().optional().register(sensitive),
            allowTailscale: z.boolean().optional(),
            rateLimit: z
              .object({
                maxAttempts: z.number().optional(),
                windowMs: z.number().optional(),
                lockoutMs: z.number().optional(),
                exemptLoopback: z.boolean().optional(),
              })
              .strict()
              .optional(),
            trustedProxy: z
              .object({
                userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
                requiredHeaders: z.array(z.string()).optional(),
                allowUsers: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        tools: z
          .object({
            deny: z.array(z.string()).optional(),
            allow: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        tailscale: z
          .object({
            mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
            token: z.string().optional().register(sensitive),
            password: z.string().optional().register(sensitive),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    maxUrlParts: z.number().int().nonnegative().optional(),
                    files: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        urlAllowlist: z.array(z.string()).optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxChars: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z.number().int().nonnegative().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        allowUrl: z.boolean().optional(),
                        urlAllowlist: z.array(z.string()).optional(),
                        allowedMimes: z.array(z.string()).optional(),
                        maxBytes: z.number().int().positive().optional(),
                        maxRedirects: z.number().int().nonnegative().optional(),
                        timeoutMs: z.number().int().positive().optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            securityHeaders: z
              .object({
                strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([z.literal("auto"), z.literal("manual"), z.literal("off")])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        customBindHost: z.string().optional(),
        allowRealIpFallback: z.boolean().optional(),
      })
      .strict()
      .optional(),
    memory: MemorySchema,
    wallet: WalletSchema,
    secrets: SecretsConfigSchema,
    mcp: z
      .object({
        servers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        marketplace: z
          .object({
            allowRegistries: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: SecretInputSchema.optional().register(sensitive),
                env: z.record(z.string(), z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
          })
          .strict()
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                config: z.record(z.string(), z.unknown()).optional(),
                runtime: z
                  .object({
                    helpers: z
                      .object({
                        sessions: z
                          .object({
                            read: z.boolean().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    adminRpcActions: z
                      .object({
                        allow: z
                          .array(
                            z
                              .object({
                                method: z
                                  .union([
                                    z.literal("chat.inject"),
                                    z.literal("push.test"),
                                    z.literal("web.login.start"),
                                    z.literal("web.login.wait"),
                                  ])
                                  .optional(),
                                sources: z.array(z.string()).optional(),
                                requireOperatorApproval: z.boolean().optional(),
                              })
                              .strict(),
                          )
                          .optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .optional(),
        installs: z.record(z.string(), z.object(InstallRecordShape).strict()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) {
      return;
    }
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) {
      return;
    }

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") {
        continue;
      }
      if (!Array.isArray(ids)) {
        continue;
      }
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId, idx],
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
          });
        }
      }
    }
  });
