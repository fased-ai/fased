import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProtectedLocalLayout,
  loadOrAllocateProtectedLocalInstance,
  removeProtectedLocalInstance,
} from "./protected-local-layout.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-protected-local-layout-"));
  tempDirs.push(root);
  const registryDir = path.join(root, "registry");
  const stateDir = path.join(root, "operator-state");
  fs.mkdirSync(registryDir, { mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  return {
    root,
    registryPath: path.join(registryDir, "instances.json"),
    stateDir,
  };
}

describe("protected Local instance allocation", () => {
  it("allocates one stable root-controlled namespace per operator/profile/state identity", () => {
    const setup = fixture();
    const params = {
      registryPath: setup.registryPath,
      operatorUid: process.getuid!(),
      operatorUser: "alice",
      profile: "default",
      stateDir: setup.stateDir,
      expectedOwnerUid: process.getuid!(),
    };
    const first = loadOrAllocateProtectedLocalInstance(params);
    const second = loadOrAllocateProtectedLocalInstance(params);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry).toEqual(first.entry);
    expect(first.entry.instanceId).toMatch(/^[a-f0-9]{16}$/u);
    expect(fs.statSync(setup.registryPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(setup.registryPath, "utf8")).instances).toHaveLength(1);
  });

  it("isolates profiles and users without copying profile text into privileged names", () => {
    const setup = fixture();
    const common = {
      registryPath: setup.registryPath,
      operatorUid: process.getuid!(),
      operatorUser: "alice",
      stateDir: setup.stateDir,
      expectedOwnerUid: process.getuid!(),
    };
    const first = loadOrAllocateProtectedLocalInstance({ ...common, profile: "main wallet" });
    const otherProfile = loadOrAllocateProtectedLocalInstance({
      ...common,
      profile: "../../hostile profile",
    });
    const otherStateDir = path.join(setup.root, "other-state");
    fs.mkdirSync(otherStateDir, { mode: 0o700 });
    const otherState = loadOrAllocateProtectedLocalInstance({
      ...common,
      profile: "main wallet",
      stateDir: otherStateDir,
    });
    expect(
      new Set([first.entry.instanceId, otherProfile.entry.instanceId, otherState.entry.instanceId])
        .size,
    ).toBe(3);
    for (const result of [first, otherProfile, otherState]) {
      expect(JSON.stringify(result.layout)).not.toContain("hostile");
      expect(result.layout.applicationSocket).toContain(result.entry.instanceId);
      expect(result.layout.gatewayUnit).toContain(result.entry.instanceId);
      expect(result.layout.controllerTransaction).toContain(result.entry.instanceId);
    }
  });

  it("rejects linked or group-accessible registry state", () => {
    const setup = fixture();
    fs.writeFileSync(setup.registryPath, '{"schemaVersion":1,"instances":[]}\n', { mode: 0o640 });
    expect(() =>
      loadOrAllocateProtectedLocalInstance({
        registryPath: setup.registryPath,
        operatorUid: process.getuid!(),
        operatorUser: "alice",
        profile: "default",
        stateDir: setup.stateDir,
        expectedOwnerUid: process.getuid!(),
      }),
    ).toThrow(/owner-only/);
  });

  it("removes only the exact failed allocation during transactional rollback", () => {
    const setup = fixture();
    const params = {
      registryPath: setup.registryPath,
      operatorUid: process.getuid!(),
      operatorUser: "alice",
      profile: "default",
      stateDir: setup.stateDir,
      expectedOwnerUid: process.getuid!(),
    };
    const allocated = loadOrAllocateProtectedLocalInstance(params);
    expect(
      removeProtectedLocalInstance({
        registryPath: setup.registryPath,
        instanceId: allocated.entry.instanceId,
        expectedOwnerUid: process.getuid!(),
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(setup.registryPath, "utf8")).instances).toHaveLength(0);
    expect(
      removeProtectedLocalInstance({
        registryPath: setup.registryPath,
        instanceId: allocated.entry.instanceId,
        expectedOwnerUid: process.getuid!(),
      }),
    ).toBe(false);
  });

  it("derives all privileged paths only from the random instance identifier", () => {
    const layout = buildProtectedLocalLayout("0123456789abcdef", {
      runtimeRoot: "/run/test",
      stateRoot: "/var/lib/test",
      installRoot: "/opt/test",
    });
    expect(layout).toMatchObject({
      gatewayUser: "fsgw-0123456789abcdef",
      signerUser: "fssg-0123456789abcdef",
      gatewayUnit: "fased-gateway-0123456789abcdef.service",
      signerUnit: "fased-signerd-0123456789abcdef.service",
      applicationSocket: "/run/test/0123456789abcdef/application/app.sock",
      operatorSocket: "/run/test/0123456789abcdef/operator/operator.sock",
      controlSocket: "/run/test/0123456789abcdef/control/control.sock",
      signerStateDir: "/var/lib/test/0123456789abcdef/signer",
      installDir: "/opt/test/0123456789abcdef",
      supervisorBinary: "/opt/test/0123456789abcdef/supervisor/fased-lifecycle-supervisor.mjs",
      supervisorClient: "/opt/test/0123456789abcdef/libexec/fased-host-updaterctl.mjs",
      legacySupervisorClient: "/opt/test/0123456789abcdef/supervisor/fased-host-updaterctl.mjs",
    });
  });
});
