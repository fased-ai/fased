#!/usr/bin/env node

import net from "node:net";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 1 << 20;
const REQUIRED_FEATURES = [
  "failClosedPolicies",
  "durableCaps",
  "atomicIdempotency",
  "signerOwnedKeys",
  "typedSolanaTransactions",
];

export function validateDockerSignerHealthEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    return false;
  }
  const result = envelope.result;
  const protocol = result?.capabilities?.protocol;
  const features = new Set(
    Array.isArray(result?.capabilities?.features) ? result.capabilities.features : [],
  );
  return (
    result?.ready === true &&
    protocol?.current === 2 &&
    Number(protocol?.min) <= 2 &&
    Number(protocol?.max) >= 2 &&
    REQUIRED_FEATURES.every((feature) => features.has(feature))
  );
}

export async function checkDockerSignerHealth(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`native signer health timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write('{"op":"v2.capabilities"}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("native signer health response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const envelope = JSON.parse(buffer.slice(0, newline));
        finish(
          validateDockerSignerHealthEnvelope(envelope)
            ? undefined
            : new Error("native signer did not acknowledge required protocol-v2 capabilities"),
        );
      } catch {
        finish(new Error("native signer returned invalid health JSON"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) {
        finish(new Error("native signer closed before returning health"));
      }
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const socketPath = String(argv[0] ?? process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  if (!socketPath.startsWith("/")) {
    throw new Error("an absolute native signer socket path is required");
  }
  await checkDockerSignerHealth(socketPath);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `fased-signerd unhealthy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
