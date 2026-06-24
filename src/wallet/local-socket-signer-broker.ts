import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { requestJsonlSocket } from "../infra/jsonl-socket.js";
import {
  parseLocalSocketSignerRequest,
  parseLocalSocketSignerResponseEnvelope,
  type LocalSocketSignerRequest,
  type LocalSocketSignerResponseEnvelope,
} from "./local-socket-signer-protocol.js";
import { redactWalletDiagnosticText, walletDiagnosticErrorMessage } from "./wallet-redaction.js";
import {
  resolveLocalSignerBackendSocketPath,
  resolveLocalSignerSidecarPaths,
  resolveLocalSignerSocketPath,
} from "./wallet-runtime-config.js";

const MAX_REQUEST_BYTES = 1 << 20;
const SOCKET_TIMEOUT_MS = 30_000;
const ALLOWED_OPS = new Set<LocalSocketSignerRequest["op"]>([
  "health",
  "getAddresses",
  "getBalance",
  "prepareTx",
  "sendTx",
  "signTx",
  "sendSolanaInstruction",
  "sendSolanaInstructions",
]);

type BrokerOptions = {
  socketPath: string;
  backendSocketPath: string;
  pidFile: string;
  auditLog: string;
  readOnly: boolean;
  fileMode: number;
};

type BrokerServer = {
  close: () => Promise<void>;
};

function bytesTrimNewline(raw: string): string {
  return raw.replace(/[\r\n]+$/g, "");
}

function fingerprintRequest(req: LocalSocketSignerRequest): Record<string, unknown> {
  return {
    op: req.op,
    chain: "chain" in req ? req.chain : undefined,
    walletId:
      "walletId" in req
        ? req.walletId
        : "request" in req &&
            req.request &&
            typeof req.request === "object" &&
            "walletId" in req.request
          ? req.request.walletId
          : undefined,
  };
}

function appendAuditLine(auditLog: string, entry: Record<string, unknown>, fileMode: number) {
  if (!auditLog) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(auditLog), {
      recursive: true,
      mode: fileMode === 0o660 ? 0o770 : 0o700,
    });
    fs.appendFileSync(auditLog, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(auditLog, fileMode);
  } catch {
    // best effort
  }
}

function writeJsonLine(socket: net.Socket, payload: LocalSocketSignerResponseEnvelope) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function validateBrokerRequest(
  req: LocalSocketSignerRequest,
  readOnly: boolean,
): string | undefined {
  if (!ALLOWED_OPS.has(req.op)) {
    return `operation ${req.op} is not allowed through broker`;
  }
  if (
    readOnly &&
    (req.op === "prepareTx" ||
      req.op === "sendTx" ||
      req.op === "signTx" ||
      req.op === "sendSolanaInstruction" ||
      req.op === "sendSolanaInstructions")
  ) {
    return "read-only signer mode";
  }
  return undefined;
}

async function callBackend(
  backendSocketPath: string,
  payload: LocalSocketSignerRequest,
): Promise<LocalSocketSignerResponseEnvelope> {
  const result = await requestJsonlSocket<LocalSocketSignerResponseEnvelope>({
    socketPath: backendSocketPath,
    payload: JSON.stringify(payload),
    timeoutMs: SOCKET_TIMEOUT_MS,
    accept: (msg) => {
      try {
        return parseLocalSocketSignerResponseEnvelope(msg);
      } catch {
        return undefined;
      }
    },
  });
  if (!result) {
    throw new Error("broker backend unavailable");
  }
  return result;
}

function handleConnection(socket: net.Socket, options: BrokerOptions) {
  socket.setEncoding("utf8");
  socket.setTimeout(SOCKET_TIMEOUT_MS);
  let buffer = "";

  const finishWithError = (message: string, req?: LocalSocketSignerRequest) => {
    const safeMessage = redactWalletDiagnosticText(message);
    writeJsonLine(socket, { ok: false, error: safeMessage });
    appendAuditLine(
      options.auditLog,
      {
        ts: new Date().toISOString(),
        ok: false,
        error: safeMessage,
        fp: req ? fingerprintRequest(req) : undefined,
      },
      options.fileMode,
    );
    socket.end();
  };

  socket.on("timeout", () => finishWithError("broker read timeout"));
  socket.on("data", async (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) {
      finishWithError("broker request too large");
      return;
    }
    const idx = buffer.indexOf("\n");
    if (idx < 0) {
      return;
    }
    const line = bytesTrimNewline(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 1);
    let req: LocalSocketSignerRequest;
    try {
      req = parseLocalSocketSignerRequest(JSON.parse(line) as unknown);
    } catch {
      finishWithError("invalid signer request");
      return;
    }
    const validationError = validateBrokerRequest(req, options.readOnly);
    if (validationError) {
      finishWithError(validationError, req);
      return;
    }
    try {
      const response = await callBackend(options.backendSocketPath, req);
      writeJsonLine(socket, response);
      appendAuditLine(
        options.auditLog,
        {
          ts: new Date().toISOString(),
          ok: response.ok,
          op: req.op,
          fp: fingerprintRequest(req),
          error:
            response.ok || !response.error ? undefined : redactWalletDiagnosticText(response.error),
        },
        options.fileMode,
      );
      socket.end();
    } catch (err) {
      finishWithError(walletDiagnosticErrorMessage(err), req);
    }
  });
  socket.on("error", () => {
    socket.destroy();
  });
}

function ensurePidLock(pidFile: string, fileMode: number) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  if (fs.existsSync(pidFile)) {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        throw new Error(`signer broker already running (pid=${pid})`);
      } catch (err) {
        if (!(err instanceof Error) || !String(err.message).includes("already running")) {
          fs.rmSync(pidFile, { force: true });
        } else {
          throw err;
        }
      }
    } else {
      fs.rmSync(pidFile, { force: true });
    }
  }
  fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: fileMode });
  fs.chmodSync(pidFile, fileMode);
}

export async function startLocalSocketSignerBroker(
  params?: Partial<BrokerOptions>,
): Promise<BrokerServer> {
  const env = process.env;
  const socketPath = path.resolve(params?.socketPath ?? resolveLocalSignerSocketPath(env));
  const backendSocketPath = path.resolve(
    params?.backendSocketPath ?? resolveLocalSignerBackendSocketPath(env),
  );
  const sidecarPaths = resolveLocalSignerSidecarPaths(socketPath);
  const pidFile = path.resolve(params?.pidFile ?? sidecarPaths.pidPath);
  const auditLog = path.resolve(params?.auditLog ?? sidecarPaths.auditPath);
  const readOnly =
    typeof params?.readOnly === "boolean"
      ? params.readOnly
      : String(env.FASED_WALLET_LOCAL_SIGNER_READ_ONLY ?? "").trim() === "1";
  const fileMode =
    typeof params?.fileMode === "number"
      ? params.fileMode
      : backendSocketPath !== socketPath
        ? 0o660
        : 0o600;
  const options: BrokerOptions = {
    socketPath,
    backendSocketPath,
    pidFile,
    auditLog,
    readOnly,
    fileMode,
  };

  fs.mkdirSync(path.dirname(socketPath), {
    recursive: true,
    mode: fileMode === 0o660 ? 0o770 : 0o700,
  });
  fs.rmSync(socketPath, { force: true });
  ensurePidLock(pidFile, fileMode);

  const server = net.createServer((socket) => {
    handleConnection(socket, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, fileMode);

  const close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(pidFile, { force: true });
  };

  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  appendAuditLine(
    auditLog,
    {
      ts: new Date().toISOString(),
      ok: true,
      event: "broker_started",
      socketPath,
      backendSocketPath,
      readOnly,
    },
    fileMode,
  );

  return { close };
}
