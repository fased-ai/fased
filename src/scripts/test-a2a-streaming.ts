import { GatewayClient } from "../gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";

/**
 * A2A Streaming Verification Script
 *
 * Usage:
 *   pnpm tsx src/scripts/test-a2a-streaming.ts --url <gateway-websocket-url> [--token <token>]
 */

async function main() {
  const args = process.argv.slice(2);
  const urlArg = args.find((_, i) => args[i - 1] === "--url");
  const tokenArg = args.find((_, i) => args[i - 1] === "--token");
  const skipTls = args.includes("--skip-tls");

  if (skipTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  if (!urlArg) {
    console.error(
      "Missing --url. Usage: pnpm tsx src/scripts/test-a2a-streaming.ts --url wss://gateway.example [--token <token>] [--skip-tls]",
    );
    process.exit(1);
  }

  console.log(`Starting A2A verification against ${urlArg}...`);
  if (skipTls) {
    console.log("TLS verification is disabled.");
  }

  const identity = loadOrCreateDeviceIdentity();
  console.log(`Local device ID: ${identity.deviceId}`);

  const client = new GatewayClient({
    url: urlArg,
    authToken: tokenArg,
    token: tokenArg,
    deviceIdentity: identity,
    onHelloOk: (hello) => {
      console.log(
        `Handshake successful. Connected to gateway version: ${hello.server?.version || "unknown"}`,
      );
      console.log(`Server connection ID: ${hello.server?.connId}`);
      void runTests(client);
    },
    onEvent: (evt) => {
      if (evt.event === "chat") {
        console.log(`Received chat event: ${JSON.stringify(evt.payload, null, 2)}`);
      } else {
        console.log(`Event: ${evt.event}`);
      }
    },
    onConnectError: (err) => {
      console.error(`Connection error: ${err.message}`);
      process.exit(1);
    },
    onClose: (code, reason) => {
      console.log(`Connection closed (${code}): ${reason}`);
      process.exit(0);
    },
  });

  client.start();

  // Keep alive for a bit to listen for events
  setTimeout(() => {
    console.log("Test timeout. Closing connection.");
    client.stop();
  }, 30000);
}

async function runTests(client: GatewayClient) {
  console.log("\nRunning diagnostics...");

  // 1. Ping Test
  try {
    const pingRes = await client.request("ping", { now: Date.now() });
    console.log(`Ping success: ${JSON.stringify(pingRes)}`);
  } catch (err) {
    console.error(`Ping failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Whoami / Identity check
  try {
    const identityRes = await client.request("whoami");
    console.log(`Identity confirmed: ${JSON.stringify(identityRes)}`);
  } catch {
    console.log("Note: whoami might be restricted for anonymous or unverified clients.");
  }

  console.log("\nListening for events for 30 seconds. Press Ctrl+C to exit early.\n");
}

main().catch((err) => {
  console.error("Fatal error:");
  console.error(err);
  process.exit(1);
});
