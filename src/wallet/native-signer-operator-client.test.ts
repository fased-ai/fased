import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokeNativeSignerOperatorCapabilities,
  invokeNativeSignerOperatorHealth,
  invokeNativeSignerRPCProfileBind,
  invokeNativeSignerRPCProfileCreate,
  invokeNativeSignerRPCProfileList,
} from "./native-signer-operator-client.js";

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

  it("uses the typed Go administrative health command", () => {
    const fixture = createNativeSignerFixture(
      JSON.stringify({
        details: "fased-signerd protocol-v2 ready",
        ready: true,
        release: {
          version: "dev",
          commit: "unknown",
          buildInputDigest: "unknown",
          development: true,
        },
        network: {
          ready: true,
          wallets: [
            {
              walletId: "agent",
              configured: true,
              version: 3,
              ready: true,
            },
          ],
        },
      }),
    );
    const result = invokeNativeSignerOperatorHealth({
      signerBinPath: fixture.binaryPath,
      operatorSocketPath: fixture.socketPath,
      env: { HOME: path.dirname(fixture.binaryPath) },
    });
    expect(result).toMatchObject({
      ok: true,
      details: "fased-signerd protocol-v2 ready",
      ready: true,
      network: { ready: true },
    });
    expect(fs.readFileSync(fixture.argsPath, "utf8").trim().split("\n")).toEqual([
      "admin",
      "service",
      "health",
      "--operator-socket",
      fixture.socketPath,
    ]);
  });

  it("fails closed on malformed health output", () => {
    const fixture = createNativeSignerFixture(JSON.stringify({ ready: true }));
    expect(() =>
      invokeNativeSignerOperatorHealth({
        signerBinPath: fixture.binaryPath,
        operatorSocketPath: fixture.socketPath,
      }),
    ).toThrow(/invalid protocol v2 result/);
  });

  it("uses typed operator commands for RPC profile list, create, and bind", () => {
    const profile = {
      profileId: "devnet-primary",
      name: "Devnet Primary",
      chain: "solana" as const,
      cluster: "devnet" as const,
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", // pragma: allowlist secret
      commitment: "finalized" as const,
      version: 1 as const,
      hash: `hmac-sha256:${"a".repeat(64)}`,
      endpointCount: 1,
      ready: true as const,
    };
    const listFixture = createNativeSignerFixture(JSON.stringify([profile]));
    expect(
      invokeNativeSignerRPCProfileList({
        signerBinPath: listFixture.binaryPath,
        operatorSocketPath: listFixture.socketPath,
      }),
    ).toEqual([profile]);
    expect(fs.readFileSync(listFixture.argsPath, "utf8").trim().split("\n")).toEqual([
      "admin",
      "rpc-profile",
      "list",
      "--operator-socket",
      listFixture.socketPath,
    ]);

    const createFixture = createNativeSignerFixture(JSON.stringify(profile));
    expect(
      invokeNativeSignerRPCProfileCreate({
        signerBinPath: createFixture.binaryPath,
        operatorSocketPath: createFixture.socketPath,
        profileId: profile.profileId,
        name: profile.name,
        primaryRpcUrl: "https://api.devnet.solana.com",
      }),
    ).toEqual(profile);

    const binding = {
      walletId: "profile",
      profileId: profile.profileId,
      profileVersion: 1,
      profileHash: profile.hash,
      networkVersion: 1,
      networkHash: `hmac-sha256:${"b".repeat(64)}`,
      genesisHash: profile.genesisHash,
      ready: true as const,
    };
    const bindFixture = createNativeSignerFixture(JSON.stringify(binding));
    expect(
      invokeNativeSignerRPCProfileBind({
        signerBinPath: bindFixture.binaryPath,
        operatorSocketPath: bindFixture.socketPath,
        walletId: binding.walletId,
        profile,
      }),
    ).toEqual(binding);
    expect(fs.readFileSync(bindFixture.argsPath, "utf8").trim().split("\n")).toEqual([
      "admin",
      "rpc-profile",
      "bind",
      "--wallet-id",
      binding.walletId,
      "--profile-id",
      profile.profileId,
      "--profile-version",
      "1",
      "--profile-hash",
      profile.hash,
      "--operator-socket",
      bindFixture.socketPath,
    ]);
  });

  it("fails closed on malformed RPC profile output", () => {
    const fixture = createNativeSignerFixture(JSON.stringify([{ profileId: "devnet-primary" }]));
    expect(() =>
      invokeNativeSignerRPCProfileList({
        signerBinPath: fixture.binaryPath,
        operatorSocketPath: fixture.socketPath,
      }),
    ).toThrow(/invalid result/);
  });
});
