export type ControlUiLoginExchangeSuccess = {
  ok: true;
  sessionToken: string;
  expiresAt?: string;
  idleTimeoutSeconds?: number;
};

export type ControlUiLoginExchangeFailure = {
  ok: false;
  code: string;
  message: string;
};

export type ControlUiLoginLogoutResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      message: string;
    };

function parseGrantFromHashLike(raw: string): string {
  const hashRaw = raw.startsWith("#") ? raw.slice(1) : raw;
  const hashParams = new URLSearchParams(hashRaw);
  return (hashParams.get("login") ?? "").trim();
}

export function normalizeControlUiLoginGrantInput(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    const fromHash = parseGrantFromHashLike(url.hash);
    if (fromHash) {
      return fromHash;
    }
    return (url.searchParams.get("login") ?? "").trim() || raw;
  } catch {
    // Not a full URL; continue parsing as hash/query fragments.
  }

  if (raw.startsWith("#")) {
    const fromHash = parseGrantFromHashLike(raw);
    if (fromHash) {
      return fromHash;
    }
  }

  if (raw.startsWith("login=") || raw.includes("&login=")) {
    const params = new URLSearchParams(raw.startsWith("login=") ? raw : raw.replace(/^.*\?/, ""));
    return (params.get("login") ?? "").trim() || raw;
  }

  return raw;
}

async function parseLoginExchangeResponse(
  response: Response,
): Promise<ControlUiLoginExchangeSuccess | ControlUiLoginExchangeFailure> {
  let body: unknown = null;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    return { ok: false, code: "invalid_response", message: "invalid response from gateway" };
  }
  const parsed = body as {
    ok?: unknown;
    sessionToken?: unknown;
    expiresAt?: unknown;
    idleTimeoutSeconds?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (parsed.ok === true && typeof parsed.sessionToken === "string" && parsed.sessionToken.trim()) {
    return {
      ok: true,
      sessionToken: parsed.sessionToken.trim(),
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined,
      idleTimeoutSeconds:
        typeof parsed.idleTimeoutSeconds === "number" ? parsed.idleTimeoutSeconds : undefined,
    };
  }
  const code =
    typeof parsed.error?.code === "string" && parsed.error.code.trim()
      ? parsed.error.code.trim()
      : response.ok
        ? "invalid_response"
        : "exchange_failed";
  const message =
    typeof parsed.error?.message === "string" && parsed.error.message.trim()
      ? parsed.error.message.trim()
      : response.ok
        ? "invalid response from gateway"
        : `gateway returned ${response.status}`;
  return { ok: false, code, message };
}

export async function exchangeControlUiLoginGrant(
  grant: string,
): Promise<ControlUiLoginExchangeSuccess | ControlUiLoginExchangeFailure> {
  const trimmedGrant = normalizeControlUiLoginGrantInput(grant);
  if (!trimmedGrant) {
    return { ok: false, code: "invalid_request", message: "grant is required" };
  }
  let response: Response;
  try {
    response = await fetch("/api/control-ui/login/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant: trimmedGrant }),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return parseLoginExchangeResponse(response);
}

export async function exchangeControlUiGatewayToken(
  token: string,
): Promise<ControlUiLoginExchangeSuccess | ControlUiLoginExchangeFailure> {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return { ok: false, code: "invalid_request", message: "gateway token is required" };
  }

  let response: Response;
  try {
    response = await fetch("/api/control-ui/login/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: trimmedToken }),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return parseLoginExchangeResponse(response);
}

export async function revokeControlUiSessionToken(
  sessionToken: string,
): Promise<ControlUiLoginLogoutResult> {
  const token = sessionToken.trim();
  if (!token) {
    return { ok: false, code: "invalid_request", message: "session token is required" };
  }

  let response: Response;
  try {
    response = await fetch("/api/control-ui/login/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let body: unknown = null;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = null;
  }
  if (response.ok) {
    return { ok: true };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, code: "invalid_response", message: `gateway returned ${response.status}` };
  }
  const parsed = body as { error?: { code?: unknown; message?: unknown } };
  const code =
    typeof parsed.error?.code === "string" && parsed.error.code.trim()
      ? parsed.error.code.trim()
      : "logout_failed";
  const message =
    typeof parsed.error?.message === "string" && parsed.error.message.trim()
      ? parsed.error.message.trim()
      : `gateway returned ${response.status}`;
  return { ok: false, code, message };
}
