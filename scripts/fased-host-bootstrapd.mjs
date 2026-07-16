#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOCKET_PATH = "/run/fased-host-bootstrap/control.sock";
const HELPER_PATH = "/usr/local/sbin/fased-host-maintenance";
const GATEWAY_HELPER_PATH = "/usr/local/sbin/fased-install-gateway-service";
const SIGNER_BINARY_PATH = "/opt/fased/signer/fased-signerd";
const SIGNER_CONTROL_SOCKET_PATH = "/run/fased-signerd/control.sock";
const SIGNER_WEBAUTHN_ENV_PATH = "/etc/fased/signerd-webauthn.env";
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
  "tailnet-ssh-ingress",
  "firewall-baseline",
  "fail2ban-enable",
  "automatic-updates",
  "gateway-install",
  "gateway-remove-legacy",
  "gateway-restart",
  "gateway-start",
  "gateway-enable-start",
  "signer-network-put",
  "signer-policy-put",
  "signer-webauthn-tailscale",
]);
const INPUT_ACTIONS = new Set([
  "tailscale-up-authkey-ssh",
  "tailscale-up-reset-authkey-ssh",
  "tailscale-serve",
  "gateway-install",
  "signer-network-put",
  "signer-policy-put",
]);

function validUser(value) {
  return /^[A-Za-z0-9_.@-]+$/.test(value) && value !== "root";
}

function strictJsonObjectKeys(raw) {
  const matches = [...raw.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map((match) => {
    const token = match[0].slice(0, match[0].lastIndexOf(":"));
    return JSON.parse(token.trim());
  });
  if (new Set(matches).size !== matches.length) {
    throw new Error("input contains a duplicate JSON field");
  }
  return matches.toSorted((a, b) => a.localeCompare(b));
}

export function parseSignerNetworkBootstrapInput(input) {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 8192) {
    throw new Error("signer network input must be one bounded JSON object");
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("signer network input must be strict JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer network input must be one JSON object");
  }
  const keys = strictJsonObjectKeys(input);
  const expectedKeys =
    value.fallbackRpcUrl === undefined
      ? ["primaryRpcUrl", "schemaVersion", "walletId"]
      : ["fallbackRpcUrl", "primaryRpcUrl", "schemaVersion", "walletId"];
  if (keys.join(",") !== expectedKeys.join(",") || Object.keys(value).length !== keys.length) {
    throw new Error("signer network input contains unsupported fields");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("unsupported signer network bootstrap schema version");
  }
  if (typeof value.walletId !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.walletId)) {
    throw new Error("signer network walletId must be normalized");
  }
  if (
    typeof value.primaryRpcUrl !== "string" ||
    !value.primaryRpcUrl.trim() ||
    value.primaryRpcUrl.length > 2048 ||
    (value.fallbackRpcUrl !== undefined &&
      (typeof value.fallbackRpcUrl !== "string" || value.fallbackRpcUrl.length > 2048))
  ) {
    throw new Error("signer network RPC fields are invalid");
  }
  return {
    schemaVersion: 1,
    walletId: value.walletId,
    primaryRpcUrl: value.primaryRpcUrl.trim(),
    ...(value.fallbackRpcUrl?.trim() ? { fallbackRpcUrl: value.fallbackRpcUrl.trim() } : {}),
  };
}

export function parseSignerPolicyBootstrapInput(input) {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 128 * 1024) {
    throw new Error("signer policy input must be one bounded JSON object");
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("signer policy input must be strict JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer policy input must be one JSON object");
  }
  const keys = strictJsonObjectKeys(input);
  if (
    keys.join(",") !== ["policyJson", "schemaVersion", "walletId"].join(",") ||
    Object.keys(value).length !== keys.length ||
    value.schemaVersion !== 1
  ) {
    throw new Error("signer policy input contains unsupported fields or version");
  }
  if (typeof value.walletId !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.walletId)) {
    throw new Error("signer policy walletId must be normalized");
  }
  if (typeof value.policyJson !== "string" || Buffer.byteLength(value.policyJson) > 64 * 1024) {
    throw new Error("signer policyJson is invalid");
  }
  let policy;
  try {
    policy = JSON.parse(value.policyJson);
  } catch {
    throw new Error("signer policyJson must be strict JSON");
  }
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.walletId !== value.walletId ||
    !new Set(["agent", "mining", "vault"]).has(policy.role) ||
    !Array.isArray(policy.operations) ||
    !Array.isArray(policy.programs) ||
    !Array.isArray(policy.assets) ||
    policy.operations.length !== 0 ||
    policy.programs.length !== 0 ||
    policy.assets.length !== 0
  ) {
    throw new Error("bootstrap may install only a matching explicit deny-all wallet policy");
  }
  return {
    schemaVersion: 1,
    walletId: value.walletId,
    role: policy.role,
    policyJson: value.policyJson,
  };
}

function parseSignerNetworkSummary(raw, walletId) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("signer network command returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer network command returned an invalid summary");
  }
  const allowedKeys =
    value.hash === undefined
      ? ["configured", "ready", "version", "walletId"]
      : ["configured", "hash", "ready", "version", "walletId"];
  if (Object.keys(value).toSorted().join(",") !== allowedKeys.join(",")) {
    throw new Error("signer network command returned unsupported summary fields");
  }
  if (
    value.walletId !== walletId ||
    typeof value.configured !== "boolean" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    typeof value.ready !== "boolean" ||
    (value.hash !== undefined && !/^hmac-sha256:[0-9a-f]{64}$/.test(value.hash))
  ) {
    throw new Error("signer network command returned an invalid summary");
  }
  return value;
}

export function redactBootstrapSensitiveError(raw, secrets = []) {
  let value = String(raw ?? "");
  for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length)) {
    value = value.split(secret).join("[redacted-rpc-url]");
  }
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-rpc-url]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|key)=([^\s&"']+)/gi, "$1=[redacted]")
    .trim()
    .slice(0, 2000);
}

function runFileWithInput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("privileged bootstrap command timed out"));
    }, options.timeout ?? 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 256 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 256 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`privileged bootstrap command exited with status ${code ?? -1}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    child.stdin.end(options.input ?? "");
  });
}

const ROOT_COMMAND_ENV = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

export async function runSignerNetworkPutAction(input, signerUser, dependencies = {}) {
  const request = parseSignerNetworkBootstrapInput(input);
  const runFile = dependencies.runFile ?? runFileWithInput;
  const commonArgs = ["-u", signerUser, "--", SIGNER_BINARY_PATH, "admin", "network"];
  const commandArgs = [
    "--control-socket",
    SIGNER_CONTROL_SOCKET_PATH,
    "--wallet-id",
    request.walletId,
  ];
  const secrets = [request.primaryRpcUrl, request.fallbackRpcUrl ?? ""];
  try {
    const currentResult = await runFile("runuser", [...commonArgs, "get", ...commandArgs], {
      env: ROOT_COMMAND_ENV,
      timeout: 30_000,
    });
    const current = parseSignerNetworkSummary(currentResult.stdout, request.walletId);
    const putInput = `${JSON.stringify({
      expectedVersion: current.version,
      primaryRpcUrl: request.primaryRpcUrl,
      ...(request.fallbackRpcUrl ? { fallbackRpcUrl: request.fallbackRpcUrl } : {}),
    })}\n`;
    const updatedResult = await runFile("runuser", [...commonArgs, "put", ...commandArgs], {
      env: ROOT_COMMAND_ENV,
      input: putInput,
      timeout: 30_000,
    });
    const updated = parseSignerNetworkSummary(updatedResult.stdout, request.walletId);
    if (
      !updated.configured ||
      !updated.ready ||
      !updated.hash ||
      updated.version !== current.version + 1
    ) {
      throw new Error("signer network command did not acknowledge the exact next ready version");
    }
    return { stdout: `${JSON.stringify(updated)}\n`, stderr: "" };
  } catch (error) {
    const detail = redactBootstrapSensitiveError(
      error?.stderr || error?.stdout || error?.message || "signer network configuration failed",
      secrets,
    );
    throw new Error(`signer network configuration failed: ${detail || "rejected"}`, {
      cause: error,
    });
  }
}

function parseSignerPolicySummary(raw, walletId) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("signer policy command returned invalid JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.walletId !== walletId ||
    !new Set(["agent", "mining", "vault"]).has(value.role) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.hash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.hash)
  ) {
    throw new Error("signer policy command returned an invalid summary");
  }
  return value;
}

async function writeTemporarySignerPolicy(policyJson) {
  // The signer owns this 0700 state directory. A root-created subdirectory would
  // prevent the signer user from reading the one-time policy file, while the
  // Gateway still cannot traverse the signer-owned parent directory.
  const directory = "/var/lib/fased-signerd";
  const filePath = path.join(directory, `bootstrap-policy-${process.pid}-${Date.now()}.json`);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, `${policyJson}\n`, { mode: 0o644, flag: "wx" });
  const handle = await fsp.open(filePath, "r");
  await handle.sync().finally(() => handle.close());
  return filePath;
}

export async function runSignerPolicyPutAction(input, signerUser, dependencies = {}) {
  const request = parseSignerPolicyBootstrapInput(input);
  const runFile = dependencies.runFile ?? runFileWithInput;
  const writePolicy = dependencies.writePolicy ?? writeTemporarySignerPolicy;
  const removePolicy = dependencies.removePolicy ?? (async (filePath) => await fsp.rm(filePath));
  const commonArgs = ["-u", signerUser, "--", SIGNER_BINARY_PATH, "admin", "policy"];
  const commandArgs = [
    "--control-socket",
    SIGNER_CONTROL_SOCKET_PATH,
    "--wallet-id",
    request.walletId,
  ];
  let policyPath = "";
  try {
    const currentResult = await runFile("runuser", [...commonArgs, "get", ...commandArgs], {
      env: ROOT_COMMAND_ENV,
      timeout: 30_000,
    });
    const current = parseSignerPolicySummary(currentResult.stdout, request.walletId);
    if (current.role !== request.role) {
      throw new Error("signer policy role does not match the existing signer wallet");
    }
    policyPath = await writePolicy(request.policyJson);
    const updatedResult = await runFile(
      "runuser",
      [
        ...commonArgs,
        "put",
        ...commandArgs,
        "--expected-version",
        String(current.version),
        "--policy-file",
        policyPath,
      ],
      { env: ROOT_COMMAND_ENV, timeout: 30_000 },
    );
    const updated = parseSignerPolicySummary(updatedResult.stdout, request.walletId);
    if (updated.role !== request.role || updated.version !== current.version + 1) {
      throw new Error("signer policy command did not acknowledge the exact next version");
    }
    return {
      stdout: `${JSON.stringify({
        walletId: updated.walletId,
        role: updated.role,
        version: updated.version,
        hash: updated.hash,
      })}\n`,
      stderr: "",
    };
  } finally {
    if (policyPath) {
      await removePolicy(policyPath);
    }
  }
}

export function validateSignerWebAuthnConfiguration(rpId, origin) {
  const normalizedRpId = String(rpId ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    !normalizedRpId ||
    normalizedRpId.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalizedRpId) ||
    normalizedRpId.includes("..")
  ) {
    throw new Error("invalid signer WebAuthn RP ID");
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("invalid signer WebAuthn origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.toLowerCase() !== normalizedRpId ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash ||
    parsed.port
  ) {
    throw new Error("signer WebAuthn origin must be the exact Tailscale HTTPS RP origin");
  }
  return { rpId: normalizedRpId, origin: `https://${normalizedRpId}` };
}

async function writeSignerWebAuthnEnvironment(config) {
  const directory = path.dirname(SIGNER_WEBAUTHN_ENV_PATH);
  const temporary = `${SIGNER_WEBAUTHN_ENV_PATH}.tmp-${process.pid}`;
  const content =
    `FASED_WALLET_WEBAUTHN_RP_ID=${config.rpId}\n` +
    `FASED_WALLET_WEBAUTHN_ORIGINS=${config.origin}\n`;
  await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
  try {
    await fsp.writeFile(temporary, content, { mode: 0o644, flag: "wx" });
    const handle = await fsp.open(temporary, "r");
    await handle.sync().finally(() => handle.close());
    await fsp.rename(temporary, SIGNER_WEBAUTHN_ENV_PATH);
    const directoryHandle = await fsp.open(directory, "r");
    await directoryHandle.sync().finally(() => directoryHandle.close());
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

export async function runSignerWebAuthnTailscaleAction(dependencies = {}) {
  const runFile = dependencies.runFile ?? runFileWithInput;
  const writeEnvironment = dependencies.writeEnvironment ?? writeSignerWebAuthnEnvironment;
  const status = await runFile("tailscale", ["status", "--json"], {
    env: ROOT_COMMAND_ENV,
    timeout: 30_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    throw new Error("Tailscale did not return valid identity JSON for signer WebAuthn");
  }
  const rpId = String(parsed?.Self?.DNSName ?? "")
    .trim()
    .replace(/\.$/, "");
  const config = validateSignerWebAuthnConfiguration(rpId, `https://${rpId}`);
  await writeEnvironment(config);
  await runFile("systemctl", ["restart", "fased-signerd.service"], {
    env: ROOT_COMMAND_ENV,
    timeout: 60_000,
  });
  await runFile("systemctl", ["is-active", "--quiet", "fased-signerd.service"], {
    env: ROOT_COMMAND_ENV,
    timeout: 30_000,
  });
  return {
    stdout: `${JSON.stringify({ configured: true, rpId: config.rpId, origins: [config.origin] })}\n`,
    stderr: "",
  };
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
    "UMask",
    "NoNewPrivileges",
    "PrivateTmp",
    "PrivateDevices",
    "ProtectSystem",
    "ProtectHome",
    "ReadWritePaths",
    "ProtectKernelTunables",
    "ProtectKernelModules",
    "ProtectKernelLogs",
    "ProtectControlGroups",
    "ProtectClock",
    "ProtectHostname",
    "LockPersonality",
    "RestrictSUIDSGID",
    "RestrictRealtime",
    "RestrictAddressFamilies",
    "SystemCallArchitectures",
    "CapabilityBoundingSet",
    "AmbientCapabilities",
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
    ["UMask", "0077"],
    ["NoNewPrivileges", "true"],
    ["PrivateTmp", "true"],
    ["PrivateDevices", "true"],
    ["ProtectSystem", "strict"],
    ["ProtectHome", "read-only"],
    ["ReadWritePaths", `/home/${appUser}/.fased`],
    ["ProtectKernelTunables", "true"],
    ["ProtectKernelModules", "true"],
    ["ProtectKernelLogs", "true"],
    ["ProtectControlGroups", "true"],
    ["ProtectClock", "true"],
    ["ProtectHostname", "true"],
    ["LockPersonality", "true"],
    ["RestrictSUIDSGID", "true"],
    ["RestrictRealtime", "true"],
    ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6"],
    ["SystemCallArchitectures", "native"],
    ["CapabilityBoundingSet", ""],
    ["AmbientCapabilities", ""],
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
        ...requiredValues.keys(),
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
        ]).has(envKey) || requiredEnvironments.has(envKey);
      if (!safeEnvironment) {
        throw new Error(`gateway unit environment key is not allowed: ${envKey}`);
      }
      if (requiredEnvironments.has(envKey) && requiredEnvironments.get(envKey) !== envValue) {
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
    "UMask",
    "NoNewPrivileges",
    "PrivateTmp",
    "PrivateDevices",
    "ProtectSystem",
    "ProtectHome",
    "ReadWritePaths",
    "ProtectKernelTunables",
    "ProtectKernelModules",
    "ProtectKernelLogs",
    "ProtectControlGroups",
    "ProtectClock",
    "ProtectHostname",
    "LockPersonality",
    "RestrictSUIDSGID",
    "RestrictRealtime",
    "RestrictAddressFamilies",
    "SystemCallArchitectures",
    "CapabilityBoundingSet",
    "AmbientCapabilities",
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
  const maxInput = new Set(["gateway-install", "signer-policy-put"]).has(value.action)
    ? 128 * 1024
    : 8192;
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
  const signerUserIndex = process.argv.indexOf("--signer-user");
  const signerUser = signerUserIndex >= 0 ? String(process.argv[signerUserIndex + 1] ?? "") : "";
  const gidIndex = process.argv.indexOf("--socket-gid");
  const socketGid = gidIndex >= 0 ? Number(process.argv[gidIndex + 1]) : Number.NaN;
  if (!validUser(appUser)) {
    throw new Error("--app-user must name the unprivileged application account");
  }
  if (!validUser(signerUser) || signerUser === appUser) {
    throw new Error("--signer-user must name the separate unprivileged signer account");
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
        : request.action === "signer-network-put"
          ? runSignerNetworkPutAction(request.input, signerUser)
          : request.action === "signer-policy-put"
            ? runSignerPolicyPutAction(request.input, signerUser)
            : request.action === "signer-webauthn-tailscale"
              ? runSignerWebAuthnTailscaleAction()
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
