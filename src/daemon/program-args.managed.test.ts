import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayProgramArguments } from "./program-args.js";

function createManagedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-service-"));
  const stateDir = path.join(root, ".fased");
  const currentLink = path.join(stateDir, "runtime", "current");
  const releaseRoot = path.join(stateDir, "runtime", "releases", "1.2.3");
  const launcher = path.join(stateDir, "bin", "fased-service");
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.symlinkSync(releaseRoot, currentLink, "dir");
  fs.writeFileSync(
    path.join(stateDir, "install.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runtime: { currentLink },
      service: { launcher },
    })}\n`,
  );
  return { stateDir, currentLink, launcher };
}

describe("managed Gateway service arguments", () => {
  it("uses the stable launcher for Local services", async () => {
    const fixture = createManagedFixture();
    const result = await resolveGatewayProgramArguments({
      port: 18789,
      startupMode: "gateway",
      env: { ...process.env, FASED_STATE_DIR: fixture.stateDir },
    });

    expect(result).toEqual({
      programArguments: ["/bin/bash", fixture.launcher, "gateway", "--port", "18789"],
      workingDirectory: fixture.currentLink,
    });
  });

  it("uses the same stable launcher for Hosting managed-up services", async () => {
    const fixture = createManagedFixture();
    const result = await resolveGatewayProgramArguments({
      port: 18789,
      startupMode: "managed-up",
      env: { ...process.env, FASED_STATE_DIR: fixture.stateDir },
    });

    expect(result).toEqual({
      programArguments: ["/bin/bash", fixture.launcher, "managed"],
      workingDirectory: fixture.currentLink,
    });
  });
});
