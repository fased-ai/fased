import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Transaction } from "@solana/web3.js";
import type { Browser, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { startGatewayServer, type GatewayServer } from "../src/gateway/server.js";
import { getFreeGatewayPort } from "../src/gateway/test-helpers.e2e.js";
import { VERSION } from "../src/version.js";
import { resolveWalletRuntimeConfig } from "../src/wallet/wallet-runtime-config.js";
import { createOrExecuteWalletSend } from "../src/wallet/wallet-send-approvals.js";

const execFileAsync = promisify(execFile);
const ENV_KEYS = [
  "HOME",
  "FASED_CONFIG_PATH",
  "FASED_STATE_DIR",
  "FASED_GATEWAY_TOKEN",
  "FASED_VERSION",
  "FASED_GATEWAY_MODE",
  "FASED_GATEWAY_SERVICE",
  "FASED_HOST_PROFILE",
  "FASED_WALLET_PROVIDER",
  "FASED_WALLET_LOCAL_SIGNER_BIN",
  "FASED_WALLET_LOCAL_SIGNER_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
  "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
  "FASED_SKIP_CHANNELS",
  "FASED_SKIP_GMAIL_WATCHER",
  "FASED_SKIP_CANVAS_HOST",
  "FASED_SKIP_BROWSER_CONTROL_SERVER",
  "FASED_TEST_MINIMAL_GATEWAY",
  "FASED_DISABLE_CONFIG_CACHE",
  "FASED_FEDERATION_AUTO_CONNECT",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

type RpcFixture = {
  server: Server;
  url: string;
  methods: string[];
  broadcasts: string[];
};

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as EnvSnapshot;
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = (digits[index] ?? 0) * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    result += alphabet[0];
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += alphabet[digits[index] ?? 0];
  }
  return result;
}

async function startRpcFixture(): Promise<RpcFixture> {
  const methods: string[] = [];
  const broadcasts: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: unknown;
      method?: unknown;
      params?: unknown[];
    };
    const method = typeof body.method === "string" ? body.method : "";
    methods.push(method);
    let result: unknown;
    switch (method) {
      case "getGenesisHash":
        result = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
        break;
      case "getBalance":
        result = { context: { slot: 1 }, value: 10_000_000_000 };
        break;
      case "getLatestBlockhash":
        result = {
          context: { slot: 1 },
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 999_999,
          },
        };
        break;
      case "simulateTransaction":
        result = {
          context: { slot: 1 },
          value: { err: null, logs: [], unitsConsumed: 1 },
        };
        break;
      case "sendTransaction": {
        const encoded = typeof body.params?.[0] === "string" ? body.params[0] : "";
        const transaction = Transaction.from(Buffer.from(encoded, "base64"));
        if (!transaction.signature) {
          throw new Error("signer submitted a transaction without a signature");
        }
        const signature = encodeBase58(transaction.signature);
        broadcasts.push(signature);
        result = signature;
        break;
      }
      case "getSignatureStatuses":
        result = {
          context: { slot: 2 },
          value: [
            {
              slot: 2,
              confirmations: null,
              err: null,
              confirmationStatus: "confirmed",
            },
          ],
        };
        break;
      case "getBlockHeight":
      case "getSlot":
        result = 2;
        break;
      case "getFeeForMessage":
        result = { context: { slot: 1 }, value: 5_000 };
        break;
      case "getMinimumBalanceForRentExemption":
        result = 0;
        break;
      case "getTokenAccountsByOwner":
      case "getParsedTokenAccountsByOwner":
      case "getMultipleAccounts":
        result = { context: { slot: 1 }, value: [] };
        break;
      case "getAccountInfo":
        result = { context: { slot: 1 }, value: null };
        break;
      case "getRecentPrioritizationFees":
        result = [];
        break;
      default:
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            error: { code: -32601, message: `unsupported test RPC method ${method}` },
          }),
        );
        return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test RPC did not bind a TCP address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    methods,
    broadcasts,
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function resolvePlaywrightBrowsersPath(): Promise<string> {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    process.env.USER ? path.join("/home", process.env.USER, ".cache", "ms-playwright") : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next shared Playwright cache.
    }
  }
  return candidates[0] ?? path.join(os.homedir(), ".cache", "ms-playwright");
}

async function waitForSocket(socketPath: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fased-signerd exited before readiness: ${stderr()}`);
    }
    try {
      if ((await fs.lstat(socketPath)).isSocket()) {
        return;
      }
    } catch {
      // The signer creates state before binding the socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fased-signerd did not create its socket: ${stderr()}`);
}

async function waitForApp(page: Page) {
  await page.waitForSelector("fased-app", { timeout: 60_000 });
  try {
    await page.waitForFunction(
      () => {
        const app = document.querySelector("fased-app");
        return Boolean(app?.connected);
      },
      null,
      { timeout: 20_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const app = document.querySelector("fased-app");
      return {
        connected: app?.connected,
        lastError: app?.lastError,
        authNotice: app?.authNotice,
        loginGrantError: app?.loginGrantError,
        fatalError: document.querySelector(".fatal-error")?.textContent,
        text: app?.textContent?.slice(0, 1_000),
        url: location.href,
      };
    });
    throw new Error(`Control UI did not connect: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
}

describe("Control UI Wallet production smoke", () => {
  let env: EnvSnapshot;
  let browser: Browser | null = null;
  let gateway: GatewayServer | null = null;
  let signer: ChildProcess | null = null;
  let root = "";
  const rpcFixtures: RpcFixture[] = [];

  beforeEach(() => {
    env = snapshotEnv();
  });

  afterEach(async () => {
    await browser?.close();
    browser = null;
    await gateway?.close();
    gateway = null;
    if (signer?.exitCode === null) {
      signer.kill("SIGTERM");
    }
    signer = null;
    for (const fixture of rpcFixtures.splice(0)) {
      await closeServer(fixture.server);
    }
    restoreEnv(env);
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it(
    "creates role-ready wallets and preserves routing, RPC, passkey, approvals, and automation across restart",
    { timeout: 240_000 },
    async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-ui-wallet-smoke-"));
      const home = root;
      const stateDir = path.join(home, ".fased");
      const walletDir = path.join(stateDir, "wallet");
      const workspace = path.join(home, "workspace");
      const binDir = path.join(stateDir, "bin");
      const signerBin = path.join(binDir, "fased-signerd");
      const signerSocket = path.join(walletDir, "local-signer.sock");
      const controlSocket = path.join(walletDir, "local-signer-control.sock");
      const stateDb = path.join(walletDir, "signerd-v2.db");
      const masterKey = path.join(walletDir, "signerd-v2.master.key");
      const pidFile = path.join(walletDir, "local-signer.pid");
      const auditLog = path.join(walletDir, "local-signer.audit.jsonl");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(walletDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(binDir, { recursive: true, mode: 0o700 });

      const primaryRpc = await startRpcFixture();
      const replacementRpc = await startRpcFixture();
      rpcFixtures.push(primaryRpc, replacementRpc);

      await execFileAsync("go", ["build", "-buildvcs=false", "-trimpath", "-o", signerBin, "."], {
        cwd: path.join(process.cwd(), "tools", "fased-signerd"),
        env: process.env,
        timeout: 120_000,
      });
      await fs.chmod(signerBin, 0o700);

      let signerStderr = "";
      signer = spawn(
        signerBin,
        [
          "--socket",
          signerSocket,
          "--control-socket",
          controlSocket,
          "--state-db",
          stateDb,
          "--master-key",
          masterKey,
          "--pid-file",
          pidFile,
          "--audit-log",
          auditLog,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      signer.stderr?.setEncoding("utf8");
      signer.stderr?.on("data", (chunk: string) => {
        signerStderr = `${signerStderr}${chunk}`.slice(-16_384);
      });
      await waitForSocket(signerSocket, signer, () => signerStderr);

      const token = `wallet-smoke-${randomUUID()}`;
      const configPath = path.join(stateDir, "fased.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              defaults: { workspace },
              list: [{ id: "main", name: "Assistant", workspace, default: true }],
            },
            gateway: {
              auth: { mode: "token", token },
              controlUi: { enabled: true },
            },
            models: { mode: "replace", providers: {} },
            wallet: {
              provider: { id: "local-socket-signer" },
              runtime: {
                enabled: true,
                mode: "external",
                runtime: "external-custom",
                chains: ["solana"],
                policy: {
                  directSigning: true,
                  capsEnabled: true,
                  solana: { maxPerTx: "1000000000", maxDaily: "5000000000" },
                },
              },
              execution: { mode: "autonomous" },
            },
            env: {
              vars: {
                FASED_WALLET_PROVIDER: "local-socket-signer",
                FASED_WALLET_LOCAL_SIGNER_SOCKET: signerSocket,
                FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET: signerSocket,
                FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET: controlSocket,
                FASED_WALLET_LOCAL_SIGNER_STATE_DB: stateDb,
                FASED_WALLET_LOCAL_SIGNER_MASTER_KEY: masterKey,
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const playwrightBrowsersPath = await resolvePlaywrightBrowsersPath();
      Object.assign(process.env, {
        HOME: home,
        FASED_CONFIG_PATH: configPath,
        FASED_STATE_DIR: stateDir,
        FASED_GATEWAY_TOKEN: token,
        FASED_VERSION: VERSION,
        FASED_GATEWAY_MODE: "managed",
        FASED_HOST_PROFILE: "local",
        FASED_WALLET_PROVIDER: "local-socket-signer",
        FASED_WALLET_LOCAL_SIGNER_BIN: signerBin,
        FASED_WALLET_LOCAL_SIGNER_SOCKET: signerSocket,
        FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET: signerSocket,
        FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET: controlSocket,
        FASED_WALLET_LOCAL_SIGNER_STATE_DB: stateDb,
        FASED_WALLET_LOCAL_SIGNER_MASTER_KEY: masterKey,
        FASED_SKIP_CHANNELS: "1",
        FASED_SKIP_GMAIL_WATCHER: "1",
        FASED_SKIP_CANVAS_HOST: "1",
        FASED_SKIP_BROWSER_CONTROL_SERVER: "1",
        FASED_TEST_MINIMAL_GATEWAY: "1",
        FASED_DISABLE_CONFIG_CACHE: "1",
        FASED_FEDERATION_AUTO_CONNECT: "0",
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      });
      delete process.env.FASED_GATEWAY_SERVICE;

      const port = await getFreeGatewayPort();
      gateway = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: true,
      });

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`http://localhost:${port}/wallet?token=${encodeURIComponent(token)}`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await waitForApp(page);

      const created = await page
        .evaluate(
          async ({ rpcUrl }) => {
            const app = document.querySelector("fased-app");
            if (!app) {
              throw new Error("fased-app was not mounted");
            }
            app.tab = "wallet";
            await app.handleWalletLoad();
            for (const role of ["agent", "vault", "mining"] as const) {
              app.walletCreateName = "";
              app.walletCreateRole = role;
              app.walletCreateRpcUrl = rpcUrl;
              await app.handleWalletCreateNamedWallet();
              if (app.walletSettingsError) {
                throw new Error(app.walletSettingsError);
              }
            }
            await app.handleWalletLoad();
            return app.walletNamedWallets.map((wallet) => ({
              id: wallet.id,
              name: wallet.name,
              role: wallet.metadata?.role,
              address: wallet.addresses.solana,
            }));
          },
          { rpcUrl: primaryRpc.url },
        )
        .catch((error: unknown) => {
          throw new Error(
            `Wallet creation failed after RPC methods ${JSON.stringify(primaryRpc.methods)}`,
            { cause: error },
          );
        });
      expect(created.map(({ id, name, role }) => ({ id, name, role }))).toEqual([
        { id: "agent", name: "Agent", role: "agent" },
        { id: "vault", name: "Vault", role: "vault" },
        { id: "mining", name: "Mining", role: "mining" },
      ]);
      expect(created.every((wallet) => Boolean(wallet.address))).toBe(true);
      await page.waitForFunction(
        () => {
          const text = document.querySelector("fased-app")?.textContent ?? "";
          return (
            text.includes("@wallet:agent") &&
            text.includes("@wallet:vault") &&
            text.includes("@wallet:mining")
          );
        },
        null,
        { timeout: 20_000 },
      );

      await page.evaluate(async () => {
        const app = document.querySelector("fased-app");
        if (!app) {
          throw new Error("fased-app was not mounted");
        }
        app.walletAssignAgentId = "main";
        app.walletAssignWalletId = "agent";
        await app.handleWalletAssignAgentWallet();
        if (app.walletSettingsError) {
          throw new Error(app.walletSettingsError);
        }
      });

      const reviewed = await page.evaluate(async () => {
        const app = document.querySelector("fased-app");
        if (!app) {
          throw new Error("fased-app was not mounted");
        }
        app.handleWalletOpenSendModal("vault");
        app.handleWalletSendCreatePatch({
          chain: "solana",
          assetId: "solana:native",
          to: "@wallet:agent",
          amount: "0.000001",
        });
        await app.handleWalletCreateSendRequest();
        const pending = app.walletApprovals.find((entry) => entry.status === "pending");
        if (!pending) {
          throw new Error(app.walletSendCreateError || "Vault send did not create an approval");
        }
        await app.handleWalletApproveRequest(pending.id);
        if (app.walletApprovalsError) {
          throw new Error(app.walletApprovalsError);
        }
        app.walletApprovalsFilter = "all";
        await app.handleWalletLoad();
        const executed = app.walletApprovals.find((entry) => entry.id === pending.id);
        return { id: pending.id, status: executed?.status };
      });
      expect(reviewed.status).toBe("executed");

      const rejected = await page.evaluate(async () => {
        const app = document.querySelector("fased-app");
        if (!app) {
          throw new Error("fased-app was not mounted");
        }
        app.handleWalletOpenSendModal("vault");
        app.handleWalletSendCreatePatch({
          chain: "solana",
          assetId: "solana:native",
          to: "@wallet:agent",
          amount: "0.000001",
        });
        await app.handleWalletCreateSendRequest();
        const pending = app.walletApprovals.find(
          (entry) => entry.status === "pending" && entry.id !== "",
        );
        if (!pending) {
          throw new Error(app.walletSendCreateError || "Vault send did not create an approval");
        }
        await app.handleWalletRejectRequest(pending.id);
        if (app.walletApprovalsError) {
          throw new Error(app.walletApprovalsError);
        }
        app.walletApprovalsFilter = "all";
        await app.handleWalletLoad();
        return app.walletApprovals.find((entry) => entry.id === pending.id)?.status;
      });
      expect(rejected).toBe("rejected");

      const runtimeConfig = loadConfig();
      const resolvedWallet = resolveWalletRuntimeConfig(runtimeConfig, process.env);
      const agentAddress = created.find((wallet) => wallet.id === "agent")?.address;
      expect(agentAddress).toBeTruthy();
      const automated = await createOrExecuteWalletSend({
        payload: {
          chain: "solana",
          walletId: "agent",
          providerId: "local-socket-signer",
          to: agentAddress,
          amount: "1000",
        },
        requestedBy: "agent",
        executionIntentId: `browser-smoke:${randomUUID()}`,
        sendPath: "automation",
        config: resolvedWallet,
        runtimeConfig,
        env: process.env,
      });
      if (!automated.ok) {
        throw new Error(`Agent automation failed: ${automated.code}: ${automated.message}`);
      }
      expect(automated.mode).toBe("autonomous");
      expect(automated.tx?.txHash).toBeTruthy();

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      const passkeyAndRpc = await page.evaluate(
        async ({ rpcUrl }) => {
          const app = document.querySelector("fased-app");
          if (!app) {
            throw new Error("fased-app was not mounted");
          }
          await app.handleWalletEnablePasskeyApproval();
          if (app.walletSettingsError) {
            throw new Error(app.walletSettingsError);
          }
          await app.handleWalletLoad();
          if (app.walletStatus?.approvalAuth?.mode !== "webauthn") {
            throw new Error("Passkey approval mode did not become active");
          }
          app.walletPasskeyLabel = "Release smoke";
          await app.handleWalletEnrollPasskey();
          if (app.walletPasskeyError) {
            throw new Error(app.walletPasskeyError);
          }
          app.walletDetailsWalletId = "agent";
          app.walletRpcUrl = rpcUrl;
          await app.handleWalletSaveRpcSecret();
          if (app.walletSettingsError) {
            throw new Error(app.walletSettingsError);
          }
          return {
            connected: app.connected,
            message: app.walletSettingsMessage,
            passkeyCount: app.walletStatus?.approvalAuth?.passkeyCount,
          };
        },
        { rpcUrl: replacementRpc.url },
      );
      expect(passkeyAndRpc).toMatchObject({ connected: true, message: "Saved", passkeyCount: 1 });

      await browser.close();
      browser = null;
      await gateway.close({ reason: "wallet browser smoke restart" });
      gateway = null;
      gateway = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: true,
      });
      browser = await chromium.launch({ headless: true });
      const restartedPage = await browser.newPage();
      restartedPage.on("pageerror", (error) => pageErrors.push(error.message));
      await restartedPage.goto(
        `http://localhost:${port}/wallet?token=${encodeURIComponent(token)}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        },
      );
      await waitForApp(restartedPage);
      const persisted = await restartedPage.evaluate(async () => {
        const app = document.querySelector("fased-app");
        if (!app) {
          throw new Error("fased-app was not mounted");
        }
        app.tab = "wallet";
        await app.handleWalletLoad();
        return {
          wallets: app.walletNamedWallets.map((wallet) => wallet.id),
          assignment: app.walletAssignments.main,
          passkeyMode: app.walletStatus?.approvalAuth?.mode,
          passkeyCount: app.walletStatus?.approvalAuth?.passkeyCount,
          connected: app.connected,
        };
      });
      expect(persisted).toEqual({
        wallets: ["agent", "vault", "mining"],
        assignment: "agent",
        passkeyMode: "webauthn",
        passkeyCount: 1,
        connected: true,
      });
      expect(primaryRpc.broadcasts.length).toBeGreaterThanOrEqual(2);
      expect(primaryRpc.methods).toContain("getGenesisHash");
      expect(primaryRpc.methods).toContain("sendTransaction");
      expect(replacementRpc.methods).toContain("getGenesisHash");
      expect(pageErrors).toEqual([]);
    },
  );
});
