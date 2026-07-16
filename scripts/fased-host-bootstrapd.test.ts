import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseBootstrapRequest,
  parseSignerNetworkBootstrapInput,
  parseSignerPolicyBootstrapInput,
  redactBootstrapSensitiveError,
  runSignerNetworkPutAction,
  runSignerPolicyPutAction,
  runSignerWebAuthnTailscaleAction,
  validateGatewayUnit,
  validateSignerWebAuthnConfiguration,
} from "./fased-host-bootstrapd.mjs";

const NETWORK_HASH = `hmac-sha256:${"a".repeat(64)}`;
const POLICY_HASH = `sha256:${"b".repeat(64)}`;

const validUnit = [
  "[Unit]",
  "Description=Fased Gateway (managed)",
  "After=fased-signerd.service",
  "Wants=fased-signerd.service",
  "[Service]",
  "Type=simple",
  "User=app",
  "Group=app",
  "ExecStart=/bin/bash /home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
  "Restart=always",
  "RestartSec=5",
  "KillMode=process",
  "WorkingDirectory=/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased",
  "Environment=FASED_GATEWAY_MODE=managed",
  "Environment=FASED_MANAGED_INTERNAL=1",
  "Environment=FASED_GATEWAY_PORT=18789",
  "Environment=FASED_HOST_PROFILE=hosting",
  "Environment=FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock",
  "UMask=0077",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "PrivateDevices=true",
  "ProtectSystem=strict",
  "ProtectHome=read-only",
  "ReadWritePaths=/home/app/.fased",
  "ProtectKernelTunables=true",
  "ProtectKernelModules=true",
  "ProtectKernelLogs=true",
  "ProtectControlGroups=true",
  "ProtectClock=true",
  "ProtectHostname=true",
  "LockPersonality=true",
  "RestrictSUIDSGID=true",
  "RestrictRealtime=true",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "SystemCallArchitectures=native",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

describe("temporary hosted root bootstrap", () => {
  it("accepts only the fixed request envelope", () => {
    expect(
      parseBootstrapRequest({ schemaVersion: 1, action: "gateway-install", input: validUnit }),
    ).toEqual({ schemaVersion: 1, action: "gateway-install", input: validUnit });
    for (const extra of [
      { command: "sh" },
      { path: "/tmp/unit" },
      { env: { LD_PRELOAD: "/tmp/payload" } },
    ]) {
      expect(() =>
        parseBootstrapRequest({
          schemaVersion: 1,
          action: "gateway-restart",
          input: "",
          ...extra,
        }),
      ).toThrow("unsupported bootstrap request fields");
    }
  });

  it("accepts the generated managed unit", () => {
    expect(() => validateGatewayUnit(validUnit, "app")).not.toThrow();
  });

  it("rejects arbitrary commands, users, environment and lifecycle hooks", () => {
    for (const [needle, replacement] of [
      ["User=app", "User=fased-signer"],
      [
        "ExecStart=/bin/bash /home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased/scripts/start-managed.sh",
        "ExecStart=/bin/bash /tmp/payload.sh",
      ],
      ["Environment=FASED_GATEWAY_MODE=managed", "Environment=LD_PRELOAD=/tmp/payload.so"],
      ["NoNewPrivileges=true", "NoNewPrivileges=false"],
      ["ProtectSystem=strict", "ProtectSystem=false"],
      ["ReadWritePaths=/home/app/.fased", "ReadWritePaths=/"],
      ["CapabilityBoundingSet=", "CapabilityBoundingSet=CAP_SYS_ADMIN"],
      ["Restart=always", "ExecStartPost=/bin/bash /tmp/payload.sh"],
    ] as const) {
      expect(() => validateGatewayUnit(validUnit.replace(needle, replacement), "app")).toThrow();
    }
  });

  it("rejects duplicate authority-defining fields", () => {
    expect(() =>
      validateGatewayUnit(validUnit.replace("User=app", "User=app\nUser=app"), "app"),
    ).toThrow("must occur once");
  });

  it("accepts only strict versioned signer network input", () => {
    const input = JSON.stringify({
      schemaVersion: 1,
      walletId: "agent",
      primaryRpcUrl: "https://rpc.example/solana?api-key=secret",
    });
    expect(parseSignerNetworkBootstrapInput(input)).toMatchObject({
      schemaVersion: 1,
      walletId: "agent",
    });
    expect(() =>
      parseSignerNetworkBootstrapInput(
        '{"schemaVersion":1,"walletId":"agent","walletId":"vault","primaryRpcUrl":"https://rpc.example"}',
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      parseSignerNetworkBootstrapInput(
        JSON.stringify({
          schemaVersion: 2,
          walletId: "agent",
          primaryRpcUrl: "https://rpc.example",
        }),
      ),
    ).toThrow(/schema version/);
    expect(() =>
      parseSignerNetworkBootstrapInput(
        JSON.stringify({
          schemaVersion: 1,
          walletId: "Agent-1",
          primaryRpcUrl: "https://rpc.example",
        }),
      ),
    ).toThrow(/normalized/);
  });

  it("gets the exact current version then puts the hosted network through signer stdin", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string; env?: object }> = [];
    const secretUrl = "https://rpc.example/solana?api-key=secret";
    const result = await runSignerNetworkPutAction(
      JSON.stringify({ schemaVersion: 1, walletId: "agent", primaryRpcUrl: secretUrl }),
      "fased-signer",
      {
        runFile: async (
          command: string,
          args: string[],
          options: { input?: string; env?: object },
        ) => {
          calls.push({ command, args, ...options });
          return args.includes("get")
            ? {
                stdout: '{"walletId":"agent","configured":false,"version":0,"ready":false}\n',
                stderr: "",
              }
            : {
                stdout: `${JSON.stringify({ walletId: "agent", configured: true, version: 1, hash: NETWORK_HASH, ready: true })}\n`,
                stderr: "",
              };
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, ready: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("get");
    expect(calls[1]?.args).toContain("put");
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(secretUrl);
    expect(JSON.parse(calls[1]?.input ?? "{}")).toEqual({
      expectedVersion: 0,
      primaryRpcUrl: secretUrl,
    });
    expect(JSON.stringify(calls[1]?.env)).not.toContain("RPC");
  });

  it("repairs an existing hosted network using its durable current version", async () => {
    const inputs: string[] = [];
    const result = await runSignerNetworkPutAction(
      JSON.stringify({
        schemaVersion: 1,
        walletId: "agent",
        primaryRpcUrl: "https://replacement-rpc.example/solana",
      }),
      "fased-signer",
      {
        runFile: async (_command: string, args: string[], options: { input?: string }) => {
          if (options.input) {
            inputs.push(options.input);
          }
          return args.includes("get")
            ? {
                stdout: `${JSON.stringify({ walletId: "agent", configured: true, version: 7, hash: NETWORK_HASH, ready: true })}\n`,
                stderr: "",
              }
            : {
                stdout: `${JSON.stringify({ walletId: "agent", configured: true, version: 8, hash: NETWORK_HASH, ready: true })}\n`,
                stderr: "",
              };
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 8, ready: true });
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0] ?? "{}")).toMatchObject({ expectedVersion: 7 });
  });

  it("fails a hosted network version mismatch without exposing the RPC credential", async () => {
    const secretUrl = "https://rpc.example/solana?token=do-not-print";
    await expect(
      runSignerNetworkPutAction(
        JSON.stringify({ schemaVersion: 1, walletId: "agent", primaryRpcUrl: secretUrl }),
        "fased-signer",
        {
          runFile: async (_command: string, args: string[]) =>
            args.includes("get")
              ? {
                  stdout: '{"walletId":"agent","configured":false,"version":0,"ready":false}\n',
                  stderr: "",
                }
              : {
                  stdout: `${JSON.stringify({ walletId: "agent", configured: true, version: 2, hash: NETWORK_HASH, ready: true })}\n`,
                  stderr: "",
                },
        },
      ),
    ).rejects.toThrow(/exact next ready version/);
    expect(
      redactBootstrapSensitiveError(`failed ${secretUrl} api_key=also-secret`, [secretUrl]),
    ).not.toContain("do-not-print");
  });

  it("validates and persists the exact Tailscale WebAuthn identity before restart", async () => {
    expect(
      validateSignerWebAuthnConfiguration("agent.tailnet.ts.net.", "https://agent.tailnet.ts.net"),
    ).toEqual({ rpId: "agent.tailnet.ts.net", origin: "https://agent.tailnet.ts.net" });
    for (const origin of [
      "http://agent.tailnet.ts.net",
      "https://evil.tailnet.ts.net",
      "https://agent.tailnet.ts.net/path",
      "https://agent.tailnet.ts.net:8443",
    ]) {
      expect(() => validateSignerWebAuthnConfiguration("agent.tailnet.ts.net", origin)).toThrow();
    }

    const calls: string[] = [];
    let written: unknown;
    const result = await runSignerWebAuthnTailscaleAction({
      runFile: async (command: string, args: string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        return command === "tailscale"
          ? {
              stdout: JSON.stringify({ Self: { DNSName: "agent.tailnet.ts.net." } }),
              stderr: "",
            }
          : { stdout: "", stderr: "" };
      },
      writeEnvironment: async (config: unknown) => {
        written = config;
      },
    });
    expect(written).toEqual({
      rpId: "agent.tailnet.ts.net",
      origin: "https://agent.tailnet.ts.net",
    });
    expect(calls).toEqual([
      "tailscale status --json",
      "systemctl restart fased-signerd.service",
      "systemctl is-active --quiet fased-signerd.service",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ configured: true });
  });

  it("provides a narrow initial-policy transport and deletes its staging file", async () => {
    const policy = {
      walletId: "agent",
      role: "agent",
      operations: [],
      programs: [],
      assets: [],
    };
    const input = JSON.stringify({
      schemaVersion: 1,
      walletId: "agent",
      policyJson: JSON.stringify(policy),
    });
    expect(parseSignerPolicyBootstrapInput(input)).toMatchObject({ walletId: "agent" });
    expect(() =>
      parseSignerPolicyBootstrapInput(
        JSON.stringify({
          schemaVersion: 1,
          walletId: "agent",
          policyJson: JSON.stringify({ ...policy, operations: ["agentSendNativeSol"] }),
        }),
      ),
    ).toThrow(/deny-all/);
    const calls: string[][] = [];
    const removed: string[] = [];
    const result = await runSignerPolicyPutAction(input, "fased-signer", {
      runFile: async (_command: string, args: string[]) => {
        calls.push(args);
        return args.includes("get")
          ? {
              stdout: `${JSON.stringify({ ...policy, version: 1, hash: POLICY_HASH })}\n`,
              stderr: "",
            }
          : {
              stdout: `${JSON.stringify({ ...policy, version: 2, hash: POLICY_HASH })}\n`,
              stderr: "",
            };
      },
      writePolicy: async () => "/var/lib/fased-signerd/bootstrap-policy.json",
      removePolicy: async (filePath: string) => {
        removed.push(filePath);
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      walletId: "agent",
      role: "agent",
      version: 2,
      hash: POLICY_HASH,
    });
    expect(calls[1]).toContain("--expected-version");
    expect(calls[1]).toContain("1");
    expect(removed).toEqual(["/var/lib/fased-signerd/bootstrap-policy.json"]);
  });

  it("tears down the privileged bootstrap and persists only root-owned signer settings", () => {
    const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
    expect(installer).toContain("rm -rf /run/fased-host-bootstrap");
    expect(installer).toContain("rm -f /var/log/fased-host-bootstrap.log");
    expect(installer).toContain('--signer-user "$signer_user"');
    expect(installer).toContain("EnvironmentFile=-/etc/fased/signerd-webauthn.env");
    expect(installer).not.toContain("fased-host-bootstrap.service");
  });
});
