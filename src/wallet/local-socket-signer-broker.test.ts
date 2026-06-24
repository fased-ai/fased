import { mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalSocketSignerBroker } from "./local-socket-signer-broker.js";
import {
  callLocalSocketSigner,
  LocalSocketSignerAdapter,
} from "./providers/local-socket-signer-adapter.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
});

async function createSocketDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

describe("local-socket-signer-broker", () => {
  it("forwards getBalance to the backend signer socket", async () => {
    const dir = await createSocketDir("fased-broker-forward-");
    const backendSocketPath = path.join(dir, "backend.sock");
    const brokerSocketPath = path.join(dir, "broker.sock");
    const calls: Array<{ op?: string; chain?: string; walletId?: string }> = [];

    const backend = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx < 0) {
          return;
        }
        const msg = JSON.parse(buf.slice(0, idx)) as {
          op?: string;
          chain?: string;
          walletId?: string;
        };
        calls.push(msg);
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
              ok: true,
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              balance: "42",
              unit: "lamports",
            },
          })}\n`,
        );
      });
    });
    await mkdir(path.dirname(backendSocketPath), { recursive: true });
    await new Promise<void>((resolve) => backend.listen(backendSocketPath, resolve));

    const broker = await startLocalSocketSignerBroker({
      socketPath: brokerSocketPath,
      backendSocketPath,
      pidFile: `${brokerSocketPath}.pid`,
      auditLog: `${brokerSocketPath}.audit.jsonl`,
      readOnly: false,
    });

    try {
      const result = await callLocalSocketSigner<{
        chain: string;
        balance: string;
      }>(brokerSocketPath, {
        op: "getBalance",
        chain: "solana",
        walletId: "miner-wallet",
      });
      expect(result.balance).toBe("42");
      expect(calls).toEqual([{ op: "getBalance", chain: "solana", walletId: "miner-wallet" }]);
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });

  it("forwards sendSolanaInstruction through the broker for signer-side policy enforcement", async () => {
    const dir = await createSocketDir("fased-broker-instruction-");
    const backendSocketPath = path.join(dir, "backend.sock");
    const brokerSocketPath = path.join(dir, "broker.sock");
    const calls: Array<{ op?: string; request?: { programId?: string } }> = [];

    const backend = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx < 0) {
          return;
        }
        const msg = JSON.parse(buf.slice(0, idx)) as {
          op?: string;
          request?: { programId?: string };
        };
        calls.push(msg);
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
              ok: true,
              chain: "solana",
              txHash: "signature",
              signer: "So11111111111111111111111111111111111111112",
            },
          })}\n`,
        );
      });
    });
    await mkdir(path.dirname(backendSocketPath), { recursive: true });
    await new Promise<void>((resolve) => backend.listen(backendSocketPath, resolve));
    const broker = await startLocalSocketSignerBroker({
      socketPath: brokerSocketPath,
      backendSocketPath,
      pidFile: `${brokerSocketPath}.pid`,
      auditLog: `${brokerSocketPath}.audit.jsonl`,
      readOnly: false,
    });

    try {
      const result = await callLocalSocketSigner<{ txHash: string }>(brokerSocketPath, {
        op: "sendSolanaInstruction",
        request: {
          programId: "11111111111111111111111111111111",
          dataBase64: "AQ==",
          keys: [
            { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
          ],
        },
      });
      expect(result.txHash).toBe("signature");
      expect(calls).toEqual([
        expect.objectContaining({
          op: "sendSolanaInstruction",
          request: expect.objectContaining({
            programId: "11111111111111111111111111111111",
          }),
        }),
      ]);
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });

  it("forwards sat cleanup sendSolanaInstructions through the broker", async () => {
    const dir = await createSocketDir("fased-broker-instruction-batch-");
    const backendSocketPath = path.join(dir, "backend.sock");
    const brokerSocketPath = path.join(dir, "broker.sock");
    const calls: Array<{ op?: string; request?: { purpose?: string; instructions?: unknown[] } }> =
      [];

    const backend = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx < 0) {
          return;
        }
        const msg = JSON.parse(buf.slice(0, idx)) as {
          op?: string;
          request?: { purpose?: string; instructions?: unknown[] };
        };
        calls.push(msg);
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
              ok: true,
              chain: "solana",
              txHash: "batch-signature",
              signer: "So11111111111111111111111111111111111111112",
              metadata: { instructionCount: 2 },
            },
          })}\n`,
        );
      });
    });
    await mkdir(path.dirname(backendSocketPath), { recursive: true });
    await new Promise<void>((resolve) => backend.listen(backendSocketPath, resolve));
    const broker = await startLocalSocketSignerBroker({
      socketPath: brokerSocketPath,
      backendSocketPath,
      pidFile: `${brokerSocketPath}.pid`,
      auditLog: `${brokerSocketPath}.audit.jsonl`,
      readOnly: false,
    });

    try {
      const result = await callLocalSocketSigner<{ txHash: string }>(brokerSocketPath, {
        op: "sendSolanaInstructions",
        request: {
          purpose: "sat-cleanup",
          instructions: [
            {
              programId: "11111111111111111111111111111111",
              dataBase64: "RQ==",
              keys: [
                { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
              ],
            },
            {
              programId: "11111111111111111111111111111111",
              dataBase64: "Rg==",
              keys: [
                { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
              ],
            },
          ],
        },
      });
      expect(result.txHash).toBe("batch-signature");
      expect(calls).toEqual([
        expect.objectContaining({
          op: "sendSolanaInstructions",
          request: expect.objectContaining({
            purpose: "sat-cleanup",
            instructions: expect.arrayContaining([
              expect.objectContaining({ dataBase64: "RQ==" }),
              expect.objectContaining({ dataBase64: "Rg==" }),
            ]),
          }),
        }),
      ]);
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });

  it("remains compatible with the local signer adapter used by gateway and mining", async () => {
    const dir = await createSocketDir("fased-broker-adapter-");
    const backendSocketPath = path.join(dir, "backend.sock");
    const brokerSocketPath = path.join(dir, "broker.sock");

    const backend = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx < 0) {
          return;
        }
        const msg = JSON.parse(buf.slice(0, idx)) as { op?: string };
        if (msg.op === "getAddresses") {
          socket.end(
            `${JSON.stringify({ ok: true, result: { solana: "So11111111111111111111111111111111111111112" } })}\n`,
          );
          return;
        }
        if (msg.op === "getBalance") {
          socket.end(
            `${JSON.stringify({
              ok: true,
              result: {
                ok: true,
                chain: "solana",
                address: "So11111111111111111111111111111111111111112",
                balance: "4200",
                unit: "lamports",
              },
            })}\n`,
          );
          return;
        }
        socket.end(`${JSON.stringify({ ok: false, error: "unexpected op" })}\n`);
      });
    });
    await mkdir(path.dirname(backendSocketPath), { recursive: true });
    await new Promise<void>((resolve) => backend.listen(backendSocketPath, resolve));
    const broker = await startLocalSocketSignerBroker({
      socketPath: brokerSocketPath,
      backendSocketPath,
      pidFile: `${brokerSocketPath}.pid`,
      auditLog: `${brokerSocketPath}.audit.jsonl`,
      readOnly: false,
    });

    try {
      const adapter = new LocalSocketSignerAdapter(brokerSocketPath);
      await expect(adapter.getAddresses({ walletId: "miner-wallet" })).resolves.toEqual({
        solana: "So11111111111111111111111111111111111111112",
      });
      await expect(adapter.getBalance("solana", { walletId: "miner-wallet" })).resolves.toEqual({
        ok: true,
        chain: "solana",
        address: "So11111111111111111111111111111111111111112",
        balance: "4200",
        unit: "lamports",
      });
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });
});
