import { once } from "node:events";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  loadConfig,
  updateConfigFile,
  writeConfigFile,
} from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { upsertMarketplaceOrderConfig } from "../federation/offers.js";
import {
  buildSignedFederationPeerRequest,
  FEDERATION_MARKETPLACE_DELIVERY_PATH,
  FEDERATION_MARKETPLACE_ORDER_PATH,
} from "../federation/peer-auth-v2.js";
import { resolveFederationHandle } from "../federation/runtime.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import { handleFederationHttpRequest } from "./federation-http.js";

class MockResponse extends PassThrough {
  public statusCode = 200;
  private readonly headerStore = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headerStore.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string) {
    return this.headerStore.get(name.toLowerCase());
  }
}

function createRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const reqStream = new PassThrough();
  const req = reqStream as unknown as IncomingMessage;
  (req as { method?: string }).method = opts.method;
  (req as { url?: string }).url = opts.url;
  (req as { headers?: Record<string, string> }).headers = opts.headers ?? {};
  process.nextTick(() => {
    if (opts.body) {
      reqStream.write(opts.body);
    }
    reqStream.end();
  });
  return req;
}

async function waitForFinish(res: MockResponse, timeoutMs = 300): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  await Promise.race([
    once(res, "finish").then(() => undefined),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("response did not finish in time")), timeoutMs);
    }),
  ]);
}

async function invoke(opts: {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  signPeerRequest?: boolean;
  baseUrl?: string;
  marketplaceDeliverySsrfLookupFn?: LookupFn;
}) {
  const parsedUrl = new URL(opts.url, "http://localhost");
  const peerPath =
    parsedUrl.pathname === FEDERATION_MARKETPLACE_ORDER_PATH
      ? FEDERATION_MARKETPLACE_ORDER_PATH
      : parsedUrl.pathname === FEDERATION_MARKETPLACE_DELIVERY_PATH
        ? FEDERATION_MARKETPLACE_DELIVERY_PATH
        : null;
  const identity =
    peerPath && opts.method === "POST"
      ? loadOrCreateDeviceIdentity(
          path.join(resolveStateDir(process.env), "identity", "device.json"),
        )
      : null;
  let body = opts.body;
  let headers = { ...opts.headers };
  if (peerPath && identity && opts.method === "POST" && opts.signPeerRequest !== false) {
    const federationBase = process.env.FASED_FEDERATION_BASE_URL || "https://ff1.fased.app";
    const recipientHandle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: new URL(federationBase).hostname,
    });
    const senderHandle = headers["x-fased-sender-handle"] || "@peer@ff1.fased.app";
    const signed = buildSignedFederationPeerRequest({
      senderHandle,
      recipientHandle,
      path: peerPath,
      body: JSON.parse(body || "{}") as unknown,
      env: process.env,
      identity,
    });
    body = signed.body;
    headers = { ...headers, ...signed.headers };
  }
  const req = createRequest({ ...opts, body, headers });
  const res = new MockResponse();
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const handled = await handleFederationHttpRequest(req, res as unknown as ServerResponse, {
    baseUrl: opts.baseUrl ?? "https://ff1.fased.app",
    peerAuthDeps: {
      directoryLookup: async ({ senderHandle }) => ({
        status: "verified",
        nodeId: identity?.deviceId ?? "missing-test-peer-identity",
        handle: senderHandle,
      }),
      rateLimiter: {
        check: () => ({ allowed: true, remaining: 100, retryAfterMs: 0 }),
        recordFailure: () => undefined,
      },
    },
    marketplaceDeliverySsrfLookupFn: opts.marketplaceDeliverySsrfLookupFn,
  });
  await waitForFinish(res);
  return {
    handled,
    statusCode: res.statusCode,
    bodyText: Buffer.concat(chunks).toString("utf-8"),
    contentType: String(res.getHeader("content-type") ?? ""),
  };
}

function writeAgentWalletRegistry(stateDir: string) {
  const walletDir = path.join(stateDir, "wallet");
  fs.mkdirSync(walletDir, { recursive: true });
  fs.writeFileSync(
    path.join(walletDir, "provider-registry.v1.json"),
    JSON.stringify(
      {
        version: 1,
        providers: {
          "embedded-keystore": {
            enabled: true,
            label: "Self-hosted",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
          "local-socket-signer": {
            enabled: true,
            label: "Local signer",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
          alchemy: { enabled: false, updatedAt: "2026-05-02T00:00:00.000Z" },
          turnkey: { enabled: false, updatedAt: "2026-05-02T00:00:00.000Z" },
          privy: { enabled: false, updatedAt: "2026-05-02T00:00:00.000Z" },
        },
        wallets: [
          {
            id: "wallet-agent",
            name: "Agent",
            providerId: "local-socket-signer",
            addresses: { solana: "AgentSeller111111111111111111111111111111111" },
            metadata: { purpose: "agent" },
            createdAt: "2026-05-02T00:00:00.000Z",
            updatedAt: "2026-05-02T00:00:00.000Z",
          },
        ],
        assignments: {},
        defaultWalletId: "wallet-agent",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  clearConfigCache();
  delete process.env.FASED_CONFIG_PATH;
  delete process.env.FASED_A2A_HANDLE;
  delete process.env.FASED_A2A_ORIGIN;
  delete process.env.FASED_FEDERATION_BASE_URL;
  delete process.env.FASED_FEDERATION_API_TOKEN;
  delete process.env.FASED_FEDERATION_TOKEN_PATH;
  delete process.env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH;
  delete process.env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH;
  delete process.env.FASED_STATE_DIR;
});

describe("federation HTTP proxy", () => {
  it("forwards marketplace offer discovery requests", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe(
        "https://ff1.fased.app/api/federation/offers?serviceKind=content.summarize",
      );
      return new Response(JSON.stringify({ offers: [{ id: "offer-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "GET",
      url: "/api/federation/offers?serviceKind=content.summarize",
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(JSON.parse(response.bodyText)).toEqual({ offers: [{ id: "offer-1" }] });
  });

  it("uses only the dedicated federation credential for upstream review publishes", async () => {
    process.env.FASED_FEDERATION_API_TOKEN = "upstream-fed-token";
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe("https://ff1.fased.app/api/federation/reviews");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer upstream-fed-token");
      expect(init?.body).toBe('{"rating":5}');
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ status: "accepted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "POST",
      url: "/api/federation/reviews",
      body: JSON.stringify({ rating: 5 }),
      headers: { authorization: "Bearer gateway-secret-must-not-forward" },
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText)).toEqual({ status: "accepted" });
  });

  it("rejects a plaintext remote federation base before forwarding credentials", async () => {
    process.env.FASED_FEDERATION_API_TOKEN = "must-not-leak";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "GET",
      url: "/api/federation/offers",
      baseUrl: "http://central.example",
      headers: { authorization: "Bearer gateway-secret" },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.bodyText).reason).toContain("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the persisted local federation token for operator economy fee reads", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-token-"));
    process.env.FASED_FEDERATION_TOKEN_PATH = path.join(stateDir, "access-token.json");
    fs.writeFileSync(
      process.env.FASED_FEDERATION_TOKEN_PATH,
      JSON.stringify({
        tokenId: "local-fed-token",
        nodeId: "node-1",
        handle: "@fees@fased.test",
        issuedAt: "2026-04-20T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["federation.read", "federation.write"],
        signature: "sig",
      }),
      "utf-8",
    );
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe(
        "https://ff1.fased.app/api/federation/operator-economy/fees/status?lane=marketplace",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-fed-token");
      return new Response(JSON.stringify({ statuses: [{ lane: "marketplace", enabled: false }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "GET",
      url: "/api/federation/operator-economy/fees/status?lane=marketplace",
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText)).toEqual({
      statuses: [{ lane: "marketplace", enabled: false }],
    });
  });

  it("persists a federation token returned from browser enrollment", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-enroll-token-"));
    process.env.FASED_FEDERATION_TOKEN_PATH = path.join(stateDir, "access-token.json");
    const issuedToken = {
      tokenId: "joined-token",
      nodeId: "node-joined",
      handle: "@joined@ff1.fased.app",
      issuedAt: "2026-06-06T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["federation.read", "federation.write"],
      signature: "sig",
      trustState: "pending",
      hostedState: "ready",
      publicUrl: "https://joined.tailnet.ts.net",
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe("https://ff1.fased.app/api/federation/admission/enroll");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ status: "accepted", token: issuedToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "POST",
      url: "/api/federation/admission/enroll",
      body: JSON.stringify({
        challengeId: "challenge-1",
        attestation: { schema: "test" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText)).toEqual({ status: "accepted", token: issuedToken });
    expect(JSON.parse(fs.readFileSync(process.env.FASED_FEDERATION_TOKEN_PATH, "utf-8"))).toEqual(
      issuedToken,
    );
  });

  it("derives a federation handle for blank browser join requests", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-derived-handle-"));
    process.env.FASED_STATE_DIR = stateDir;
    process.env.FASED_A2A_ORIGIN = "https://joined.tailnet.ts.net";
    let forwardedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe("https://ff1.fased.app/api/federation/registry/handles");
      expect(typeof init?.body).toBe("string");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      forwardedBody = body;
      return new Response(JSON.stringify({ status: "accepted", handle: body.requestedHandle }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "POST",
      url: "/api/federation/registry/handles",
      body: JSON.stringify({ requestedHandle: "", nodeEndpoint: "" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(String(forwardedBody?.requestedHandle)).toMatch(
      /^@fased-agent-[a-f0-9]{12}@ff1\.fased\.app$/,
    );
    expect(forwardedBody?.nodeEndpoint).toBe("https://joined.tailnet.ts.net");
  });

  it("falls back to local threshold status when the upstream fee status route is missing", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-ops-status-"));
    process.env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH = path.join(
      stateDir,
      "operator-economy-devnet-threshold-status.json",
    );
    fs.writeFileSync(
      process.env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH,
      JSON.stringify({
        routingCollectionDeferred: true,
        assessment: {
          historyDaysObserved: 1,
          thresholds: {
            historyDays: 14,
            marketplaceRuns: 30,
            disputeNotaryCases: 10,
            settlementVerifierCases: 10,
            routingRuns: 30,
          },
          lanes: {
            marketplace: { observed: 2, ready: false },
            "dispute-notary": { observed: 1, ready: false },
            "settlement-verifier": { observed: 1, ready: false },
            routing: { observed: 0, ready: false },
          },
        },
      }),
      "utf-8",
    );
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "GET",
      url: "/api/federation/operator-economy/fees/status",
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText)).toEqual({
      statuses: [
        {
          lane: "marketplace",
          enabled: false,
          reason:
            "fee collection is disabled until the multi-day measurement history threshold is met",
          thresholds: {
            historyDays: 14,
            marketplaceRuns: 30,
            disputeNotaryCases: 10,
            settlementVerifierCases: 10,
            routingRuns: 30,
          },
          observed: {
            historyDaysObserved: 1,
            marketplaceRunsObserved: 2,
            disputeNotaryCasesObserved: 1,
            settlementVerifierCasesObserved: 1,
            routingRunsObserved: 0,
          },
        },
        {
          lane: "dispute-notary",
          enabled: false,
          reason:
            "fee collection is disabled until the multi-day measurement history threshold is met",
          thresholds: {
            historyDays: 14,
            marketplaceRuns: 30,
            disputeNotaryCases: 10,
            settlementVerifierCases: 10,
            routingRuns: 30,
          },
          observed: {
            historyDaysObserved: 1,
            marketplaceRunsObserved: 2,
            disputeNotaryCasesObserved: 1,
            settlementVerifierCasesObserved: 1,
            routingRunsObserved: 0,
          },
        },
        {
          lane: "settlement-verifier",
          enabled: false,
          reason:
            "fee collection is disabled until the multi-day measurement history threshold is met",
          thresholds: {
            historyDays: 14,
            marketplaceRuns: 30,
            disputeNotaryCases: 10,
            settlementVerifierCases: 10,
            routingRuns: 30,
          },
          observed: {
            historyDaysObserved: 1,
            marketplaceRunsObserved: 2,
            disputeNotaryCasesObserved: 1,
            settlementVerifierCasesObserved: 1,
            routingRunsObserved: 0,
          },
        },
        {
          lane: "routing",
          enabled: false,
          reason: "routing fee collection remains deferred",
          thresholds: {
            historyDays: 14,
            marketplaceRuns: 30,
            disputeNotaryCases: 10,
            settlementVerifierCases: 10,
            routingRuns: 30,
          },
          observed: {
            historyDaysObserved: 1,
            marketplaceRunsObserved: 2,
            disputeNotaryCasesObserved: 1,
            settlementVerifierCasesObserved: 1,
            routingRunsObserved: 0,
          },
        },
      ],
    });
  });

  it("falls back to local collection evidence for fee object reads when the upstream route is missing", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-ops-evidence-"));
    process.env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH = path.join(
      stateDir,
      "operator-economy-fee-collection-marketplace.json",
    );
    fs.writeFileSync(
      process.env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH,
      JSON.stringify({
        feeObjects: [
          {
            feeId: "fee:marketplace:review-1",
            lane: "marketplace",
            status: "collected",
            reviewState: "approved",
            policyVersion: "oe-fees-v0",
          },
          {
            feeId: "fee:settlement-verifier:inv-1",
            lane: "settlement-verifier",
            status: "held",
            reviewState: "held-for-review",
            policyVersion: "oe-fees-v0",
          },
        ],
      }),
      "utf-8",
    );
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "GET",
      url: "/api/federation/operator-economy/fees/objects?lane=marketplace&status=collected",
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText)).toEqual({
      feeObjects: [
        {
          feeId: "fee:marketplace:review-1",
          lane: "marketplace",
          status: "collected",
          reviewState: "approved",
          policyVersion: "oe-fees-v0",
        },
      ],
    });
  });

  it("serves local showcase metadata for simulated operator-economy evidence", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-ops-showcase-"));
    process.env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH = path.join(
      stateDir,
      "operator-economy-simulated-status.json",
    );
    process.env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH = path.join(
      stateDir,
      "operator-economy-simulated-collection-evidence.json",
    );
    fs.writeFileSync(
      process.env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH,
      JSON.stringify({
        simulated: true,
        nonEvidence: true,
        routingCollectionDeferred: true,
        payoutEnabled: false,
      }),
      "utf-8",
    );
    fs.writeFileSync(
      process.env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH,
      JSON.stringify({
        simulated: true,
        nonEvidence: true,
        collectionActivationMode: "real-domain-events",
        reconciliationMode: "auto-generated",
        payoutEnabled: false,
      }),
      "utf-8",
    );

    const response = await invoke({
      method: "GET",
      url: "/api/federation/operator-economy/fees/showcase",
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText)).toEqual({
      showcase: {
        available: true,
        source: "local-fallback",
        simulated: true,
        nonEvidence: true,
        hasThresholdStatus: false,
        hasCollectionEvidence: false,
        statusPath: process.env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH,
        evidencePath: process.env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH,
        collectionActivationMode: "real-domain-events",
        reconciliationMode: "auto-generated",
        routingCollectionDeferred: true,
        payoutEnabled: false,
        notes: [
          "showcase mode is using simulated operator activity evidence for demo purposes only",
          "simulated operator activity rows do not satisfy live activation or distribution readiness checks",
          "routing fee collection remains deferred",
          "distribution remains disabled in this release",
        ],
      },
    });
  });

  it("creates, updates, lists, and deletes local manual offers", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    writeAgentWalletRegistry(configDir);
    await writeConfigFile({});

    const created = await invoke({
      method: "POST",
      url: "/api/federation/local/offers",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Custom Summary",
        serviceKind: "content.custom-summary",
        summary: "Manual local offer",
        capabilities: ["summarize", "custom"],
      }),
    });

    expect(created.handled).toBe(true);
    expect(created.statusCode).toBe(200);
    const createdBody = JSON.parse(created.bodyText) as {
      created: boolean;
      offer?: { source?: string; mutable?: boolean; configId?: string; offer?: { title?: string } };
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.offer?.source).toBe("manual");
    expect(createdBody.offer?.mutable).toBe(true);
    expect(createdBody.offer?.offer?.title).toBe("Custom Summary");
    const offerId = String(createdBody.offer?.configId ?? "");
    expect(offerId).toBeTruthy();

    const listed = await invoke({
      method: "GET",
      url: "/api/federation/local/offers",
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    expect(listed.handled).toBe(true);
    expect(listed.statusCode).toBe(200);
    const listedBody = JSON.parse(listed.bodyText) as {
      offers: Array<{ source?: string; configId?: string; offer?: { title?: string } }>;
    };
    expect(
      listedBody.offers.some((entry) => entry.source === "manual" && entry.configId === offerId),
    ).toBe(true);

    const updated = await invoke({
      method: "PUT",
      url: `/api/federation/local/offers/${encodeURIComponent(offerId)}`,
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Custom Summary v2",
        serviceKind: "content.custom-summary",
        summary: "Updated manual offer",
        enabled: false,
      }),
    });
    expect(updated.handled).toBe(true);
    expect(updated.statusCode).toBe(200);
    const updatedBody = JSON.parse(updated.bodyText) as {
      offer?: { enabled?: boolean; offer?: { title?: string; summary?: string } };
    };
    expect(updatedBody.offer?.enabled).toBe(false);
    expect(updatedBody.offer?.offer?.title).toBe("Custom Summary v2");

    const deleted = await invoke({
      method: "DELETE",
      url: `/api/federation/local/offers/${encodeURIComponent(offerId)}`,
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    expect(deleted.handled).toBe(true);
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(deleted.bodyText)).toMatchObject({ ok: true, deleted: true, id: offerId });

    const afterDelete = await invoke({
      method: "GET",
      url: "/api/federation/local/offers",
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    const afterDeleteBody = JSON.parse(afterDelete.bodyText) as {
      offers: Array<{ source?: string; configId?: string }>;
    };
    expect(
      afterDeleteBody.offers.some(
        (entry) => entry.source === "manual" && entry.configId === offerId,
      ),
    ).toBe(false);
  });

  it("creates, updates, lists, and deletes local marketplace requests", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-requests-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    writeAgentWalletRegistry(configDir);
    await writeConfigFile({});

    const created = await invoke({
      method: "POST",
      url: "/api/federation/local/requests",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: "chat",
        title: "Need data lookup",
        serviceKind: "data.lookup",
        summary: "Find verified supplier rows.",
        pricing: {
          currency: "USDC",
          model: "quote",
          amount: 25,
          unit: "per-day",
        },
        fulfillmentMode: "agent-approval",
        receiptRules: [{ kind: "result", required: true }],
      }),
    });

    expect(created.handled).toBe(true);
    expect(created.statusCode).toBe(200);
    const createdBody = JSON.parse(created.bodyText) as {
      created: boolean;
      request?: {
        source?: string;
        mutable?: boolean;
        status?: string;
        configId?: string;
        request?: { title?: string; pricing?: { unit?: string } };
      };
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.request?.source).toBe("chat");
    expect(createdBody.request?.mutable).toBe(true);
    expect(createdBody.request?.status).toBe("draft");
    expect(createdBody.request?.request?.title).toBe("Need data lookup");
    expect(createdBody.request?.request?.pricing?.unit).toBe("per-day");
    const requestId = String(createdBody.request?.configId ?? "");
    expect(requestId).toBeTruthy();

    const listed = await invoke({
      method: "GET",
      url: "/api/federation/local/requests",
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    expect(listed.handled).toBe(true);
    expect(listed.statusCode).toBe(200);
    const listedBody = JSON.parse(listed.bodyText) as {
      requests: Array<{ source?: string; configId?: string }>;
    };
    expect(
      listedBody.requests.some((entry) => entry.source === "chat" && entry.configId === requestId),
    ).toBe(true);

    const updated = await invoke({
      method: "PUT",
      url: `/api/federation/local/requests/${encodeURIComponent(requestId)}`,
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Need data lookup v2",
        serviceKind: "data.lookup",
        summary: "Updated buyer request.",
        enabled: true,
        status: "open",
      }),
    });
    expect(updated.handled).toBe(true);
    expect(updated.statusCode).toBe(200);
    const updatedBody = JSON.parse(updated.bodyText) as {
      request?: { enabled?: boolean; status?: string; request?: { title?: string } };
    };
    expect(updatedBody.request?.enabled).toBe(true);
    expect(updatedBody.request?.status).toBe("open");
    expect(updatedBody.request?.request?.title).toBe("Need data lookup v2");

    const deleted = await invoke({
      method: "DELETE",
      url: `/api/federation/local/requests/${encodeURIComponent(requestId)}`,
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    expect(deleted.handled).toBe(true);
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(deleted.bodyText)).toMatchObject({ ok: true, deleted: true, id: requestId });

    const afterDelete = await invoke({
      method: "GET",
      url: "/api/federation/local/requests",
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    const afterDeleteBody = JSON.parse(afterDelete.bodyText) as {
      requests: Array<{ source?: string; configId?: string }>;
    };
    expect(
      afterDeleteBody.requests.some(
        (entry) => entry.source === "chat" && entry.configId === requestId,
      ),
    ).toBe(false);
  });

  it("previews and publishes local marketplace entries to the federation index", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-index-publish-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    process.env.FASED_A2A_HANDLE = "@seller@ff1.fased.app";
    process.env.FASED_A2A_ORIGIN = "https://seller.example";
    process.env.FASED_FEDERATION_TOKEN_PATH = path.join(configDir, "access-token.json");
    writeAgentWalletRegistry(configDir);
    fs.writeFileSync(
      process.env.FASED_FEDERATION_TOKEN_PATH,
      JSON.stringify({
        tokenId: "seller-fed-token",
        nodeId: "node-1",
        handle: "@seller@ff1.fased.app",
        issuedAt: "2026-05-02T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["federation.read", "federation.write"],
        signature: "sig",
      }),
      "utf-8",
    );
    await writeConfigFile({});

    const createdOffer = await invoke({
      method: "POST",
      url: "/api/federation/local/offers",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Signal Feed",
        serviceKind: "market.signal",
        summary: "Daily market signal feed.",
        pricing: {
          currency: "USDC",
          model: "fixed",
          amount: 10,
          unit: "per-day",
        },
      }),
    });
    expect(createdOffer.statusCode).toBe(200);

    const createdRequest = await invoke({
      method: "POST",
      url: "/api/federation/local/requests",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Need Data Feed",
        serviceKind: "data.feed",
        summary: "Need a compact market data feed.",
        enabled: true,
        status: "open",
        pricing: {
          currency: "USDC",
          model: "fixed",
          amount: 20,
          unit: "per-day",
        },
      }),
    });
    expect(createdRequest.statusCode).toBe(200);

    const preview = await invoke({
      method: "GET",
      url: "/api/federation/local/marketplace-index/preview",
      headers: { host: "127.0.0.1:18789" },
    });
    expect(preview.handled).toBe(true);
    expect(preview.statusCode).toBe(200);
    const previewBody = JSON.parse(preview.bodyText) as {
      counts: { offers: number; requests: number };
      offers: Array<{ title?: string; serviceKind?: string }>;
      requests: Array<{ title?: string; serviceKind?: string }>;
    };
    expect(previewBody.counts).toEqual({ offers: 1, requests: 1 });
    expect(previewBody.offers).toEqual([
      expect.objectContaining({ title: "Signal Feed", serviceKind: "market.signal" }),
    ]);
    expect(previewBody.requests).toEqual([
      expect.objectContaining({ title: "Need Data Feed", serviceKind: "data.feed" }),
    ]);

    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe("https://ff1.fased.app/api/federation/marketplace/index");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer seller-fed-token");
      const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        handle?: string;
        offers?: Array<{ title?: string; type?: string }>;
        requests?: Array<{ title?: string; type?: string }>;
      };
      expect(payload.handle).toBe("@seller@ff1.fased.app");
      expect(payload.offers).toHaveLength(1);
      expect(payload.offers?.[0]).toMatchObject({ title: "Signal Feed", type: "AgentOffer" });
      expect(payload.requests).toHaveLength(1);
      expect(payload.requests?.[0]).toMatchObject({
        title: "Need Data Feed",
        type: "MarketplaceRequest",
      });
      return new Response(
        JSON.stringify({
          status: "accepted",
          indexed: { offers: payload.offers?.length ?? 0, requests: payload.requests?.length ?? 0 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const published = await invoke({
      method: "POST",
      url: "/api/federation/local/marketplace-index/publish",
      headers: { host: "127.0.0.1:18789" },
    });
    expect(published.handled).toBe(true);
    expect(published.statusCode).toBe(200);
    expect(JSON.parse(published.bodyText)).toMatchObject({
      ok: true,
      handle: "@seller@ff1.fased.app",
      counts: { offers: 1, requests: 1 },
      upstream: {
        status: "accepted",
        indexed: { offers: 1, requests: 1 },
      },
    });
  });

  it("creates, updates, lists, and deletes local marketplace orders", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-orders-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    writeAgentWalletRegistry(configDir);
    await writeConfigFile({});

    const created = await invoke({
      method: "POST",
      url: "/api/federation/local/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "accepted",
        offerId: "https://seller.example/offers/data-feed",
        buyerHandle: "@buyer@fased.test",
        sellerHandle: "@seller@fased.test",
        sellerEndpoint: "https://seller.ff1.fased.app",
        title: "Daily data feed",
        serviceKind: "data.feed",
        pricing: {
          currency: "USDC",
          model: "fixed",
          amount: 15,
          unit: "per-day",
        },
        fulfillmentMode: "api",
        receiptRules: [{ kind: "receipt", required: true }],
        paymentIntent: {
          status: "requires_payment",
          method: "agent-wallet",
          acceptedAssets: ["USDC", "SOL"],
        },
        delivery: {
          status: "pending",
          inputShape: "query",
          deliveryShape: "webhook-json",
          target: {
            kind: "webhook",
            status: "ready",
            label: "Buyer webhook",
            webhook: { url: "https://buyer.example/hooks/orders/secret-token" },
            scope: { expiresAt: "2026-06-01T00:00:00.000Z" },
          },
        },
        subscription: {
          status: "active",
          billingPeriod: "per-day",
          maxBuyers: 100,
          remainingSlots: 99,
          startsAt: "2026-05-02T00:00:00.000Z",
          endsAt: "2026-06-02T00:00:00.000Z",
          renewalPolicy: "manual",
          paymentExpiresAt: "2026-05-09T00:00:00.000Z",
          deliveryStop: {
            status: "scheduled",
            reason: "payment_expires",
            scheduledAt: "2026-05-09T00:00:00.000Z",
          },
        },
        receipt: {
          status: "pending",
        },
      }),
    });

    expect(created.handled).toBe(true);
    expect(created.statusCode).toBe(200);
    const createdBody = JSON.parse(created.bodyText) as {
      created: boolean;
      order?: {
        status?: string;
        configId?: string;
        order?: {
          title?: string;
          sellerEndpoint?: string;
          paymentIntent?: { status?: string; currency?: string; acceptedAssets?: string[] };
          delivery?: {
            status?: string;
            deliveryShape?: string;
            targetId?: string;
            targetKind?: string;
            targetLabel?: string;
            targetMasked?: string;
            target?: unknown;
          };
          subscription?: {
            status?: string;
            billingPeriod?: string;
            maxBuyers?: number;
            remainingSlots?: number;
            renewalPolicy?: string;
            paymentExpiresAt?: string;
            deliveryStop?: { status?: string; reason?: string; scheduledAt?: string };
          };
          receipt?: { status?: string };
        };
      };
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.order?.status).toBe("accepted");
    expect(createdBody.order?.order?.title).toBe("Daily data feed");
    expect(createdBody.order?.order?.sellerEndpoint).toBe("https://seller.ff1.fased.app");
    expect(createdBody.order?.order?.paymentIntent?.status).toBe("requires_payment");
    expect(createdBody.order?.order?.paymentIntent?.currency).toBe("USDC");
    expect(createdBody.order?.order?.paymentIntent?.acceptedAssets).toEqual(["USDC", "SOL"]);
    expect(createdBody.order?.order?.delivery?.deliveryShape).toBe("webhook-json");
    expect(createdBody.order?.order?.delivery?.targetKind).toBe("webhook");
    expect(createdBody.order?.order?.delivery?.targetLabel).toBe("Buyer webhook");
    expect(createdBody.order?.order?.delivery?.targetMasked).toBe("https://buyer.example/...");
    expect(createdBody.order?.order?.delivery?.target).toBeUndefined();
    expect(createdBody.order?.order?.subscription).toMatchObject({
      status: "active",
      billingPeriod: "per-day",
      maxBuyers: 100,
      remainingSlots: 99,
      renewalPolicy: "manual",
      paymentExpiresAt: "2026-05-09T00:00:00.000Z",
      deliveryStop: {
        status: "scheduled",
        reason: "payment_expires",
        scheduledAt: "2026-05-09T00:00:00.000Z",
      },
    });
    const orderId = String(createdBody.order?.configId ?? "");
    expect(orderId).toBeTruthy();
    expect(createdBody.order?.order?.delivery?.targetId).toBeTruthy();

    const savedConfig = loadConfig();
    const savedTarget = savedConfig.federation?.marketplace?.deliveryTargets?.local?.find(
      (entry) => entry.targetId === createdBody.order?.order?.delivery?.targetId,
    );
    expect(savedTarget?.webhook?.url).toBe("https://buyer.example/hooks/orders/secret-token");
    expect(savedTarget?.maskedTarget).toBe("https://buyer.example/...");

    const listed = await invoke({
      method: "GET",
      url: "/api/federation/local/orders",
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    expect(listed.handled).toBe(true);
    expect(listed.statusCode).toBe(200);
    const listedBody = JSON.parse(listed.bodyText) as {
      orders: Array<{ configId?: string; order?: { offerId?: string } }>;
    };
    expect(listedBody.orders.some((entry) => entry.configId === orderId)).toBe(true);

    const updated = await invoke({
      method: "PUT",
      url: `/api/federation/local/orders/${encodeURIComponent(orderId)}`,
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "delivered",
        offerId: "https://seller.example/offers/data-feed",
        title: "Daily data feed",
        serviceKind: "data.feed",
        pricing: {
          currency: "USDC",
          model: "fixed",
          amount: 15,
          unit: "per-day",
        },
        paymentIntent: {
          status: "verified",
          txRef: "tx-123",
        },
        delivery: {
          status: "delivered",
          resultRef: "artifact://result-1",
        },
        receipt: {
          status: "issued",
          receiptId: "receipt-123",
        },
      }),
    });
    expect(updated.handled).toBe(true);
    expect(updated.statusCode).toBe(200);
    const updatedBody = JSON.parse(updated.bodyText) as {
      order?: {
        status?: string;
        order?: {
          paymentIntent?: { status?: string; txRef?: string };
          sellerEndpoint?: string;
          delivery?: { status?: string; resultRef?: string };
          receipt?: { status?: string; receiptId?: string };
        };
      };
    };
    expect(updatedBody.order?.status).toBe("delivered");
    expect(updatedBody.order?.order?.sellerEndpoint).toBe("https://seller.ff1.fased.app");
    expect(updatedBody.order?.order?.paymentIntent?.status).toBe("verified");
    expect(updatedBody.order?.order?.delivery?.resultRef).toBe("artifact://result-1");
    expect(updatedBody.order?.order?.receipt?.receiptId).toBe("receipt-123");

    const deleted = await invoke({
      method: "DELETE",
      url: `/api/federation/local/orders/${encodeURIComponent(orderId)}`,
      headers: {
        host: "127.0.0.1:18789",
      },
    });
    expect(deleted.handled).toBe(true);
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(deleted.bodyText)).toMatchObject({ ok: true, deleted: true, id: orderId });
  });

  it("rejects invalid marketplace delivery targets", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-bad-target-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    writeAgentWalletRegistry(configDir);
    await writeConfigFile({});

    const response = await invoke({
      method: "POST",
      url: "/api/federation/local/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "accepted",
        offerId: "offer-1",
        title: "Bad delivery target",
        serviceKind: "data.feed",
        delivery: {
          target: {
            kind: "webhook",
            webhook: { url: "ftp://buyer.example/secret" },
          },
        },
      }),
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.bodyText)).toMatchObject({
      status: "rejected",
      reason: "delivery webhook target requires an HTTPS URL or localhost smoke URL",
    });
  });

  it("delivers paid content summaries to the saved webhook target without exposing target secrets", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-webhook-delivery-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    writeAgentWalletRegistry(configDir);
    await writeConfigFile({});

    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await invoke({
      method: "POST",
      url: "/api/federation/local/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "running",
        offerId: "https://seller.example/offers/content-summarize-v0",
        title: "Paid summary",
        serviceKind: "content.summarize",
        pricing: {
          currency: "USDC",
          model: "fixed",
          amount: 5,
          unit: "per-job",
        },
        paymentIntent: {
          status: "submitted",
          currency: "USDC",
          amount: 5,
        },
        delivery: {
          status: "running",
          deliveryShape: "summary-v0",
          target: {
            kind: "webhook",
            status: "ready",
            label: "Buyer webhook",
            descriptor: "Private buyer webhook",
            webhook: { url: "https://buyer.example/hooks/orders/secret-token" },
          },
        },
        receipt: { status: "pending" },
      }),
    });
    const createdBody = JSON.parse(created.bodyText) as {
      order?: { configId?: string; order?: { delivery?: { targetId?: string; target?: unknown } } };
    };
    const orderId = String(createdBody.order?.configId ?? "");
    expect(orderId).toBeTruthy();
    expect(createdBody.order?.order?.delivery?.target).toBeUndefined();

    const delivered = await invoke({
      method: "POST",
      url: `/api/federation/local/orders/${encodeURIComponent(orderId)}/deliver/content-summarize`,
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        result: {
          status: "accepted",
          taskId: "task-123",
          snapshot: {
            taskId: "task-123",
            output: {
              taskId: "task-123",
              result: {
                kind: "content.summarize.v0",
                summaryText: "Delivered paid summary.",
                sentenceCount: 1,
                sourceWordCount: 4,
                style: "plain",
              },
              payment: {
                status: "verified",
                invoiceId: "invoice-1",
                receiptId: "receipt-1",
                txRef: "tx-1",
              },
            },
          },
        },
      }),
      marketplaceDeliverySsrfLookupFn: (async () => [
        { address: "93.184.216.34", family: 4 },
      ]) as unknown as LookupFn,
    });

    expect(delivered.handled).toBe(true);
    expect(delivered.statusCode).toBe(200);
    expect(JSON.parse(delivered.bodyText)).toMatchObject({
      ok: true,
      delivered: true,
      targetKind: "webhook",
      deliveryStatus: "delivered",
      order: {
        status: "delivered",
        order: {
          paymentIntent: { status: "verified", txRef: "tx-1" },
          delivery: {
            status: "delivered",
            targetKind: "webhook",
            targetMasked: "https://buyer.example/...",
            resultRef: "task-123",
          },
          receipt: {
            status: "issued",
            invoiceId: "invoice-1",
            receiptId: "receipt-1",
          },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [webhookUrlRaw, init] = fetchMock.mock.calls[0] ?? [];
    const webhookUrl =
      typeof webhookUrlRaw === "string"
        ? webhookUrlRaw
        : webhookUrlRaw instanceof URL
          ? webhookUrlRaw.toString()
          : "";
    expect(webhookUrl).toBe("https://buyer.example/hooks/orders/secret-token");
    const body = init?.body;
    expect(typeof body).toBe("string");
    const payload = JSON.parse(body as string) as {
      result?: { summaryText?: string };
      target?: { maskedTarget?: string };
    };
    expect(payload.result?.summaryText).toBe("Delivered paid summary.");
    expect(payload.target?.maskedTarget).toBe("https://buyer.example/...");
    expect(JSON.stringify(payload)).not.toContain("secret-token");

    const savedTarget = loadConfig().federation?.marketplace?.deliveryTargets?.local?.find(
      (entry) => entry.targetId === createdBody.order?.order?.delivery?.targetId,
    );
    expect(savedTarget?.webhook?.url).toBe("https://buyer.example/hooks/orders/secret-token");
  });

  it("accepts federation marketplace deliveries into the local read-only order inbox", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-delivery-inbox-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    const buyerOrder = upsertMarketplaceOrderConfig({
      config: {},
      input: {
        id: "buyer-order-1",
        source: "local",
        status: "accepted",
        offerId: "https://seller.example/offers/content-summarize-v0",
        buyerHandle: "@buyer@ff1.fased.app",
        sellerHandle: "@seller@ff1.fased.app",
        sellerOrderId: "seller-order-1",
        serviceKind: "content.summarize",
        title: "Federated content summary",
      },
    });
    await writeConfigFile(buyerOrder.config);

    const response = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/deliveries",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@seller@ff1.fased.app",
      },
      body: JSON.stringify({
        schema: "https://schemas.fased.ai/fased-marketplace-delivery-v0.json",
        type: "content.summarize.delivered",
        orderId: "seller-order-1",
        offerId: "https://seller.example/offers/content-summarize-v0",
        serviceKind: "content.summarize",
        resultRef: "task-fed-1",
        artifactRef: "fased://marketplace/orders/seller-order-1/content-summarize/task-fed-1",
        deliveredAt: "2026-05-02T12:00:00.000Z",
        target: {
          kind: "federation",
          label: "Buyer node",
          maskedTarget: "@buyer@ff1.fased.app",
        },
        result: {
          kind: "content.summarize.v0",
          summaryText: "Federated paid summary result.",
          sourceWordCount: 4,
          sentenceCount: 1,
          style: "plain",
        },
        payment: {
          status: "verified",
          invoiceId: "invoice-fed-1",
          receiptId: "receipt-fed-1",
          txRef: "tx-fed-1",
          settledAt: "2026-05-02T12:00:00.000Z",
        },
      }),
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.bodyText) as {
      ok?: boolean;
      accepted?: boolean;
      delivery?: {
        configId?: string;
        order?: {
          source?: string;
          status?: string;
          sellerHandle?: string;
          paymentIntent?: { status?: string; txRef?: string };
          settlement?: { status?: string; txRef?: string; notes?: string };
          delivery?: { status?: string; notes?: string; targetKind?: string };
          receipt?: { status?: string; invoiceId?: string; receiptId?: string; txRef?: string };
        };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(true);
    expect(body.delivery?.configId).toMatch(
      /^inbound-delivery-seller-ff1-fased-app-seller-order-1-[a-f0-9]{32}$/u,
    );
    expect(body.delivery?.order).toMatchObject({
      source: "federation",
      status: "delivered",
      sellerHandle: "@seller@ff1.fased.app",
      paymentIntent: { status: "submitted", txRef: "tx-fed-1" },
      settlement: {
        status: "submitted",
        txRef: "tx-fed-1",
        notes: expect.stringContaining("not been locally chain-verified"),
      },
      delivery: {
        status: "delivered",
        targetKind: "federation",
        notes: expect.stringContaining("Federated paid summary result."),
      },
      receipt: {
        status: "pending",
      },
    });
    expect(body.delivery?.order?.receipt?.invoiceId).toBeUndefined();
    expect(body.delivery?.order?.receipt?.receiptId).toBeUndefined();
    expect(body.delivery?.order?.receipt?.txRef).toBeUndefined();
    expect(loadConfig().federation?.marketplace?.orders?.local).toHaveLength(2);

    const unsolicited = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/deliveries",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@seller@ff1.fased.app",
      },
      body: JSON.stringify({
        type: "content.summarize.delivered",
        orderId: "unknown-seller-order",
        offerId: "https://seller.example/offers/content-summarize-v0",
        serviceKind: "content.summarize",
        resultRef: "task-unsolicited",
        result: { summaryText: "Unsolicited result." },
      }),
    });
    expect(unsolicited.statusCode).toBe(409);
    expect(JSON.parse(unsolicited.bodyText)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("does not match an existing local buyer order"),
    });
    expect(
      loadConfig().federation?.marketplace?.orders?.local?.some(
        (entry) => entry.sellerOrderId === "unknown-seller-order",
      ),
    ).toBe(false);
  });

  it("accepts remote buyer marketplace orders into seller Sales idempotently", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-order-intake-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_A2A_HANDLE = "@seller@ff1.fased.app";
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    await writeConfigFile({
      federation: {
        offers: {
          manual: [
            {
              id: "signal-v0",
              enabled: true,
              title: "Daily trading signal",
              summary: "Daily market signal.",
              serviceKind: "trading.signal",
              pricing: { amount: 25, currency: "USDC", model: "fixed", unit: "per-day" },
              visibility: "federation",
              availability: "open",
              acceptedAssets: ["USDC", "SOL"],
              paymentDefaults: {
                currency: "USDC",
                chain: "solana",
                asset: {
                  kind: "spl-token",
                  address: "Usdc111111111111111111111111111111111111111",
                },
                assetDecimals: 6,
                payee: {
                  chain: "solana",
                  address: "Seller111111111111111111111111111111111111",
                },
              },
            },
          ],
        },
      },
    });

    const payload = {
      id: "checkout-1",
      source: "federation",
      status: "draft",
      offerId: "http://127.0.0.1:18789/offers/signal-v0",
      buyerHandle: "@buyer@ff1.fased.app",
      sellerHandle: "@seller@ff1.fased.app",
      sellerEndpoint: "https://attacker.example",
      title: "Daily trading signal",
      serviceKind: "trading.signal",
      pricing: { amount: 25, currency: "USDC", model: "fixed", unit: "per-day" },
      paymentIntent: {
        status: "requires_payment",
        amount: 25,
        currency: "USDC",
        unit: "per-day",
        method: "agent-wallet",
        chain: "solana",
        assetKind: "native",
        acceptedAssets: ["ATTACK"],
        payeeAddress: "Attacker1111111111111111111111111111111111",
      },
      settlement: {
        mode: "escrow",
        status: "settled",
        amount: 25,
        currency: "USDC",
        chain: "solana",
        assetKind: "native",
        payeeAddress: "Attacker1111111111111111111111111111111111",
      },
      delivery: {
        status: "pending",
        targetKind: "channel",
        targetStatus: "ready",
        targetLabel: "Buyer Telegram",
        targetMasked: "telegram:buyer-chat",
      },
      receipt: { status: "pending" },
    };

    const unsigned = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify(payload),
      signPeerRequest: false,
    });
    expect(unsigned.statusCode).toBe(401);
    expect(JSON.parse(unsigned.bodyText)).toMatchObject({
      status: "rejected",
      code: "peer_auth_invalid",
    });
    expect(loadConfig().federation?.marketplace?.orders?.local).toBeUndefined();

    const [first] = await Promise.all([
      invoke({
        method: "POST",
        url: "/api/federation/marketplace/orders",
        headers: {
          host: "127.0.0.1:18789",
          "content-type": "application/json",
          "x-fased-sender-handle": "@buyer@ff1.fased.app",
        },
        body: JSON.stringify(payload),
      }),
      updateConfigFile(async (current) => ({
        config: { ...current, logging: { ...current.logging, level: "debug" } },
        result: undefined,
      })),
    ]);

    expect(first.handled).toBe(true);
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.bodyText) as {
      created?: boolean;
      order?: {
        configId?: string;
        status?: string;
        order?: {
          source?: string;
          buyerHandle?: string;
          sellerHandle?: string;
          offerId?: string;
          sellerEndpoint?: string;
          paymentIntent?: {
            status?: string;
            amount?: number;
            currency?: string;
            assetKind?: string;
            assetAddress?: string;
            acceptedAssets?: string[];
            payeeAddress?: string;
          };
          settlement?: { mode?: string; status?: string; payeeAddress?: string };
          delivery?: {
            targetId?: string;
            targetKind?: string;
            targetMasked?: string;
            target?: unknown;
          };
        };
      };
    };
    expect(firstBody.created).toBe(true);
    expect(firstBody.order?.configId).toMatch(
      /^inbound-order-buyer-ff1-fased-app-checkout-1-[a-f0-9]{32}$/u,
    );
    expect(firstBody.order?.status).toBe("accepted");
    expect(firstBody.order?.order).toMatchObject({
      source: "federation",
      buyerHandle: "@buyer@ff1.fased.app",
      sellerHandle: "@seller@ff1.fased.app",
      offerId: "http://127.0.0.1:18789/offers/signal-v0",
      paymentIntent: {
        status: "requires_payment",
        amount: 25,
        currency: "USDC",
        assetKind: "spl-token",
        assetAddress: "Usdc111111111111111111111111111111111111111",
        acceptedAssets: ["USDC", "SOL"],
        payeeAddress: "Seller111111111111111111111111111111111111",
      },
      settlement: {
        mode: "direct",
        status: "requires_payment",
        payeeAddress: "Seller111111111111111111111111111111111111",
      },
      delivery: {
        targetKind: "federation",
        targetMasked: "@buyer@ff1.fased.app",
      },
    });
    expect(firstBody.order?.order?.sellerEndpoint).toBeUndefined();
    expect(firstBody.order?.order?.delivery?.target).toBeUndefined();
    const savedDeliveryTarget = loadConfig().federation?.marketplace?.deliveryTargets?.local?.find(
      (entry) => entry.targetId === firstBody.order?.order?.delivery?.targetId,
    );
    expect(savedDeliveryTarget).toMatchObject({
      kind: "federation",
      status: "ready",
      owner: "buyer",
      maskedTarget: "@buyer@ff1.fased.app",
      federation: { handle: "@buyer@ff1.fased.app" },
    });
    expect(JSON.stringify(savedDeliveryTarget)).not.toContain("telegram:buyer-chat");
    expect(loadConfig().logging?.level).toBe("debug");

    const second = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify(payload),
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.bodyText)).toMatchObject({ created: false });
    expect(loadConfig().federation?.marketplace?.orders?.local).toHaveLength(1);
  });

  it("keeps peer-reported payment and delivery evidence unverified on seller intake", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-order-paid-sync-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_A2A_HANDLE = "@seller@ff1.fased.app";
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    await writeConfigFile({
      federation: {
        offers: {
          manual: [
            {
              id: "summary-v0",
              enabled: true,
              title: "Content summary",
              summary: "Summarize buyer text.",
              serviceKind: "content.summarize",
              pricing: { amount: 0.001, currency: "SOL", model: "fixed", unit: "per-job" },
              visibility: "federation",
              availability: "open",
              acceptedAssets: ["SOL"],
              paymentDefaults: {
                currency: "SOL",
                chain: "solana",
                asset: { kind: "native" },
                assetDecimals: 9,
                payee: {
                  chain: "solana",
                  address: "Seller111111111111111111111111111111111111",
                },
              },
            },
          ],
        },
      },
    });

    const basePayload = {
      id: "checkout-paid-1",
      source: "federation",
      status: "draft",
      offerId: "http://127.0.0.1:18789/offers/summary-v0",
      buyerHandle: "@buyer@ff1.fased.app",
      sellerHandle: "@seller@ff1.fased.app",
      title: "Content summary",
      serviceKind: "content.summarize",
      pricing: { amount: 0.001, currency: "SOL", model: "fixed", unit: "per-job" },
      paymentIntent: {
        status: "requires_payment",
        amount: 0.001,
        currency: "SOL",
        unit: "per-job",
        method: "agent-wallet",
        acceptedAssets: ["SOL"],
        chain: "solana",
        assetKind: "native",
        assetDecimals: 9,
        payeeAddress: "Seller111111111111111111111111111111111111",
      },
      settlement: {
        mode: "direct",
        status: "requires_payment",
        amount: 0.001,
        currency: "SOL",
        chain: "solana",
        assetKind: "native",
        payeeAddress: "Seller111111111111111111111111111111111111",
      },
      delivery: {
        status: "pending",
        targetKind: "app-inbox",
        targetStatus: "ready",
        targetLabel: "Buyer inbox",
        targetMasked: "@buyer@ff1.fased.app",
      },
      receipt: { status: "pending" },
    };

    const first = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify(basePayload),
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.bodyText)).toMatchObject({ created: true });

    const paid = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify({
        ...basePayload,
        status: "delivered",
        paymentIntent: {
          ...basePayload.paymentIntent,
          status: "verified",
          txRef: "sol-tx-paid-1",
        },
        settlement: {
          ...basePayload.settlement,
          status: "settled",
          invoiceId: "invoice-paid-1",
          receiptId: "receipt-paid-1",
          txRef: "sol-tx-paid-1",
          evidenceRef: "tx:sol-tx-paid-1",
        },
        delivery: {
          ...basePayload.delivery,
          status: "delivered",
          resultRef: "task-summary-1",
          artifactRef:
            "fased://marketplace/orders/checkout-paid-1/content-summarize/task-summary-1",
        },
        receipt: {
          status: "issued",
          invoiceId: "invoice-paid-1",
          receiptId: "receipt-paid-1",
          txRef: "sol-tx-paid-1",
          resultRef: "task-summary-1",
        },
        invoiceId: "invoice-paid-1",
        receiptId: "receipt-paid-1",
        txRef: "sol-tx-paid-1",
        resultRef: "task-summary-1",
      }),
    });
    expect(paid.statusCode).toBe(409);
    expect(JSON.parse(paid.bodyText)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("immutable"),
    });
    const savedOrder = loadConfig().federation?.marketplace?.orders?.local?.[0];
    expect(savedOrder).toMatchObject({
      paymentIntent: { status: "requires_payment" },
      settlement: {
        status: "requires_payment",
      },
      delivery: {
        status: "pending",
      },
      receipt: {
        status: "pending",
      },
    });
    expect(savedOrder?.paymentIntent?.txRef).toBeUndefined();
    expect(savedOrder?.settlement?.invoiceId).toBeUndefined();
    expect(savedOrder?.settlement?.receiptId).toBeUndefined();
    expect(savedOrder?.settlement?.txRef).toBeUndefined();
    expect(savedOrder?.delivery?.resultRef).toBeUndefined();
    expect(savedOrder?.delivery?.artifactRef).toBeUndefined();
    expect(savedOrder?.invoiceId).toBeUndefined();
    expect(savedOrder?.receiptId).toBeUndefined();
    expect(savedOrder?.txRef).toBeUndefined();
    expect(savedOrder?.resultRef).toBeUndefined();
    expect(loadConfig().federation?.marketplace?.orders?.local).toHaveLength(1);
  });

  it("rejects unsafe seller marketplace order intake changes", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-order-intake-reject-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_A2A_HANDLE = "@seller@ff1.fased.app";
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    await writeConfigFile({
      federation: {
        offers: {
          manual: [
            {
              id: "signal-v0",
              enabled: true,
              title: "Daily trading signal",
              serviceKind: "trading.signal",
              pricing: { amount: 25, currency: "USDC", model: "fixed", unit: "per-day" },
              visibility: "federation",
              paymentDefaults: {
                currency: "USDC",
                chain: "solana",
                asset: {
                  kind: "spl-token",
                  address: "Usdc111111111111111111111111111111111111111",
                },
                assetDecimals: 6,
                payee: {
                  chain: "solana",
                  address: "Seller111111111111111111111111111111111111",
                },
              },
            },
          ],
        },
      },
    });

    const basePayload = {
      id: "checkout-1",
      offerId: "http://127.0.0.1:18789/offers/signal-v0",
      buyerHandle: "@buyer@ff1.fased.app",
      sellerHandle: "@seller@ff1.fased.app",
      title: "Daily trading signal",
      serviceKind: "trading.signal",
      pricing: { amount: 25, currency: "USDC", model: "fixed", unit: "per-day" },
      paymentIntent: {
        status: "requires_payment",
        amount: 25,
        currency: "USDC",
        unit: "per-day",
      },
      delivery: { status: "pending", targetKind: "channel", targetMasked: "telegram:buyer" },
    };

    const selfOrder = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@seller@ff1.fased.app",
      },
      body: JSON.stringify(basePayload),
    });
    expect(selfOrder.statusCode).toBe(409);
    expect(JSON.parse(selfOrder.bodyText).reason).toContain("itself");

    const mismatchedBuyer = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify({ ...basePayload, buyerHandle: "@other@ff1.fased.app" }),
    });
    expect(mismatchedBuyer.statusCode).toBe(409);
    expect(JSON.parse(mismatchedBuyer.bodyText).reason).toContain(
      "buyerHandle does not match signed sender",
    );

    const priceChanged = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify({
        ...basePayload,
        pricing: { amount: 1, currency: "USDC", model: "fixed", unit: "per-day" },
      }),
    });
    expect(priceChanged.statusCode).toBe(409);
    expect(JSON.parse(priceChanged.bodyText).reason).toContain("price");

    const rawTarget = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify({
        ...basePayload,
        delivery: {
          ...basePayload.delivery,
          target: {
            kind: "webhook",
            status: "ready",
            webhook: { url: "https://buyer.example/secret-token" },
          },
        },
      }),
    });
    expect(rawTarget.statusCode).toBe(400);
    expect(JSON.parse(rawTarget.bodyText).reason).toContain("masked delivery");
    expect(loadConfig().federation?.marketplace?.orders?.local).toBeUndefined();

    await writeConfigFile({
      federation: {
        offers: {
          manual: [
            {
              id: "signal-v0",
              enabled: true,
              title: "Daily trading signal",
              serviceKind: "trading.signal",
              pricing: { amount: 25, currency: "USDC", model: "fixed", unit: "per-day" },
              visibility: "federation",
            },
          ],
        },
      },
    });
    const noLocalPayee = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/orders",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
        "x-fased-sender-handle": "@buyer@ff1.fased.app",
      },
      body: JSON.stringify(basePayload),
    });
    expect(noLocalPayee.statusCode).toBe(409);
    expect(JSON.parse(noLocalPayee.bodyText).reason).toContain(
      "no wallet-backed payment destination",
    );
    expect(loadConfig().federation?.marketplace?.orders?.local).toBeUndefined();
  });

  it("submits a local checkout envelope to the seller intake endpoint", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-order-submit-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    process.env.FASED_A2A_HANDLE = "@buyer@ff1.fased.app";
    process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
    await writeConfigFile({
      federation: {
        marketplace: {
          orders: {
            local: [
              {
                id: "checkout-1",
                source: "federation",
                status: "draft",
                offerId: "https://seller.ff1.fased.app/offers/signal-v0",
                buyerHandle: "@buyer@ff1.fased.app",
                sellerHandle: "@seller@ff1.fased.app",
                sellerEndpoint: "https://seller.ff1.fased.app",
                title: "Daily trading signal",
                serviceKind: "trading.signal",
                pricing: { amount: 25, currency: "USDC", model: "fixed", unit: "per-day" },
                paymentIntent: { status: "requires_payment", amount: 25, currency: "USDC" },
                delivery: {
                  status: "pending",
                  targetKind: "channel",
                  targetMasked: "telegram:buyer",
                },
                receipt: { status: "pending" },
              },
            ],
          },
        },
      },
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      expect(url.toString()).toBe("https://seller.ff1.fased.app/api/federation/marketplace/orders");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-fased-protocol-version")).toBe("2");
      expect(headers.get("x-fased-sender-handle")).toBe("@buyer@ff1.fased.app");
      expect(headers.get("x-fased-recipient-handle")).toBe("@seller@ff1.fased.app");
      expect(headers.get("x-fased-device-public-key")).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(headers.get("x-fased-request-signature")).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(headers.get("x-fased-request-nonce")).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
      expect(headers.get("x-fased-content-sha256")).toMatch(/^[a-f0-9]{64}$/u);
      const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        id?: string;
        delivery?: { target?: unknown; targetMasked?: string };
      };
      expect(payload.id).toBe("checkout-1");
      expect(payload.delivery?.target).toBeUndefined();
      expect(payload.delivery?.targetMasked).toBe("telegram:buyer");
      return new Response(
        JSON.stringify({
          ok: true,
          accepted: true,
          created: true,
          order: { configId: "inbound-buyer-checkout-1" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      method: "POST",
      url: "/api/federation/local/orders/checkout-1/submit-seller",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.bodyText) as {
      submitted?: boolean;
      order?: {
        status?: string;
        order?: {
          receipt?: { notes?: string };
          sellerEndpoint?: string;
          sellerOrderId?: string;
          sellerSyncStatus?: string;
        };
      };
    };
    expect(body.submitted).toBe(true);
    expect(body.order?.status).toBe("accepted");
    expect(body.order?.order?.sellerEndpoint).toBe("https://seller.ff1.fased.app");
    expect(body.order?.order?.sellerOrderId).toBe("inbound-buyer-checkout-1");
    expect(body.order?.order?.sellerSyncStatus).toBe("accepted");
    expect(body.order?.order?.receipt?.notes).toContain("Seller intake accepted");
    expect(fetchMock).toHaveBeenCalledOnce();

    const insecure = await invoke({
      method: "POST",
      url: "/api/federation/local/orders/checkout-1/submit-seller",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ endpoint: "http://seller.ff1.fased.app" }),
    });
    expect(insecure.statusCode).toBe(400);
    expect(JSON.parse(insecure.bodyText).reason).toContain("must use HTTPS");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects unsupported federation marketplace delivery payloads", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-fed-http-delivery-reject-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    process.env.FASED_STATE_DIR = configDir;
    await writeConfigFile({});

    const response = await invoke({
      method: "POST",
      url: "/api/federation/marketplace/deliveries",
      headers: {
        host: "127.0.0.1:18789",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "wallet.transfer.delivered",
        orderId: "bad",
        serviceKind: "wallet.transfer",
      }),
    });

    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.bodyText)).toMatchObject({
      status: "rejected",
      reason: "unsupported marketplace delivery type",
    });
    expect(loadConfig().federation?.marketplace?.orders?.local).toBeUndefined();
  });
});
