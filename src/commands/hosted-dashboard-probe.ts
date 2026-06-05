import { WebSocket } from "ws";
import { ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE } from "../gateway/method-scopes.js";
import { PROTOCOL_VERSION } from "../gateway/protocol/index.js";
import { rawDataToString } from "../infra/ws.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

export type HostedDashboardBrowserProbeResult =
  | {
      ok: true;
      durationMs: number;
      wsUrl: string;
    }
  | {
      ok: false;
      durationMs: number;
      stage: "login" | "websocket";
      message: string;
      wsUrl?: string;
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
      ws.send(
        JSON.stringify({
          type: "req",
          id: "dashboard-browser-probe-connect",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              version: "dashboard-probe",
              platform: "node",
              mode: GATEWAY_CLIENT_MODES.UI,
            },
            role: "operator",
            scopes: [ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE],
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
      setTimeout(sendConnect, 100);
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
      wsUrl,
    };
  }

  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    wsUrl,
  };
}
