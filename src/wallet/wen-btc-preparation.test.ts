import { readFileSync } from "node:fs";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect, it } from "vitest";
import { parseLocalSocketSignerRequest } from "./local-socket-signer-protocol.js";
import type { WenBtcInspection } from "./wen-btc-inspection-contract.js";
import type { WenBtcIntentCandidate } from "./wen-btc-intent.js";
import {
  bindWenBtcPreparation,
  isWenBtcPreparation,
  type WenBtcPreparation,
} from "./wen-btc-preparation-contract.js";
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-btc-inspection-wire.json", import.meta.url),
    "utf8",
  ),
) as Array<{ intent: WenBtcIntentCandidate; result: WenBtcInspection }>;
function fixture(index = 0) {
  const { intent, result } = fixtures[index];
  const keys = result.readback.accounts.map((a) => ({ ...a, pubkey: new PublicKey(a.pubkey) }));
  const addresses = [
    ...new Map(keys.slice(1).map((k) => [k.pubkey.toBase58(), k.pubkey])).values(),
  ];
  const blockhash = new PublicKey(
    Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)),
  ).toBase58();
  const lookup = new AddressLookupTableAccount({
    key: new PublicKey(new Uint8Array(32).fill(99)),
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 149,
      lastExtendedSlotStartIndex: 0,
      addresses,
    },
  });
  const message = MessageV0.compile({
    payerKey: keys[0].pubkey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
      new TransactionInstruction({
        programId: new PublicKey(intent.programId),
        keys,
        data: Buffer.from(result.readback.dataBase64, "base64"),
      }),
    ],
    addressLookupTableAccounts: [lookup],
  });
  const prepared: WenBtcPreparation = {
    status: "requires-signing-revalidation",
    operation: intent.operation,
    descriptorSha256: intent.descriptorSha256,
    offerSha256: intent.offerSha256,
    signingEnabled: false,
    messageBase64: Buffer.from(message.serialize()).toString("base64"),
    blockhash,
    minimumSlot: "150",
    currentHeight: "10",
    lastValidHeight: "20",
    simulationSlot: "155",
    computeUnits: "100000",
    networkFeeLamports: "5000",
    rentLamports: "200",
    refundableRentLamports: intent.operation === "acquisition" ? "200" : "0",
    totalCostLamports: "5200",
  };
  return { intent, prepared };
}
it.each([0, 1])("accepts and binds preparation %i", (index) => {
  const { intent, prepared } = fixture(index);
  expect(bindWenBtcPreparation(prepared, intent)).toEqual(prepared);
  expect(
    parseLocalSocketSignerRequest({ op: "v2.wenBtc.prepare", walletId: "buyer", request: intent }),
  ).toBeTruthy();
});
it.each([
  "total",
  "refund",
  "compute",
  "simulation-slot",
  "cost-overflow",
  "enabled",
  "status",
  "numeric-height",
  "overflow",
  "expired",
  "extra-field",
  "malformed-message",
  "message-trailing",
  "blockhash",
  "offer",
])("rejects preparation %s", (name) => {
  const { prepared: p } = fixture();
  switch (name) {
    case "total":
      p.totalCostLamports = "1";
      break;
    case "refund":
      p.refundableRentLamports = "200";
      break;
    case "compute":
      p.computeUnits = "200001";
      break;
    case "simulation-slot":
      p.simulationSlot = "149";
      break;
    case "cost-overflow":
      p.rentLamports = "18446744073709551616";
      break;
    case "enabled":
      Object.assign(p, { signingEnabled: true });
      break;
    case "status":
      Object.assign(p, { status: "ready" });
      break;
    case "numeric-height":
      Object.assign(p, { currentHeight: 10 });
      break;
    case "overflow":
      p.currentHeight = "18446744073709551616";
      break;
    case "expired":
      p.currentHeight = "20";
      break;
    case "extra-field":
      Object.assign(p, { signature: "fake" });
      break;
    case "malformed-message":
      p.messageBase64 = "AA==";
      break;
    case "message-trailing":
      p.messageBase64 = Buffer.concat([
        Buffer.from(p.messageBase64, "base64"),
        Buffer.from([0]),
      ]).toString("base64");
      break;
    case "blockhash":
      p.blockhash = p.offerSha256;
      break;
    case "offer":
      p.offerSha256 = "1".repeat(64);
      break;
  }
  expect(isWenBtcPreparation(p)).toBe(false);
});
it.each(["descriptor", "operation", "slot", "expiry", "program"])(
  "rejects request mismatch %s",
  (name) => {
    const { intent, prepared } = fixture();
    const changed = { ...intent };
    switch (name) {
      case "descriptor":
        changed.descriptorSha256 = "1".repeat(64);
        break;
      case "operation":
        changed.operation = "acquisition";
        break;
      case "slot":
        changed.minFinalizedSlot = "151";
        break;
      case "expiry":
        changed.expiresSlot = "150";
        break;
      case "program":
        changed.programId = changed.sourceAccount;
        break;
    }
    expect(() => bindWenBtcPreparation(prepared, changed)).toThrow();
  },
);

it.each(["fee", "rent", "simulation-expiry"])("rejects simulation budget %s", (name) => {
  const { intent, prepared } = fixture();
  if (name === "fee") {
    intent.maxFeeLamports = "4999";
  }
  if (name === "rent") {
    intent.maxRentLamports = "199";
  }
  if (name === "simulation-expiry") {
    prepared.simulationSlot = intent.expiresSlot;
  }
  expect(() => bindWenBtcPreparation(prepared, intent)).toThrow();
});
