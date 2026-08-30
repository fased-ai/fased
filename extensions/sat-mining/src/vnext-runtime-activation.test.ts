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
  Buffer.from("0100020002000300030003000300020002000200", "hex").copy(body, 4);
  Buffer.from(ECONOMICS_DIGEST_HEX, "hex").copy(body, 32);
  body[3] = 1;
  body.writeBigUInt64LE(12n, 104);
  return { owner: MINING_PROGRAM, data };
}

describe("SAT-DEP-0012 activation-descendant deployment binding", () => {
  it("rejects stale or impossible pause/resume descendants before program checks", () => {
    const staleGeneration = protocolRecord();
    staleGeneration.data.writeBigUInt64LE(10n, 112);
    expect(() => verifySatVNextRuntimeActivationRecords([staleGeneration])).toThrow(
      "protocol-generation state does not match",
    );

    const disabledWithoutGenerationAdvance = protocolRecord();
    disabledWithoutGenerationAdvance.data[11] = 0;
    expect(() =>
      verifySatVNextRuntimeActivationRecords([disabledWithoutGenerationAdvance]),
    ).toThrow("protocol-generation state does not match");

    const enabledAtOddGeneration = protocolRecord();
    enabledAtOddGeneration.data.writeBigUInt64LE(13n, 112);
    expect(() => verifySatVNextRuntimeActivationRecords([enabledAtOddGeneration])).toThrow(
      "protocol-generation state does not match",
    );
  });

  it.each([
    { generation: 12n, enabled: 1 },
    { generation: 13n, enabled: 0 },
    { generation: 14n, enabled: 1 },
    { generation: 15n, enabled: 0 },
  ])(
    "accepts valid generation $generation enabled=$enabled descendants before ProgramData checks",
    ({ generation, enabled }) => {
      const descendant = protocolRecord();
      descendant.data[11] = enabled;
      descendant.data.writeBigUInt64LE(generation, 112);
      expect(() => verifySatVNextRuntimeActivationRecords([descendant])).toThrow(
        "mining program binding does not match SAT-DEP-0012",
      );
    },
  );

  it("returns the current operational entry state after immutable bindings pass", () => {
    const protocol = protocolRecord();
    protocol.data[11] = 0;
    protocol.data.writeBigUInt64LE(15n, 112);
    expect(() => verifySatVNextRuntimeActivationRecords([protocol])).toThrow(
      "mining program binding does not match SAT-DEP-0012",
    );
  });
});
