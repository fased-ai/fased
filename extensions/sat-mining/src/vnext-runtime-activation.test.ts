import { describe, expect, it } from "vitest";
import { verifySatVNextRuntimeActivationRecords, type SatRpcAccountRecord } from "./rpc-read.js";

const MINING_PROGRAM = "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF";

function protocolRecord(): NonNullable<SatRpcAccountRecord> {
  const data = Buffer.alloc(184);
  data[0] = 152;
  const body = data.subarray(8);
  body[0] = 1;
  body[1] = 1;
  body[3] = 1;
  Buffer.from("0100020002000300030003000300020002000200", "hex").copy(body, 4);
  Buffer.from("ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c", "hex").copy(
    body,
    32,
  );
  body.writeBigUInt64LE(2n, 104);
  return { owner: MINING_PROGRAM, data };
}

describe("SAT-DEP-0006 runtime activation binding", () => {
  it("rejects a disabled or generation-mismatched protocol root before program checks", () => {
    const protocol = protocolRecord();
    protocol.data[11] = 0;
    expect(() => verifySatVNextRuntimeActivationRecords([protocol])).toThrow(
      "protocol-generation state does not match",
    );
  });

  it("accepts the exact active protocol fields and then fails closed on absent ProgramData", () => {
    expect(() => verifySatVNextRuntimeActivationRecords([protocolRecord()])).toThrow(
      "mining program binding does not match SAT-DEP-0006",
    );
  });
});
