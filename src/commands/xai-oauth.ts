import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const XAI_OAUTH_CLIENT_ID =
  process.env.FASED_XAI_OAUTH_CLIENT_ID?.trim() || "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CALLBACK_HOST = "127.0.0.1";
const XAI_OAUTH_CALLBACK_PORT = 56121;
const XAI_OAUTH_CALLBACK_PATH = "/callback";
const XAI_OAUTH_REDIRECT_URI = `http://${XAI_OAUTH_CALLBACK_HOST}:${XAI_OAUTH_CALLBACK_PORT}${XAI_OAUTH_CALLBACK_PATH}`;
const XAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30 * 1000;
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type XaiDiscovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
};

type XaiTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expires?: number;
  idToken?: string;
};

type XaiDeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInMs: number;
  intervalMs: number;
};

type XaiCallback = {
  code: string;
  state: string;
};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function trustedXaiEndpoint(endpoint: string, label: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || (url.hostname !== "x.ai" && !url.hostname.endsWith(".x.ai"))) {
    throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
  }
  return endpoint;
}

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const errorText = readRecord(body).error_description ?? readRecord(body).error;
    throw new Error(
      `${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`,
    );
  }
  return body;
}

async function fetchXaiDiscovery(): Promise<XaiDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json", "User-Agent": "Fased/xai-oauth" },
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = readRecord(await readJsonResponse(response, "xAI OAuth discovery"));
  const authorizationEndpoint = json.authorization_endpoint;
  const tokenEndpoint = json.token_endpoint;
  const deviceAuthorizationEndpoint = json.device_authorization_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new Error("xAI OAuth discovery response is missing endpoints");
  }
  return {
    authorizationEndpoint: trustedXaiEndpoint(authorizationEndpoint, "authorization endpoint"),
    tokenEndpoint: trustedXaiEndpoint(tokenEndpoint, "token endpoint"),
    ...(typeof deviceAuthorizationEndpoint === "string"
      ? {
          deviceAuthorizationEndpoint: trustedXaiEndpoint(
            deviceAuthorizationEndpoint,
            "device authorization endpoint",
          ),
        }
      : {}),
  };
}

function formUrlEncoded(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function buildPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl(params: {
  authorizationEndpoint: string;
  state: string;
  nonce: string;
  challenge: string;
}) {
  const url = new URL(trustedXaiEndpoint(params.authorizationEndpoint, "authorization endpoint"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", XAI_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", XAI_OAUTH_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("plan", "generic");
  url.searchParams.set("referrer", "fased");
  return url.toString();
}

function parseRedirectCallback(rawUrl: string, expectedState: string): XaiCallback {
  const url = new URL(rawUrl);
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`xAI OAuth returned ${error}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new Error("xAI OAuth redirect is missing code or state");
  }
  if (state !== expectedState) {
    throw new Error("xAI OAuth state mismatch");
  }
  return { code, state };
}

function waitForLocalXaiCallback(expectedState: string): Promise<XaiCallback> {
  return new Promise((resolve, reject) => {
    let listening = false;
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", XAI_OAUTH_REDIRECT_URI);
        if (url.pathname !== XAI_OAUTH_CALLBACK_PATH) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const callback = parseRedirectCallback(url.toString(), expectedState);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<html><body><h1>xAI sign-in complete</h1><p>You can close this tab.</p></body></html>",
        );
        cleanup();
        resolve(callback);
      } catch (err) {
        res.statusCode = 400;
        res.end("xAI sign-in failed. Return to Fased and retry.");
        cleanup();
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("xAI OAuth timed out"));
    }, XAI_OAUTH_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      if (listening) {
        server.close();
      }
    }

    server.once("error", (err) => {
      cleanup();
      reject(err);
    });
    server.listen(XAI_OAUTH_CALLBACK_PORT, XAI_OAUTH_CALLBACK_HOST, () => {
      listening = true;
    });
  });
}

function normalizeExpires(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Date.now() + seconds * 1000;
}

function parseTokenResponse(value: unknown, options: { requireRefreshToken?: boolean } = {}) {
  const json = readRecord(value);
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("xAI OAuth token response is missing access_token");
  }
  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token.trim()
      ? json.refresh_token.trim()
      : undefined;
  if (options.requireRefreshToken && !refreshToken) {
    throw new Error("xAI OAuth token response is missing refresh_token");
  }
  const idToken =
    typeof json.id_token === "string" && json.id_token.trim() ? json.id_token.trim() : undefined;
  const expires = normalizeExpires(json.expires_in);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(expires ? { expires } : {}),
  } satisfies XaiTokenResponse;
}

async function exchangeToken(params: {
  tokenEndpoint: string;
  body: Record<string, string>;
  context: string;
  requireRefreshToken?: boolean;
}): Promise<XaiTokenResponse> {
  const response = await fetch(trustedXaiEndpoint(params.tokenEndpoint, "token endpoint"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Fased/xai-oauth",
    },
    body: formUrlEncoded(params.body),
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  return parseTokenResponse(await readJsonResponse(response, params.context), {
    requireRefreshToken: params.requireRefreshToken,
  });
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  const part = token?.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return readRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function buildCredentials(params: {
  tokens: XaiTokenResponse;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  authFlow?: string;
}): OAuthCredentials {
  const payload = decodeJwtPayload(params.tokens.idToken ?? params.tokens.accessToken);
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const displayName = typeof payload.name === "string" ? payload.name : undefined;
  const accountId = typeof payload.sub === "string" ? payload.sub : undefined;
  return {
    access: params.tokens.accessToken,
    ...(params.tokens.refreshToken ? { refresh: params.tokens.refreshToken } : {}),
    ...(params.tokens.expires ? { expires: params.tokens.expires } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    tokenEndpoint: params.tokenEndpoint,
    issuer: XAI_OAUTH_ISSUER,
    ...(params.tokens.idToken ? { idToken: params.tokens.idToken } : {}),
    ...(accountId ? { accountId } : {}),
    ...(params.deviceAuthorizationEndpoint
      ? { deviceAuthorizationEndpoint: params.deviceAuthorizationEndpoint }
      : {}),
    ...(params.authFlow ? { authFlow: params.authFlow } : {}),
  } as OAuthCredentials;
}

export async function loginXaiOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl } = params;
  await prompter.note(
    isRemote
      ? [
          "Open the xAI sign-in URL in your LOCAL browser.",
          "After the browser redirects to 127.0.0.1, paste the full redirected URL back here.",
        ].join("\n")
      : [
          "Browser will open for xAI authentication.",
          `Fased listens on ${XAI_OAUTH_REDIRECT_URI} for the callback.`,
        ].join("\n"),
    "xAI sign-in",
  );

  const spin = prompter.progress("Starting xAI OAuth...");
  try {
    const discovery = await fetchXaiDiscovery();
    const pkce = buildPkce();
    const state = randomBytes(32).toString("hex");
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      state,
      nonce: randomBytes(16).toString("hex"),
      challenge: pkce.challenge,
    });

    let callback: XaiCallback;
    if (isRemote) {
      spin.stop("xAI OAuth URL ready");
      runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${authorizeUrl}\n`);
      const redirectUrl = await prompter.text({
        message: ["Paste the full xAI redirect URL after sign-in", "", authorizeUrl].join("\n"),
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      callback = parseRedirectCallback(String(redirectUrl), state);
    } else {
      const callbackPromise = waitForLocalXaiCallback(state);
      try {
        await openUrl(authorizeUrl);
        runtime.log(`Open: ${authorizeUrl}`);
      } catch {
        runtime.log(`Open manually: ${authorizeUrl}`);
      }
      spin.update("Waiting for xAI OAuth callback...");
      callback = await callbackPromise;
    }

    const tokens = await exchangeToken({
      tokenEndpoint: discovery.tokenEndpoint,
      context: "xAI OAuth token exchange",
      requireRefreshToken: true,
      body: {
        grant_type: "authorization_code",
        code: callback.code,
        redirect_uri: XAI_OAUTH_REDIRECT_URI,
        client_id: XAI_OAUTH_CLIENT_ID,
        code_verifier: pkce.verifier,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
    });
    spin.stop("xAI OAuth complete");
    return buildCredentials({ tokens, tokenEndpoint: discovery.tokenEndpoint });
  } catch (err) {
    spin.stop("xAI OAuth failed");
    runtime.error(String(err));
    await prompter.note(
      "xAI OAuth failed. Retry sign-in, use device code, or save an xAI API key.",
      "xAI OAuth help",
    );
    throw err;
  }
}

function normalizeSecondsToMs(value: unknown, fallbackMs: number): number {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : fallbackMs;
}

async function requestDeviceCode(endpoint: string): Promise<XaiDeviceCodeResponse> {
  const response = await fetch(trustedXaiEndpoint(endpoint, "device authorization endpoint"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Fased/xai-oauth",
    },
    body: formUrlEncoded({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = readRecord(await readJsonResponse(response, "xAI device code request"));
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri;
  const verificationUriComplete = json.verification_uri_complete;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new Error("xAI device code response is missing required fields");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: trustedXaiEndpoint(verificationUri, "device verification URI"),
    ...(typeof verificationUriComplete === "string" && verificationUriComplete.trim()
      ? {
          verificationUriComplete: trustedXaiEndpoint(
            verificationUriComplete,
            "complete device verification URI",
          ),
        }
      : {}),
    expiresInMs: normalizeSecondsToMs(json.expires_in, XAI_OAUTH_TIMEOUT_MS),
    intervalMs: normalizeSecondsToMs(json.interval, XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS),
  };
}

async function pollDeviceCode(params: {
  tokenEndpoint: string;
  deviceCode: string;
  expiresInMs: number;
  intervalMs: number;
}): Promise<XaiTokenResponse> {
  const deadline = Date.now() + params.expiresInMs;
  let intervalMs = params.intervalMs;
  while (Date.now() < deadline) {
    const response = await fetch(trustedXaiEndpoint(params.tokenEndpoint, "token endpoint"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Fased/xai-oauth",
      },
      body: formUrlEncoded({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: params.deviceCode,
      }),
      signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.ok) {
      return parseTokenResponse(body, { requireRefreshToken: true });
    }
    const error = readRecord(body).error;
    if (error === "authorization_pending") {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(intervalMs, XAI_DEVICE_CODE_MIN_INTERVAL_MS)),
      );
      continue;
    }
    if (error === "slow_down") {
      intervalMs += XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (error === "expired_token") {
      throw new Error("xAI device code expired. Re-run sign-in.");
    }
    throw new Error(
      `xAI device token exchange failed (${response.status})${typeof error === "string" ? `: ${error}` : ""}`,
    );
  }
  throw new Error("xAI device authorization timed out");
}

export async function loginXaiDeviceCode(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl } = params;
  const spin = prompter.progress("Starting xAI device code...");
  try {
    const discovery = await fetchXaiDiscovery();
    if (!discovery.deviceAuthorizationEndpoint) {
      throw new Error("xAI discovery did not advertise a device code endpoint");
    }
    const device = await requestDeviceCode(discovery.deviceAuthorizationEndpoint);
    spin.stop("xAI device code ready");
    const browserUrl = device.verificationUriComplete ?? device.verificationUri;
    await prompter.note(
      [
        isRemote
          ? "Open this URL in your LOCAL browser and enter the code below."
          : "Open this URL in your browser and enter the code below.",
        `URL: ${browserUrl}`,
        `Code: ${device.userCode}`,
        "Never share this code.",
      ].join("\n"),
      "xAI device code",
    );
    if (!isRemote) {
      try {
        await openUrl(browserUrl);
      } catch {
        runtime.log(`Open manually: ${browserUrl}`);
      }
    } else {
      runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${browserUrl}\n`);
    }

    const wait = prompter.progress("Waiting for xAI device authorization...");
    const tokens = await pollDeviceCode({
      tokenEndpoint: discovery.tokenEndpoint,
      deviceCode: device.deviceCode,
      expiresInMs: device.expiresInMs,
      intervalMs: device.intervalMs,
    });
    wait.stop("xAI device code complete");
    return buildCredentials({
      tokens,
      tokenEndpoint: discovery.tokenEndpoint,
      deviceAuthorizationEndpoint: discovery.deviceAuthorizationEndpoint,
      authFlow: "device-code",
    });
  } catch (err) {
    spin.stop("xAI device code failed");
    runtime.error(String(err));
    await prompter.note(
      "xAI device code failed. Retry sign-in or save an xAI API key.",
      "xAI device code help",
    );
    throw err;
  }
}

export async function refreshXaiOAuthCredential(
  credential: OAuthCredentials,
): Promise<OAuthCredentials> {
  const refresh = credential.refresh;
  if (!refresh) {
    throw new Error("xAI OAuth credential is missing refresh token");
  }
  const record = credential as OAuthCredentials & { tokenEndpoint?: unknown };
  const tokenEndpoint =
    typeof record.tokenEndpoint === "string" && record.tokenEndpoint.trim()
      ? record.tokenEndpoint.trim()
      : (await fetchXaiDiscovery()).tokenEndpoint;
  const tokens = await exchangeToken({
    tokenEndpoint,
    context: "xAI OAuth refresh",
    body: {
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refresh,
    },
  });
  return {
    ...credential,
    ...buildCredentials({ tokens, tokenEndpoint }),
    refresh: tokens.refreshToken ?? refresh,
  } as OAuthCredentials;
}
