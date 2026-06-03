import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const WalletChainSchema = Type.Literal("solana");

const TxRequestSchema = Type.Object(
  {
    chain: WalletChainSchema,
    walletId: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    amount: Type.Optional(Type.String()),
    contract: Type.Optional(Type.String()),
    program: Type.Optional(Type.String()),
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
      return Value.Check(LocalSocketSignerHealthResultSchema, result);
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
    case "custodyStatus":
      return Value.Check(LocalSocketSignerCustodyStatusResultSchema, result);
    case "unlockCustody":
      return Value.Check(LocalSocketSignerCustodyStatusResultSchema, result);
    case "lockCustody":
      return Value.Check(LocalSocketSignerCustodyLockResultSchema, result);
  }
}
