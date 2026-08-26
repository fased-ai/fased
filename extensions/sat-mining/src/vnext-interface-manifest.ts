// Generated from the exact SAT generation-2 interface bundle; do not edit.

export const SAT_VNEXT_INTERFACE = {
  state: "FROZEN_NOT_ACTIVE",
  active: false,
  schemaGeneration: 2,
  signerCapabilityGeneration: 2,
  strategyChannels: 16,
  legacyStrategyChannels: 25,
  revealDiscriminator: 114,
  revealDataLength: 105,
  revealAccountShape: "SW,-W,-W,-W,-W,-W,-W,-W,-W,--",
  contractSha256: "35b5026b4e907686fb32e1847870d2907686169f6c95dc5ea782fe398fbc445c",
  idlSha256: "2016465b305dd15fb01a42299e20ebc7dc08d5d3005c8a50524593e7b464892b",
  accountOrderSha256: "a158dc63b30dc6f5c0ae1057a3f33d9f71c5fd18914a777ff1dd1d16fa94858c",
  stateLayoutsSha256: "bcf2fab02b64eeba1be9b67d0e4747153923e5750235878cad2dfbfe63d53b28",
  signerCodecsSha256: "4deadf1f1173803f94787f906398c8dec437be854874e26982aaa9a957319148",
} as const;

export function encodeSatVNextRevealData(params: {
  cycleId: bigint;
  nonce: Buffer;
  allocationFp: readonly number[];
}): Buffer {
  if (params.nonce.length !== 32) throw new Error("SAT vNext reveal nonce must contain 32 bytes");
  if (params.allocationFp.length !== SAT_VNEXT_INTERFACE.strategyChannels) {
    throw new Error("SAT vNext reveal must contain exactly 16 strategy channels");
  }
  const data = Buffer.alloc(SAT_VNEXT_INTERFACE.revealDataLength);
  data[0] = SAT_VNEXT_INTERFACE.revealDiscriminator;
  data.writeBigUInt64LE(params.cycleId, 1);
  params.nonce.copy(data, 9);
  params.allocationFp.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`SAT vNext allocation[${index}] is not a u32`);
    }
    data.writeUInt32LE(value, 41 + index * 4);
  });
  return data;
}
