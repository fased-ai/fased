import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT } from "../mining/sat-vnext-release-contract.generated.js";
import { SIGNER_PROTOCOL_V2 } from "./signer-protocol-v2.generated.js";

const WalletChainSchema = Type.Literal("solana");

export const LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2 =
  SIGNER_PROTOCOL_V2.nativeFeeReservationLamports;

const SignerWalletRoleSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("mining"),
  Type.Literal("vault"),
  Type.Literal("keeper"),
]);

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

export const LocalSocketSignerSatReleaseAcknowledgementSchema = Type.Object(
  {
    schema: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.schema),
    state: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.state),
    componentGenerations: Type.Object(
      {
        bond: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.bond),
        cycle: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.cycle),
        economics: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.economics),
        penalty: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.penalty),
        protocol: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.protocol),
        keeper: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.keeper),
        receipt: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.receipt),
        schema: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.schema),
        signerCapability: Type.Literal(
          SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.signerCapability,
        ),
      },
      { additionalProperties: false },
    ),
    interfaceContractSha256: Type.Literal(
      SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.interfaceContractSha256,
    ),
    idlSha256: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.idlSha256),
    accountOrderSha256: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.accountOrderSha256),
    stateLayoutsSha256: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.stateLayoutsSha256),
    signerCodecsSha256: Type.Literal(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.signerCodecsSha256),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerSatReleaseAcknowledgement = Static<
  typeof LocalSocketSignerSatReleaseAcknowledgementSchema
>;

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

export const LocalSocketSignerKeeperFeePayerCapabilityV2Schema = Type.Object(
  {
    miningWalletId: Type.String({ minLength: 1 }),
    feePayerWalletId: Type.String({ minLength: 1 }),
    feePayerPublicKey: Type.String({ minLength: 1 }),
    policyHash: Type.String({ minLength: 1 }),
    maxPerTransactionLamports: Type.String({ pattern: "^[1-9][0-9]*$" }),
    maxDailyLamports: Type.String({ pattern: "^[1-9][0-9]*$" }),
    state: Type.Literal("ready"),
  },
  { additionalProperties: false },
);

const SignerSatAccountV2Schema = Type.Object(
  {
    pubkey: Type.String(),
    isSigner: Type.Boolean(),
    isWritable: Type.Boolean(),
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

const SignerSatContextV2Schema = Type.Object(
  {
    targetAuthority: Type.Optional(Type.String()),
    disputeAuthority: Type.Optional(Type.String()),
    intervalStartCycleId: Type.Optional(Type.String()),
    registryPageIndex: Type.Optional(Type.String()),
    minerAuthorities: Type.Optional(Type.Array(Type.String())),
    permanentMiningIds: Type.Optional(Type.Array(Type.String())),
    frontCycleIds: Type.Optional(Type.Array(Type.String())),
    backCycleIds: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const SignerSatCommitmentIntentV1Schema = Type.Object(
  {
    reference: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    cluster: Type.Union([
      Type.Literal("local"),
      Type.Literal("devnet"),
      Type.Literal("mainnet-beta"),
    ]),
    protocolGeneration: Type.String({ minLength: 1, maxLength: 128 }),
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

const SignerSatInstructionV2Schema = Type.Object(
  {
    action: Type.String({ minLength: 1 }),
    programId: Type.String(),
    dataBase64: Type.String(),
    keys: Type.Array(SignerSatAccountV2Schema),
    context: Type.Optional(SignerSatContextV2Schema),
  },
  { additionalProperties: false },
);

const SignerSatLookupTableV2Schema = Type.Object(
  {
    address: Type.String(),
    cycleId: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
    pageIndex: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
    recentSlot: Type.Optional(Type.String({ pattern: "^(0|[1-9][0-9]*)$" })),
    addresses: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
    parent: Type.Optional(SignerSatInstructionV2Schema),
  },
  { additionalProperties: false },
);

const SignerFederationBondChallengeV2Schema = Type.Object(
  {
    challengeId: Type.String({ minLength: 1, maxLength: 256 }),
    federationOrigin: Type.String({ minLength: 1, maxLength: 2048 }),
    handle: Type.String({ minLength: 1, maxLength: 512 }),
    nodeId: Type.String({ minLength: 1, maxLength: 512 }),
    tokenId: Type.String({ minLength: 1, maxLength: 512 }),
    bondId: Type.String({ minLength: 1, maxLength: 512 }),
    tier: Type.Union([
      Type.Literal("none"),
      Type.Literal("basic-bond"),
      Type.Literal("operator-bond"),
    ]),
    amountRaw: Type.Optional(Type.String({ pattern: "^(0|[1-9][0-9]*)$" })),
    expiresAt: Type.String({ minLength: 1, maxLength: 512 }),
    payloadBase64: Type.String({ minLength: 4, maxLength: 24 * 1024 }),
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
      type: Type.Literal("solana.satAction"),
      action: Type.String({ minLength: 1 }),
      programId: Type.Optional(Type.String()),
      dataBase64: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(SignerSatAccountV2Schema)),
      context: Type.Optional(SignerSatContextV2Schema),
      satCommitment: Type.Optional(SignerSatCommitmentIntentV1Schema),
      instructions: Type.Optional(
        Type.Array(SignerSatInstructionV2Schema, { minItems: 1, maxItems: 6 }),
      ),
      addressLookupTables: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Union([
    Type.Object(
      {
        type: Type.Literal("solana.satKeeperAction"),
        authorityWalletId: Type.String({ minLength: 1 }),
        action: Type.String({ minLength: 1 }),
        programId: Type.String(),
        dataBase64: Type.String(),
        keys: Type.Array(SignerSatAccountV2Schema),
        context: Type.Optional(SignerSatContextV2Schema),
        addressLookupTables: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 1 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal("solana.satKeeperAction"),
        authorityWalletId: Type.String({ minLength: 1 }),
        action: Type.Literal("cleanupBatch"),
        instructions: Type.Array(SignerSatInstructionV2Schema, { minItems: 1, maxItems: 6 }),
      },
      { additionalProperties: false },
    ),
  ]),
  Type.Object(
    {
      type: Type.Literal("solana.satLookupTable"),
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("extend"),
        Type.Literal("deactivate"),
        Type.Literal("close"),
      ]),
      lookupTable: SignerSatLookupTableV2Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("solana.vaultBondAction"),
      cluster: Type.Union([
        Type.Literal("local"),
        Type.Literal("devnet"),
        Type.Literal("mainnet-beta"),
      ]),
      action: Type.String({ minLength: 1 }),
      programId: Type.String(),
      dataBase64: Type.String(),
      keys: Type.Array(SignerSatAccountV2Schema),
      context: Type.Optional(SignerSatContextV2Schema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("federation.bondChallenge"),
      federation: SignerFederationBondChallengeV2Schema,
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

const SignerRoleBaselineV1Schema = Type.Object(
  { version: Type.Literal(1), role: SignerWalletRoleSchema },
  { additionalProperties: false },
);

const SignerWalletPolicyCreateV2Schema = Type.Union([
  Type.Object(
    {
      expectedPolicyVersion: Type.Literal(0),
      policy: SignerPolicyInputV2Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      expectedPolicyVersion: Type.Literal(0),
      baseline: SignerRoleBaselineV1Schema,
    },
    { additionalProperties: false },
  ),
]);

const SignerOperationLookupV2Schema = Type.Object(
  { requestId: Type.String() },
  { additionalProperties: false },
);

const SignerSatLookupBindingRequestV2Schema = Type.Object(
  {
    cycleId: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
    pageIndex: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
  },
  { additionalProperties: false },
);

const SignerSatCommitmentClusterV1Schema = Type.Union([
  Type.Literal("local"),
  Type.Literal("devnet"),
  Type.Literal("mainnet-beta"),
]);

const SignerSatCommitmentProgramIdV1Schema = Type.String({
  pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$",
});

const SignerSatCommitmentProtocolGenerationV1Schema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

const SignerSatCommitmentAllocationV1Schema = Type.Union([
  Type.Array(Type.Integer({ minimum: 0, maximum: 0xffff_ffff }), {
    minItems: 16,
    maxItems: 16,
  }),
  Type.Array(Type.Integer({ minimum: 0, maximum: 0xffff_ffff }), {
    minItems: 25,
    maxItems: 25,
  }),
]);

const SignerSatCommitmentBindingRequestV1Schema = Type.Object(
  {
    cluster: SignerSatCommitmentClusterV1Schema,
    programId: SignerSatCommitmentProgramIdV1Schema,
    protocolGeneration: SignerSatCommitmentProtocolGenerationV1Schema,
    cycleId: Type.String({ pattern: "^[1-9][0-9]*$" }),
  },
  { additionalProperties: false },
);

const SignerSatCommitmentAllocateRequestV1Schema = Type.Object(
  {
    cluster: SignerSatCommitmentClusterV1Schema,
    programId: SignerSatCommitmentProgramIdV1Schema,
    protocolGeneration: SignerSatCommitmentProtocolGenerationV1Schema,
    cycleId: Type.String({ pattern: "^[1-9][0-9]*$" }),
    committedLamports: Type.String({ pattern: "^[1-9][0-9]*$" }),
    allocationFp: SignerSatCommitmentAllocationV1Schema,
  },
  { additionalProperties: false },
);

export const LocalSocketSignerSatLookupBindingV2Schema = Type.Object(
  {
    cycleId: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
    pageIndex: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
    address: Type.Optional(Type.String({ minLength: 1 })),
    bound: Type.Boolean(),
    mutationRequestId: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
    mutationState: Type.Optional(
      Type.Union([
        Type.Literal("reserved"),
        Type.Literal("broadcast"),
        Type.Literal("confirmed"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export type LocalSocketSignerSatLookupBindingV2 = Static<
  typeof LocalSocketSignerSatLookupBindingV2Schema
>;

export const LocalSocketSignerSatCommitmentBindingV1Schema = Type.Object(
  {
    reference: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    commitmentHex: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    cycleId: Type.String({ pattern: "^[1-9][0-9]*$" }),
    committedLamports: Type.String({ pattern: "^[1-9][0-9]*$" }),
    allocationCount: Type.Union([Type.Literal(16), Type.Literal(25)]),
    protocolGeneration: SignerSatCommitmentProtocolGenerationV1Schema,
  },
  { additionalProperties: false },
);

export type LocalSocketSignerSatCommitmentBindingV1 = Static<
  typeof LocalSocketSignerSatCommitmentBindingV1Schema
>;

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
      { op: Type.Literal("v2.keeperFeePayer.get"), walletId: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.keeperFeePayer.ensure"),
        walletId: Type.String({ minLength: 1 }),
        request: Type.Object({}, { additionalProperties: false }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.policy.activateBaseline"),
        walletId: Type.String(),
        request: Type.Object(
          {
            expectedPolicyVersion: Type.Integer({ minimum: 1 }),
            baseline: SignerRoleBaselineV1Schema,
          },
          { additionalProperties: false },
        ),
      },
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
        request: Type.Union([
          Type.Object(
            {
              expectedPolicyVersion: Type.Literal(0),
              policy: SignerPolicyInputV2Schema,
              path: Type.String(),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              expectedPolicyVersion: Type.Literal(0),
              baseline: SignerRoleBaselineV1Schema,
              path: Type.String(),
            },
            { additionalProperties: false },
          ),
        ]),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.wallet.importLegacy"),
        walletId: Type.String(),
        request: Type.Union([
          Type.Object(
            {
              expectedPolicyVersion: Type.Literal(0),
              policy: SignerPolicyInputV2Schema,
              path: Type.String(),
              passphrasePath: Type.String(),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              expectedPolicyVersion: Type.Literal(0),
              baseline: SignerRoleBaselineV1Schema,
              path: Type.String(),
              passphrasePath: Type.String(),
            },
            { additionalProperties: false },
          ),
        ]),
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
        op: Type.Literal("v2.satLookup.binding.get"),
        walletId: Type.String(),
        request: SignerSatLookupBindingRequestV2Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.satCommitment.allocate"),
        walletId: Type.String({ minLength: 1 }),
        request: SignerSatCommitmentAllocateRequestV1Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("v2.satCommitment.binding.get"),
        walletId: Type.String({ minLength: 1 }),
        request: SignerSatCommitmentBindingRequestV1Schema,
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
    satRelease: Type.Optional(LocalSocketSignerSatReleaseAcknowledgementSchema),
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
      Type.Literal("mining-reviewed-only"),
      Type.Literal("mining-typed-sat"),
      Type.Literal("vault-reviewed-only"),
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
  if (
    input.op === "v2.satCommitment.allocate" &&
    input.request.allocationFp.reduce((sum, value) => sum + value, 0) !== 1_000_000
  ) {
    throw new Error("invalid signer request: SAT commitment allocation must sum to 1000000");
  }
  if (
    (input.op === "v2.execute" || input.op === "v2.review.prepare") &&
    input.request.intent.type === "solana.satAction" &&
    input.request.intent.satCommitment !== undefined &&
    (input.request.intent.action !== "revealCycle" ||
      input.request.intent.instructions !== undefined)
  ) {
    if (
      input.request.intent.action !== "revealCycleV2" ||
      input.request.intent.instructions !== undefined
    ) {
      throw new Error(
        "invalid signer request: signer-owned SAT commitment references require one revealCycle generation",
      );
    }
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
    case "v2.policy.get":
    case "v2.policy.put":
    case "v2.policy.tighten":
    case "v2.policy.activateBaseline":
      return Value.Check(LocalSocketSignerPolicyV2Schema, result);
    case "v2.wallet.get":
    case "v2.wallet.reencrypt":
      return Value.Check(LocalSocketSignerWalletV2Schema, result);
    case "v2.wallet.readiness":
      return Value.Check(LocalSocketSignerWalletReadinessV2Schema, result);
    case "v2.keeperFeePayer.get":
    case "v2.keeperFeePayer.ensure":
      return Value.Check(LocalSocketSignerKeeperFeePayerCapabilityV2Schema, result);
    case "v2.wallet.create":
    case "v2.wallet.import":
    case "v2.wallet.importLegacy":
      return Value.Check(LocalSocketSignerWalletPolicyResultV2Schema, result);
    case "v2.execute":
    case "v2.operation.get":
    case "v2.operation.reconcile":
      return Value.Check(LocalSocketSignerOperationV2Schema, result);
    case "v2.satLookup.binding.get":
      return Value.Check(LocalSocketSignerSatLookupBindingV2Schema, result);
    case "v2.satCommitment.allocate":
    case "v2.satCommitment.binding.get":
      return Value.Check(LocalSocketSignerSatCommitmentBindingV1Schema, result);
    case "v2.review.get":
    case "v2.review.prepare":
      return Value.Check(LocalSocketSignerReviewV2Schema, result);
    case "v2.review.execute":
      return Value.Check(LocalSocketSignerReviewExecutionV2Schema, result);
    case "v2.review.authorization.begin":
      return Value.Check(LocalSocketSignerReviewAuthorizationBeginV2Schema, result);
    case "v2.review.authorization.finish":
      return Value.Check(LocalSocketSignerReviewAuthorizationFinishV2Schema, result);
    case "getAddresses":
      return Value.Check(LocalSocketSignerAddressMapSchema, result);
    case "getBalance":
      return Value.Check(LocalSocketSignerBalanceResultSchema, result);
  }
}
