#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProtectedLocalLayout } from "./protected-local-layout.mjs";

function fail(message) {
  throw new Error(message);
}

function cleanAbsolute(value, label) {
  const text = String(value ?? "").trim();
  if (
    !path.isAbsolute(text) ||
    path.resolve(text) !== text ||
    text.includes("\r") ||
    text.includes("\n") ||
    text.includes("\0")
  ) {
    fail(`${label} must be absolute, clean, and single-line`);
  }
  return text;
}

function positiveID(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function safeAccount(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(text) || text === "root") {
    fail(`${label} is invalid`);
  }
  return text;
}

function unitPath(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

export function buildProtectedLocalServicePlan(params) {
  const layout = buildProtectedLocalLayout(params.instanceId, params.roots);
  const operatorUid = positiveID(params.operatorUid, "operator UID");
  const gatewayUid = positiveID(params.gatewayUid, "Gateway UID");
  const signerUid = positiveID(params.signerUid, "signer UID");
  const gatewayGid = positiveID(params.gatewayGid, "Gateway GID");
  const operatorGid = positiveID(params.operatorGid, "operator GID");
  const operatorUser = safeAccount(params.operatorUser, "operator user");
  const operatorHome = cleanAbsolute(params.operatorHome, "operator home");
  const appStateDir = cleanAbsolute(params.appStateDir, "application state directory");
  const repoDir = cleanAbsolute(params.repoDir, "application runtime directory");
  const nodeBinary = cleanAbsolute(params.nodeBinary, "Node.js binary");
  const gatewayPort = Number(params.gatewayPort ?? 18789);
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    fail("Gateway port must be an integer from 1 through 65535");
  }
  if (!appStateDir.startsWith(`${operatorHome}${path.sep}`)) {
    fail("application state directory must remain below the operator home");
  }
  if (repoDir !== layout.applicationCurrentLink) {
    fail("application runtime directory must be the root-controlled current release");
  }
  if (new Set([operatorUid, gatewayUid, signerUid]).size !== 3) {
    fail("operator, Gateway, and signer UIDs must be distinct");
  }

  const escaped = {
    appStateDir: unitPath(appStateDir),
    operatorHome: unitPath(operatorHome),
    repoDir: unitPath(repoDir),
    nodeBinary: unitPath(nodeBinary),
    signerBinary: unitPath(layout.signerBinary),
    runtimeDir: unitPath(layout.runtimeDir),
    signerStateDir: unitPath(layout.signerStateDir),
    controllerStateDir: unitPath(layout.controllerStateDir),
    installDir: unitPath(layout.installDir),
    applicationInstallDir: unitPath(layout.applicationInstallDir),
    signerInstallDir: unitPath(path.dirname(layout.signerBinary)),
    supervisorInstallDir: unitPath(path.dirname(layout.supervisorBinary)),
    supervisorStateDir: unitPath(layout.supervisorStateDir),
  };
  const gatewayLaunch = path.join(layout.installDir, "gateway-launch");
  const operatorSocketFinalize = path.join(layout.installDir, "operator-socket-finalize");
  const controllerLaunch = path.join(
    layout.installDir,
    "controller",
    "current",
    "fased-host-updater.mjs",
  );
  const supervisorLaunch = layout.supervisorBinary;
  const gatewayUnit = `[Unit]
Description=Fased Protected Local Gateway (${layout.instanceId})
After=${layout.signerUnit} ${layout.controllerUnit} ${layout.supervisorUnit} network-online.target
Wants=${layout.signerUnit} ${layout.controllerUnit} ${layout.supervisorUnit} network-online.target
ConditionPathExists=!${layout.controllerStateDir}/gateway-update-gate
ConditionPathExists=${layout.controllerStateDir}/gateway-activation-ready

[Service]
Type=simple
User=${layout.gatewayUser}
Group=${layout.gatewayGroup}
SupplementaryGroups=${layout.configGroup}
WorkingDirectory=${escaped.repoDir}
Environment=HOME=${escaped.operatorHome}
Environment=FASED_STATE_DIR=${escaped.appStateDir}
Environment=FASED_CONFIG_DIR=${escaped.appStateDir}
Environment=FASED_CONFIG_PATH=${escaped.appStateDir}/fased.json
Environment=FASED_MANAGED_RUNTIME_ROOT=${escaped.repoDir}
Environment=FASED_NODE_BIN=${escaped.nodeBinary}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=FASED_GATEWAY_MODE=managed
Environment=FASED_RUNTIME_SOURCE=managed-package
Environment=FASED_MANAGED_INTERNAL=1
Environment=FASED_GATEWAY_SERVICE=1
Environment=FASED_GATEWAY_PORT=${gatewayPort}
Environment=FASED_HOST_PROFILE=local
Environment=FASED_PROTECTED_LOCAL=1
Environment=FASED_PROTECTED_LOCAL_INSTANCE=${layout.instanceId}
Environment=FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external
Environment=FASED_WALLET_LOCAL_SIGNER_SOCKET=${layout.applicationSocket}
Environment=FASED_PLUGIN_STATUS_CACHE_PATH=${escaped.appStateDir}/cache/plugin-status.json
ExecStartPre=/usr/bin/test -s ${layout.controllerStateDir}/gateway-activation-ready
ExecStartPre=/usr/bin/test -s ${escaped.appStateDir}/fased.json
ExecStart=${unitPath(gatewayLaunch)}
Restart=always
RestartSec=1
UMask=0007
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${escaped.appStateDir}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
  const signerUnit = `[Unit]
Description=Fased Protected Local native wallet signer (${layout.instanceId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${layout.signerUser}
Group=${layout.signerUser}
SupplementaryGroups=${layout.gatewayGroup} ${layout.operatorGroup}
RuntimeDirectory=fased-local/${layout.instanceId}
RuntimeDirectoryMode=0755
StateDirectory=fased-local/${layout.instanceId}/signer
StateDirectoryMode=0700
UMask=0077
Environment=HOME=${escaped.signerStateDir}
Environment=FASED_WALLET_WEBAUTHN_RP_ID=localhost
Environment=FASED_WALLET_WEBAUTHN_ORIGINS=http://localhost:${gatewayPort},http://localhost:18791
ExecStart=${escaped.signerBinary} -socket ${layout.applicationSocket} -operator-socket ${layout.operatorSocket} -control-socket ${layout.controlSocket} -socket-mode 0660 -socket-group ${layout.gatewayGroup} -operator-socket-group ${layout.operatorGroup} -application-uid ${gatewayUid} -operator-uid ${operatorUid} -control-uid ${signerUid} -state-db ${layout.signerStateDir}/state.db -master-key ${layout.signerStateDir}/master.key -update-gate ${layout.controllerStateDir}/signer-update-gate -pid-file ${layout.runtimeDir}/fased-signerd.pid -audit-log ${layout.auditLog}
ExecStartPost=+${unitPath(operatorSocketFinalize)}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
  const controllerUnit = `[Unit]
Description=Fased Protected Local target lifecycle controller (${layout.instanceId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=fased-local-controller-worker/${layout.instanceId}
RuntimeDirectoryMode=0711
StateDirectory=fased-local/${layout.instanceId}/controller
StateDirectoryMode=0711
UMask=0077
Environment=HOME=${escaped.controllerStateDir}
ExecStart=${escaped.nodeBinary} ${unitPath(controllerLaunch)} --protected-local-instance ${layout.instanceId} --supervised --socket-path ${unitPath(layout.controllerSocket)} --socket-uid 0 --socket-gid 0
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
AmbientCapabilities=CAP_SETUID CAP_SETGID
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=${escaped.installDir} ${escaped.signerStateDir} ${escaped.controllerStateDir} ${escaped.appStateDir} /run/fased-local-controller-worker/${layout.instanceId} /etc/systemd/system
ReadOnlyPaths=${unitPath(path.join(layout.installDir, "controller"))} ${escaped.supervisorInstallDir} ${unitPath(path.join(layout.installDir, "signer-owner"))} ${unitPath(operatorSocketFinalize)} ${escaped.supervisorStateDir} /etc/systemd/system/${layout.supervisorUnit}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
  const supervisorUnit = `[Unit]
Description=Fased Protected Local stable lifecycle supervisor (${layout.instanceId})
After=${layout.controllerUnit} network-online.target
Wants=${layout.controllerUnit} network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=fased-local-controller/${layout.instanceId}
RuntimeDirectoryMode=0711
UMask=0177
Environment=HOME=${unitPath(layout.supervisorStateDir)}
ExecStart=${escaped.nodeBinary} ${unitPath(supervisorLaunch)} --profile protected-local --protected-local-instance ${layout.instanceId} --operator-uid ${operatorUid} --operator-gid ${operatorGid}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${unitPath(layout.supervisorStateDir)} ${unitPath(path.join(layout.installDir, "controller"))} /run/fased-local-controller/${layout.instanceId}
ReadOnlyPaths=${unitPath(path.dirname(layout.supervisorBinary))}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=CAP_CHOWN
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
  const gatewayLauncher = `#!/usr/bin/env bash
set -euo pipefail
[[ -s "${layout.controllerStateDir}/gateway-activation-ready" ]] || {
  echo "protected Local Gateway activation marker is unavailable" >&2
  exit 78
}
[[ -s "${appStateDir}/fased.json" ]] || {
  echo "protected Local Gateway configuration is unavailable" >&2
  exit 78
}
gateway_entry=""
for candidate in \
  "${repoDir}/dist/entry.js" \
  "${repoDir}/dist/entry.mjs" \
  "${repoDir}/dist/index.js" \
  "${repoDir}/dist/index.mjs"; do
  if [[ -f "$candidate" && ! -L "$candidate" ]]; then
    gateway_entry="$candidate"
    break
  fi
done
[[ -n "$gateway_entry" ]] || {
  echo "protected Local Gateway entrypoint is unavailable" >&2
  exit 78
}
runtime_version="$("${nodeBinary}" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const buildVersion = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8")).version;
  if (typeof packageVersion !== "string" || !packageVersion.trim() || packageVersion !== buildVersion) {
    process.exit(1);
  }
  process.stdout.write(packageVersion.trim());
' "${repoDir}")" || {
  echo "protected Local Gateway release identity is unavailable or inconsistent" >&2
  exit 78
}
export FASED_VERSION="$runtime_version"
exec "${nodeBinary}" \
  --disable-warning=ExperimentalWarning \
  --disable-warning=DEP0040 \
  "$gateway_entry" gateway --allow-unconfigured --force --bind loopback --port "${gatewayPort}"
`;
  const operatorSocketFinalizer = `#!/usr/bin/env bash
set -euo pipefail
socket=${layout.operatorSocket}
for _ in {1..200}; do
  if [[ -S "$socket" && ! -L "$socket" ]]; then
    [[ "$(/usr/bin/stat -c %u "$socket")" == "${signerUid}" ]]
    /usr/bin/chown ${operatorUid}:${operatorGid} "$socket"
    /usr/bin/chmod 0600 "$socket"
    exit 0
  fi
  /usr/bin/sleep 0.1
done
echo "protected Local operator socket was not created" >&2
exit 1
`;

  return {
    schemaVersion: 1,
    layout,
    principals: {
      operatorUser,
      operatorUid,
      gatewayUid,
      signerUid,
      gatewayGid,
      operatorGid,
    },
    files: {
      gatewayUnit: {
        path: path.join("/etc/systemd/system", layout.gatewayUnit),
        mode: 0o644,
        content: gatewayUnit,
      },
      signerUnit: {
        path: path.join("/etc/systemd/system", layout.signerUnit),
        mode: 0o644,
        content: signerUnit,
      },
      controllerUnit: {
        path: path.join("/etc/systemd/system", layout.controllerUnit),
        mode: 0o644,
        content: controllerUnit,
      },
      supervisorUnit: {
        path: path.join("/etc/systemd/system", layout.supervisorUnit),
        mode: 0o644,
        content: supervisorUnit,
      },
      gatewayLauncher: {
        path: gatewayLaunch,
        mode: 0o755,
        content: gatewayLauncher,
      },
      operatorSocketFinalizer: {
        path: operatorSocketFinalize,
        mode: 0o755,
        content: operatorSocketFinalizer,
      },
    },
  };
}

async function main() {
  if (process.argv[2] === "--self-check") {
    process.stdout.write('{"schemaVersion":1,"role":"protected-local-service-plan"}\n');
    return;
  }
  throw new Error("protected-local-service-plan.mjs is a library used by the root installer");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `protected-local-service-plan: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
