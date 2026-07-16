#!/usr/bin/env node

import net from "node:net";

const SOCKET_PATH =
  process.env.FASED_HOST_BOOTSTRAP_SOCKET || "/run/fased-host-bootstrap/control.sock";
const action = String(process.argv[2] ?? "").trim();
if (!/^[a-z][a-z0-9-]{1,63}$/.test(action)) {
  throw new Error("a fixed bootstrap action is required");
}
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (Buffer.byteLength(input) > 128 * 1024) {
    throw new Error("bootstrap input is too large");
  }
}
input = input.replace(/[\r\n]+$/g, "");

const response = await new Promise((resolve, reject) => {
  const socket = net.createConnection({ path: SOCKET_PATH });
  socket.setEncoding("utf8");
  socket.setTimeout(5 * 60_000);
  let body = "";
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ schemaVersion: 1, action, input })}\n`);
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
      reject(new Error("bootstrap helper returned invalid data"));
    }
  });
  socket.once("timeout", () => reject(new Error("bootstrap helper timed out")));
  socket.once("error", reject);
});

if (!response?.ok) {
  process.stderr.write(String(response?.error || "bootstrap action failed"));
  process.exitCode = 1;
} else if (response.output) {
  process.stdout.write(String(response.output));
}
