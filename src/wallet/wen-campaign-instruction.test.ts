import { PublicKey } from "@solana/web3.js";
import { describe, it, expect } from "vitest";
import { buildWenCampaignOwnerInstruction as build } from "./wen-campaign-instruction.js";
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const program = key(2),
  economy = key(3),
  owner = key(4),
  issuer = key(6);
const [mint] = PublicKey.findProgramAddressSync(
  [Buffer.from("wen-sat-mint-v1"), economy.toBuffer()],
  program,
);
const [position] = PublicKey.findProgramAddressSync(
  [Buffer.from("wen-retail-position-v2"), owner.toBuffer(), mint.toBuffer()],
  program,
);
const data = Buffer.alloc(256);
data.write("WENRPOS2");
data[8] = 1;
owner.toBuffer().copy(data, 16);
issuer.toBuffer().copy(data, 48);
mint.toBuffer().copy(data, 80);
const snapshot = {
  address: position.toBase58(),
  accountOwner: program.toBase58(),
  executable: false,
  data,
  lamports: 1100n,
  rentLamports: 100n,
};
const input = {
  operation: "stop",
  genesis: key(1).toBase58(),
  programId: program.toBase58(),
  economy: economy.toBase58(),
  owner: owner.toBase58(),
  position: position.toBase58(),
  programSha256: "ab".repeat(32),
  amountLamports: "0",
  maxFeeLamports: "5000",
  minFinalizedSlot: "10",
  expiresSlot: "20",
};
describe("campaign canonical owner instructions", () => {
  it.each([
    ["stop", "0", 139],
    ["top-up", "1000", 143],
    ["withdraw", "1000", 138],
  ])("matches SAT portable builder for %s", async (operation, amountLamports, op) => {
    const sdk = await import(
      new URL("../../../wen/node_modules/@solana/kit/dist/index.node.mjs", import.meta.url).href
    );
    const portable = await import(
      new URL(
        "../../../token/sat/wen-genesis/client/campaign-owner-instruction.mjs",
        import.meta.url,
      ).href
    );
    const hex = (k: PublicKey) => k.toBuffer().toString("hex");
    const expected = await portable.buildCampaignOwnerInstruction(sdk, {
      program: hex(program),
      owner: hex(owner),
      issuer: hex(issuer),
      mint: hex(mint),
      op,
      positionRent: 100n,
      position: {
        address: hex(position),
        owner: hex(program),
        executable: false,
        data: Array.from(data),
        lamports: 1100n,
      },
      ...(op === 139 ? {} : { amount: BigInt(amountLamports) }),
    });
    const result = build({ ...input, operation, amountLamports }, snapshot);
    expect(Array.from(result.instruction.data)).toEqual(Array.from(expected.instruction.data));
    expect(
      result.instruction.keys.map((k) => ({
        address: k.pubkey.toBase58(),
        role: (k.isSigner ? 2 : 0) + (k.isWritable ? 1 : 0),
      })),
    ).toEqual(expected.instruction.accounts);
    expect(result.rpcAuthenticated).toBe(false);
    expect(result.signingEnabled).toBe(false);
  });
  it("rejects wrong PDA, foreign owner, overspending and retained legacy position", () => {
    for (const change of [
      { address: key(8).toBase58() },
      { accountOwner: key(8).toBase58() },
      { executable: true },
      { rentLamports: 1200n },
    ]) {
      expect(() => build(input, { ...snapshot, ...change })).toThrow();
    }
    expect(() =>
      build({ ...input, operation: "withdraw", amountLamports: "1001" }, snapshot),
    ).toThrow();
    const bad = Buffer.from(data);
    bad[184] = 1;
    expect(() => build(input, { ...snapshot, data: bad })).toThrow();
  });
});
