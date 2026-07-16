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
const POLICY_HASH = `sha256:${"b".repeat(64)}`;

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

  it("uses the one-shot hosted bootstrap and keeps the RPC URL out of argv", async () => {
    const root = await temporaryRoot("fased-network-admin-hosted-");
    const argsPath = path.join(root, "args.txt");
    const stdinPath = path.join(root, "stdin.json");
    const bootstrap = path.join(root, "bootstrap.mjs");
    await fs.writeFile(
      bootstrap,
      [
        'import fs from "node:fs";',
        "let input = '';",
        "for await (const chunk of process.stdin) input += String(chunk);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, process.argv.slice(2).join('\\n'));`,
        `fs.writeFileSync(${JSON.stringify(stdinPath)}, input);`,
        `process.stdout.write(${JSON.stringify(`${JSON.stringify({ walletId: "agent", configured: true, version: 1, hash: NETWORK_HASH, ready: true })}\n`)});`,
      ].join("\n"),
      "utf8",
    );
    const rpcUrl = "https://hosted.example/solana?token=hosted-secret";
    const result = configureSignerOwnedWalletNetwork({
      walletId: "agent",
      primaryRpcUrl: rpcUrl,
      env: {
        HOME: root,
        PATH: process.env.PATH,
        FASED_HOST_PROFILE: "hosting",
        FASED_HOST_BOOTSTRAP_CTL: bootstrap,
        FASED_HOST_BOOTSTRAP_SOCKET: "/run/fased-host-bootstrap/control.sock",
      },
    });

    expect(result.ready).toBe(true);
    const [args, input] = await Promise.all([
      fs.readFile(argsPath, "utf8"),
      fs.readFile(stdinPath, "utf8"),
    ]);
    expect(args).toBe("signer-network-put");
    expect(args).not.toContain(rpcUrl);
    expect(JSON.parse(input)).toMatchObject({
      schemaVersion: 1,
      walletId: "agent",
      primaryRpcUrl: rpcUrl,
    });
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

  it("exposes a stdin-only hosted policy hook without selecting permissions", async () => {
    const root = await temporaryRoot("fased-policy-admin-hosted-");
    const argsPath = path.join(root, "args.txt");
    const stdinPath = path.join(root, "stdin.json");
    const bootstrap = path.join(root, "bootstrap.mjs");
    await fs.writeFile(
      bootstrap,
      [
        'import fs from "node:fs";',
        "let input = '';",
        "for await (const chunk of process.stdin) input += String(chunk);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, process.argv.slice(2).join('\\n'));`,
        `fs.writeFileSync(${JSON.stringify(stdinPath)}, input);`,
        `process.stdout.write(${JSON.stringify(`${JSON.stringify({ walletId: "agent", role: "agent", version: 2, hash: POLICY_HASH })}\n`)});`,
      ].join("\n"),
      "utf8",
    );
    const policy = {
      role: "agent" as const,
      operations: [],
      programs: [],
      assets: [],
    };
    const result = applyHostedSignerOwnedWalletPolicy({
      walletId: "agent",
      policy,
      env: {
        HOME: root,
        PATH: process.env.PATH,
        FASED_HOST_BOOTSTRAP_CTL: bootstrap,
      },
    });
    expect(result).toEqual({ walletId: "agent", role: "agent", version: 2, hash: POLICY_HASH });
    expect(await fs.readFile(argsPath, "utf8")).toBe("signer-policy-put");
    const input = JSON.parse(await fs.readFile(stdinPath, "utf8"));
    expect(input).toMatchObject({ schemaVersion: 1, walletId: "agent" });
    expect(JSON.parse(input.policyJson)).toEqual({ ...policy, walletId: "agent" });
    expect(() =>
      applyHostedSignerOwnedWalletPolicy({
        walletId: "agent",
        policy: { ...policy, operations: ["agentSendNativeSol"] },
        env: { FASED_HOST_BOOTSTRAP_CTL: bootstrap },
      }),
    ).toThrow(/deny-all/);
  });
});
