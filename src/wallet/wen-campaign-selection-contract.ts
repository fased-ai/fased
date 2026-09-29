import { z } from "zod";
const text = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .transform(BigInt)
  .refine((v) => v <= 18446744073709551615n);
export const campaignExpectedSchema = z
  .object({
    requestId: text,
    walletId: text,
    walletPublicKey: text,
    policyHash: text,
    program: text,
    economy: text,
    position: text,
    operation: z.enum(["stop", "top-up", "withdraw", "setup", "policy", "claim", "claim-stake"]),
    claimStake: z
      .object({
        destination: text,
        pool: text,
        stakingPosition: text,
        mint: text,
        pageIndex: uint,
        mask: uint,
        minimumNet: uint,
        maxTotal: uint,
        descriptorSha256: hash,
        capabilitySha256: hash,
        day: uint,
        last: uint,
        aggregateFrom: uint,
      })
      .strict()
      .optional(),
    claim: z
      .object({ destination: text, pageIndex: uint, mask: uint, minNet: uint })
      .strict()
      .optional(),
    policy: z
      .object({
        window: text,
        maxPrice: uint,
        daily: uint,
        total: uint,
        expiry: uint,
        maxWait: uint,
        enabled: uint,
      })
      .strict()
      .optional(),
    setup: z
      .object({
        issuer: text,
        nonce: uint,
        deposit: uint,
        maxPrice: uint,
        daily: uint,
        total: uint,
        expiry: uint,
        maxWait: uint,
        maxRent: uint,
      })
      .strict()
      .optional(),
    amount: uint,
    maxFee: uint,
    genesis: text,
    codeSha256: hash,
    deploymentSlot: uint,
    upgradeAuthority: text.nullable(),
  })
  .strict();
export const campaignSelectionSchema = z
  .object({ expected: campaignExpectedSchema, draftSha256: hash, artifactDigest: hash })
  .strict();
