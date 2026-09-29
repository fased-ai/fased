import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { VersionedMessage } from "@solana/web3.js";
import type { WenBtcIntentCandidate } from "./wen-btc-intent.js";
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const WenBtcPreparationSchema = Type.Object(
  {
    status: Type.Literal("requires-signing-revalidation"),
    operation: Type.Union([Type.Literal("acceptance"), Type.Literal("acquisition")]),
    descriptorSha256: digest,
    offerSha256: digest,
    signingEnabled: Type.Literal(false),
    messageBase64: Type.String({ minLength: 1, maxLength: 1556 }),
    blockhash: Type.String(),
    minimumSlot: uint,
    currentHeight: uint,
    lastValidHeight: uint,
    simulationSlot: uint,
    computeUnits: uint,
    networkFeeLamports: uint,
    rentLamports: uint,
    refundableRentLamports: uint,
    totalCostLamports: uint,
  },
  { additionalProperties: false },
);
export type WenBtcPreparation = Static<typeof WenBtcPreparationSchema>;
export function isWenBtcPreparation(value: unknown): value is WenBtcPreparation {
  if (!Value.Check(WenBtcPreparationSchema, value)) {
    return false;
  }
  const max = (1n << 64n) - 1n;
  if (
    [
      value.minimumSlot,
      value.currentHeight,
      value.lastValidHeight,
      value.simulationSlot,
      value.computeUnits,
      value.networkFeeLamports,
      value.rentLamports,
      value.refundableRentLamports,
      value.totalCostLamports,
    ].some((n) => BigInt(n) > max) ||
    BigInt(value.minimumSlot) === 0n ||
    BigInt(value.simulationSlot) < BigInt(value.minimumSlot) ||
    BigInt(value.totalCostLamports) !==
      BigInt(value.networkFeeLamports) + BigInt(value.rentLamports) ||
    BigInt(value.refundableRentLamports) !==
      (value.operation === "acquisition" ? BigInt(value.rentLamports) : 0n) ||
    BigInt(value.currentHeight) >= BigInt(value.lastValidHeight)
  ) {
    return false;
  }
  try {
    const raw = Buffer.from(value.messageBase64, "base64");
    if (raw.length + 65 > 1232 || raw.toString("base64") !== value.messageBase64) {
      return false;
    }
    const m = VersionedMessage.deserialize(raw);
    if (
      m.version !== 0 ||
      !Buffer.from(m.serialize()).equals(raw) ||
      m.header.numRequiredSignatures !== 1 ||
      m.header.numReadonlySignedAccounts !== 0 ||
      m.recentBlockhash !== value.blockhash ||
      value.blockhash === "11111111111111111111111111111111" ||
      m.compiledInstructions.length !== 2 ||
      m.addressTableLookups.length < 1 ||
      m.addressTableLookups.length > 4
    ) {
      return false;
    }
    const [budget, wen] = m.compiledInstructions;
    if (
      m.staticAccountKeys[budget.programIdIndex]?.toBase58() !==
        "ComputeBudget111111111111111111111111111111" ||
      budget.accountKeyIndexes.length !== 0 ||
      budget.data.length !== 5 ||
      budget.data[0] !== 2
    ) {
      return false;
    }
    const units = Buffer.from(budget.data).readUInt32LE(1);
    return (
      BigInt(value.computeUnits) <= BigInt(units) &&
      units > 0 &&
      units <= 1400000 &&
      wen.programIdIndex < m.staticAccountKeys.length &&
      wen.data[0] === (value.operation === "acceptance" ? 111 : 112) &&
      wen.data.length >= 465 &&
      Buffer.from(wen.data.subarray(1, 9)).toString("ascii") === "WENBTCO1" &&
      createHash("sha256").update(wen.data.subarray(1, 465)).digest("hex") === value.offerSha256
    );
  } catch {
    return false;
  }
}
export function bindWenBtcPreparation(
  value: unknown,
  intent: WenBtcIntentCandidate,
): WenBtcPreparation {
  if (
    !isWenBtcPreparation(value) ||
    value.operation !== intent.operation ||
    value.descriptorSha256 !== intent.descriptorSha256 ||
    value.offerSha256 !== intent.offerSha256 ||
    BigInt(value.minimumSlot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(value.simulationSlot) >= BigInt(intent.expiresSlot) ||
    BigInt(value.networkFeeLamports) > BigInt(intent.maxFeeLamports) ||
    BigInt(value.rentLamports) > BigInt(intent.maxRentLamports)
  ) {
    throw new Error("WEN BTC preparation differs from requested review");
  }
  const message = VersionedMessage.deserialize(Buffer.from(value.messageBase64, "base64"));
  if (
    message.staticAccountKeys[message.compiledInstructions[1].programIdIndex]?.toBase58() !==
    intent.programId
  ) {
    throw new Error("WEN BTC preparation program differs from review");
  }
  return value;
}
