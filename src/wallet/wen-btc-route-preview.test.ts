import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";
import type { WenBtcIntentCandidate } from "./wen-btc-intent.js";
import {
  bindWenBtcRoutePreview,
  isWenBtcRoutePreview,
  type WenBtcRoutePreview,
} from "./wen-btc-route-preview-contract.js";
import { previewWenBtcRouteWithSigner } from "./wen-btc-route-preview.js";
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-btc-inspection-wire.json", import.meta.url),
    "utf8",
  ),
) as Array<{ intent: WenBtcIntentCandidate }>;
const vectors = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-btc-source-vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: Array<{
    opcode: number;
    dataBase64: string;
    keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  }>;
};
function fixture() {
  const intent = { ...fixtures.find((f) => f.intent.operation === "acquisition")!.intent };
  const v = vectors.vectors.find((v) => v.opcode === 112)!;
  const data = Buffer.from(v.dataBase64, "base64"),
    n = data[465];
  const route = {
    Program: v.keys.at(-1)!.pubkey,
    Data: data.subarray(466 + n).toString("base64"),
    Accounts: v.keys.slice(8, 8 + n).map((a, i) => ({
      ...a,
      isSigner: !!(data[466 + i] & 1),
      isWritable: !!(data[466 + i] & 2),
    })),
  };
  const raw = Buffer.from(JSON.stringify(route));
  const result: WenBtcRoutePreview = {
    status: "requires-route-review",
    operation: "acquisition",
    descriptorSha256: intent.descriptorSha256,
    offerSha256: intent.offerSha256,
    signingEnabled: false,
    installed: false,
    baseReviewSha256: "1".repeat(64),
    providerInstructionSha256: "2".repeat(64),
    routeSha256: createHash("sha256").update(raw).digest("hex"),
    routeBase64: raw.toString("base64"),
    validity: { observedSlot: "150", expiresSlot: "160" },
  };
  return { intent, result };
}
it("binds source-derived candidate and protocol", () => {
  const { intent, result } = fixture();
  expect(bindWenBtcRoutePreview(result, intent)).toEqual(result);
  expect(
    parseLocalSocketSignerRequest({
      op: "v2.wenBtc.route.preview",
      walletId: "buyer",
      request: intent,
    }),
  ).toBeTruthy();
  expect(validateLocalSocketSignerResult("v2.wenBtc.route.preview", result)).toBe(true);
});
it.each([
  "signed",
  "installed",
  "status",
  "hash",
  "base-hash",
  "provider-hash",
  "bytes",
  "zero-slot",
  "overflow",
  "expired",
  "extra",
  "route-signer",
])("rejects preview %s", (name) => {
  const { result } = fixture();
  switch (name) {
    case "signed":
      Object.assign(result, { signingEnabled: true });
      break;
    case "installed":
      Object.assign(result, { installed: true });
      break;
    case "status":
      Object.assign(result, { status: "ready" });
      break;
    case "hash":
      result.routeSha256 = "3".repeat(64);
      break;
    case "base-hash":
      result.baseReviewSha256 = "x";
      break;
    case "provider-hash":
      result.providerInstructionSha256 = "";
      break;
    case "bytes":
      result.routeBase64 = "AA==";
      break;
    case "zero-slot":
      result.validity.observedSlot = "0";
      break;
    case "overflow":
      result.validity.expiresSlot = "18446744073709551616";
      break;
    case "expired":
      result.validity.expiresSlot = "150";
      break;
    case "extra":
      Object.assign(result, { signature: "fake" });
      break;
    case "route-signer": {
      const route = JSON.parse(Buffer.from(result.routeBase64, "base64").toString());
      route.Accounts[3].isSigner = true;
      const raw = Buffer.from(JSON.stringify(route));
      result.routeBase64 = raw.toString("base64");
      result.routeSha256 = createHash("sha256").update(raw).digest("hex");
      break;
    }
  }
  expect(isWenBtcRoutePreview(result)).toBe(false);
});
it.each(["operation", "descriptor", "offer", "minimum", "expiry"])(
  "rejects request mismatch %s",
  (name) => {
    const { intent, result } = fixture();
    if (name === "operation") {
      intent.operation = "acceptance";
    }
    if (name === "descriptor") {
      intent.descriptorSha256 = "3".repeat(64);
    }
    if (name === "offer") {
      intent.offerSha256 = "3".repeat(64);
    }
    if (name === "minimum") {
      intent.minFinalizedSlot = "151";
    }
    if (name === "expiry") {
      intent.expiresSlot = "159";
    }
    expect(() => bindWenBtcRoutePreview(result, intent)).toThrow();
  },
);
it.each([false, true])("socket preview rejects installation claim: %s", async (altered) => {
  const { intent, result } = fixture();
  if (altered) {
    Object.assign(result, { installed: true });
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-preview-")),
    socketPath = path.join(dir, "signer.sock");
  const server = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) {
        return;
      }
      const request = JSON.parse(input);
      expect(request.op).toBe("v2.wenBtc.route.preview");
      socket.end(JSON.stringify({ ok: true, result }) + "\n");
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const promise = previewWenBtcRouteWithSigner(socketPath, "buyer", intent);
    if (altered) {
      await expect(promise).rejects.toThrow();
    } else {
      await expect(promise).resolves.toEqual(result);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
