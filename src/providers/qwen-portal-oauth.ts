export type QwenPortalCredentials = {
  access: string;
  refresh?: string;
  expires: number;
};

const QWEN_PORTAL_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";

export async function refreshQwenPortalCredentials(
  credentials: QwenPortalCredentials,
): Promise<QwenPortalCredentials> {
  const refresh = credentials.refresh?.trim();
  if (!refresh) {
    throw new Error("Qwen OAuth refresh token missing");
  }

  const response = await fetch(QWEN_PORTAL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText || "unknown error");
    if (response.status === 400 && text.includes("invalid_grant")) {
      throw new Error("Qwen OAuth refresh token expired or invalid");
    }
    throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText || response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const access = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!access) {
    throw new Error("Qwen OAuth refresh response missing access token");
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 0;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Qwen OAuth refresh response missing or invalid expires_in");
  }
  const nextRefresh =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : refresh;

  return {
    access,
    refresh: nextRefresh,
    expires: Date.now() + expiresIn * 1000,
  };
}
