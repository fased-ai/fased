#!/usr/bin/env node

import net from "node:net";

const op = String(process.argv[2] ?? "").trim();
if (op !== "authorizeGatewayRelease") {
  throw new Error("fixture updater request accepts only authorizeGatewayRelease");
}

const socketPath = "/run/fased-host-updater/request.sock";
const transactionId = String(process.argv[3] ?? "").trim();
const version = String(process.argv[4] ?? "").trim();
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId) ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)
) {
  throw new Error("fixture updater request requires an exact transaction ID and version");
}
const request = {
  schemaVersion: 2,
  op,
  transactionId,
  version,
};

const response = await new Promise((resolve, reject) => {
  const socket = net.createConnection({ path: socketPath });
  socket.setEncoding("utf8");
  socket.setTimeout(30_000);
  let body = "";
  socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on("data", (chunk) => {
    body += chunk;
    const newline = body.indexOf("\n");
    if (newline < 0) {
      return;
    }
    socket.destroy();
    try {
      resolve(JSON.parse(body.slice(0, newline)));
    } catch (error) {
      reject(new Error(`fixture updater response is invalid: ${error.message}`));
    }
  });
  socket.once("timeout", () => reject(new Error("fixture updater request timed out")));
  socket.once("error", reject);
});

if (
  response?.ok !== true ||
  response.transactionId !== request.transactionId ||
  response.version !== request.version
) {
  throw new Error(response?.error || "fixture updater rejected the request");
}
process.stdout.write(`${JSON.stringify(response)}\n`);
