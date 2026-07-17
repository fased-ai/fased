import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  applyHostedSignerOwnedWalletPolicy,
  configureSignerOwnedWalletNetwork,
} from "./signer-network-admin.js";

const cleanup: string[] = [];
const NETWORK_HASH = `hmac-sha256:${"a".repeat(64)}`;

afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

describe("signer-owned network administration", () => {
  it("uses the same-user local admin socket and sends RPC credentials only on stdin", async () => {
    const root = await temporaryRoot("fased-network-admin-local-");
    const argsPath = path.join(root, "args.txt");
    const stdinPath = path.join(root, "stdin.json");
    const envPath = path.join(root, "env.txt");
    const signer = path.join(root, "fased-signerd");
    await fs.writeFile(
      signer,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        `env > ${JSON.stringify(envPath)}`,
        'if [ "$3" = "get" ]; then',
        '  printf \'{"walletId":"agent_2","configured":false,"version":0,"ready":false}\\n\'',
        "else",
        `  cat > ${JSON.stringify(stdinPath)}`,
        `  printf '%s\\n' '${JSON.stringify({ walletId: "agent_2", configured: true, version: 1, hash: NETWORK_HASH, ready: true })}'`,
        "fi",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const rpcUrl = "https://rpc.example/solana?api-key=local-secret";
    const result = configureSignerOwnedWalletNetwork({
      walletId: "Agent-2",
      primaryRpcUrl: rpcUrl,
      env: {
        HOME: root,
        PATH: process.env.PATH,
        FASED_WALLET_SOLANA_RPC_URL: rpcUrl,
      },
      signerBinPath: signer,
      controlSocketPath: path.join(root, "control.sock"),
    });

    expect(result).toMatchObject({ walletId: "agent_2", version: 1, ready: true });
    const [args, input, childEnv] = await Promise.all([
      fs.readFile(argsPath, "utf8"),
      fs.readFile(stdinPath, "utf8"),
      fs.readFile(envPath, "utf8"),
    ]);
    expect(args).toContain("admin\nnetwork\nput\n");
    expect(args).toContain("agent_2");
    expect(args).not.toContain(rpcUrl);
    expect(input).toContain(rpcUrl);
    expect(JSON.parse(input)).toEqual({ expectedVersion: 0, primaryRpcUrl: rpcUrl });
    expect(childEnv).not.toContain("FASED_WALLET_SOLANA_RPC_URL");
    expect(childEnv).not.toContain("local-secret");
  });

  it("keeps hosted RPC activation fail-closed and emits only a root-console handoff", () => {
    const rpcUrl = "https://hosted.example/solana?token=hosted-secret";
    const result = configureSignerOwnedWalletNetwork({
      walletId: "agent",
      primaryRpcUrl: rpcUrl,
      env: {
        HOME: "/home/app",
        PATH: process.env.PATH,
        FASED_HOST_PROFILE: "hosting",
      },
    });

    expect(result).toEqual({
      walletId: "agent",
      configured: false,
      version: 0,
      ready: false,
      rootAdminRequired: true,
      rootCommand:
        "/usr/local/sbin/fased-signer-network --wallet-id agent --network-file /root/fased-network.json",
    });
    expect(JSON.stringify(result)).not.toContain(rpcUrl);
  });

  it("rejects a wrong next version without retrying and redacts provider credentials", async () => {
    const root = await temporaryRoot("fased-network-admin-version-");
    const signer = path.join(root, "fased-signerd");
    await fs.writeFile(
      signer,
      [
        "#!/bin/sh",
        'if [ "$3" = "get" ]; then',
        '  printf \'{"walletId":"agent","configured":false,"version":0,"ready":false}\\n\'',
        "else",
        "  cat >/dev/null",
        `  printf '%s\\n' '${JSON.stringify({ walletId: "agent", configured: true, version: 2, hash: NETWORK_HASH, ready: true })}'`,
        "fi",
      ].join("\n"),
      { mode: 0o700 },
    );
    expect(() =>
      configureSignerOwnedWalletNetwork({
        walletId: "agent",
        primaryRpcUrl: "https://rpc.example/?api-key=do-not-print",
        env: { HOME: root, PATH: process.env.PATH },
        signerBinPath: signer,
        controlSocketPath: path.join(root, "control.sock"),
      }),
    ).toThrow(/exact next ready version/);
    expect(
      __testing.redactSignerNetworkError(
        "provider https://rpc.example/?api-key=do-not-print token=also-secret",
        ["https://rpc.example/?api-key=do-not-print"],
      ),
    ).toBe("provider [redacted-rpc-url] token=[redacted]");
  });

  it("refuses every app-side hosted policy mutation", () => {
    const policy = {
      role: "agent" as const,
      operations: [],
      programs: [],
      assets: [],
    };
    expect(() => applyHostedSignerOwnedWalletPolicy({ walletId: "agent", policy })).toThrow(
      /root-only \/usr\/local\/sbin\/fased-signer-policy/,
    );
    expect(() =>
      applyHostedSignerOwnedWalletPolicy({
        walletId: "agent",
        policy: { ...policy, operations: ["agentSendNativeSol"] },
      }),
    ).toThrow(/deny-all/);
  });
});
