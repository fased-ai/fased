import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeNativeSignerOperatorCapabilities } from "./native-signer-operator-client.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createNativeSignerFixture(stdout: string): {
  binaryPath: string;
  argsPath: string;
  socketPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-native-operator-client-"));
  tempDirs.push(root);
  const binaryPath = path.join(root, "fased-signerd");
  const argsPath = `${binaryPath}.args`;
  const socketPath = path.join(root, "operator.sock");
  fs.writeFileSync(
    binaryPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argsPath}"
printf '%s\\n' '${stdout}'
`,
    { mode: 0o700 },
  );
  return { binaryPath, argsPath, socketPath };
}

describe("native signer operator client", () => {
  it("uses the typed Go administrative capabilities command", () => {
    const fixture = createNativeSignerFixture(
      JSON.stringify({
        ready: true,
        capabilities: {
          protocol: { current: 2, min: 2, max: 2 },
          features: ["failClosedPolicies", "signerOwnedKeys", "atomicIdempotency"],
        },
      }),
    );
    const result = invokeNativeSignerOperatorCapabilities({
      signerBinPath: fixture.binaryPath,
      operatorSocketPath: fixture.socketPath,
      env: { HOME: path.dirname(fixture.binaryPath) },
    });
    expect(result.ready).toBe(true);
    expect(result.capabilities.protocol).toEqual({ current: 2, min: 2, max: 2 });
    expect(fs.readFileSync(fixture.argsPath, "utf8").trim().split("\n")).toEqual([
      "admin",
      "service",
      "capabilities",
      "--operator-socket",
      fixture.socketPath,
    ]);
  });

  it("fails closed on malformed capability output", () => {
    const fixture = createNativeSignerFixture(JSON.stringify({ ready: true }));
    expect(() =>
      invokeNativeSignerOperatorCapabilities({
        signerBinPath: fixture.binaryPath,
        operatorSocketPath: fixture.socketPath,
      }),
    ).toThrow(/protocol v2 readiness/);
  });
});
