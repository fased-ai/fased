import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  readWalletProviderRegistry,
  upsertNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: class {},
}));

async function withTempConfig(params: {
  cfg: unknown;
  env?: Record<string, string>;
  run: () => Promise<void>;
}): Promise<void> {
  const prevConfigPath = process.env.FASED_CONFIG_PATH;
  const prevDisableCache = process.env.FASED_DISABLE_CONFIG_CACHE;
  const prevStateDir = process.env.FASED_STATE_DIR;
  const prevGatewayMode = process.env.FASED_GATEWAY_MODE;
  const prevSignerSocket = process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-wallet-providers-http-test-"));
  const stateDir = path.join(dir, "state");
  const configPath = path.join(dir, "fased.json");
  process.env.FASED_CONFIG_PATH = configPath;
  process.env.FASED_DISABLE_CONFIG_CACHE = "1";
  process.env.FASED_STATE_DIR = stateDir;
  process.env.FASED_GATEWAY_MODE = "managed";
  delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
  if (params.env) {
    for (const [key, value] of Object.entries(params.env)) {
      process.env[key] = value;
    }
  }
  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.FASED_CONFIG_PATH;
    } else {
      process.env.FASED_CONFIG_PATH = prevConfigPath;
    }
    if (prevDisableCache === undefined) {
      delete process.env.FASED_DISABLE_CONFIG_CACHE;
    } else {
      process.env.FASED_DISABLE_CONFIG_CACHE = prevDisableCache;
    }
    if (prevStateDir === undefined) {
      delete process.env.FASED_STATE_DIR;
    } else {
      process.env.FASED_STATE_DIR = prevStateDir;
    }
    if (prevGatewayMode === undefined) {
      delete process.env.FASED_GATEWAY_MODE;
    } else {
      process.env.FASED_GATEWAY_MODE = prevGatewayMode;
    }
    if (prevSignerSocket === undefined) {
      delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    } else {
      process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = prevSignerSocket;
    }
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    } catch {
      // Best effort cleanup for CI/tmpfs race conditions.
    }
  }
}

function createRequest(params: {
  method?: string;
  path: string;
  host?: string;
  authorization?: string;
  body?: unknown;
}): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = params.method ?? "GET";
  req.url = params.path;
  req.headers = {
    host: params.host ?? "fasedagent7f1b9b93ccfdb.agents.fased.app",
    ...(params.authorization ? { authorization: params.authorization } : {}),
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  queueMicrotask(() => {
    const writableReq = req as IncomingMessage & {
      write: (chunk: string) => void;
      end: () => void;
    };
    if (params.body != null) {
      writableReq.write(JSON.stringify(params.body));
    }
    writableReq.end();
  });
  return req;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  const pushChunk = (chunk?: unknown) => {
    if (typeof chunk === "string") {
      body += chunk;
      return;
    }
    if (chunk instanceof Uint8Array) {
      body += Buffer.from(chunk).toString("utf8");
    }
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    write: vi.fn((chunk?: unknown) => {
      pushChunk(chunk);
      return true;
    }),
    end: vi.fn((chunk?: unknown) => {
      pushChunk(chunk);
    }),
  } as unknown as ServerResponse;
  return { res, getBody: () => body };
}

async function dispatch(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
) {
  server.emit("request", req, res);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const endMock = (res as unknown as { end?: { mock?: { calls: unknown[] } } }).end;
    if (Array.isArray(endMock?.mock?.calls) && endMock.mock.calls.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "root-token",
  allowTailscale: false,
};

const signerV2Capabilities = {
  details: "fased-signerd protocol-v2 ready",
  readOnly: false,
  keystoreType: "signer-owned-v2",
  chains: ["solana"] as const,
  ready: true,
  capabilities: {
    protocol: { current: 2 as const, min: 2, max: 2 },
    intentTypes: ["solana.nativeTransfer", "solana.splTransferChecked"],
    operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
    features: [
      "failClosedPolicies",
      "policyHashes",
      "applicationPolicyTightening",
      "durableCaps",
      "atomicIdempotency",
      "ambiguousBroadcastReconciliation",
      "signerOwnedKeys",
      "signerOwnedRPC",
      "typedSolanaTransactions",
      "signerOwnedWebAuthn",
      "singleUseReviewedAuthorization",
      "typedJupiterSemantics",
      "signerOwnedReviewPrepareExecute",
      "exactPreparedTransactions",
      "verifiedAddressLookupTables",
    ],
  },
  policies: [],
};

type PolicySignerPolicy = {
  walletId: string;
  role: "agent" | "mining" | "vault";
  version: number;
  operations: string[];
  programs: string[];
  assets: Array<{
    asset: string;
    destinations: string[];
    maxPerTx: string;
    maxDaily: string;
  }>;
  hash: string;
};

async function createPolicySignerServer(params: {
  socketPath: string;
  current: PolicySignerPolicy;
  next: PolicySignerPolicy;
  pauseTighten?: {
    started: () => void;
    wait: Promise<void>;
  };
}): Promise<{
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  let durable = params.current;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      const respond = async () => {
        let result: unknown;
        if (request.op === "v2.capabilities") {
          result = signerV2Capabilities;
        } else if (request.op === "v2.policy.get") {
          result = durable;
        } else if (request.op === "v2.policy.tighten") {
          params.pauseTighten?.started();
          await params.pauseTighten?.wait;
          durable = params.next;
          result = durable;
        } else {
          socket.end(
            `${JSON.stringify({ ok: false, error: `unsupported op ${String(request.op)}` })}\n`,
          );
          return;
        }
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      };
      void respond();
    });
  });
  await mkdir(path.dirname(params.socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.socketPath, resolve);
  });
  await chmod(params.socketPath, 0o660);
  return {
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForResponseEnd(res: ServerResponse, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const endMock = (res as unknown as { end?: { mock?: { calls: unknown[] } } }).end;
    if (Array.isArray(endMock?.mock?.calls) && endMock.mock.calls.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`response did not end ${count} time(s)`);
}

const baseConfig = {
  gateway: { trustedProxies: [] },
  wallet: {
    provider: { id: "local-socket-signer" },
    runtime: {
      enabled: true,
      runtime: "external-custom",
      mode: "external",
      service: { host: "127.0.0.1", port: 19444 },
    },
    execution: { mode: "manual" },
    approvalAuth: { mode: "none" },
  },
};

describe("wallet providers HTTP", () => {
  test("accepts local-socket-signer when patching default provider", async () => {
    await withTempConfig({
      cfg: baseConfig,
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/providers",
            authorization: "Bearer root-token",
            body: { providerId: "local-socket-signer", enabled: true, setDefault: true },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          providers?: Array<{ id: string; enabled: boolean }>;
        };
        expect(payload.ok).toBe(true);
        expect(
          payload.providers?.find((provider) => provider.id === "local-socket-signer")?.enabled,
        ).toBe(true);
      },
    });
  });

  test("requires native migration instead of switching a legacy wallet through settings", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: { ...baseConfig.wallet, provider: { id: "embedded-keystore" } },
      },
      env: { FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-wallet-test.sock" },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/settings",
            authorization: "Bearer root-token",
            body: { providerId: "local-socket-signer" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(409);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          error?: { code?: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error?.code).toBe("wallet_legacy_embedded_keystore_migration_required");
      },
    });
  });

  test("rejects autonomous execution mode for non-local signer providers", async () => {
    await withTempConfig({
      cfg: baseConfig,
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/settings",
            authorization: "Bearer root-token",
            body: { providerId: "alchemy", executionMode: "autonomous" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          error?: { code?: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error?.code).toBe("provider_execution_mode_unsupported");
      },
    });
  });

  test("lists wallet RPC URLs from config-scoped env vars", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__SOLANA_1: "https://rpc.example/solana-1",
          },
        },
      },
      run: async () => {
        upsertNamedWallet({
          walletId: "solana-1",
          name: "Solana 1",
          providerId: "local-socket-signer",
          addresses: { solana: "3P2TQ3ED1111111111111111111111111116TNai5" },
          env: process.env,
        });
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/api/wallet/wallets",
            authorization: "Bearer root-token",
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          wallets?: Array<{
            id: string;
            readiness?: {
              rpc?: boolean;
            };
          }>;
        };
        const wallet = payload.wallets?.find((entry) => entry.id === "solana-1");
        expect(payload.ok).toBe(true);
        expect(wallet?.readiness?.rpc).toBe(true);
        expect(wallet?.readiness).not.toHaveProperty("rpcUrl");
      },
    });
  });

  test("lists wallets from a config-scoped wallet state dir", async () => {
    const configScopedStateDir = path.join(os.tmpdir(), "wallet-http-config-state");
    await withTempConfig({
      cfg: {
        ...baseConfig,
        env: {
          vars: {
            FASED_STATE_DIR: configScopedStateDir,
            FASED_WALLET_SOLANA_RPC_URL__SOLANA_1: "https://rpc.example/solana-1",
          },
        },
      },
      run: async () => {
        const configScopedEnv = {
          ...process.env,
          FASED_STATE_DIR: configScopedStateDir,
        } as NodeJS.ProcessEnv;
        await mkdir(configScopedStateDir, { recursive: true });
        upsertNamedWallet({
          walletId: "solana-1",
          name: "Solana 1",
          providerId: "local-socket-signer",
          addresses: { solana: "3P2TQ3ED1111111111111111111111111116TNai5" },
          env: configScopedEnv,
        });
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/api/wallet/wallets",
            authorization: "Bearer root-token",
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          wallets?: Array<{
            id: string;
            readiness?: {
              rpc?: boolean;
            };
          }>;
        };
        const wallet = payload.wallets?.find((entry) => entry.id === "solana-1");
        expect(payload.ok).toBe(true);
        expect(wallet).toBeTruthy();
        expect(wallet?.readiness?.rpc).toBe(true);
        expect(wallet?.readiness).not.toHaveProperty("rpcUrl");
      },
    });
    await rm(configScopedStateDir, { recursive: true, force: true });
  });

  test("accepts wallet policy patch in external mode", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: { ...baseConfig.wallet, provider: { id: "alchemy" } },
      },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/settings",
            authorization: "Bearer root-token",
            body: { solanaMaxPerTx: "2000000000", directSigning: true },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          settings?: { policy?: { solana?: { maxPerTx?: string } } };
        };
        expect(payload.ok).toBe(true);
        expect(payload.settings?.policy?.solana?.maxPerTx).toBe("2000000000");

        const persistedRaw = await readFile(String(process.env.FASED_CONFIG_PATH), "utf-8");
        const persisted = JSON.parse(persistedRaw) as {
          wallet?: { runtime?: { policy?: { solana?: { maxPerTx?: string } } } };
        };
        expect(persisted.wallet?.runtime?.policy?.solana?.maxPerTx).toBe("2000000000");
      },
    });
  });

  test("persists Agent wallet-scoped recurring transfer policy in settings payload", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: { ...baseConfig.wallet, provider: { id: "alchemy" } },
      },
      run: async () => {
        upsertNamedWallet({
          walletId: "vault",
          name: "Vault",
          providerId: "alchemy",
          metadata: { role: "vault" },
          env: process.env,
        });
        upsertNamedWallet({
          walletId: "agent",
          name: "Agent",
          providerId: "alchemy",
          metadata: { role: "agent" },
          env: process.env,
        });
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/settings",
            authorization: "Bearer root-token",
            body: {
              walletId: "agent",
              directSigning: true,
              solanaMaxPerTx: "1000000000",
              recurringTransfer: {
                enabled: true,
                chain: "solana",
                to: "@wallet:vault",
                amountMode: "percentage",
                percentage: 40,
                minAmount: "1000000",
                keepAmount: "10000000",
                schedule: { kind: "cron", expr: "0 9 * * *" },
                name: "Agent sweep",
              },
            },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          settings?: {
            policy?: {
              directSigning?: boolean;
              recurringTransfer?: {
                enabled?: boolean;
                to?: string;
                amountMode?: string;
                percentage?: number;
                minAmount?: string;
                keepAmount?: string;
              } | null;
            };
          };
        };
        expect(payload.ok).toBe(true);
        expect(payload.settings?.policy?.directSigning).toBe(true);
        expect(payload.settings?.policy?.recurringTransfer).toMatchObject({
          enabled: true,
          to: "@wallet:vault",
          amountMode: "percentage",
          percentage: 40,
          minAmount: "1000000",
          keepAmount: "10000000",
        });
      },
    });
  });

  test("uses the canonical signer ID and persists settings only after durable acknowledgement", async () => {
    await withTempConfig({
      cfg: baseConfig,
      run: async () => {
        const oldHash = `sha256:${"a".repeat(64)}`;
        const nextHash = `sha256:${"b".repeat(64)}`;
        const current: PolicySignerPolicy = {
          walletId: "agent_2",
          role: "agent",
          version: 4,
          operations: ["solana.nativeTransfer"],
          programs: ["11111111111111111111111111111111"],
          assets: [
            {
              asset: "solana:native",
              destinations: ["Destination11111111111111111111111111111"],
              maxPerTx: "1000",
              maxDaily: "5000",
            },
          ],
          hash: oldHash,
        };
        const next: PolicySignerPolicy = {
          ...current,
          version: 5,
          assets: current.assets.map((asset) => ({
            ...asset,
            maxPerTx: "500",
            maxDaily: "2500",
          })),
          hash: nextHash,
        };
        const socketPath = path.join(String(process.env.FASED_STATE_DIR), "signer.sock");
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
        let markTightenStarted: (() => void) | undefined;
        const tightenStarted = new Promise<void>((resolve) => {
          markTightenStarted = resolve;
        });
        let releaseTighten: (() => void) | undefined;
        const tightenWait = new Promise<void>((resolve) => {
          releaseTighten = resolve;
        });
        const signer = await createPolicySignerServer({
          socketPath,
          current,
          next,
          pauseTighten: {
            started: () => markTightenStarted?.(),
            wait: tightenWait,
          },
        });
        try {
          upsertNamedWallet({
            walletId: "agent-2",
            name: "Agent 2",
            providerId: "local-socket-signer",
            metadata: {
              role: "agent",
              signerWalletId: "agent_2",
              policyState: "acknowledged",
              policyVersion: 4,
              policyHash: oldHash,
            },
            env: process.env,
          });
          const server = createGatewayHttpServer({
            canvasHost: null,
            clients: new Set(),
            controlUiEnabled: false,
            controlUiBasePath: "/ui",
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest: async () => false,
            resolvedAuth,
          });
          const response = createResponse();
          server.emit(
            "request",
            createRequest({
              method: "PATCH",
              path: "/api/wallet/settings",
              authorization: "Bearer root-token",
              body: {
                walletId: "agent-2",
                solanaMaxPerTx: "500",
                solanaMaxDaily: "2500",
              },
            }),
            response.res,
          );

          await tightenStarted;
          const policyStatePath = path.join(
            String(process.env.FASED_STATE_DIR),
            "wallet",
            "wallet-policy-state.v1.json",
          );
          await expect(readFile(policyStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            readWalletProviderRegistry(process.env).wallets.find(
              (wallet) => wallet.id === "agent-2",
            )?.metadata,
          ).toMatchObject({ policyVersion: 4, policyHash: oldHash });

          releaseTighten?.();
          await waitForResponseEnd(response.res);
          expect(response.res.statusCode).toBe(200);
          const payload = JSON.parse(response.getBody()) as {
            ok: boolean;
            settings?: {
              signerPolicy?: { state?: string; version?: number; hash?: string };
              policy?: { solana?: { maxPerTx?: string; maxDaily?: string } };
            };
          };
          expect(payload.ok).toBe(true);
          expect(payload.settings?.signerPolicy).toMatchObject({
            state: "acknowledged",
            version: 5,
            hash: nextHash,
          });
          expect(payload.settings?.policy?.solana).toMatchObject({
            maxPerTx: "500",
            maxDaily: "2500",
          });
          const persisted = JSON.parse(await readFile(policyStatePath, "utf8")) as {
            wallets?: Record<string, { solana?: { maxPerTx?: string; maxDaily?: string } }>;
          };
          expect(persisted.wallets?.["agent-2"]?.solana).toMatchObject({
            maxPerTx: "500",
            maxDaily: "2500",
          });
          expect(
            readWalletProviderRegistry(process.env).wallets.find(
              (wallet) => wallet.id === "agent-2",
            )?.metadata,
          ).toMatchObject({
            role: "agent",
            purpose: "agent",
            policyState: "acknowledged",
            policyVersion: 5,
            policyHash: nextHash,
          });
          expect(signer.requests.map((request) => request.op)).toEqual([
            "v2.capabilities",
            "v2.policy.get",
            "v2.capabilities",
            "v2.policy.tighten",
            "v2.policy.get",
          ]);
          expect(
            signer.requests
              .filter((request) => request.op === "v2.policy.get")
              .map((request) => request.walletId),
          ).toEqual(["agent_2", "agent_2"]);
          const tightenRequest = signer.requests.find(
            (request) => request.op === "v2.policy.tighten",
          );
          expect(tightenRequest).toMatchObject({
            walletId: "agent_2",
            request: {
              expectedVersion: 4,
              policy: {
                role: "agent",
                assets: [{ maxPerTx: "500", maxDaily: "2500" }],
              },
            },
          });
        } finally {
          releaseTighten?.();
          await signer.close();
        }
      },
    });
  });

  test("rejects signer policy expansion without changing app policy or metadata", async () => {
    await withTempConfig({
      cfg: baseConfig,
      run: async () => {
        const oldHash = `sha256:${"c".repeat(64)}`;
        const current: PolicySignerPolicy = {
          walletId: "agent",
          role: "agent",
          version: 7,
          operations: ["solana.nativeTransfer"],
          programs: ["11111111111111111111111111111111"],
          assets: [
            {
              asset: "solana:native",
              destinations: ["Destination11111111111111111111111111111"],
              maxPerTx: "1000",
              maxDaily: "5000",
            },
          ],
          hash: oldHash,
        };
        const socketPath = path.join(String(process.env.FASED_STATE_DIR), "signer.sock");
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
        const signer = await createPolicySignerServer({
          socketPath,
          current,
          next: current,
        });
        try {
          upsertNamedWallet({
            walletId: "agent",
            name: "Agent",
            providerId: "local-socket-signer",
            metadata: {
              role: "agent",
              policyState: "acknowledged",
              policyVersion: 7,
              policyHash: oldHash,
            },
            env: process.env,
          });
          const server = createGatewayHttpServer({
            canvasHost: null,
            clients: new Set(),
            controlUiEnabled: false,
            controlUiBasePath: "/ui",
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest: async () => false,
            resolvedAuth,
          });
          const response = createResponse();
          await dispatch(
            server,
            createRequest({
              method: "PATCH",
              path: "/api/wallet/settings",
              authorization: "Bearer root-token",
              body: { walletId: "agent", solanaMaxPerTx: "2000" },
            }),
            response.res,
          );
          expect(response.res.statusCode).toBe(409);
          const payload = JSON.parse(response.getBody()) as {
            ok: boolean;
            error?: { code?: string; message?: string };
          };
          expect(payload.ok).toBe(false);
          expect(payload.error?.code).toBe("signer_policy_admin_required");
          expect(payload.error?.message).toContain("Gateway cannot widen policy");
          expect(signer.requests.map((request) => request.op)).toEqual([
            "v2.capabilities",
            "v2.policy.get",
          ]);
          await expect(
            readFile(
              path.join(
                String(process.env.FASED_STATE_DIR),
                "wallet",
                "wallet-policy-state.v1.json",
              ),
              "utf8",
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            readWalletProviderRegistry(process.env).wallets.find((wallet) => wallet.id === "agent")
              ?.metadata,
          ).toMatchObject({ policyVersion: 7, policyHash: oldHash });
        } finally {
          await signer.close();
        }
      },
    });
  });

  test("keeps a fresh deny-all signer wallet locked until native administration", async () => {
    await withTempConfig({
      cfg: baseConfig,
      run: async () => {
        const lockedHash = `sha256:${"d".repeat(64)}`;
        const locked: PolicySignerPolicy = {
          walletId: "fresh-agent",
          role: "agent",
          version: 1,
          operations: [],
          programs: [],
          assets: [],
          hash: lockedHash,
        };
        const socketPath = path.join(String(process.env.FASED_STATE_DIR), "signer.sock");
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
        const signer = await createPolicySignerServer({
          socketPath,
          current: locked,
          next: locked,
        });
        try {
          upsertNamedWallet({
            walletId: "fresh-agent",
            name: "Fresh Agent",
            providerId: "local-socket-signer",
            metadata: {
              role: "agent",
              policyState: "locked",
              policyVersion: 1,
              policyHash: lockedHash,
            },
            env: process.env,
          });
          const server = createGatewayHttpServer({
            canvasHost: null,
            clients: new Set(),
            controlUiEnabled: false,
            controlUiBasePath: "/ui",
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest: async () => false,
            resolvedAuth,
          });
          const getResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              path: "/api/wallet/settings?walletId=fresh-agent",
              authorization: "Bearer root-token",
            }),
            getResponse.res,
          );
          const settingsPayload = JSON.parse(getResponse.getBody()) as {
            settings?: { signerPolicy?: { state?: string; guidance?: string } };
          };
          expect(settingsPayload.settings?.signerPolicy?.state).toBe("locked");
          expect(settingsPayload.settings?.signerPolicy?.guidance).toContain(
            "native signer control socket",
          );

          const patchResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              method: "PATCH",
              path: "/api/wallet/settings",
              authorization: "Bearer root-token",
              body: { walletId: "fresh-agent", directSigning: true },
            }),
            patchResponse.res,
          );
          expect(patchResponse.res.statusCode).toBe(409);
          const patchPayload = JSON.parse(patchResponse.getBody()) as {
            error?: { code?: string; message?: string };
          };
          expect(patchPayload.error?.code).toBe("signer_policy_admin_required");
          expect(patchPayload.error?.message).toContain("explicit deny-all policy");
          expect(signer.requests.filter((request) => request.op === "v2.policy.tighten")).toEqual(
            [],
          );
        } finally {
          await signer.close();
        }
      },
    });
  });

  test("persists zero-valued wallet policy limits", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: { ...baseConfig.wallet, provider: { id: "alchemy" } },
      },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/settings",
            authorization: "Bearer root-token",
            body: {
              solanaMaxPerTx: "0",
              solanaMaxDaily: "0",
              directSigning: true,
            },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          settings?: {
            policy?: {
              solana?: { maxPerTx?: string; maxDaily?: string };
            };
          };
        };
        expect(payload.ok).toBe(true);
        expect(payload.settings?.policy?.solana?.maxPerTx).toBe("0");
        expect(payload.settings?.policy?.solana?.maxDaily).toBe("0");
        expect(payload.settings?.policy?.solana?.maxPerTx).toBe("0");
        expect(payload.settings?.policy?.solana?.maxDaily).toBe("0");
      },
    });
  });

  test("still rejects non-policy wallet settings mutation in external mode", async () => {
    await withTempConfig({
      cfg: baseConfig,
      env: { FASED_GATEWAY_MODE: "local" },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "PATCH",
            path: "/api/wallet/settings",
            authorization: "Bearer root-token",
            body: { providerId: "local-socket-signer" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          error?: { code?: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error?.code).toBe("managed_mode_required");
      },
    });
  });

  test("hides derived auto wallets by default in provider payload", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: {
          ...baseConfig.wallet,
          provider: { id: "local-socket-signer" },
        },
      },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/api/wallet/providers",
            authorization: "Bearer root-token",
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          wallets?: Array<{ id?: string; providerId?: string }>;
        };
        expect(payload.ok).toBe(true);
        expect(payload.wallets?.some((wallet) => wallet.id?.startsWith("auto_"))).toBe(false);
      },
    });
  });

  test("returns derived auto wallets when includeDerived=1 is requested", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: {
          ...baseConfig.wallet,
          provider: { id: "local-socket-signer" },
        },
      },
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/api/wallet/providers?includeDerived=1",
            authorization: "Bearer root-token",
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          wallets?: Array<{ id?: string; providerId?: string }>;
        };
        expect(payload.ok).toBe(true);
        expect(payload.wallets?.some((wallet) => wallet.providerId === "local-socket-signer")).toBe(
          true,
        );
        expect(payload.wallets?.some((wallet) => wallet.id === "auto_local-socket-signer")).toBe(
          true,
        );
      },
    });
  });

  test("returns wallet observability snapshot endpoint", async () => {
    await withTempConfig({
      cfg: baseConfig,
      run: async () => {
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "GET",
            path: "/api/wallet/observability",
            authorization: "Bearer root-token",
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          observability?: { version?: number };
        };
        expect(payload.ok).toBe(true);
        expect(payload.observability?.version).toBe(1);
      },
    });
  });

  test("uses config-scoped Solana RPC with the signer-owned v2 wallet address", async () => {
    const rpcPort = 18999;
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;
    await withTempConfig({
      cfg: {
        ...baseConfig,
        env: {
          vars: {
            FASED_WALLET_SOLANA_RPC_URL__SOLANA_1: rpcUrl,
          },
        },
      },
      run: async () => {
        const signerRequests: Array<Record<string, unknown>> = [];
        const rpcServer = createHttpServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString("utf8");
          });
          req.on("end", () => {
            const payload = JSON.parse(body || "{}") as { method?: string };
            res.setHeader("content-type", "application/json");
            if (payload.method === "getBalance") {
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: "wallet-balance-fallback",
                  result: { value: 498000000 },
                }),
              );
              return;
            }
            res.end(JSON.stringify({ jsonrpc: "2.0", id: "wallet-balance-fallback" }));
          });
        });
        await new Promise<void>((resolve, reject) => {
          rpcServer.once("error", reject);
          rpcServer.listen(rpcPort, "127.0.0.1", resolve);
        });
        const socketPath = path.join(
          String(process.env.FASED_STATE_DIR ?? os.tmpdir()),
          "balance.sock",
        );
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
        await mkdir(path.dirname(socketPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const signer = net.createServer((conn) => {
            conn.setEncoding("utf8");
            conn.on("data", (chunk) => {
              const lines = String(chunk)
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              for (const line of lines) {
                const payload = JSON.parse(line) as Record<string, unknown>;
                signerRequests.push(payload);
                const op = typeof payload.op === "string" ? payload.op : "";
                if (op === "v2.capabilities") {
                  conn.write(`${JSON.stringify({ ok: true, result: signerV2Capabilities })}\n`);
                } else if (op === "v2.wallet.get") {
                  conn.write(
                    `${JSON.stringify({
                      ok: true,
                      result: {
                        walletId: "solana_1",
                        publicKey: "3P2TQ3ED1111111111111111111111111116TNai5",
                      },
                    })}\n`,
                  );
                } else if (op === "health") {
                  conn.write(
                    `${JSON.stringify({
                      ok: true,
                      result: { details: "ok", readOnly: false, chains: ["solana"] },
                    })}\n`,
                  );
                } else {
                  conn.write(`${JSON.stringify({ ok: false, error: `unsupported op: ${op}` })}\n`);
                }
              }
            });
          });
          signer.once("error", reject);
          signer.listen(socketPath, async () => {
            try {
              upsertNamedWallet({
                walletId: "solana-1",
                name: "Solana 1",
                providerId: "local-socket-signer",
                addresses: { solana: "3P2TQ3ED1111111111111111111111111116TNai5" },
                env: process.env,
              });
              const server = createGatewayHttpServer({
                canvasHost: null,
                clients: new Set(),
                controlUiEnabled: false,
                controlUiBasePath: "/ui",
                openAiChatCompletionsEnabled: false,
                openResponsesEnabled: false,
                handleHooksRequest: async () => false,
                resolvedAuth,
              });
              const response = createResponse();
              await dispatch(
                server,
                createRequest({
                  method: "GET",
                  path: "/api/wallet/balances?chain=solana&walletId=solana-1",
                  authorization: "Bearer root-token",
                }),
                response.res,
              );
              expect(response.res.statusCode).toBe(200);
              const payload = JSON.parse(response.getBody()) as {
                balances?: { solana?: { ok?: boolean; balance?: string } };
              };
              expect(payload.balances?.solana?.ok).toBe(true);
              expect(payload.balances?.solana?.balance).toBe("498000000");
              expect(signerRequests.some((entry) => entry.op === "v2.capabilities")).toBe(true);
              expect(signerRequests.some((entry) => entry.op === "v2.wallet.get")).toBe(true);
              expect(signerRequests.some((entry) => entry.op === "getBalance")).toBe(false);
              signer.close(() => rpcServer.close(() => resolve()));
            } catch (err) {
              signer.close(() => rpcServer.close(() => reject(err)));
            }
          });
        });
      },
    });
  });

  test("routes balances/address probes with walletId to local socket signer", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        wallet: {
          ...baseConfig.wallet,
          provider: { id: "local-socket-signer" },
        },
      },
      run: async () => {
        const socketPath = path.join(
          String(process.env.FASED_STATE_DIR ?? os.tmpdir()),
          "wallet.sock",
        );
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = socketPath;
        await mkdir(path.dirname(socketPath), { recursive: true });
        const received: Array<Record<string, unknown>> = [];
        await new Promise<void>((resolve, reject) => {
          const signer = net.createServer((conn) => {
            conn.setEncoding("utf8");
            conn.on("data", (chunk) => {
              const lines = String(chunk)
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              for (const line of lines) {
                const payload = JSON.parse(line) as Record<string, unknown>;
                received.push(payload);
                const op = typeof payload.op === "string" ? payload.op : "";
                if (op === "v2.capabilities") {
                  conn.write(`${JSON.stringify({ ok: true, result: signerV2Capabilities })}\n`);
                } else if (op === "v2.wallet.get") {
                  conn.write(
                    `${JSON.stringify({
                      ok: true,
                      result: {
                        walletId: "trading_main",
                        publicKey: "2bm8fYZ6BDVE5LMRotEdQSqCgAonenegsVzKDuVGtaic",
                      },
                    })}\n`,
                  );
                } else if (op === "health") {
                  conn.write(
                    `${JSON.stringify({
                      ok: true,
                      result: { details: "ok", readOnly: false, chains: ["solana"] },
                    })}\n`,
                  );
                } else {
                  conn.write(`${JSON.stringify({ ok: false, error: `unsupported op: ${op}` })}\n`);
                }
              }
            });
          });
          signer.once("error", reject);
          signer.listen(socketPath, async () => {
            try {
              upsertNamedWallet({
                walletId: "trading-main",
                name: "Trading Main",
                providerId: "local-socket-signer",
                env: process.env,
              });
              const server = createGatewayHttpServer({
                canvasHost: null,
                clients: new Set(),
                controlUiEnabled: false,
                controlUiBasePath: "/ui",
                openAiChatCompletionsEnabled: false,
                openResponsesEnabled: false,
                handleHooksRequest: async () => false,
                resolvedAuth,
              });
              const response = createResponse();
              await dispatch(
                server,
                createRequest({
                  method: "GET",
                  path: "/api/wallet/balances?chain=solana&walletId=trading-main",
                  authorization: "Bearer root-token",
                }),
                response.res,
              );
              expect(response.res.statusCode).toBe(200);
              const payload = JSON.parse(response.getBody()) as {
                walletId?: string;
              };
              expect(payload.walletId).toBe("trading-main");
              expect(
                received.some(
                  (entry) =>
                    entry.op === "v2.wallet.get" &&
                    (entry.walletId === "trading-main" || entry.walletId === "trading_main"),
                ),
              ).toBe(true);
              expect(received.some((entry) => entry.op === "v2.capabilities")).toBe(true);
              expect(received.some((entry) => entry.op === "getAddresses")).toBe(false);
              expect(received.some((entry) => entry.op === "getBalance")).toBe(false);
              signer.close(() => resolve());
            } catch (err) {
              signer.close(() => reject(err));
            }
          });
        });
      },
    });
  });

  test("blocks deleting the active SAT mining wallet", async () => {
    await withTempConfig({
      cfg: {
        ...baseConfig,
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: { walletId: "miner-wallet", network: "devnet", riskMode: "balanced" },
            },
          },
        },
      },
      run: async () => {
        upsertNamedWallet({
          walletId: "miner-wallet",
          name: "Miner Wallet",
          providerId: "local-socket-signer",
          env: process.env,
        });
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/ui",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const response = createResponse();
        await dispatch(
          server,
          createRequest({
            method: "DELETE",
            path: "/api/wallet/wallets",
            authorization: "Bearer root-token",
            body: { walletId: "miner-wallet" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(409);
        const payload = JSON.parse(response.getBody()) as {
          ok: boolean;
          error?: { code?: string; message?: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error?.code).toBe("wallet_in_use");
      },
    });
  });
});
