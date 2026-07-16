#!/usr/bin/env node

import net from "node:net";

const socketPath = process.env.FASED_HOST_UPDATER_SOCKET || "/run/fased-host-updater/request.sock";
const version = String(process.argv[2] ?? "")
  .trim()
  .replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
  throw new Error("an exact signer release version is required");
}

const response = await new Promise((resolve, reject) => {
  const socket = net.createConnection({ path: socketPath });
  socket.setEncoding("utf8");
  socket.setTimeout(20 * 60_000);
  let body = "";
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ schemaVersion: 1, op: "prepareRelease", version })}\n`);
  });
  socket.on("data", (chunk) => {
    body += chunk;
    const newline = body.indexOf("\n");
    if (newline < 0) {
      return;
    }
    socket.destroy();
    try {
      resolve(JSON.parse(body.slice(0, newline)));
    } catch {
      reject(new Error("host updater returned invalid data"));
    }
  });
  socket.once("timeout", () => reject(new Error("host updater timed out")));
  socket.once("error", reject);
});

if (!response?.ok || response.version !== version) {
  process.stderr.write(`${String(response?.error || "host updater failed")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
