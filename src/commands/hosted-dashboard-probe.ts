import { WebSocket } from "ws";
import { buildDeviceAuthPayload } from "../gateway/device-auth.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE } from "../gateway/method-scopes.js";
import { PROTOCOL_VERSION } from "../gateway/protocol/index.js";
import {
  createEphemeralDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { rawDataToString } from "../infra/ws.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

export type HostedDashboardBrowserProbeResult =
  | {
      ok: true;
      durationMs: number;
      wsUrl: string;
      bootCheck: HostedDashboardBootCheck;
    }
  | {
      ok: false;
      durationMs: number;
      stage: "login" | "assets" | "websocket";
      message: string;
      wsUrl?: string;
      bootCheck?: HostedDashboardBootCheck;
    };

export type HostedDashboardBootAssetCheck = {
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  message?: string;
};

export type HostedDashboardBootCheck = {
  serve: "tailscale" | "direct";
  index: "ok" | "failed";
  indexResponse: HostedDashboardBootAssetCheck;
  entryJs?: HostedDashboardBootAssetCheck;
  appJs?: HostedDashboardBootAssetCheck;
  assets: HostedDashboardBootAssetCheck[];
};

type LoginResponse = {
  ok?: boolean;
  sessionToken?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

function sanitizeErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

function buildOrigin(httpUrl: string): string {
  const url = new URL(httpUrl);
  return url.origin;
}

function buildLoginUrl(httpUrl: string): string {
  return new URL("/api/control-ui/login/token", httpUrl).toString();
}

function buildWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveAssetUrl(src: string, baseUrl: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractHtmlAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) {
    const resolved = resolveAssetUrl(match[1] ?? "", baseUrl);
    if (resolved) {
      urls.add(resolved);
    }
  }
  return [...urls];
}

function extractHtmlScriptAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0] ?? "";
    if (/\bdata-fased-boot-watchdog\b/i.test(tag)) {
      continue;
    }
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ?? "";
    const resolved = resolveAssetUrl(src, baseUrl);
    if (resolved && /\.js(?:[?#].*)?$/i.test(resolved)) {
      urls.add(resolved);
    }
  }
  return [...urls];
}

function extractDynamicImportUrls(js: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of js.matchAll(/\bimport\(\s*["']([^"']+\.js)["']\s*\)/g)) {
    const resolved = resolveAssetUrl(match[1] ?? "", baseUrl);
    if (resolved) {
      urls.add(resolved);
    }
  }
  return [...urls];
}

async function fetchTextWithTimeout(params: {
  url: string;
  timeoutMs: number;
  headers?: HeadersInit;
}): Promise<
  | { ok: true; url: string; status: number; contentType: string; text: string }
  | { ok: false; message: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: "GET",
      headers: params.headers,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    return {
      ok: true,
      url: response.url || params.url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  } catch (err) {
    return { ok: false, message: sanitizeErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

function inferServe(httpUrl: string): "tailscale" | "direct" {
  try {
    return new URL(httpUrl).protocol === "https:" ? "tailscale" : "direct";
  } catch {
    return "direct";
  }
}

function urlPathnameLower(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isLikelyAppJsUrl(url: string): boolean {
  const basename = urlPathnameLower(url).split("/").pop() ?? "";
  return /^app-[^.]+\.js$/.test(basename);
}

function makeAssetCheck(params: {
  url: string;
  status: number;
  contentType: string;
  text: string;
}): HostedDashboardBootAssetCheck {
  const valid = validateAssetResponse(params);
  return valid.ok
    ? {
        url: params.url,
        ok: true,
        status: params.status,
        contentType: params.contentType,
      }
    : {
        url: params.url,
        ok: false,
        status: params.status,
        contentType: params.contentType,
        message: valid.message,
      };
}

function validateAssetResponse(params: {
  url: string;
  status: number;
  contentType: string;
  text: string;
}): { ok: true } | { ok: false; message: string } {
  if (params.status < 200 || params.status >= 300) {
    return { ok: false, message: `${params.url} returned HTTP ${params.status}` };
  }
  const head = params.text.slice(0, 80).trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    return { ok: false, message: `${params.url} returned HTML instead of an asset` };
  }
  const lowerUrl = urlPathnameLower(params.url);
  const lowerContentType = params.contentType.toLowerCase();
  if (lowerUrl.endsWith(".js") && !lowerContentType.includes("javascript")) {
    return {
      ok: false,
      message: `${params.url} returned ${params.contentType || "missing content-type"} instead of JavaScript`,
    };
  }
  if (lowerUrl.endsWith(".css") && !lowerContentType.includes("text/css")) {
    return {
      ok: false,
      message: `${params.url} returned ${params.contentType || "missing content-type"} instead of CSS`,
    };
  }
  return { ok: true };
}

async function probeHostedControlUiAssets(params: {
  httpUrl: string;
  sessionToken: string;
  timeoutMs: number;
}): Promise<
  | { ok: true; bootCheck: HostedDashboardBootCheck }
  | { ok: false; message: string; bootCheck: HostedDashboardBootCheck }
> {
  const bootCheck: HostedDashboardBootCheck = {
    serve: inferServe(params.httpUrl),
    index: "failed",
    indexResponse: {
      url: params.httpUrl,
      ok: false,
    },
    assets: [],
  };
  const cookieHeader = `fased_ui_session=${encodeURIComponent(params.sessionToken)}`;
  const index = await fetchTextWithTimeout({
    url: params.httpUrl,
    timeoutMs: params.timeoutMs,
    headers: {
      accept: "text/html",
      cookie: cookieHeader,
    },
  });
  if (!index.ok) {
    bootCheck.indexResponse.message = `index fetch failed: ${index.message}`;
    return { ok: false, message: bootCheck.indexResponse.message, bootCheck };
  }
  bootCheck.indexResponse = {
    url: index.url,
    ok: false,
    status: index.status,
    contentType: index.contentType,
  };
  if (index.status < 200 || index.status >= 300) {
    bootCheck.indexResponse.message = `index returned HTTP ${index.status}`;
    return { ok: false, message: bootCheck.indexResponse.message, bootCheck };
  }
  if (!index.contentType.toLowerCase().includes("text/html")) {
    bootCheck.indexResponse.message = `index returned ${
      index.contentType || "missing content-type"
    } instead of HTML`;
    return { ok: false, message: bootCheck.indexResponse.message, bootCheck };
  }
  bootCheck.index = "ok";
  bootCheck.indexResponse.ok = true;
  const htmlAssets = extractHtmlAssetUrls(index.text, index.url).filter((url) =>
    /\.(?:js|css)(?:[?#].*)?$/i.test(url),
  );
  const entryJsUrl = extractHtmlScriptAssetUrls(index.text, index.url)[0];
  if (htmlAssets.length === 0) {
    const message = "index did not reference dashboard JS/CSS assets";
    bootCheck.indexResponse.message = message;
    return { ok: false, message, bootCheck };
  }

  const checked = new Set<string>();
  const pending = [...htmlAssets];
  let appJsUrl: string | undefined;
  while (pending.length > 0) {
    const assetUrl = pending.shift();
    if (!assetUrl || checked.has(assetUrl)) {
      continue;
    }
    checked.add(assetUrl);
    const asset = await fetchTextWithTimeout({
      url: assetUrl,
      timeoutMs: params.timeoutMs,
      headers: { accept: "*/*" },
    });
    if (!asset.ok) {
      const failedAsset: HostedDashboardBootAssetCheck = {
        url: assetUrl,
        ok: false,
        message: `${assetUrl} fetch failed: ${asset.message}`,
      };
      bootCheck.assets.push(failedAsset);
      if (assetUrl === entryJsUrl) {
        bootCheck.entryJs = failedAsset;
      }
      if (assetUrl === appJsUrl) {
        bootCheck.appJs = failedAsset;
      }
      return { ok: false, message: failedAsset.message ?? "asset fetch failed", bootCheck };
    }
    const assetCheck = makeAssetCheck({
      url: assetUrl,
      status: asset.status,
      contentType: asset.contentType,
      text: asset.text,
    });
    bootCheck.assets.push(assetCheck);
    if (assetUrl === entryJsUrl) {
      bootCheck.entryJs = assetCheck;
    }
    if (assetUrl === appJsUrl) {
      bootCheck.appJs = assetCheck;
    }
    if (!assetCheck.ok) {
      return { ok: false, message: assetCheck.message ?? "asset validation failed", bootCheck };
    }
    if (/\.js(?:[?#].*)?$/i.test(assetUrl)) {
      const dynamicUrls = extractDynamicImportUrls(asset.text, assetUrl);
      if (assetUrl === entryJsUrl && !appJsUrl) {
        appJsUrl = dynamicUrls.find(isLikelyAppJsUrl) ?? dynamicUrls[0];
      }
      for (const dynamicUrl of dynamicUrls) {
        if (!checked.has(dynamicUrl)) {
          pending.push(dynamicUrl);
        }
      }
    }
  }

  return { ok: true, bootCheck };
}

async function readLoginJson(response: Response): Promise<LoginResponse> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as LoginResponse;
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: text.slice(0, 160),
      },
    };
  }
}

async function exchangeGatewayTokenForSession(params: {
  httpUrl: string;
  token: string;
  timeoutMs: number;
}): Promise<{ ok: true; sessionToken: string } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(buildLoginUrl(params.httpUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: buildOrigin(params.httpUrl),
      },
      cache: "no-store",
      body: JSON.stringify({ token: params.token }),
      signal: controller.signal,
    });
    const body = await readLoginJson(response);
    if (!response.ok || body.ok !== true || !body.sessionToken?.trim()) {
      const code = body.error?.code ? `${body.error.code}: ` : "";
      const message = body.error?.message || `HTTP ${response.status}`;
      return { ok: false, message: `${code}${message}` };
    }
    return { ok: true, sessionToken: body.sessionToken.trim() };
  } catch (err) {
    return { ok: false, message: sanitizeErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeGatewayConnectError(frame: unknown): string {
  const error =
    frame && typeof frame === "object" && "error" in frame
      ? ((frame as { error?: unknown }).error as {
          code?: unknown;
          message?: unknown;
          details?: unknown;
        })
      : undefined;
  if (!error || typeof error !== "object") {
    return "connect rejected";
  }
  const code = typeof error.code === "string" ? error.code : "connect_rejected";
  const message = typeof error.message === "string" ? error.message : "connect rejected";
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : null;
  const detailCode = typeof details?.code === "string" ? ` (${details.code})` : "";
  const authReason = typeof details?.authReason === "string" ? ` auth=${details.authReason}` : "";
  return `${code}: ${message}${detailCode}${authReason}`;
}

function probeHostedWs(params: {
  wsUrl: string;
  origin: string;
  sessionToken: string;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let connectSent = false;
    let ws: WebSocket | null = null;
    let connectNonce = "";
    const role = "operator";
    const scopes = [ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE];
    const client = {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "dashboard-probe",
      platform: "node",
      mode: GATEWAY_CLIENT_MODES.UI,
    };
    const deviceIdentity = createEphemeralDeviceIdentity();

    const finish = (result: { ok: true } | { ok: false; message: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // best effort cleanup
      }
      resolve(result);
    };

    const sendConnect = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN || connectSent) {
        return;
      }
      connectSent = true;
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes,
        signedAtMs,
        token: params.sessionToken,
        nonce: connectNonce,
      });
      ws.send(
        JSON.stringify({
          type: "req",
          id: "dashboard-browser-probe-connect",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client,
            role,
            scopes,
            device: {
              id: deviceIdentity.deviceId,
              publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
              signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
              signedAt: signedAtMs,
              nonce: connectNonce,
            },
            caps: [],
            auth: {
              token: params.sessionToken,
            },
            userAgent: "fased-dashboard-probe",
            locale: "en-US",
          },
        }),
      );
    };

    const timer = setTimeout(() => {
      finish({ ok: false, message: `timeout after ${params.timeoutMs}ms` });
    }, params.timeoutMs);

    try {
      ws = new WebSocket(params.wsUrl, {
        headers: {
          Origin: params.origin,
        },
        handshakeTimeout: Math.max(1000, Math.floor(params.timeoutMs)),
        maxPayload: 1024 * 1024,
      });
    } catch (err) {
      finish({ ok: false, message: sanitizeErrorMessage(err) });
      return;
    }

    ws.on("open", () => {
      // The browser waits for the gateway challenge before signing device auth.
      // Keep the hosted probe on the same path so health matches the real UI.
    });
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(data));
      } catch {
        return;
      }
      const frame = parsed as { type?: unknown; event?: unknown; id?: unknown; ok?: unknown };
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce =
          parsed && typeof parsed === "object" && "payload" in parsed
            ? ((parsed as { payload?: { nonce?: unknown } }).payload?.nonce ?? "")
            : "";
        connectNonce = typeof nonce === "string" ? nonce : "";
        sendConnect();
        return;
      }
      if (frame.type !== "res" || frame.id !== "dashboard-browser-probe-connect") {
        return;
      }
      if (frame.ok === true) {
        finish({ ok: true });
        return;
      }
      finish({ ok: false, message: summarizeGatewayConnectError(parsed) });
    });
    ws.on("error", (err) => {
      if (!settled) {
        finish({ ok: false, message: sanitizeErrorMessage(err) });
      }
    });
    ws.on("close", (code, reason) => {
      if (!settled) {
        const reasonText = String(reason || "").trim();
        finish({
          ok: false,
          message: `closed before connect response (${code}${reasonText ? `: ${reasonText}` : ""})`,
        });
      }
    });
  });
}

export async function probeHostedDashboardBrowserPath(params: {
  httpUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<HostedDashboardBrowserProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Math.floor(params.timeoutMs ?? 6000));
  const token = params.token.trim();
  const wsUrl = buildWsUrl(params.httpUrl);
  if (!token) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      stage: "login",
      message: "missing gateway token",
      wsUrl,
    };
  }

  const login = await exchangeGatewayTokenForSession({
    httpUrl: params.httpUrl,
    token,
    timeoutMs,
  });
  if (!login.ok) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      stage: "login",
      message: login.message,
      wsUrl,
    };
  }

  const assets = await probeHostedControlUiAssets({
    httpUrl: params.httpUrl,
    sessionToken: login.sessionToken,
    timeoutMs,
  });
  if (!assets.ok) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      stage: "assets",
      message: assets.message,
      bootCheck: assets.bootCheck,
      wsUrl,
    };
  }

  const websocket = await probeHostedWs({
    wsUrl,
    origin: buildOrigin(params.httpUrl),
    sessionToken: login.sessionToken,
    timeoutMs,
  });
  if (!websocket.ok) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      stage: "websocket",
      message: websocket.message,
      bootCheck: assets.bootCheck,
      wsUrl,
    };
  }

  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    bootCheck: assets.bootCheck,
    wsUrl,
  };
}

export async function waitForHostedDashboardBrowserPath(params: {
  httpUrl: string;
  token: string;
  deadlineMs?: number;
  probeTimeoutMs?: number;
  pollMs?: number;
}): Promise<HostedDashboardBrowserProbeResult> {
  const deadlineMs = Math.max(1, Math.floor(params.deadlineMs ?? 15_000));
  const probeTimeoutMs = Math.max(1, Math.floor(params.probeTimeoutMs ?? 6000));
  const pollMs = Math.max(250, Math.floor(params.pollMs ?? 1000));
  const startedAt = Date.now();
  let lastResult: HostedDashboardBrowserProbeResult | null = null;

  while (Date.now() - startedAt < deadlineMs) {
    lastResult = await probeHostedDashboardBrowserPath({
      httpUrl: params.httpUrl,
      token: params.token,
      timeoutMs: probeTimeoutMs,
    });
    if (lastResult.ok) {
      return {
        ...lastResult,
        durationMs: Date.now() - startedAt,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (lastResult) {
    return {
      ...lastResult,
      durationMs: Date.now() - startedAt,
    };
  }
  return {
    ok: false,
    durationMs: Date.now() - startedAt,
    stage: "websocket",
    message: "timeout before first hosted dashboard probe completed",
  };
}
