import { describe, expect, it } from "vitest";
import { buildWalletActionsGrant } from "./skills-wallet-grant.js";

describe("buildWalletActionsGrant", () => {
  it("grants generic skill wallet access only to the agent wallet role", () => {
    expect(
      buildWalletActionsGrant({
        actions: ["quote"],
        walletId: ["agent-1"],
        chain: ["solana"],
      }),
    ).toMatchObject({
      actions: ["quote"],
      roles: ["agent"],
      walletIds: ["agent-1"],
      chains: ["solana"],
    });
  });

  it("requires explicit agent wallet ids for skill wallet grants", () => {
    expect(() =>
      buildWalletActionsGrant({
        actions: ["quote"],
        chain: ["solana"],
      }),
    ).toThrow("at least one Agent wallet id is required");
  });

  it("rejects mining wallet role grants for generic skills", () => {
    expect(() =>
      buildWalletActionsGrant({
        actions: ["quote"],
        walletId: ["agent-1"],
        role: "mining",
        chain: ["solana"],
      }),
    ).toThrow("wallet skills can only be granted role=agent");
  });
});
