#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function assertGatewayRuntimeIdentity(payload, expectedVersion, options = {}) {
  if (payload?.version !== expectedVersion) {
    throw new Error(
      `Gateway runtime version ${payload?.version ?? "unknown"} does not match installed CLI ${expectedVersion}.`,
    );
  }
  const acceptedRuntimeSources = new Set(["managed-package", "packaged-runtime"]);
  if (options.allowSourceCheckout === true) {
    acceptedRuntimeSources.add("source-checkout");
  }
  if (!acceptedRuntimeSources.has(payload.runtimeSource)) {
    throw new Error(
      `Gateway runtime source ${payload?.runtimeSource ?? "unknown"} is not a managed packaged runtime.`,
    );
  }
}

function readGatewayEndpoint(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      port: Number.isInteger(config?.gateway?.port) ? config.gateway.port : 18789,
      tls: config?.gateway?.tls?.enabled === true,
    };
  } catch {
    return { port: 18789, tls: false };
  }
}

export async function verifyGatewayRuntimeIdentity({
  expectedVersion,
  configPath,
  allowSourceCheckout = false,
}) {
  const endpoint = readGatewayEndpoint(configPath);
  const client = endpoint.tls ? https : http;
  const payload = await new Promise((resolve, reject) => {
    const request = client.get(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: "/healthz",
        timeout: 5000,
        ...(endpoint.tls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Gateway identity response is invalid: ${error.message}`));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Gateway identity request timed out")));
    request.on("error", reject);
  });
  assertGatewayRuntimeIdentity(payload, expectedVersion, { allowSourceCheckout });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument: ${arg ?? ""}`);
    }
    values.set(arg, value);
    index += 1;
  }
  const expectedVersion = values.get("--expected-version");
  const configPath = values.get("--config");
  if (!expectedVersion || !configPath) {
    throw new Error("--expected-version and --config are required");
  }
  const allowSourceCheckout = values.get("--allow-source-checkout") === "true";
  return { expectedVersion, configPath, allowSourceCheckout };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { expectedVersion, configPath, allowSourceCheckout } = parseArgs(process.argv.slice(2));
    await verifyGatewayRuntimeIdentity({ expectedVersion, configPath, allowSourceCheckout });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
