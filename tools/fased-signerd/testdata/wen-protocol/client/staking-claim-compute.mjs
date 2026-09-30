// Claim instructions can exceed Solana's default 200,000 CU transaction limit.
// Keep the signed envelope and receipt verifier on the same explicit budget.
export const CLAIM_COMPUTE_LIMIT = 400_000;
export const claimComputeInstruction = () =>
  Object.freeze({
    programAddress: "ComputeBudget111111111111111111111111111111",
    accounts: [],
    data: Uint8Array.of(2, 0x80, 0x1a, 0x06, 0),
  });
