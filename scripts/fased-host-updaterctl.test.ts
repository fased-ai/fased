import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-host-updaterctl-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function runClient(params: {
  socketPath: string;
  statePath: string;
  version?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "fased-host-updaterctl.mjs"),
        params.version ?? "1.2.3",
        "--apply",
      ],
      {
        env: {
          ...process.env,
          FASED_HOST_UPDATER_SOCKET: params.socketPath,
          FASED_HOST_UPDATERCTL_STATE: params.statePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("host updater controller client", () => {
  it("applies one transaction and reuses its identity after a target-owned rollback", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "request.sock");
    const statePath = path.join(root, "client", "transaction.json");
    const requests: Array<{
      schemaVersion: number;
      op: string;
      transactionId: string;
      nonce: string;
      version: string;
      clientCapabilities: { protocolVersion: number; requestSchema: number };
    }> = [];
    let rejectFirstApply = true;
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let body = "";
      socket.on("data", (chunk) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const request = JSON.parse(body.slice(0, newline)) as {
          schemaVersion: number;
          op: string;
          transactionId: string;
          nonce: string;
          version: string;
          clientCapabilities: { protocolVersion: number; requestSchema: number };
        };
        requests.push(request);
        if (request.op === "recoveryStatus") {
          socket.end(
            `${JSON.stringify({
              ok: true,
              transactionId: request.transactionId,
              version: request.version,
              phase: "ready",
              recovery: { state: "READY" },
            })}\n`,
          );
          return;
        }
        if (request.op === "applyRelease" && rejectFirstApply) {
          rejectFirstApply = false;
          socket.end(
            `${JSON.stringify({
              ok: false,
              transactionId: request.transactionId,
              version: request.version,
              error: "deterministic target rollback",
            })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({
            ok: true,
            transactionId: request.transactionId,
            version: request.version,
            controllerChanged: false,
            phase: request.op === "applyRelease" ? "committed" : undefined,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const first = await runClient({ socketPath, statePath });
      expect(first.code).not.toBe(0);
      expect(first.stderr).toContain("deterministic target rollback");
      const retained = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        transactionId: string;
      };

      const second = await runClient({ socketPath, statePath });
      expect(second).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(second.stdout)).toMatchObject({
        version: "1.2.3",
        phase: "committed",
      });
      await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });

      const applyRequests = requests.filter((request) => request.op === "applyRelease");
      expect(applyRequests).toHaveLength(2);
      expect(requests.every((request) => request.schemaVersion === 3)).toBe(true);
      expect(
        requests.every(
          (request) =>
            request.clientCapabilities?.protocolVersion === 2 &&
            request.clientCapabilities?.requestSchema === 3 &&
            /^[0-9a-f-]{36}$/u.test(request.nonce),
        ),
      ).toBe(true);
      expect(new Set(applyRequests.map((request) => request.transactionId))).toEqual(
        new Set([retained.transactionId]),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("treats an unfinished different-target marker as a hint and reaches the supervisor", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "request.sock");
    const statePath = path.join(root, "client", "transaction.json");
    const priorTransactionId = "00000000-0000-4000-8000-000000000001";
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: priorTransactionId,
        version: "1.2.2",
      })}\n`,
      { mode: 0o600 },
    );
    const requests: Array<{
      schemaVersion: number;
      op: string;
      transactionId: string;
      nonce: string;
      version: string;
      clientCapabilities: { protocolVersion: number; requestSchema: number };
    }> = [];
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let body = "";
      socket.on("data", (chunk) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const request = JSON.parse(body.slice(0, newline)) as {
          schemaVersion: number;
          op: string;
          transactionId: string;
          nonce: string;
          version: string;
          clientCapabilities: { protocolVersion: number; requestSchema: number };
        };
        requests.push(request);
        if (request.op === "recoveryStatus") {
          socket.end(
            `${JSON.stringify({
              ok: true,
              transactionId: request.transactionId,
              version: request.version,
              phase: "ready",
              recovery: { state: "READY" },
            })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({
            ok: true,
            transactionId: request.transactionId,
            version: request.version,
            controllerChanged: false,
            phase: request.op === "applyRelease" ? "committed" : undefined,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const result = await runClient({ socketPath, statePath, version: "1.2.3" });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(requests.map(({ op }) => op)).toEqual([
        "recoveryStatus",
        "updateController",
        "applyRelease",
      ]);
      expect(new Set(requests.map(({ version }) => version))).toEqual(new Set(["1.2.3"]));
      expect(requests[0]?.transactionId).not.toBe(priorTransactionId);
      expect(new Set(requests.map(({ transactionId }) => transactionId)).size).toBe(1);
      expect(new Set(requests.map(({ nonce }) => nonce)).size).toBe(1);
      await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("clears its retry hint only after the root supervisor confirms recovery", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "request.sock");
    const statePath = path.join(root, "client", "transaction.json");
    const requests: string[] = [];
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let body = "";
      socket.on("data", (chunk) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const request = JSON.parse(body.slice(0, newline)) as {
          op: string;
          transactionId: string;
          version: string;
        };
        requests.push(request.op);
        if (request.op === "recoveryStatus") {
          socket.end(
            `${JSON.stringify({
              ok: true,
              transactionId: request.transactionId,
              version: request.version,
              phase: "ready",
              recovery: { state: "READY" },
            })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({
            ok: request.op === "updateController",
            transactionId: request.transactionId,
            version: request.version,
            controllerChanged: false,
            recoveryComplete: request.op === "applyRelease",
            error: request.op === "applyRelease" ? "rolled back by root supervisor" : undefined,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const result = await runClient({ socketPath, statePath });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("rolled back by root supervisor");
      expect(requests).toEqual(["recoveryStatus", "updateController", "applyRelease"]);
      await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
