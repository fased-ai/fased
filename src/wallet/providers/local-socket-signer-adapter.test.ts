import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSecureLocalSignerSocket,
  callLocalSocketSigner,
  requireLocalSocketSignerPath,
} from "./local-socket-signer-adapter.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
});

describe("requireLocalSocketSignerPath", () => {
  it("returns explicit signer socket when configured", () => {
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/tmp/fased-wallet.sock");
    expect(requireLocalSocketSignerPath(process.env)).toBe("/tmp/fased-wallet.sock");
  });

  it("falls back to wallet state dir socket when env var is absent", () => {
    vi.stubEnv("FASED_STATE_DIR", "/tmp/fased-state");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    expect(requireLocalSocketSignerPath(process.env)).toBe(
      path.join("/tmp/fased-state", "wallet", "local-signer.sock"),
    );
  });
});

async function createSocketDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

describe("callLocalSocketSigner", () => {
  it("times out bounded signer calls", async () => {
    const dir = await createSocketDir("fased-signer-timeout-");
    const socketPath = path.join(dir, "signer.sock");
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        callLocalSocketSigner(socketPath, { op: "health" }, { timeoutMs: 25 }),
      ).rejects.toThrow(/timeout/);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects oversized signer responses", async () => {
    const dir = await createSocketDir("fased-signer-response-cap-");
    const socketPath = path.join(dir, "signer.sock");
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => {
        socket.end(`${JSON.stringify({ ok: true, result: { details: "x".repeat(128) } })}\n`);
      });
    });
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        callLocalSocketSigner(socketPath, { op: "health" }, { maxResponseBytes: 16 }),
      ).rejects.toThrow(/response exceeds 16 bytes/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("assertSecureLocalSignerSocket", () => {
  it("rejects world-accessible signer sockets before risky calls", async () => {
    const dir = await createSocketDir("fased-signer-socket-mode-");
    const socketPath = path.join(dir, "signer.sock");
    const server = net.createServer();
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await chmod(socketPath, 0o777);
      expect(() => assertSecureLocalSignerSocket(socketPath)).toThrow(/world-accessible/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
