import { describe, expect, it } from "vitest";
import { decodeSatMinerCapital } from "./rpc-read.js";

describe("SAT miner capital generation decoding", () => {
  it("preserves the account generation byte instead of reinterpreting its layout", () => {
    const buffer = Buffer.alloc(8 + 112);
    buffer[0] = 138;
    const body = buffer.subarray(8);
    body[0] = 1;
    body.writeBigUInt64LE(500_000_000n, 40);
    body.writeBigUInt64LE(250_000_000n, 48);
    body.writeBigUInt64LE(250_000_000n, 56);

    expect(decodeSatMinerCapital(buffer, "miner-capital-address")).toMatchObject({
      address: "miner-capital-address",
      version: 1,
      authority: expect.any(String),
      fundedLamports: "500000000",
      lockedLamports: "250000000",
      freeLamports: "250000000",
      activeCommitLamports: "250000000",
    });
  });
});
