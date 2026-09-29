import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";

const address = Type.String();
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const schema = Type.Object(
  {
    operation: Type.Union([Type.Literal("stop"), Type.Literal("top-up"), Type.Literal("withdraw")]),
    genesis: address,
    programId: address,
    economy: address,
    owner: address,
    position: address,
    programSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    amountLamports: uint,
    maxFeeLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
type Candidate = Static<typeof schema>;

// Source review only. No signer protocol mapping, wallet access or arbitrary wire.
// Chain readers must still derive the PDA and verify balances before execution.
export function reviewWenCampaignAction(input: unknown) {
  if (!Value.Check(schema, input)) {
    throw new Error("Invalid campaign review schema");
  }
  const candidate: Candidate = { ...input };
  for (const name of ["genesis", "programId", "economy", "owner", "position"] as const) {
    if (
      !isValidSolanaAddress(candidate[name]) ||
      candidate[name] === "11111111111111111111111111111111"
    ) {
      throw new Error("Invalid campaign review identity");
    }
  }
  const amount = BigInt(candidate.amountLamports);
  const fee = BigInt(candidate.maxFeeLamports);
  const start = BigInt(candidate.minFinalizedSlot);
  const end = BigInt(candidate.expiresSlot);
  if (
    [amount, fee, start, end].some((n) => n > (1n << 64n) - 1n) ||
    fee === 0n ||
    start === 0n ||
    end <= start ||
    end - start > 32n ||
    (candidate.operation === "stop" ? amount !== 0n : amount === 0n)
  ) {
    throw new Error("Invalid campaign review bounds");
  }
  return Object.freeze({
    scope: "wen-campaign-source-review" as const,
    candidate: Object.freeze(candidate),
    opcode: candidate.operation === "stop" ? 139 : candidate.operation === "top-up" ? 143 : 138,
    signingEnabled: false as const,
    deploymentVerified: false as const,
    positionVerified: false as const,
  });
}
