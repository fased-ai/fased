import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createChatGptPlanAttempt,
  exchangeChatGptPlanCode,
  getChatGptHostId,
  refreshChatGptPlanCredential,
  validateChatGptCallback,
  verifyChatGptIdentity,
  type ChatGptPlanCredential,
} from "./chatgpt-plan-auth.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
export function identity(nonce?: string, overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url",
  );
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "oaiapp_fased_test",
      sub: "owner",
      email: "owner@example.com",
      exp: Date.now() / 1000 + 3600,
      nonce,
      ...overrides,
    }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), pair.privateKey).toString(
    "base64url",
  );
  return `${header}.${claims}.${signature}`;
}
const makeAttempt = () =>
  createChatGptPlanAttempt({
    redirectUri: "http://127.0.0.1:54321/auth/callback",
    hostId: "urn:uuid:test-host",
  });
const callback = (
  attempt: ReturnType<typeof makeAttempt>,
  overrides: Record<string, string> = {},
) => {
  const url = new URL(attempt.redirectUri);
  for (const [name, value] of Object.entries({
    state: attempt.state,
    code: "test-code",
    client_id: "oaiapp_fased_test",
    ...overrides,
  })) {
    url.searchParams.set(name, value);
  }
  return url;
};
const tokenResponse = (nonce?: string) => ({
  access_token: "test-access",
  refresh_token: "test-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid offline_access chatgpt.tokens.use.direct",
  id_token: identity(nonce),
});

export const planCredential: ChatGptPlanCredential = {
  chatgptPlan: true,
  clientId: "oaiapp_fased_test",
  subject: "owner",
  hostId: "urn:uuid:test-host",
  idToken: identity(),
  access: "test-access",
  refresh: "test-refresh",
  expires: Date.now() + 3600000,
  scopes: ["chatgpt.tokens.use.direct"],
};

describe("Fased ChatGPT plan registration", () => {
  it("persists the host identity across restarts with owner-only permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fased-plan-test-"));
    try {
      const host = await getChatGptHostId(directory);
      expect(await getChatGptHostId(directory)).toBe(host);
      expect(host).toMatch(/^urn:uuid:/);
      expect((await fs.stat(path.join(directory, "providers/chatgpt-host-id"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await fs.rm(directory, { recursive: true });
    }
  });
  it("registers Fased with fresh state/nonce/PKCE and an exact numeric callback", () => {
    const attempt = makeAttempt();
    const url = new URL(attempt.url);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("Fased");
    expect(url.searchParams.get("redirect_uri")).toBe(attempt.redirectUri);
    expect(url.searchParams.get("code_challenge")).not.toBe(attempt.verifier);
    expect(makeAttempt().state).not.toBe(attempt.state);
    expect(() =>
      createChatGptPlanAttempt({
        redirectUri: "http://localhost:1455/auth/callback",
        hostId: "test",
      }),
    ).toThrow("loopback");
  });
  it.each(["wrong-state", "", "stale-attempt"])(
    "rejects invalid state %s before code exchange",
    async (state) => {
      const request = vi.fn();
      await expect(
        exchangeChatGptPlanCode(makeAttempt(), callback(makeAttempt(), { state }), request),
      ).rejects.toThrow("state mismatch");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate callback parameters and incomplete registration", () => {
    const attempt = makeAttempt();
    const url = callback(attempt);
    url.searchParams.append("code", "second");
    expect(() => validateChatGptCallback(attempt, url)).toThrow("Invalid ChatGPT callback");
    expect(() =>
      validateChatGptCallback(attempt, callback(attempt, { client_id: "dynamic_agent_client" })),
    ).toThrow("issued client ID");
  });
  it("never exchanges a denied authorization", async () => {
    const attempt = makeAttempt();
    const request = vi.fn();
    await expect(
      exchangeChatGptPlanCode(attempt, callback(attempt, { error: "access_denied" }), request),
    ).rejects.toThrow("denied");
    expect(request).not.toHaveBeenCalled();
  });
  it("validates identity and plan permission, exchanges using the issued client and exact redirect", async () => {
    const attempt = makeAttempt();
    const request = vi.fn<typeof fetch>(async (input) =>
      (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).endsWith(
        "jwks.json",
      )
        ? Response.json({ keys: [key] })
        : Response.json(tokenResponse(attempt.nonce)),
    );
    const result = await exchangeChatGptPlanCode(attempt, callback(attempt), request);
    expect(result).toMatchObject({
      chatgptPlan: true,
      subject: "owner",
      clientId: "oaiapp_fased_test",
      access: "test-access",
    });
    const body = request.mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("client_id")).toBe("oaiapp_fased_test");
    expect(body.get("redirect_uri")).toBe(attempt.redirectUri);
    expect(body.get("code_verifier")).toBe(attempt.verifier);
  });
  it.each([
    { nonce: "wrong" },
    { iss: "https://other.example" },
    { aud: "other-client" },
    { exp: 1 },
    { sub: "another-owner" },
  ])("rejects mismatched identity %j", async (override) => {
    await expect(
      verifyChatGptIdentity({
        token: identity("nonce", override),
        nonce: "nonce",
        subject: "owner",
        clientId: "oaiapp_fased_test",
        fetchImpl: async () => Response.json({ keys: [key] }),
      }),
    ).rejects.toThrow("validation failed");
  });
  it("rejects a tampered signature and missing plan scope", async () => {
    const bad = identity("nonce").split(".");
    bad[2] = Buffer.alloc(256).toString("base64url");
    await expect(
      verifyChatGptIdentity({
        token: bad.join("."),
        nonce: "nonce",
        clientId: "oaiapp_fased_test",
        fetchImpl: async () => Response.json({ keys: [key] }),
      }),
    ).rejects.toThrow("validation failed");
    const attempt = makeAttempt();
    await expect(
      exchangeChatGptPlanCode(attempt, callback(attempt), async () =>
        Response.json({ ...tokenResponse(attempt.nonce), scope: "openid email" }),
      ),
    ).rejects.toThrow("not granted");
  });
  it("reauthorizes the chosen registration without switching accounts", async () => {
    const attempt = createChatGptPlanAttempt({
      redirectUri: makeAttempt().redirectUri,
      hostId: "test",
      existing: planCredential,
    });
    expect(new URL(attempt.url).searchParams.has("agent_name_hint")).toBe(false);
    expect(() =>
      validateChatGptCallback(attempt, callback(attempt, { client_id: "another-client" })),
    ).toThrow("identity mismatch");
    const url = callback(attempt);
    url.searchParams.delete("client_id");
    expect(validateChatGptCallback(attempt, url).clientId).toBe(planCredential.clientId);
  });
  it("refreshes with the issued client and rotates credentials while preserving account identity", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...tokenResponse(),
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: undefined,
      }),
    );
    const result = await refreshChatGptPlanCredential(planCredential, request);
    expect(result).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
      subject: "owner",
      clientId: planCredential.clientId,
    });
    expect((request.mock.calls[0][1]!.body as URLSearchParams).get("scope")).toBeNull();
  });
  it("does not retry or leak an invalid refresh response", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response("sensitive-response", { status: 400 }),
    );
    await expect(refreshChatGptPlanCredential(planCredential, request)).rejects.toThrow("(400)");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
