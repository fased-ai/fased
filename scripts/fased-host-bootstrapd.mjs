#!/usr/bin/env node

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOCKET_PATH = "/run/fased-host-bootstrap/control.sock";
const HELPER_PATH = "/usr/local/sbin/fased-host-maintenance";
const GATEWAY_HELPER_PATH = "/usr/local/sbin/fased-install-gateway-service";
const MAX_BYTES = 132 * 1024;
const ALLOWED_ACTIONS = new Set([
  "harden-ssh",
  "enable-dnf-automatic",
  "tailscale-status",
  "tailscale-status-json",
  "tailscale-ip4",
  "tailscale-logout",
  "tailscale-up-ssh",
  "tailscale-up-reset-ssh",
  "tailscale-up-authkey-ssh",
  "tailscale-up-reset-authkey-ssh",
  "tailscale-serve",
  "tailscale-serve-status",
  "tailscale-install-start",
  "tailscale-set-operator-self",
  "tailnet-ssh-ingress",
  "firewall-baseline",
  "fail2ban-enable",
  "automatic-updates",
  "gateway-install",
  "gateway-remove-legacy",
  "gateway-restart",
  "gateway-start",
  "gateway-enable-start",
]);
const INPUT_ACTIONS = new Set([
  "tailscale-up-authkey-ssh",
  "tailscale-up-reset-authkey-ssh",
  "tailscale-serve",
  "gateway-install",
]);

function validUser(value) {
  return /^[A-Za-z0-9_.@-]+$/.test(value) && value !== "root";
}

const UNIT_DIRECTIVES = {
  Unit: new Set(["Description", "After", "Wants"]),
  Service: new Set([
    "Type",
    "User",
    "Group",
    "ExecStart",
    "Restart",
    "RestartSec",
    "KillMode",
    "WorkingDirectory",
    "Environment",
    "NoNewPrivileges",
    "PrivateTmp",
  ]),
  Install: new Set(["WantedBy"]),
};

export function validateGatewayUnit(input, appUser) {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
    throw new Error("gateway unit input is invalid");
  }
  let section = "";
  const sections = new Set();
  const singletonCounts = new Map();
  const requiredValues = new Map([
    ["User", appUser],
    ["Group", appUser],
    ["NoNewPrivileges", "true"],
    ["PrivateTmp", "true"],
    ["WantedBy", "multi-user.target"],
  ]);
  const allowedExecStarts = new Set([
    `/bin/bash /home/${appUser}/.fased/bin/fased-service managed`,
    `/bin/bash /home/${appUser}/fased/scripts/start-managed.sh`,
    `/bin/bash /home/${appUser}/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh`,
  ]);
  const allowedWorkingDirectories = new Set([
    `/home/${appUser}/.fased/runtime/current`,
    `/home/${appUser}/fased`,
    `/home/${appUser}/.fased/install-cache/npm-global/lib/node_modules/@fased/fased`,
  ]);
  const requiredEnvironments = new Map([
    ["FASED_GATEWAY_MODE", "managed"],
    ["FASED_MANAGED_INTERNAL", "1"],
    ["FASED_GATEWAY_PORT", "18789"],
    ["FASED_HOST_PROFILE", "hosting"],
    ["FASED_WALLET_LOCAL_SIGNER_SOCKET", "/run/fased-signerd/app.sock"],
  ]);
  const seenEnvironments = new Map();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = /^\[(Unit|Service|Install)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (sections.has(section)) {
        throw new Error(`duplicate gateway unit section: ${section}`);
      }
      sections.add(section);
      continue;
    }
    const equals = line.indexOf("=");
    if (!section || equals <= 0) {
      throw new Error("gateway unit contains data outside an approved section");
    }
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (!UNIT_DIRECTIVES[section].has(key)) {
      throw new Error(`gateway unit directive is not allowed: ${section}.${key}`);
    }
    if (
      new Set([
        "User",
        "Group",
        "ExecStart",
        "WorkingDirectory",
        "NoNewPrivileges",
        "PrivateTmp",
        "WantedBy",
      ]).has(key)
    ) {
      const count = (singletonCounts.get(key) ?? 0) + 1;
      singletonCounts.set(key, count);
      if (count !== 1) {
        throw new Error(`gateway unit directive must occur once: ${key}`);
      }
    }
    if (requiredValues.has(key) && value !== requiredValues.get(key)) {
      throw new Error(`gateway unit ${key} has an unsupported value`);
    }
    if (key === "ExecStart" && !allowedExecStarts.has(value)) {
      throw new Error("gateway unit ExecStart is not an approved managed launcher");
    }
    if (key === "WorkingDirectory" && !allowedWorkingDirectories.has(value)) {
      throw new Error("gateway unit WorkingDirectory is not an approved Fased path");
    }
    if (key === "Environment") {
      const normalized = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
      const separator = normalized.indexOf("=");
      if (separator <= 0) {
        throw new Error("gateway unit environment is malformed");
      }
      const envKey = normalized.slice(0, separator);
      const envValue = normalized.slice(separator + 1);
      const safeEnvironment =
        new Set([
          "HOME",
          "TMPDIR",
          "PATH",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "no_proxy",
          "all_proxy",
          "NODE_EXTRA_CA_CERTS",
        ]).has(envKey) ||
        requiredEnvironments.has(envKey) ||
        envKey === "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET";
      if (!safeEnvironment) {
        throw new Error(`gateway unit environment key is not allowed: ${envKey}`);
      }
      if (
        (requiredEnvironments.has(envKey) && requiredEnvironments.get(envKey) !== envValue) ||
        (envKey === "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET" &&
          envValue !== "/run/fased-signerd/app.sock")
      ) {
        throw new Error(`gateway unit environment value is not allowed: ${envKey}`);
      }
      if (seenEnvironments.has(envKey)) {
        throw new Error(`gateway unit environment occurs more than once: ${envKey}`);
      }
      seenEnvironments.set(envKey, envValue);
    }
  }
  if (["Unit", "Service", "Install"].some((name) => !sections.has(name))) {
    throw new Error("gateway unit is missing a required section");
  }
  for (const key of [
    "User",
    "Group",
    "ExecStart",
    "WorkingDirectory",
    "NoNewPrivileges",
    "PrivateTmp",
    "WantedBy",
  ]) {
    if (singletonCounts.get(key) !== 1) {
      throw new Error(`gateway unit is missing required directive: ${key}`);
    }
  }
  for (const key of [
    "FASED_GATEWAY_MODE",
    "FASED_MANAGED_INTERNAL",
    "FASED_GATEWAY_PORT",
    "FASED_HOST_PROFILE",
    "FASED_WALLET_LOCAL_SIGNER_SOCKET",
  ]) {
    if (!seenEnvironments.has(key)) {
      throw new Error(`gateway unit is missing required environment: ${key}`);
    }
  }
}

export function parseBootstrapRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid bootstrap request");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "action,input,schemaVersion") {
    throw new Error("unsupported bootstrap request fields");
  }
  if (value.schemaVersion !== 1 || !ALLOWED_ACTIONS.has(value.action)) {
    throw new Error("unsupported bootstrap action");
  }
  const input = typeof value.input === "string" ? value.input : "";
  const maxInput = value.action === "gateway-install" ? 128 * 1024 : 8192;
  if (Buffer.byteLength(input) > maxInput || input.includes("\0")) {
    throw new Error("invalid bootstrap input");
  }
  if (input && !INPUT_ACTIONS.has(value.action)) {
    throw new Error("bootstrap action does not accept input");
  }
  return { schemaVersion: 1, action: value.action, input };
}

async function runGatewayAction(action, appUser, input) {
  const systemctl = "/usr/bin/systemctl";
  if (action === "gateway-install") {
    validateGatewayUnit(input, appUser);
    return await execFileAsync(GATEWAY_HELPER_PATH, ["fased-gateway", appUser], {
      env: { HOME: "/root", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      input,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  if (action === "gateway-remove-legacy") {
    await execFileAsync(systemctl, ["disable", "--now", "fased-gateway.service"], {
      timeout: 60_000,
    }).catch(() => undefined);
    await fsp.rm("/etc/systemd/system/fased-gateway.service.d", {
      recursive: true,
      force: true,
    });
    await execFileAsync(systemctl, ["reset-failed", "fased-gateway.service"], {
      timeout: 30_000,
    }).catch(() => undefined);
    await execFileAsync(systemctl, ["daemon-reload"], { timeout: 30_000 });
    return { stdout: "", stderr: "" };
  }
  const args =
    action === "gateway-restart"
      ? ["restart", "--no-block", "fased-gateway.service"]
      : action === "gateway-start"
        ? ["start", "--no-block", "fased-gateway.service"]
        : ["enable", "--now", "fased-gateway.service"];
  return await execFileAsync(systemctl, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
}

async function main() {
  const userIndex = process.argv.indexOf("--app-user");
  const appUser = userIndex >= 0 ? String(process.argv[userIndex + 1] ?? "") : "";
  const gidIndex = process.argv.indexOf("--socket-gid");
  const socketGid = gidIndex >= 0 ? Number(process.argv[gidIndex + 1]) : Number.NaN;
  if (!validUser(appUser)) {
    throw new Error("--app-user must name the unprivileged application account");
  }
  if (!Number.isSafeInteger(socketGid) || socketGid <= 0) {
    throw new Error("--socket-gid must be a positive numeric group id");
  }
  await fsp.mkdir(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o750 });
  await fsp.rm(SOCKET_PATH, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(5 * 60_000);
    let body = "";
    socket.on("error", () => socket.destroy());
    socket.on("timeout", () => socket.destroy());
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      socket.pause();
      let request;
      try {
        request = parseBootstrapRequest(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
        return;
      }
      const operation = request.action.startsWith("gateway-")
        ? runGatewayAction(request.action, appUser, request.input)
        : execFileAsync(HELPER_PATH, [request.action], {
            env: {
              HOME: "/root",
              PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              SUDO_USER: appUser,
            },
            input: request.input ? `${request.input}\n` : "",
            timeout: 5 * 60_000,
            maxBuffer: 4 * 1024 * 1024,
          });
      void operation.then(
        ({ stdout, stderr }) =>
          socket.end(`${JSON.stringify({ ok: true, output: `${stdout}${stderr}` })}\n`),
        (error) =>
          socket.end(
            `${JSON.stringify({
              ok: false,
              error: String(error?.stderr || error?.stdout || error?.message || "action failed"),
            })}\n`,
          ),
      );
    });
  });
  process.umask(0o117);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, resolve);
  });
  await fsp.chmod(SOCKET_PATH, 0o660);
  await fsp.chown(SOCKET_PATH, 0, socketGid);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(SOCKET_PATH, { force: true });
  };
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
}

if (import.meta.url === `file://${path.resolve(process.argv[1] ?? "")}`) {
  await main();
}
