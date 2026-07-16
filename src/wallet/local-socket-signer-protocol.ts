import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const WalletChainSchema = Type.Literal("solana");

const SignerWalletRoleSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("mining"),
  Type.Literal("vault"),
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
    intentTypes: Type.Array(Type.String()),
    operationStates: Type.Array(Type.String()),
    features: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const SignerPolicyAssetV2Schema = Type.Object(
  {
    asset: Type.String(),
    destinations: Type.Array(Type.String()),
    maxPerTx: Type.String(),
    maxDaily: Type.String(),
  },
  { additionalProperties: false },
);

const SignerPolicyInputV2Schema = Type.Object(
  {
    walletId: Type.Optional(Type.String()),
    role: SignerWalletRoleSchema,
    version: Type.Optional(Type.Integer({ minimum: 0 })),
    operations: Type.Array(Type.String()),
    programs: Type.Array(Type.String()),
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
    operations: Type.Array(Type.String()),
    programs: Type.Array(Type.String()),
    assets: Type.Array(SignerPolicyAssetV2Schema),
    hash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

const SignerIntentV2Schema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("solana.nativeTransfer"),
      destination: Type.String(),
      lamports: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("solana.splTransferChecked"),
      destination: Type.String(),
      tokenProgram: Type.String(),
      mint: Type.String(),
      amount: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

const SignerWalletPolicyCreateV2Schema = Type.Object(
  {
    expectedPolicyVersion: Type.Literal(0),
    policy: SignerPolicyInputV2Schema,
  },
  { additionalProperties: false },
);

const SignerOperationLookupV2Schema = Type.Object(
  { requestId: Type.String() },
  { additionalProperties: false },
);

const TxRequestSchema = Type.Object(
  {
    chain: WalletChainSchema,
    walletId: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    amount: Type.Optional(Type.String()),
    contract: Type.Optional(Type.String()),
    program: Type.Optional(Type.String()),
    tokenMint: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    destination: Type.Optional(Type.String()),
    allowSplInstructions: Type.Optional(Type.Array(Type.String())),
    memo: Type.Optional(Type.String()),
    serializedTxBase64: Type.Optional(Type.String()),
    preparedId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const SolanaInstructionAccountSchema = Type.Object(
  {
    pubkey: Type.String(),
    isSigner: Type.Boolean(),
    isWritable: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SolanaInstructionRequestSchema = Type.Object(
  {
    walletId: Type.Optional(Type.String()),
    programId: Type.String(),
    dataBase64: Type.String(),
    keys: Type.Array(SolanaInstructionAccountSchema),
  },
  { additionalProperties: false },
);

const SolanaInstructionsRequestSchema = Type.Object(
  {
    walletId: Type.Optional(Type.String()),
    purpose: Type.Literal("sat-cleanup"),
    instructions: Type.Array(SolanaInstructionRequestSchema, { minItems: 1, maxItems: 6 }),
  },
  { additionalProperties: false },
);

const LocalSocketSignerCustodyUnlockRequestSchema = Type.Object(
  {
    sessionId: Type.String(),
    host: Type.String(),
    walletId: Type.String(),
    role: Type.Optional(
      Type.Union([Type.Literal("mining"), Type.Literal("agent"), Type.Literal("vault")]),
    ),
    chains: Type.Optional(Type.Array(WalletChainSchema)),
    allowPrograms: Type.Optional(Type.Array(Type.String())),
    expiresAt: Type.String(),
    passphrase: Type.String(),
    solanaMaxPerTx: Type.Optional(Type.String()),
    solanaMaxDaily: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const LocalSocketSignerCustodyLockRequestSchema = Type.Object(
  {
    sessionId: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    walletId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerRequestSchema = Type.Union(
  [
    Type.Object({ op: Type.Literal("health") }, { additionalProperties: false }),
    Type.Object({ op: Type.Literal("v2.capabilities") }, { additionalProperties: false }),
    Type.Object(
      { op: Type.Literal("v2.policy.get"), walletId: Type.String() },
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
      { op: Type.Literal("v2.wallet.get"), walletId: Type.String() },
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
        op: Type.Union([Type.Literal("v2.operation.get"), Type.Literal("v2.operation.reconcile")]),
        walletId: Type.String(),
        request: SignerOperationLookupV2Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("getAddresses"), walletId: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("getBalance"),
        chain: WalletChainSchema,
        walletId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("prepareTx"), request: TxRequestSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("sendTx"), request: TxRequestSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("signTx"), request: TxRequestSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("sendSolanaInstruction"), request: SolanaInstructionRequestSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("sendSolanaInstructions"), request: SolanaInstructionsRequestSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("custodyStatus"), walletId: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("unlockCustody"), request: LocalSocketSignerCustodyUnlockRequestSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("lockCustody"), request: LocalSocketSignerCustodyLockRequestSchema },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);

export type LocalSocketSignerRequest = Static<typeof LocalSocketSignerRequestSchema>;

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
    ok: Type.Boolean(),
    chain: WalletChainSchema,
    address: Type.String(),
    balance: Type.String(),
    unit: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerPrepareResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    chain: WalletChainSchema,
    preparedId: Type.String(),
    signer: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerSendResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    chain: WalletChainSchema,
    txHash: Type.String(),
    signer: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerSignResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    chain: WalletChainSchema,
    signedTxBase64: Type.String(),
    signer: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerSendSolanaInstructionResultSchema = LocalSocketSignerSendResultSchema;
export const LocalSocketSignerSendSolanaInstructionsResultSchema =
  LocalSocketSignerSendResultSchema;

export const LocalSocketSignerCustodyStatusResultSchema = Type.Object(
  {
    active: Type.Boolean(),
    sessionId: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.String()),
    walletId: Type.Optional(Type.String()),
    role: Type.Optional(
      Type.Union([Type.Literal("mining"), Type.Literal("agent"), Type.Literal("vault")]),
    ),
    chains: Type.Optional(Type.Array(WalletChainSchema)),
    allowPrograms: Type.Optional(Type.Array(Type.String())),
    solanaMaxPerTx: Type.Optional(Type.String()),
    solanaMaxDaily: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LocalSocketSignerCustodyLockResultSchema = Type.Object(
  {
    active: Type.Boolean(),
    removed: Type.Boolean(),
  },
  { additionalProperties: false },
);

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

export function parseLocalSocketSignerRequest(input: unknown): LocalSocketSignerRequest {
  if (!Value.Check(LocalSocketSignerRequestSchema, input)) {
    throw new Error("invalid signer request");
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
    case "v2.policy.get":
    case "v2.policy.put":
      return Value.Check(LocalSocketSignerPolicyV2Schema, result);
    case "v2.wallet.get":
    case "v2.wallet.reencrypt":
      return Value.Check(LocalSocketSignerWalletV2Schema, result);
    case "v2.wallet.create":
    case "v2.wallet.import":
    case "v2.wallet.importLegacy":
      return Value.Check(LocalSocketSignerWalletPolicyResultV2Schema, result);
    case "v2.execute":
    case "v2.operation.get":
    case "v2.operation.reconcile":
      return Value.Check(LocalSocketSignerOperationV2Schema, result);
    case "getAddresses":
      return Value.Check(LocalSocketSignerAddressMapSchema, result);
    case "getBalance":
      return Value.Check(LocalSocketSignerBalanceResultSchema, result);
    case "prepareTx":
      return Value.Check(LocalSocketSignerPrepareResultSchema, result);
    case "sendTx":
      return Value.Check(LocalSocketSignerSendResultSchema, result);
    case "signTx":
      return Value.Check(LocalSocketSignerSignResultSchema, result);
    case "sendSolanaInstruction":
      return Value.Check(LocalSocketSignerSendSolanaInstructionResultSchema, result);
    case "sendSolanaInstructions":
      return Value.Check(LocalSocketSignerSendSolanaInstructionsResultSchema, result);
    case "custodyStatus":
      return Value.Check(LocalSocketSignerCustodyStatusResultSchema, result);
    case "unlockCustody":
      return Value.Check(LocalSocketSignerCustodyStatusResultSchema, result);
    case "lockCustody":
      return Value.Check(LocalSocketSignerCustodyLockResultSchema, result);
  }
}
