import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type JsonWebKeyInput,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../config/paths.js";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";

export type ChatGptPlanCredential = OAuthCredentials & {
  chatgptPlan: true;
  clientId: string;
  subject: string;
  hostId: string;
  idToken: string;
  scopes: string[];
  email?: string;
};

export function isChatGptPlanCredential(value: OAuthCredentials): value is ChatGptPlanCredential {
  return (
    value.chatgptPlan === true &&
    typeof value.clientId === "string" &&
    value.clientId !== DYNAMIC_CLIENT &&
    typeof value.subject === "string"
  );
}

export async function getChatGptHostId(stateDir = resolveStateDir()): Promise<string> {
  const directory = path.join(stateDir, "providers");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "chatgpt-host-id");
  const read = async () => {
    const value = (await fs.readFile(filename, "utf8")).trim();
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(value)) {
      throw new Error("Invalid retained ChatGPT host identity");
    }
    return value;
  };
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const value = `urn:uuid:${randomUUID()}`;
  try {
    const handle = await fs.open(filename, "wx", 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return await read();
  }
}

export function createChatGptPlanAttempt(params: {
  redirectUri: string;
  hostId: string;
  existing?: ChatGptPlanCredential;
}) {
  const redirect = new URL(params.redirectUri);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== "/auth/callback" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    throw new Error("ChatGPT sign-in requires an exact 127.0.0.1 loopback callback");
  }
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const clientId = params.existing?.clientId ?? DYNAMIC_CLIENT;
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  const values: Record<string, string> = {
    client_id: clientId,
    ext_agent_host_id: params.hostId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
  if (!params.existing) {
    values.agent_name_hint = "Fased";
  } else {
    values.id_token_hint = params.existing.idToken;
    if (params.existing.email) {
      values.login_hint = params.existing.email;
    }
  }
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  return { url: url.toString(), state, nonce, verifier, clientId, ...params };
}

export type ChatGptPlanAttempt = ReturnType<typeof createChatGptPlanAttempt>;

export function validateChatGptCallback(attempt: ChatGptPlanAttempt, url: URL) {
  if (
    url.origin + url.pathname !== attempt.redirectUri ||
    ["code", "state", "client_id", "error"].some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    throw new Error("Invalid ChatGPT callback");
  }
  const state = url.searchParams.get("state") ?? "";
  const received = Buffer.from(state);
  const expected = Buffer.from(attempt.state);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("ChatGPT sign-in state mismatch");
  }
  if (url.searchParams.has("error")) {
    throw new Error("ChatGPT sign-in was denied or could not complete");
  }
  const clientId = url.searchParams.get("client_id") ?? (attempt.existing ? attempt.clientId : "");
  if (
    !clientId ||
    clientId === DYNAMIC_CLIENT ||
    (attempt.existing && clientId !== attempt.clientId)
  ) {
    throw new Error("ChatGPT registration identity mismatch or missing issued client ID");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("ChatGPT callback contains no authorization code");
  }
  return { clientId, code };
}

async function fetchJson(url: string, init: RequestInit, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ChatGPT authorization request failed (${response.status}); sign in again`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function verifyChatGptIdentity(params: {
  token: string;
  clientId: string;
  nonce?: string;
  subject?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const segments = params.token.split(".");
  if (segments.length !== 3) {
    throw new Error("Invalid ChatGPT ID token");
  }
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("Invalid ChatGPT ID token");
  }
  if (
    !["RS256", "ES256"].includes(String(header.alg)) ||
    typeof header.kid !== "string" ||
    header.crit
  ) {
    throw new Error("Unsupported ChatGPT ID token signature");
  }
  const jwks = await fetchJson(
    `${ISSUER}/.well-known/jwks.json`,
    { signal: params.signal },
    params.fetchImpl ?? fetch,
  );
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const matching = keys.filter(
    (key: Record<string, unknown>) =>
      key.kid === header.kid &&
      (!key.alg || key.alg === header.alg) &&
      (!key.use || key.use === "sig") &&
      (header.alg === "RS256" ? key.kty === "RSA" : key.kty === "EC" && key.crv === "P-256"),
  );
  if (matching.length !== 1) {
    throw new Error("ChatGPT signing key not found");
  }
  const key = createPublicKey({ key: matching[0] as JsonWebKeyInput["key"], format: "jwk" });
  const valid = verify(
    "sha256",
    Buffer.from(`${segments[0]}.${segments[1]}`),
    header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
    Buffer.from(segments[2], "base64url"),
  );
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !valid ||
    claims.iss !== ISSUER ||
    !audiences.includes(params.clientId) ||
    (audiences.length > 1 && claims.azp !== params.clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now) ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    (params.nonce !== undefined && claims.nonce !== params.nonce) ||
    (params.subject !== undefined && claims.sub !== params.subject)
  ) {
    throw new Error("ChatGPT identity validation failed");
  }
  return {
    subject: claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
  };
}

async function readTokenSet(params: {
  data: Record<string, unknown>;
  clientId: string;
  hostId: string;
  nonce?: string;
  previous?: ChatGptPlanCredential;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ChatGptPlanCredential> {
  const { data, previous } = params;
  const scopes =
    typeof data.scope === "string"
      ? data.scope.split(/\s+/).filter(Boolean)
      : (previous?.scopes ?? []);
  if (
    !scopes.includes(PLAN_SCOPE) ||
    data.token_type !== "Bearer" ||
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new Error("ChatGPT plan usage was not granted or token response is invalid");
  }
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : previous?.refresh;
  if (!refresh) {
    throw new Error("ChatGPT offline access was not granted");
  }
  let identity: { subject: string; email?: string } | undefined = previous
    ? { subject: previous.subject, email: previous.email }
    : undefined;
  if (typeof data.id_token === "string") {
    identity = await verifyChatGptIdentity({
      token: data.id_token,
      clientId: params.clientId,
      nonce: params.nonce,
      subject: previous?.subject,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
    });
  } else if (!previous || params.nonce !== undefined) {
    throw new Error("ChatGPT ID token is missing");
  }
  return {
    chatgptPlan: true,
    clientId: params.clientId,
    hostId: params.hostId,
    subject: identity!.subject,
    ...(identity?.email ? { email: identity.email } : {}),
    idToken: typeof data.id_token === "string" ? data.id_token : previous!.idToken,
    access: data.access_token,
    refresh,
    expires: Date.now() + data.expires_in * 1000,
    scopes,
  };
}

export async function exchangeChatGptPlanCode(
  attempt: ChatGptPlanAttempt,
  callback: URL,
  fetchImpl = fetch,
  signal?: AbortSignal,
) {
  const { code, clientId } = validateChatGptCallback(attempt, callback);
  const data = await fetchJson(
    TOKEN_URL,
    {
      method: "POST",
      signal,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource: RESOURCE,
      }),
    },
    fetchImpl,
  );
  return await readTokenSet({
    data,
    clientId,
    hostId: attempt.hostId,
    nonce: attempt.nonce,
    previous: attempt.existing,
    signal,
    fetchImpl,
  });
}

export async function refreshChatGptPlanCredential(
  credential: ChatGptPlanCredential,
  fetchImpl = fetch,
) {
  const data = await fetchJson(
    TOKEN_URL,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credential.clientId,
        refresh_token: credential.refresh,
        resource: RESOURCE,
      }),
    },
    fetchImpl,
  );
  return await readTokenSet({
    data,
    clientId: credential.clientId,
    hostId: credential.hostId,
    previous: credential,
    fetchImpl,
  });
}
