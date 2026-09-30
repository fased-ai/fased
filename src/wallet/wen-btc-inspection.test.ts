import { readFileSync } from "node:fs";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLocalSocketSignerRequest,
  validateLocalSocketSignerResult,
} from "./local-socket-signer-protocol.js";
import { isWenBtcInspection, type WenBtcInspection } from "./wen-btc-inspection-contract.js";
import { inspectWenBtcWithSigner } from "./wen-btc-inspection.js";
import type { WenBtcIntentCandidate } from "./wen-btc-intent.js";
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-btc-inspection-wire.json", import.meta.url),
    "utf8",
  ),
) as Array<{ intent: WenBtcIntentCandidate; result: WenBtcInspection }>;

async function withSigner(
  response: unknown,
  run: (socket: string, requests: unknown[]) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-inspect-"));
  const socketPath = path.join(dir, "signer.sock");
  const requests: unknown[] = [];
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      const at = text.indexOf("\n");
      if (at < 0) {
        return;
      }
      requests.push(JSON.parse(text.slice(0, at)));
      socket.end(JSON.stringify(response) + "\n");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    await chmod(socketPath, 0o600);
    await run(socketPath, requests);
  } finally {
    for (const socket of connections) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe("WEN inspection contract", () => {
  for (const f of fixtures) {
    it(`accepts the Go ${f.intent.operation} wire without signing capability`, () => {
      expect(isWenBtcInspection(f.result)).toBe(true);
      expect(validateLocalSocketSignerResult("v2.wenBtc.inspect", f.result)).toBe(true);
      expect(
        parseLocalSocketSignerRequest({
          op: "v2.wenBtc.inspect",
          walletId: "buyer",
          request: f.intent,
        }),
      ).toBeTruthy();
    });
  }
  for (const name of [
    "enabled",
    "status",
    "unknown",
    "numeric-slot",
    "overflow",
    "stale-reference",
    "extra-signer",
    "bad-address",
    "wire",
    "wrong-op",
  ]) {
    it(`rejects ${name}`, () => {
      const r = structuredClone(fixtures[0].result);
      switch (name) {
        case "enabled":
          Object.assign(r, { signingEnabled: true });
          break;
        case "status":
          Object.assign(r, { status: "ready-to-sign" });
          break;
        case "unknown":
          Object.assign(r, { signature: "fake" });
          break;
        case "numeric-slot":
          Object.assign(r.readback, { slot: 150 });
          break;
        case "overflow":
          r.readback.slot = "18446744073709551616";
          break;
        case "stale-reference":
          r.readback.referenceSlot = "149";
          break;
        case "extra-signer":
          r.readback.accounts[1].isSigner = true;
          break;
        case "bad-address":
          r.readback.accounts[1].pubkey = "bad";
          break;
        case "wire":
          r.readback.dataBase64 = "AA==";
          break;
        case "wrong-op":
          r.operation = "acquisition";
          break;
      }
      expect(isWenBtcInspection(r)).toBe(false);
    });
  }
  it("rejects request overrides and numeric limit overflow", () => {
    for (const extra of [
      { rpcUrl: "https://untrusted.invalid" },
      { transaction: "bytes" },
      { maxCashRaw: "18446744073709551616" },
    ]) {
      expect(() =>
        parseLocalSocketSignerRequest({
          op: "v2.wenBtc.inspect",
          walletId: "buyer",
          request: { ...fixtures[0].intent, ...extra },
        }),
      ).toThrow();
    }
  });
});

describe("WEN Unix transport", () => {
  for (const f of fixtures) {
    it(`inspects ${f.intent.operation} through the real client socket`, async () => {
      await withSigner({ ok: true, result: f.result }, async (socket, requests) => {
        expect(await inspectWenBtcWithSigner(socket, "buyer", f.intent)).toEqual(f.result);
        expect(requests).toEqual([
          { op: "v2.wenBtc.inspect", walletId: "buyer", request: f.intent },
        ]);
      });
    });
  }
  for (const name of ["offer", "descriptor", "slot", "expiry", "enabled", "server-error"]) {
    it(`rejects ${name} through transport`, async () => {
      const f = fixtures[0];
      const r = structuredClone(f.result);
      switch (name) {
        case "offer":
          r.offerSha256 = "1".repeat(64);
          break;
        case "descriptor":
          r.descriptorSha256 = "1".repeat(64);
          break;
        case "slot":
          r.readback.slot = "99";
          break;
        case "expiry":
          r.readback.referenceSlot = "200";
          break;
        case "enabled":
          Object.assign(r, { signingEnabled: true });
          break;
      }
      await withSigner(
        name === "server-error"
          ? { ok: false, error: "review unavailable" }
          : { ok: true, result: r },
        async (socket, requests) => {
          await expect(inspectWenBtcWithSigner(socket, "buyer", f.intent)).rejects.toThrow();
          expect(requests).toHaveLength(1);
        },
      );
    });
  }
});
