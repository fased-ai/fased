import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  buildHostedSystemdUnit,
  findHostedSystemdUnitPath,
  parseProtectedLocalSystemdTarget,
  resolveRootManagedSystemdTarget,
} from "./systemd-system.js";

describe("hosted systemd unit", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("builds the root-managed service shape accepted by the hosted installer helper", () => {
    const unit = buildHostedSystemdUnit({
      runAsUser: "app",
      programArguments: [
        "/bin/bash",
        "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
      ],
      workingDirectory: "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased",
      environment: {
        FASED_GATEWAY_MODE: "managed",
        FASED_MANAGED_INTERNAL: "1",
        FASED_GATEWAY_PORT: "18789",
      },
    });

    expect(unit).toContain("User=app");
    expect(unit).toContain("Group=app");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("After=fased-signerd.service");
    expect(unit).toContain("Wants=fased-signerd.service");
    expect(unit).toContain("Environment=FASED_HOST_PROFILE=hosting");
    expect(unit).toContain("Environment=FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external");
    expect(unit).toContain(
      "Environment=FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock",
    );
    expect(unit).not.toContain("FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain(
      "ExecStart=/bin/bash /home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
    );
  });

  it.runIf(process.platform === "linux")("finds a root-managed gateway unit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-system-service-"));
    roots.push(root);
    const unitPath = path.join(root, "fased-gateway.service");
    await fs.writeFile(unitPath, "[Unit]\n", "utf8");

    expect(findHostedSystemdUnitPath([path.join(root, "missing"), unitPath])).toBe(unitPath);
  });

  it("reads the hosted command and environment from the system unit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-system-service-"));
    roots.push(root);
    const unitPath = path.join(root, "fased-gateway.service");
    await fs.writeFile(
      unitPath,
      [
        "[Service]",
        "ExecStart=/bin/bash /home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
        "WorkingDirectory=/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased",
        "Environment=FASED_GATEWAY_PORT=18789",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(__testing.readRootManagedSystemdCommand(unitPath)).resolves.toMatchObject({
      programArguments: [
        "/bin/bash",
        "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
      ],
      environment: { FASED_GATEWAY_PORT: "18789" },
      sourcePath: unitPath,
    });
  });

  it("waits for the hosted service restart transaction to finish", () => {
    expect(__testing.buildRootManagedSystemctlControlArgs("restart")).toEqual([
      "restart",
      "fased-gateway.service",
    ]);
    expect(__testing.buildRootManagedSystemctlControlArgs("stop")).toEqual([
      "stop",
      "fased-gateway.service",
    ]);
  });

  it("accepts only an exact protected Local system service identity", () => {
    expect(
      parseProtectedLocalSystemdTarget(
        {
          schemaVersion: 2,
          profile: "protected-local",
          service: {
            name: "fased-gateway-0123456789abcdef.service",
            scope: "system",
          },
        },
        "/test/system",
      ),
    ).toEqual({
      profile: "protected-local",
      serviceName: "fased-gateway-0123456789abcdef.service",
      unitPath: "/test/system/fased-gateway-0123456789abcdef.service",
      updaterSocketPath: "/run/fased-local-controller/0123456789abcdef/request.sock",
    });
    for (const service of [
      { name: "fased-gateway.service", scope: "system" },
      { name: "fased-gateway-0123456789abcdef.service", scope: "user" },
      { name: "fased-gateway-../../root.service", scope: "system" },
    ]) {
      expect(
        parseProtectedLocalSystemdTarget({
          schemaVersion: 2,
          profile: "protected-local",
          service,
        }),
      ).toBeNull();
    }
  });

  it("resolves the protected Local unit and controller from the managed manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-protected-service-"));
    roots.push(root);
    const manifestPath = path.join(root, "install.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        profile: "protected-local",
        runtime: { activeVersion: "1.2.3" },
        service: {
          name: "fased-gateway-fedcba9876543210.service",
          scope: "system",
        },
      }),
      "utf8",
    );

    expect(
      resolveRootManagedSystemdTarget({
        env: { HOME: root },
        manifestPath,
        unitRoot: path.join(root, "system"),
        hostedCandidates: [],
      }),
    ).toEqual({
      profile: "protected-local",
      serviceName: "fased-gateway-fedcba9876543210.service",
      unitPath: path.join(root, "system", "fased-gateway-fedcba9876543210.service"),
      updaterSocketPath: "/run/fased-local-controller/fedcba9876543210/request.sock",
    });
  });
});
