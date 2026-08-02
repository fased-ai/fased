import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProtectedLocalServicePlan } from "./protected-local-service-plan.mjs";

const fixture = fs.readFileSync(
  new URL("./protected-local-t2-systemd-fixture.mjs", import.meta.url),
  "utf8",
);

describe("minimal Protected Local T2 generated-unit fixture", () => {
  it("uses production-generated units without full installation machinery", () => {
    expect(fixture).toContain("buildProtectedLocalServicePlan");
    expect(fixture).toContain('systemctl("enable", layout.controllerUnit)');
    expect(fixture).toContain('systemctl("enable", layout.supervisorUnit)');
    expect(fixture).toContain('systemctl("restart", layout.supervisorUnit)');
    expect(fixture).toContain('"recoveryStatus"');
    expect(fixture).toContain('"recoverActive"');
    expect(fixture).toContain('pending.recovery?.state, "RECOVERY_PENDING"');
    expect(fixture).toContain("firstWorkerStartFailed: true");
    expect(fixture).toContain("publicRecoveryPending: true");
    expect(fixture).toContain("exactRecoveryRollback: true");
    expect(fixture).toContain('"applyRelease"');
    expect(fixture).toContain("productCommit: true");
    expect(fixture).toContain("restartRecoveryReady: true");
    expect(fixture).toContain("controller unexpectedly wrote");
    expect(fixture).toContain('fsp.chown(path.join(generation, "fased-host-updater.mjs"), 0, 0)');
    expect(fixture).toContain(
      'const failureMarker = path.join(layout.controllerStateDir, "t2-fail-once")',
    );
    expect(fixture).toContain("ownerInstallationTouched: false");
    expect(fixture).toContain("freshProductInstallationCreated: false");
    expect(fixture).toContain("packageBootstrapRun: false");
    expect(fixture).toContain("createRootFixtureRoot(instanceId)");
    expect(fixture).toContain("parentInfo.isSymbolicLink()");
    expect(fixture).toContain("fsp.mkdtemp(path.join(parent, `.fased-t2-${instanceId}-`))");
    expect(fixture).toContain(
      "BindReadOnlyPaths=${registryRoot}:/var/lib/fased-local-registry ${fixtureHome}:${operator.home}",
    );
    expect(fixture).toContain("BindPaths=${fixtureHome}:${operator.home}");
    expect(fixture.indexOf("for (const fixedPath of fixedPaths)")).toBeLessThan(
      fixture.indexOf("const fixtureRoot = await createRootFixtureRoot(instanceId)"),
    );
    expect(fixture).not.toContain('fsp.chown(path.join(operator.home, ".fased-t2")');
    expect(fixture).not.toContain("/var/lib/fased-t2/");
    expect(fixture).not.toContain("podman");
    expect(fixture).not.toContain("docker");
    expect(fixture).not.toContain("apt-get");
    expect(fixture).not.toContain("dnf");
    expect(fixture).not.toContain("useradd");
    expect(fixture).not.toContain("pnpm");
    expect(fixture).not.toContain("npm");
  });

  it("retains the exact production controller and supervisor sandbox contract", () => {
    const plan = buildProtectedLocalServicePlan({
      instanceId: "0123456789abcdef",
      operatorUid: 1000,
      operatorUser: "alice",
      operatorHome: "/var/lib/fased-t2/operator",
      appStateDir: "/var/lib/fased-t2/operator/.fased",
      repoDir: "/opt/fased/local/0123456789abcdef/application/current",
      gatewayUid: 61001,
      signerUid: 61002,
      gatewayGid: 62001,
      operatorGid: 1000,
      nodeBinary: "/usr/bin/node",
    });
    expect(plan.files.controllerUnit.content).toContain("ProtectSystem=strict");
    expect(plan.files.controllerUnit.content).toContain(
      "ReadOnlyPaths=/opt/fased/local/0123456789abcdef/controller", // pragma: allowlist secret
    );
    expect(plan.files.controllerUnit.content).toContain(
      "/etc/systemd/system/fased-local-controller-worker-0123456789abcdef.service.d",
    );
    expect(plan.files.supervisorUnit.content).toContain("CapabilityBoundingSet=CAP_CHOWN");
  });
});
