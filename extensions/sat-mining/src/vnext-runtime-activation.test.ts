import { describe, expect, it } from "vitest";
import { verifySatVNextRuntimeActivationRecords, type SatRpcAccountRecord } from "./rpc-read.js";

const MINING_PROGRAM = "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF"; // pragma: allowlist secret
const ECONOMICS_DIGEST_HEX = "ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c"; // pragma: allowlist secret

function protocolRecord(): NonNullable<SatRpcAccountRecord> {
  const data = Buffer.alloc(184);
  data[0] = 152;
  const body = data.subarray(8);
  body[0] = 1;
  body[1] = 1;
  body[3] = 0;
  Buffer.from("0100020002000300030003000300020002000200", "hex").copy(body, 4);
  Buffer.from(ECONOMICS_DIGEST_HEX, "hex").copy(body, 32);
  body.writeBigUInt64LE(5n, 104);
  return { owner: MINING_PROGRAM, data };
}

describe("SAT-DEP-0009 frozen deployment binding", () => {
  it("rejects an enabled or generation-mismatched protocol root before program checks", () => {
    const enabled = protocolRecord();
    enabled.data[11] = 1;
    expect(() => verifySatVNextRuntimeActivationRecords([enabled])).toThrow(
      "protocol-generation state does not match",
    );

    const staleGeneration = protocolRecord();
    staleGeneration.data.writeBigUInt64LE(4n, 112);
    expect(() => verifySatVNextRuntimeActivationRecords([staleGeneration])).toThrow(
      "protocol-generation state does not match",
    );
  });

  it("accepts the exact frozen protocol fields and then fails closed on absent ProgramData", () => {
    expect(() => verifySatVNextRuntimeActivationRecords([protocolRecord()])).toThrow(
      "mining program binding does not match SAT-DEP-0009",
    );
  });
});
