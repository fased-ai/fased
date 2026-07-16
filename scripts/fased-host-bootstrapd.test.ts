import { describe, expect, it } from "vitest";
import { parseBootstrapRequest, validateGatewayUnit } from "./fased-host-bootstrapd.mjs";

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
  "Environment=FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET=/run/fased-signerd/app.sock",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
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
});
