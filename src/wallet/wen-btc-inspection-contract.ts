import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";

const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const WenBtcInspectionSchema = Type.Object(
  {
    status: Type.Literal("requires-transaction-verification"),
    operation: Type.Union([Type.Literal("acceptance"), Type.Literal("acquisition")]),
    descriptorSha256: digest,
    offerSha256: digest,
    signingEnabled: Type.Literal(false),
    readback: Type.Object(
      {
        slot: uint,
        referenceSlot: uint,
        now: uint,
        dataBase64: Type.String({ minLength: 1, maxLength: 1024 }),
        accounts: Type.Array(
          Type.Object(
            {
              pubkey: Type.String(),
              isSigner: Type.Boolean(),
              isWritable: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
          { minItems: 23, maxItems: 73 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type WenBtcInspection = Static<typeof WenBtcInspectionSchema>;

export function isWenBtcInspection(value: unknown): value is WenBtcInspection {
  if (!Value.Check(WenBtcInspectionSchema, value)) {
    return false;
  }
  const r = value.readback;
  const maximum = (1n << 64n) - 1n;
  if (
    [r.slot, r.referenceSlot, r.now].some((n) => BigInt(n) > maximum) ||
    BigInt(r.slot) === 0n ||
    BigInt(r.referenceSlot) < BigInt(r.slot) ||
    BigInt(r.now) > (1n << 63n) - 1n
  ) {
    return false;
  }
  const data = Buffer.from(r.dataBase64, "base64");
  if (
    data.toString("base64") !== r.dataBase64 ||
    data.subarray(1, 9).toString("ascii") !== "WENBTCO1" ||
    r.accounts.some((a, i) => !isValidSolanaAddress(a.pubkey) || a.isSigner !== (i === 0)) ||
    !r.accounts[0].isWritable
  ) {
    return false;
  }
  if (value.operation === "acceptance") {
    return data[0] === 111 && data.length === 569 && r.accounts.length === 27;
  }
  const count = data[465];
  if (data[0] !== 112 || count < 14 || count > 64 || r.accounts.length !== count + 9) {
    return false;
  }
  const routeLength = data.length - 466 - count;
  return (
    [36, 40, 44].includes(routeLength) && data.subarray(466, 466 + count).every((flag) => flag <= 3)
  );
}
