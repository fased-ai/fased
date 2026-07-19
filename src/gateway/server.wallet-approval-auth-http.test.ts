import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WalletProviderAdapter } from "../wallet/wallet-provider-adapter.js";
import * as walletProviderResolver from "../wallet/wallet-provider-resolver.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: class {},
}));

async function withTempConfig(params: { cfg: unknown; run: () => Promise<void> }): Promise<void> {
  const prevConfigPath = process.env.FASED_CONFIG_PATH;
  const prevDisableCache = process.env.FASED_DISABLE_CONFIG_CACHE;
  const dir = await mkdtemp(path.join(os.tmpdir(), "fased-wallet-auth-http-test-"));
  const configPath = path.join(dir, "fased.json");
  process.env.FASED_CONFIG_PATH = configPath;
  process.env.FASED_DISABLE_CONFIG_CACHE = "1";
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
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

function createRequest(params: {
  method?: string;
  path: string;
  host?: string;
  authorization?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = params.method ?? "POST";
  req.url = params.path;
  req.headers = {
    host: params.host ?? "fasedagent7f1b9b93ccfdb.agents.fased.app",
    ...(params.authorization ? { authorization: params.authorization } : {}),
    ...params.headers,
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
  setHeader: ReturnType<typeof vi.fn>;
  getBody: () => string;
} {
  const setHeader = vi.fn();
  let body = "";
  const end = vi.fn((chunk?: unknown) => {
    if (typeof chunk === "string") {
      body = chunk;
      return;
    }
    if (chunk instanceof Uint8Array) {
      body = Buffer.from(chunk).toString("utf8");
      return;
    }
    body = "";
  });
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, getBody: () => body };
}

function parseBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function signerReviewAdapter() {
  const prepareTypedTransferReview = vi.fn(
    async (request: {
      walletId: string;
      requestId: string;
      destination: string;
      amount: string;
      mint?: string;
    }) => ({
      requestId: request.requestId,
      walletId: request.walletId,
      intentType: request.mint
        ? ("solana.splTransferChecked" as const)
        : ("solana.nativeTransfer" as const),
      intentDigest: `sha256:${"a".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      mode: "reviewed" as const,
      nonce: "c".repeat(64),
      semanticIntent: request.mint
        ? {
            type: "solana.splTransferChecked" as const,
            tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            mint: request.mint,
            destination: request.destination,
            amount: request.amount,
          }
        : {
            type: "solana.nativeTransfer" as const,
            destination: request.destination,
            lamports: request.amount,
          },
      walletPublicKey: "So11111111111111111111111111111111111111112",
      artifactKind: "solana-transaction" as const,
      artifactDigest: `sha256:${"d".repeat(64)}`,
      transaction: {
        serializedTxBase64: "AA==",
        programs: ["11111111111111111111111111111111"],
        writableAccounts: [request.destination],
        submission: "rpc" as const,
      },
      asset: request.mint ? `solana:spl:${request.mint}` : "solana:native",
      amount: request.amount,
      destination: request.destination,
      policyOperation: request.mint ? "solana.splTransferChecked" : "solana.nativeTransfer",
      requiredPrograms: ["11111111111111111111111111111111"],
      requiredRole: "vault" as const,
      issuedAt: "2026-07-16T12:00:00.000Z",
      state: "prepared" as const,
      preparedAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2099-07-16T12:15:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
      transactionDigest: `sha256:${"d".repeat(64)}`,
    }),
  );
  const preparedInputFor = (requestId: string) =>
    prepareTypedTransferReview.mock.calls.find(([input]) => input.requestId === requestId)?.[0];
  const getSignerReview = vi.fn(async (request: { walletId: string; requestId: string }) => {
    const preparedInput = preparedInputFor(request.requestId);
    if (!preparedInput || preparedInput.walletId !== request.walletId) {
      throw new Error("signer review not found; review.prepare is required");
    }
    return await prepareTypedTransferReview(preparedInput);
  });
  const bindingFor = (requestId: string, walletId: string) => {
    const preparedInput = preparedInputFor(requestId) ?? {
      walletId,
      requestId,
      destination: "So11111111111111111111111111111111111111112",
      amount: "500000000",
    };
    const intentType = preparedInput.mint
      ? ("solana.splTransferChecked" as const)
      : ("solana.nativeTransfer" as const);
    const semanticIntent = preparedInput.mint
      ? {
          type: "solana.splTransferChecked" as const,
          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          mint: preparedInput.mint,
          destination: preparedInput.destination,
          amount: preparedInput.amount,
        }
      : {
          type: "solana.nativeTransfer" as const,
          destination: preparedInput.destination,
          lamports: preparedInput.amount,
        };
    return {
      requestId,
      walletId,
      role: "vault" as const,
      intentType,
      intentDigest: `sha256:${"a".repeat(64)}`,
      semanticIntent,
      walletPublicKey: "So11111111111111111111111111111111111111112",
      artifactKind: "solana-transaction" as const,
      artifactDigest: `sha256:${"d".repeat(64)}`,
      transactionDigest: `sha256:${"d".repeat(64)}`,
      asset: preparedInput.mint ? `solana:spl:${preparedInput.mint}` : "solana:native",
      amount: preparedInput.amount,
      destination: preparedInput.destination,
      policyOperation: intentType,
      requiredPrograms: ["11111111111111111111111111111111"],
      policyHash: `sha256:${"b".repeat(64)}`,
      nonce: "c".repeat(64),
      issuedAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2099-07-16T12:15:00.000Z",
    };
  };
  const beginSignerReviewAuthorization = vi.fn(
    async (request: { walletId: string; requestId: string }) => ({
      challengeId: "challenge-123",
      expiresAt: "2099-07-16T12:02:00.000Z",
      binding: bindingFor(request.requestId, request.walletId),
      options: {
        publicKey: {
          challenge: "AQID",
          rpId: "localhost",
          allowCredentials: [{ type: "public-key", id: "BAUG" }],
          userVerification: "required",
        },
      },
    }),
  );
  const finishSignerReviewAuthorization = vi.fn(
    async (request: { walletId: string; challengeId: string; credential: unknown }) => ({
      authorization: { type: "webauthn" as const, proof: { proofId: "proof-123" } },
      binding: bindingFor("review-placeholder", request.walletId),
      credentialId: "credential-123",
      expiresAt: "2099-07-16T12:02:00.000Z",
    }),
  );
  const executeSignerReview = vi.fn(async (request: { walletId: string; requestId: string }) => ({
    review: {
      ...(await prepareTypedTransferReview({
        walletId: request.walletId,
        requestId: request.requestId,
        destination: "So11111111111111111111111111111111111111112",
        amount: "500000000",
      })),
      state: "signed" as const,
      signature: "review-signature",
    },
    signer: "So11111111111111111111111111111111111111112",
    operation: {
      requestId: request.requestId,
      walletId: request.walletId,
      intentType: "solana.nativeTransfer",
      intentDigest: `sha256:${"a".repeat(64)}`,
      transactionDigest: `sha256:${"d".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      asset: "solana:native",
      amount: "500000000",
      state: "confirmed" as const,
      reservationActive: false,
      usageBucket: "2026-07-16:solana:native",
      reservedAt: "2026-07-16T12:00:00.000Z",
      confirmedAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:01.000Z",
      signature: "review-signature",
      authorizationProof: "proof-123",
    },
  }));
  const sendTx = vi.fn();
  const adapter = {
    id: "local-socket-signer",
    displayName: "Local Socket Signer",
    capabilities: {
      custodyModel: "self-hosted",
      supportsCreateWallet: false,
      supportsPrepare: true,
      supportsSend: true,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      supportedExecutionModes: ["manual", "autonomous"],
      supportedChains: ["solana"],
    },
    supportsChain: () => true,
    health: async () => ({
      ok: true,
      provider: "local-socket-signer" as const,
      configured: true,
      checkedAt: new Date().toISOString(),
    }),
    getAddresses: async () => ({ solana: "So11111111111111111111111111111111111111112" }),
    getBalance: async () => ({
      ok: true as const,
      chain: "solana" as const,
      address: "So11111111111111111111111111111111111111112",
      balance: "1",
      unit: "lamports",
    }),
    prepareTx: async () => ({
      ok: true as const,
      chain: "solana" as const,
      preparedId: "prepared-1",
    }),
    sendTx,
    prepareTypedTransferReview,
    beginSignerReviewAuthorization,
    finishSignerReviewAuthorization,
    executeSignerReview,
    getSignerReview,
  } as WalletProviderAdapter;
  return {
    adapter,
    prepareTypedTransferReview,
    beginSignerReviewAuthorization,
    finishSignerReviewAuthorization,
    executeSignerReview,
    getSignerReview,
    sendTx,
    setFinishReviewId(requestId: string) {
      finishSignerReviewAuthorization.mockImplementationOnce(async (request) => ({
        authorization: { type: "webauthn" as const, proof: { proofId: "proof-123" } },
        binding: bindingFor(requestId, request.walletId),
        credentialId: "credential-123",
        expiresAt: "2099-07-16T12:02:00.000Z",
      }));
    },
  };
}

async function withDefaultSignerWallet(run: () => Promise<void>): Promise<void> {
  const previousStateDir = process.env.FASED_STATE_DIR;
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-signer-review-http-"));
  process.env.FASED_STATE_DIR = stateDir;
  const walletDir = path.join(stateDir, "wallet");
  await mkdir(walletDir, { recursive: true });
  await writeFile(
    path.join(walletDir, "provider-registry.v1.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        "local-socket-signer": {
          enabled: true,
          updatedAt: "2026-07-16T00:00:00.000Z",
          label: "Local signer",
        },
      },
      wallets: [
        {
          id: "vault-1",
          name: "Vault",
          providerId: "local-socket-signer",
          addresses: { solana: "So11111111111111111111111111111111111111112" },
          metadata: { role: "vault" },
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "vault-1",
      updatedAt: "2026-07-16T00:00:00.000Z",
    })}\n`,
  );
  try {
    await run();
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.FASED_STATE_DIR;
    } else {
      process.env.FASED_STATE_DIR = previousStateDir;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function dispatch(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
) {
  server.emit("request", req, res);
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const endMock = (res.end as unknown as { mock?: { calls?: unknown[] } }).mock;
    if ((endMock?.calls?.length ?? 0) > 0) {
      break;
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wallet approval-auth HTTP", () => {
  const resolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "root-token",
    allowTailscale: false,
  };

  const cfg = {
    gateway: { trustedProxies: [] },
    wallet: {
      runtime: {
        enabled: true,
        runtime: "external-docker",
        mode: "external",
        service: { host: "127.0.0.1", port: 19444 },
      },
      execution: { mode: "autonomous" },
      approvalAuth: { mode: "webauthn" },
    },
  };

  const manualSocketSignerCfg = {
    gateway: { trustedProxies: [] },
    wallet: {
      provider: { id: "local-socket-signer" },
      runtime: {
        enabled: true,
        runtime: "external-custom",
        mode: "external",
        chains: ["solana"],
        service: { host: "127.0.0.1", port: 19444 },
        policy: { directSigning: true },
      },
      execution: { mode: "manual" },
      approvalAuth: { mode: "none" },
    },
  };

  test("accepts wallet.send as a valid passkey operation", async () => {
    await withTempConfig({
      cfg,
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
            path: "/api/wallet/approval-auth/assert/options",
            authorization: "Bearer root-token",
            body: { operation: "wallet.send" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("webauthn_not_ready");
        expect(response.getBody()).not.toContain("invalid_operation");
      },
    });
  });

  test.each(["wallet.network", "wallet.archive"])(
    "accepts %s as a valid passkey operation",
    async (operation) => {
      await withTempConfig({
        cfg,
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
              path: "/api/wallet/approval-auth/assert/options",
              authorization: "Bearer root-token",
              body: { operation },
            }),
            response.res,
          );
          expect(response.res.statusCode).toBe(400);
          expect(response.getBody()).toContain("webauthn_not_ready");
          expect(response.getBody()).not.toContain("invalid_operation");
        },
      });
    },
  );

  test("rejects removed custody operations at the Gateway passkey boundary", async () => {
    await withTempConfig({
      cfg,
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
            path: "/api/wallet/approval-auth/assert/options",
            authorization: "Bearer root-token",
            body: { operation: "wallet.custody-unlock" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("invalid_operation");
      },
    });
  });

  test("accepts mining.capital as a valid passkey assertion operation", async () => {
    await withTempConfig({
      cfg,
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
            path: "/api/wallet/approval-auth/assert/options",
            authorization: "Bearer root-token",
            body: { operation: "mining.capital" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("webauthn_not_ready");
        expect(response.getBody()).not.toContain("invalid_operation");
      },
    });
  });

  test("accepts mining.policy as a valid passkey assertion operation", async () => {
    await withTempConfig({
      cfg,
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
            path: "/api/wallet/approval-auth/assert/options",
            authorization: "Bearer root-token",
            body: { operation: "mining.policy" },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("webauthn_not_ready");
        expect(response.getBody()).not.toContain("invalid_operation");
      },
    });
  });

  test("creates a reviewed manual request for direct control-ui sends", async () => {
    await withDefaultSignerWallet(async () => {
      const signer = signerReviewAdapter();
      vi.spyOn(walletProviderResolver, "createWalletProviderAdapter").mockReturnValue(
        signer.adapter,
      );
      await withTempConfig({
        cfg: manualSocketSignerCfg,
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
              path: "/api/wallet/approvals/create",
              authorization: "Bearer root-token",
              body: {
                chain: "solana",
                to: "So11111111111111111111111111111111111111112",
                amount: "1",
              },
            }),
            response.res,
          );
          expect(response.res.statusCode, response.getBody()).toBe(200);
          const parsed = parseBody(response.getBody());
          expect(parsed.ok).toBe(true);
          expect(parsed.mode).toBe("manual");
          expect(signer.prepareTypedTransferReview).toHaveBeenCalledWith(
            expect.objectContaining({ walletId: "vault-1", amount: "1" }),
          );
        },
      });
    });
  });

  test("completes signer-owned WebAuthn review without Gateway token or custody fallback", async () => {
    await withDefaultSignerWallet(async () => {
      const signer = signerReviewAdapter();
      vi.spyOn(walletProviderResolver, "createWalletProviderAdapter").mockReturnValue(
        signer.adapter,
      );
      const signerPasskeyCfg = {
        ...manualSocketSignerCfg,
        wallet: {
          ...manualSocketSignerCfg.wallet,
          approvalAuth: { mode: "webauthn" },
        },
      };
      await withTempConfig({
        cfg: signerPasskeyCfg,
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
          const createdResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              path: "/api/wallet/approvals/create",
              authorization: "Bearer root-token",
              body: {
                chain: "solana",
                to: "So11111111111111111111111111111111111111112",
                amount: "0.5",
                amountFormat: "human",
              },
            }),
            createdResponse.res,
          );
          expect(createdResponse.res.statusCode, createdResponse.getBody()).toBe(200);
          const createdBody = parseBody(createdResponse.getBody());
          const approval = (createdBody.request ?? {}) as Record<string, unknown>;
          const approvalId = typeof approval.id === "string" ? approval.id : "";
          const approvalPayload = (approval.payload ?? {}) as Record<string, unknown>;
          const reviewId =
            typeof approvalPayload.signerReviewId === "string"
              ? approvalPayload.signerReviewId
              : "";
          expect(approvalId).not.toBe("");
          expect(reviewId).toBe(approvalId);
          expect(approvalPayload.amount).toBe("500000000");

          const injectedResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              path: `/api/wallet/approvals/${approvalId}/approve`,
              authorization: "Bearer root-token",
              body: { policyHash: `sha256:${"f".repeat(64)}` },
            }),
            injectedResponse.res,
          );
          expect(injectedResponse.res.statusCode).toBe(400);
          expect(injectedResponse.getBody()).toContain("accepts only signerAuthorization");

          signer.beginSignerReviewAuthorization.mockRejectedValueOnce(
            new Error(
              "no signer-owned WebAuthn credential is enrolled; from host administration, run 'fased-signerd admin webauthn registration begin --control-socket <signer-control.sock> --label <label>' and complete 'webauthn registration finish' through the same control socket; Gateway enrollment is intentionally unavailable",
            ),
          );
          const unenrolledResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              path: `/api/wallet/approvals/${approvalId}/approve`,
              authorization: "Bearer root-token",
              body: {},
            }),
            unenrolledResponse.res,
          );
          expect(unenrolledResponse.res.statusCode).toBe(400);
          expect(unenrolledResponse.getBody()).toContain("wallet_signer_webauthn_not_enrolled");
          expect(unenrolledResponse.getBody()).toContain(
            "fased-signerd admin webauthn registration begin",
          );
          expect(unenrolledResponse.getBody()).toContain(
            "Gateway enrollment is intentionally unavailable",
          );

          const beginResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              path: `/api/wallet/approvals/${approvalId}/approve`,
              authorization: "Bearer root-token",
              body: {},
            }),
            beginResponse.res,
          );
          expect(beginResponse.res.statusCode, beginResponse.getBody()).toBe(200);
          const beginBody = parseBody(beginResponse.getBody());
          expect(beginBody.mode).toBe("signer-webauthn");
          expect(beginBody.signerAuthorization).toMatchObject({
            challengeId: "challenge-123",
            binding: {
              requestId: reviewId,
              walletId: "vault-1",
              policyHash: approvalPayload.signerPolicyHash,
              intentDigest: approvalPayload.signerIntentDigest,
              transactionDigest: approvalPayload.signerTransactionDigest,
            },
          });

          signer.setFinishReviewId(reviewId);
          const credential = {
            id: "credential-123",
            rawId: "BAUG",
            type: "public-key",
            response: {
              clientDataJSON: "AQID",
              authenticatorData: "BAUG",
              signature: "BwgJ",
            },
          };
          const finishResponse = createResponse();
          await dispatch(
            server,
            createRequest({
              path: `/api/wallet/approvals/${approvalId}/approve`,
              authorization: "Bearer root-token",
              body: {
                signerAuthorization: { challengeId: "challenge-123", credential },
              },
            }),
            finishResponse.res,
          );
          expect(finishResponse.res.statusCode, finishResponse.getBody()).toBe(200);
          expect(parseBody(finishResponse.getBody())).toMatchObject({
            ok: true,
            request: { status: "executed" },
            tx: { txHash: "review-signature" },
          });
          expect(signer.finishSignerReviewAuthorization).toHaveBeenCalledWith({
            walletId: "vault-1",
            challengeId: "challenge-123",
            credential,
          });
          expect(signer.executeSignerReview).toHaveBeenCalledWith({
            walletId: "vault-1",
            requestId: reviewId,
            authorization: { type: "webauthn", proof: { proofId: "proof-123" } },
          });
          expect(signer.sendTx).not.toHaveBeenCalled();
        },
      });
    });
  });

  test("resolves Solana destination wallet handles for reviewed sends", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-wallet-handle-send-test-"));
    const previousStateDir = process.env.FASED_STATE_DIR;
    try {
      process.env.FASED_STATE_DIR = stateDir;
      const walletDir = path.join(stateDir, "wallet");
      await mkdir(walletDir, { recursive: true });
      await writeFile(
        path.join(walletDir, "provider-registry.v1.json"),
        `${JSON.stringify(
          {
            version: 1,
            providers: {
              "embedded-keystore": {
                enabled: true,
                updatedAt: "2026-05-26T00:00:00.000Z",
                label: "Self-hosted",
              },
              "local-socket-signer": {
                enabled: true,
                updatedAt: "2026-05-26T00:00:00.000Z",
                label: "Local signer",
              },
              alchemy: { enabled: false, updatedAt: "2026-05-26T00:00:00.000Z" },
              turnkey: { enabled: false, updatedAt: "2026-05-26T00:00:00.000Z" },
              privy: { enabled: false, updatedAt: "2026-05-26T00:00:00.000Z" },
            },
            wallets: [
              {
                id: "vault-1",
                name: "Vault",
                providerId: "local-socket-signer",
                addresses: { solana: "So11111111111111111111111111111111111111112" },
                metadata: { role: "vault" },
                createdAt: "2026-05-26T00:00:00.000Z",
                updatedAt: "2026-05-26T00:00:00.000Z",
              },
            ],
            assignments: {},
            defaultWalletId: "vault-1",
            updatedAt: "2026-05-26T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
      );
      const signer = signerReviewAdapter();
      vi.spyOn(walletProviderResolver, "createWalletProviderAdapter").mockReturnValue(
        signer.adapter,
      );
      await withTempConfig({
        cfg: manualSocketSignerCfg,
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
              path: "/api/wallet/approvals/create",
              authorization: "Bearer root-token",
              body: {
                chain: "solana",
                to: "@wallet:vault",
                amount: "1",
              },
            }),
            response.res,
          );
          expect(response.res.statusCode, response.getBody()).toBe(200);
          const parsed = parseBody(response.getBody());
          expect(parsed.ok).toBe(true);
          const request = (parsed.request ?? {}) as Record<string, unknown>;
          const payload = (request.payload ?? {}) as Record<string, unknown>;
          expect(payload.to).toBe("So11111111111111111111111111111111111111112");
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("does not expose legacy custody helper routes", async () => {
    await withTempConfig({
      cfg,
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
        for (const route of [
          "/api/wallet/custody/status",
          "/api/wallet/custody/init",
          "/api/wallet/custody/recover",
          "/api/wallet/custody/enroll-device",
          "/api/wallet/custody/revoke-device",
          "/api/wallet/custody/disable",
          "/api/wallet/custody/unlock",
          "/api/wallet/custody/refresh",
          "/api/wallet/custody/lock",
        ]) {
          const response = createResponse();
          await dispatch(
            server,
            createRequest({
              path: route,
              authorization: "Bearer root-token",
              body: {},
            }),
            response.res,
          );
          expect(response.res.statusCode, `${route}: ${response.getBody()}`).toBe(404);
        }
      },
    });
  });

  test("blocks normal approval actions when passkey mode is enabled but no passkey is enrolled", async () => {
    await withTempConfig({
      cfg,
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
            path: "/api/wallet/approvals/missing-request/approve",
            authorization: "Bearer root-token",
            body: {},
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
        expect(response.getBody()).toContain("wallet_control_passkey_not_ready");
      },
    });
  });

  test("converts Solana human amountFormat for /api/wallet/approvals/create", async () => {
    const prevSocket = process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = "/tmp/fased-test.sock";
    try {
      await withDefaultSignerWallet(async () => {
        const signer = signerReviewAdapter();
        vi.spyOn(walletProviderResolver, "createWalletProviderAdapter").mockReturnValue(
          signer.adapter,
        );
        await withTempConfig({
          cfg: manualSocketSignerCfg,
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
                path: "/api/wallet/approvals/create",
                authorization: "Bearer root-token",
                body: {
                  chain: "solana",
                  to: "So11111111111111111111111111111111111111112",
                  amount: "0.5",
                  amountFormat: "human",
                },
              }),
              response.res,
            );
            expect(response.res.statusCode).toBe(200);
            const parsed = parseBody(response.getBody());
            expect(parsed.ok).toBe(true);
            expect(parsed.mode).toBe("manual");
            const request = (parsed.request ?? {}) as Record<string, unknown>;
            const payload = (request.payload ?? {}) as Record<string, unknown>;
            expect(payload.amount).toBe("500000000");
            expect(signer.prepareTypedTransferReview).toHaveBeenCalledWith(
              expect.objectContaining({ amount: "500000000" }),
            );
          },
        });
      });
    } finally {
      if (prevSocket === undefined) {
        delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
      } else {
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = prevSocket;
      }
    }
  });

  test("rejects invalid human amount precision on /api/wallet/approvals/create", async () => {
    const prevSocket = process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = "/tmp/fased-test.sock";
    try {
      await withTempConfig({
        cfg: manualSocketSignerCfg,
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
              path: "/api/wallet/approvals/create",
              authorization: "Bearer root-token",
              body: {
                chain: "solana",
                to: "So11111111111111111111111111111111111111112",
                amount: "1.1234567891",
                amountFormat: "human",
              },
            }),
            response.res,
          );
          expect(response.res.statusCode).toBe(400);
          expect(response.getBody()).toContain("supports at most 9 decimals");
        },
      });
    } finally {
      if (prevSocket === undefined) {
        delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
      } else {
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = prevSocket;
      }
    }
  });

  test("rejects malformed Solana destination address on /api/wallet/approvals/create", async () => {
    const prevSocket = process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = "/tmp/fased-test.sock";
    try {
      await withTempConfig({
        cfg: manualSocketSignerCfg,
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
              path: "/api/wallet/approvals/create",
              authorization: "Bearer root-token",
              body: {
                chain: "solana",
                to: "not-a-solana-address",
                amount: "0.1",
                amountFormat: "human",
              },
            }),
            response.res,
          );
          expect(response.res.statusCode).toBe(400);
          expect(response.getBody()).toContain("invalid_solana_address");
        },
      });
    } finally {
      if (prevSocket === undefined) {
        delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
      } else {
        process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET = prevSocket;
      }
    }
  });
});
