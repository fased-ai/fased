import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProtectedLocalServicePlan } from "./protected-local-service-plan.mjs";

const startManaged = fs.readFileSync(new URL("./start-managed.sh", import.meta.url), "utf8");

function plan() {
  return buildProtectedLocalServicePlan({
    instanceId: "0123456789abcdef",
    operatorUid: 1000,
    operatorUser: "alice",
    operatorHome: "/home/alice",
    appStateDir: "/home/alice/.fased",
    repoDir: "/opt/fased/local/0123456789abcdef/application/current",
    gatewayUid: 61001,
    signerUid: 61002,
    gatewayGid: 62001,
    operatorGid: 62002,
    nodeBinary: "/usr/bin/node",
  });
}

describe("Protected Local service plan", () => {
  it("separates operator, Gateway, signer, and controller authorities", () => {
    const result = plan();
    const gateway = result.files.gatewayUnit.content;
    const signer = result.files.signerUnit.content;
    const controller = result.files.controllerUnit.content;
    expect(gateway).toContain("User=fsgw-0123456789abcdef");
    expect(gateway).toContain("SupplementaryGroups=fscf-0123456789abcdef"); // pragma: allowlist secret
    expect(gateway).not.toContain("fsop-0123456789abcdef");
    expect(gateway).toContain(
      "FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-local/0123456789abcdef/application/app.sock",
    );
    expect(gateway).toContain("FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external");
    expect(gateway).toContain(
      "FASED_PLUGIN_STATUS_CACHE_PATH=/home/alice/.fased/cache/plugin-status.json",
    );
    expect(gateway).toContain(
      "WorkingDirectory=/opt/fased/local/0123456789abcdef/application/current", // pragma: allowlist secret
    );
    expect(gateway).toContain(
      "FASED_MANAGED_RUNTIME_ROOT=/opt/fased/local/0123456789abcdef/application/current", // pragma: allowlist secret
    );
    expect(gateway).toContain("FASED_NODE_BIN=/usr/bin/node");
    expect(gateway).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
    expect(gateway).toContain("Environment=FASED_RUNTIME_SOURCE=managed-package");
    expect(gateway).toContain(
      "ExecStartPre=/usr/bin/test -s /var/lib/fased-local/0123456789abcdef/controller/gateway-activation-ready",
    );
    expect(gateway).toContain("ExecStartPre=/usr/bin/test -s /home/alice/.fased/fased.json");
    expect(result.files.gatewayLauncher.content).not.toContain("while [[");
    expect(result.files.gatewayLauncher.content).toContain(
      "protected Local Gateway activation marker is unavailable",
    );
    expect(result.files.gatewayLauncher.content).toContain(
      "protected Local Gateway configuration is unavailable",
    );
    expect(result.files.gatewayLauncher.content).toContain('exec "/usr/bin/node"');
    expect(result.files.gatewayLauncher.content).toContain(
      'gateway --allow-unconfigured --force --bind loopback --port "18789"',
    );
    expect(result.files.gatewayLauncher.content).toContain(
      'export FASED_VERSION="$runtime_version"',
    );
    expect(result.files.gatewayLauncher.content).toContain(
      "protected Local Gateway release identity is unavailable or inconsistent",
    );
    expect(result.files.gatewayLauncher.content).not.toContain("scripts/start-managed.sh");
    expect(signer).toContain("User=fssg-0123456789abcdef");
    expect(signer).toContain("SupplementaryGroups=fsgw-0123456789abcdef fsop-0123456789abcdef");
    expect(signer).toContain("-application-uid 61001");
    expect(signer).toContain("-operator-uid 1000");
    expect(signer).toContain("-control-uid 61002");
    expect(signer).toContain(
      "ExecStartPost=+/opt/fased/local/0123456789abcdef/operator-socket-finalize", // pragma: allowlist secret
    );
    expect(signer).toContain("-state-db /var/lib/fased-local/0123456789abcdef/signer/state.db");
    expect(signer).toContain("-master-key /var/lib/fased-local/0123456789abcdef/signer/master.key");
    expect(controller).toContain("User=root");
    expect(controller).toContain("StateDirectory=fased-local/0123456789abcdef/controller"); // pragma: allowlist secret
    expect(controller).toContain("--socket-uid 1000 --socket-gid 62002");
    expect(controller).toContain("RuntimeDirectoryMode=0711");
    expect(controller).toContain("StateDirectoryMode=0711");
    expect(result.files.operatorSocketFinalizer.content).toContain("/usr/bin/chown 1000:62002");
    expect(result.files.operatorSocketFinalizer.content).toContain("/usr/bin/chmod 0600");
  });

  it("keeps the Gateway loopback-only and hardens both long-running services", () => {
    const result = plan();
    const gateway = result.files.gatewayUnit.content;
    const signer = result.files.signerUnit.content;
    expect(gateway).toContain("FASED_GATEWAY_PORT=18789");
    expect(gateway).toContain("FASED_HOST_PROFILE=local");
    expect(gateway).toContain("NoNewPrivileges=true");
    expect(gateway).toContain("ProtectSystem=strict");
    expect(gateway).toContain("CapabilityBoundingSet=");
    expect(signer).toContain("NoNewPrivileges=true");
    expect(signer).toContain("ProtectSystem=strict");
    expect(signer).toContain("CapabilityBoundingSet=");
    expect(signer).toContain("FASED_WALLET_WEBAUTHN_RP_ID=localhost");
    expect(signer).toContain(
      "FASED_WALLET_WEBAUTHN_ORIGINS=http://localhost:18789,http://localhost:18791",
    );
  });

  it("uses the protected application socket without launching a same-user signer", () => {
    expect(startManaged).toContain(
      'if [[ "${FASED_HOST_PROFILE:-}" == "hosting" || "${FASED_PROTECTED_LOCAL:-0}" == "1" ]]',
    );
    expect(startManaged).toContain(
      'SIGNERD_SOCKET="${FASED_WALLET_LOCAL_SIGNER_SOCKET:?Protected Local requires its root-managed application socket}"',
    );
    expect(startManaged).toContain('[[ "${FASED_PROTECTED_LOCAL:-0}" != "1" ]] || return 1');
  });

  it("rejects overlapping identities and untrusted paths", () => {
    expect(() =>
      buildProtectedLocalServicePlan({
        instanceId: "0123456789abcdef",
        operatorUid: 1000,
        operatorUser: "alice",
        operatorHome: "/home/alice",
        appStateDir: "/home/alice/.fased",
        repoDir: "/tmp/user-controlled",
        gatewayUid: 1000,
        signerUid: 61002,
        gatewayGid: 62001,
        operatorGid: 62002,
        nodeBinary: "/usr/bin/node",
      }),
    ).toThrow(/root-controlled current release|must be distinct/);
  });
});
