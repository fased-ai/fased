import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWenMiningWithSigner } from "./wen-mining-preparation.js";
const { intent: fixture } = JSON.parse(
  readFileSync(
    new URL("../../tools/fased-signerd/testdata/wen-mining-candidate.json", import.meta.url),
    "utf8",
  ),
);

describe("mining preview over Unix socket", () => {
  for (const operation of ["commit", "reveal"] as const) {
    for (const mode of [
      "valid",
      "fragmented",
      "denied",
      "changed-entry",
      "excess-fee",
      "disconnect",
      "truncated",
      "input-change",
    ] as const) {
      it(`${operation}: ${mode}`, async () => {
        const intent = { ...fixture, operation };
        const original = { ...intent };
        const dir = await mkdtemp(path.join(os.tmpdir(), "wen-socket-"));
        const socketPath = path.join(dir, "signer.sock");
        const requests: unknown[] = [];
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          socket.setEncoding("utf8");
          let buffer = "";
          let answered = false;
          socket.on("data", (chunk: string) => {
            buffer += chunk;
            if (answered || !buffer.includes("\n")) {
              return;
            }
            answered = true;
            requests.push(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
            if (mode === "truncated") {
              socket.end('{"ok":true');
              return;
            }
            if (mode === "disconnect") {
              socket.end();
              return;
            }
            const result = {
              status: "requires-signing-revalidation",
              signingEnabled: false,
              operation,
              entrySha256: original.entrySha256,
              descriptorSha256: original.descriptorSha256,
              messageSha256: "ab".repeat(32),
              slot: "150",
              networkFeeLamports: "5000",
              computeUnits: "10000",
            };
            if (mode === "changed-entry") {
              result.entrySha256 = "cd".repeat(32);
            }
            if (mode === "excess-fee") {
              result.networkFeeLamports = "5001";
            }
            if (mode === "input-change") {
              intent.entrySha256 = "ef".repeat(32);
            }
            const reply =
              JSON.stringify(
                mode === "denied"
                  ? { ok: false, error: "protected review unavailable" }
                  : { ok: true, result },
              ) + "\n";
            if (mode === "fragmented") {
              socket.write(reply.slice(0, 17));
              setImmediate(() => socket.end(reply.slice(17)));
            } else {
              socket.end(reply);
            }
          });
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
          });
          await chmod(socketPath, 0o660);
          const call = prepareWenMiningWithSigner(socketPath, "miner", intent);
          if (mode === "valid" || mode === "fragmented" || mode === "input-change") {
            const result = await call;
            expect(result.entrySha256).toBe(original.entrySha256);
            expect(result.signingEnabled).toBe(false);
          } else {
            if (mode === "disconnect" || mode === "truncated") {
              await expect(call).rejects.toThrow(/closed before a complete response/);
            } else {
              await expect(call).rejects.toThrow();
            }
          }
          expect(requests).toEqual([
            { op: "v2.wenMining.prepare", walletId: "miner", request: original },
          ]);
        } finally {
          for (const socket of sockets) {
            socket.destroy();
          }
          if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
