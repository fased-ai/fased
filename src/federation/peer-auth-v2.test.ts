import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEphemeralDeviceIdentity } from "../infra/device-identity.js";
import {
  authorizeFederationPeerRequestV2,
  buildSignedFederationPeerRequest,
  canonicalizeFederationPeerJson,
  FEDERATION_MARKETPLACE_ORDER_PATH,
  FEDERATION_PEER_HEADERS,
  isTrustedFederationPeerUrl,
  reserveFederationPeerReplay,
} from "./peer-auth-v2.js";

const NOW_MS = Date.parse("2026-07-17T12:00:00.000Z");
const SENDER = "@buyer@ff1.fased.app";
const RECIPIENT = "@seller@ff1.fased.app";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-peer-auth-v2-"));
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

function request(
  headers: Record<string, string>,
  overrides?: { method?: string; url?: string },
): IncomingMessage {
  return {
    method: overrides?.method ?? "POST",
    url: overrides?.url ?? FEDERATION_MARKETPLACE_ORDER_PATH,
    headers,
    socket: { remoteAddress: "203.0.113.10" },
  } as IncomingMessage;
}

function noLimit() {
  return {
    check: () => ({ allowed: true, remaining: 100, retryAfterMs: 0 }),
    recordFailure: () => undefined,
  };
}

describe("federation peer protocol v2", () => {
  it("canonicalizes JSON independently of object key insertion order", () => {
    expect(canonicalizeFederationPeerJson({ z: 1, a: { y: true, b: 2 } })).toBe(
      canonicalizeFederationPeerJson({ a: { b: 2, y: true }, z: 1 }),
    );
  });

  it("accepts HTTPS and explicit loopback HTTP peer URLs only", () => {
    expect(isTrustedFederationPeerUrl(new URL("https://seller.example"))).toBe(true);
    expect(isTrustedFederationPeerUrl(new URL("http://127.0.0.1:18789"))).toBe(true);
    expect(isTrustedFederationPeerUrl(new URL("http://[::1]:18789"))).toBe(true);
    expect(isTrustedFederationPeerUrl(new URL("http://seller.example"))).toBe(false);
    expect(isTrustedFederationPeerUrl(new URL("https://user:secret@seller.example"))).toBe(false);
    expect(isTrustedFederationPeerUrl(new URL("ftp://seller.example"))).toBe(false);
  });

  it("verifies directory-bound signatures and atomically rejects a replay", async () => {
    const identity = createEphemeralDeviceIdentity();
    const body = { offerId: "offer-1", nested: { b: 2, a: 1 } };
    const signed = buildSignedFederationPeerRequest({
      senderHandle: SENDER,
      recipientHandle: RECIPIENT,
      path: FEDERATION_MARKETPLACE_ORDER_PATH,
      body,
      nowMs: NOW_MS,
      nonce: "nonce-peer-auth-v2-0001",
      identity,
    });
    const directoryLookup = vi.fn(async () => ({
      status: "verified",
      nodeId: identity.deviceId,
      handle: SENDER,
    }));
    const authorize = async () =>
      await authorizeFederationPeerRequestV2({
        req: request(signed.headers),
        body,
        recipientHandle: RECIPIENT,
        expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
        directoryBaseUrl: "https://ff1.fased.app",
        env: { FASED_STATE_DIR: stateDir },
        deps: {
          now: () => NOW_MS,
          directoryLookup,
          rateLimiter: noLimit(),
        },
      });

    const [first, second] = await Promise.all([authorize(), authorize()]);
    expect([first.ok, second.ok].toSorted((a, b) => Number(a) - Number(b))).toEqual([false, true]);
    expect([first, second].find((result) => !result.ok)).toMatchObject({
      statusCode: 409,
      code: "peer_auth_replay",
    });
    expect(directoryLookup).toHaveBeenCalledTimes(2);

    const replayPath = path.join(stateDir, "federation", "peer-replay-v2.json");
    const stat = await fs.stat(replayPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const replayState = JSON.parse(await fs.readFile(replayPath, "utf8")) as {
      version?: number;
      reservations?: Record<string, number>;
    };
    expect(replayState.version).toBe(2);
    expect(Object.keys(replayState.reservations ?? {})).toHaveLength(1);
  });

  it("rejects body, recipient, signature, clock, and directory mismatches before mutation", async () => {
    const identity = createEphemeralDeviceIdentity();
    const body = { offerId: "offer-1" };
    const signed = buildSignedFederationPeerRequest({
      senderHandle: SENDER,
      recipientHandle: RECIPIENT,
      path: FEDERATION_MARKETPLACE_ORDER_PATH,
      body,
      nowMs: NOW_MS,
      nonce: "nonce-peer-auth-v2-0002",
      identity,
    });
    const directoryLookup = vi.fn(async () => ({
      status: "verified",
      nodeId: identity.deviceId,
      handle: SENDER,
    }));
    const authorize = async (params?: {
      headers?: Record<string, string>;
      body?: unknown;
      recipientHandle?: string;
      nowMs?: number;
      directoryNodeId?: string;
      directoryStatus?: string;
    }) =>
      await authorizeFederationPeerRequestV2({
        req: request(params?.headers ?? signed.headers),
        body: params?.body ?? body,
        recipientHandle: params?.recipientHandle ?? RECIPIENT,
        expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
        directoryBaseUrl: "https://ff1.fased.app",
        env: { FASED_STATE_DIR: stateDir },
        deps: {
          now: () => params?.nowMs ?? NOW_MS,
          directoryLookup: async () => ({
            status: params?.directoryStatus ?? "verified",
            nodeId: params?.directoryNodeId ?? identity.deviceId,
            handle: SENDER,
          }),
          reserveReplay: async () => ({ ok: true }),
          rateLimiter: noLimit(),
        },
      });

    await expect(authorize({ body: { offerId: "tampered" } })).resolves.toMatchObject({
      ok: false,
      code: "peer_auth_invalid",
    });
    await expect(authorize({ recipientHandle: "@other@ff1.fased.app" })).resolves.toMatchObject({
      ok: false,
      code: "peer_auth_invalid",
    });
    await expect(
      authorize({
        headers: {
          ...signed.headers,
          [FEDERATION_PEER_HEADERS.signature]: `${signed.headers[FEDERATION_PEER_HEADERS.signature]}x`,
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "peer_auth_invalid" });
    await expect(authorize({ nowMs: NOW_MS + 2 * 60_000 + 1 })).resolves.toMatchObject({
      ok: false,
      code: "peer_auth_stale",
    });
    await expect(authorize({ directoryNodeId: "0".repeat(64) })).resolves.toMatchObject({
      ok: false,
      code: "peer_auth_unverified",
    });
    await expect(authorize({ directoryStatus: "revoked" })).resolves.toMatchObject({
      ok: false,
      code: "peer_auth_unverified",
    });
    const wrongMethod = await authorizeFederationPeerRequestV2({
      req: request(signed.headers, { method: "PUT" }),
      body,
      recipientHandle: RECIPIENT,
      expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
      directoryBaseUrl: "https://ff1.fased.app",
      deps: { now: () => NOW_MS, rateLimiter: noLimit() },
    });
    expect(wrongMethod).toMatchObject({ ok: false, code: "peer_auth_invalid" });
    const wrongPath = await authorizeFederationPeerRequestV2({
      req: request(signed.headers, { url: "/api/federation/marketplace/deliveries" }),
      body,
      recipientHandle: RECIPIENT,
      expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
      directoryBaseUrl: "https://ff1.fased.app",
      deps: { now: () => NOW_MS, rateLimiter: noLimit() },
    });
    expect(wrongPath).toMatchObject({ ok: false, code: "peer_auth_invalid" });
    const normalizedPathVariant = await authorizeFederationPeerRequestV2({
      req: request(signed.headers, { url: "/api/federation/foo/../marketplace/orders" }),
      body,
      recipientHandle: RECIPIENT,
      expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
      directoryBaseUrl: "https://ff1.fased.app",
      deps: { now: () => NOW_MS, rateLimiter: noLimit() },
    });
    expect(normalizedPathVariant).toMatchObject({ ok: false, code: "peer_auth_invalid" });
    const queryVariant = await authorizeFederationPeerRequestV2({
      req: request(signed.headers, { url: `${FEDERATION_MARKETPLACE_ORDER_PATH}?source=variant` }),
      body,
      recipientHandle: RECIPIENT,
      expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
      directoryBaseUrl: "https://ff1.fased.app",
      deps: { now: () => NOW_MS, rateLimiter: noLimit() },
    });
    expect(queryVariant).toMatchObject({ ok: false, code: "peer_auth_invalid" });
    expect(directoryLookup).not.toHaveBeenCalled();
  });

  it("applies the ingress budget before a directory lookup", async () => {
    const identity = createEphemeralDeviceIdentity();
    const body = { offerId: "offer-1" };
    const signed = buildSignedFederationPeerRequest({
      senderHandle: SENDER,
      recipientHandle: RECIPIENT,
      path: FEDERATION_MARKETPLACE_ORDER_PATH,
      body,
      nowMs: NOW_MS,
      nonce: "nonce-peer-auth-v2-0003",
      identity,
    });
    const directoryLookup = vi.fn();
    const result = await authorizeFederationPeerRequestV2({
      req: request(signed.headers),
      body,
      recipientHandle: RECIPIENT,
      expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
      directoryBaseUrl: "https://ff1.fased.app",
      env: { FASED_STATE_DIR: stateDir },
      deps: {
        now: () => NOW_MS,
        directoryLookup,
        rateLimiter: {
          check: () => ({ allowed: false, remaining: 0, retryAfterMs: 12_000 }),
          recordFailure: () => undefined,
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      statusCode: 429,
      code: "peer_auth_rate_limited",
      retryAfterMs: 12_000,
    });
    expect(directoryLookup).not.toHaveBeenCalled();
  });

  it("requires HTTPS for directory identity, with only loopback HTTP allowed", async () => {
    const identity = createEphemeralDeviceIdentity();
    const body = { offerId: "offer-transport" };
    const signed = buildSignedFederationPeerRequest({
      senderHandle: SENDER,
      recipientHandle: RECIPIENT,
      path: FEDERATION_MARKETPLACE_ORDER_PATH,
      body,
      nowMs: NOW_MS,
      nonce: "nonce-peer-auth-v2-transport",
      identity,
    });
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          status: "verified",
          nodeId: identity.deviceId,
          handle: SENDER,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const authorize = async (directoryBaseUrl: string) =>
      await authorizeFederationPeerRequestV2({
        req: request(signed.headers),
        body,
        recipientHandle: RECIPIENT,
        expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
        directoryBaseUrl,
        env: { FASED_STATE_DIR: stateDir },
        deps: {
          now: () => NOW_MS,
          fetchImpl,
          reserveReplay: async () => ({ ok: true }),
          rateLimiter: noLimit(),
        },
      });

    await expect(authorize("http://directory.example")).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
      code: "peer_auth_directory_unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(authorize("http://127.0.0.1:8787")).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const directoryUrl =
      url instanceof URL ? url.toString() : typeof url === "string" ? url : url?.url;
    expect(directoryUrl).toContain("/api/federation/directory/%40buyer%40ff1.fased.app");
    expect(init?.redirect).toBe("error");
  });

  it("fails closed on corrupt replay state and never age-evicts a live lock owner", async () => {
    const env = { FASED_STATE_DIR: stateDir };
    const replayPath = path.join(stateDir, "federation", "peer-replay-v2.json");
    await fs.mkdir(path.dirname(replayPath), { recursive: true });
    await fs.writeFile(replayPath, "{not-json\n", { mode: 0o600 });

    await expect(
      reserveFederationPeerReplay({
        senderHandle: SENDER,
        nodeId: "a".repeat(64),
        nonce: "nonce-peer-auth-v2-corrupt",
        timestampMs: NOW_MS,
        nowMs: NOW_MS,
        env,
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(await fs.readFile(replayPath, "utf8")).toBe("{not-json\n");

    const identity = createEphemeralDeviceIdentity();
    const body = { offerId: "offer-replay-unavailable" };
    const signed = buildSignedFederationPeerRequest({
      senderHandle: SENDER,
      recipientHandle: RECIPIENT,
      path: FEDERATION_MARKETPLACE_ORDER_PATH,
      body,
      nowMs: NOW_MS,
      nonce: "nonce-peer-auth-v2-unavailable",
      identity,
    });
    await expect(
      authorizeFederationPeerRequestV2({
        req: request(signed.headers),
        body,
        recipientHandle: RECIPIENT,
        expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
        directoryBaseUrl: "https://ff1.fased.app",
        deps: {
          now: () => NOW_MS,
          directoryLookup: async () => ({
            status: "verified",
            nodeId: identity.deviceId,
            handle: SENDER,
          }),
          reserveReplay: async () => ({ ok: false, reason: "unavailable" }),
          rateLimiter: noLimit(),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
      code: "peer_auth_replay_unavailable",
    });

    await fs.writeFile(replayPath, '{"version":2,"reservations":{}}\n', { mode: 0o600 });
    const lockPath = `${replayPath}.lock`;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" }),
    );
    await expect(
      reserveFederationPeerReplay({
        senderHandle: SENDER,
        nodeId: "a".repeat(64),
        nonce: "nonce-peer-auth-v2-live-lock",
        timestampMs: NOW_MS,
        nowMs: NOW_MS,
        env,
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
    expect(JSON.parse(await fs.readFile(replayPath, "utf8"))).toEqual({
      version: 2,
      reservations: {},
    });

    if (process.platform === "linux") {
      await fs.rm(lockPath, { force: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          startTime: -1,
        }),
      );
      await expect(
        reserveFederationPeerReplay({
          senderHandle: SENDER,
          nodeId: "a".repeat(64),
          nonce: "nonce-peer-auth-v2-recycled-pid",
          timestampMs: NOW_MS,
          nowMs: NOW_MS,
          env,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
