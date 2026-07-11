const SENSITIVE_URL_QUERY_PARAM_NAMES = new Set([
  "token",
  "key",
  "api_key",
  "api-key",
  "apikey",
  "secret",
  "access_token",
  "password",
  "pass",
  "auth",
  "client_secret",
  "refresh_token",
  "signature",
]);

function isSensitiveUrlQueryParamName(name: string): boolean {
  return SENSITIVE_URL_QUERY_PARAM_NAMES.has(name.trim().toLowerCase());
}

export function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value);
    let mutated = false;
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
      mutated = true;
    }
    const redactedPathname = parsed.pathname.replace(/\/file\/bot[^/]+/giu, "/file/bot***");
    if (redactedPathname !== parsed.pathname) {
      parsed.pathname = redactedPathname;
      mutated = true;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveUrlQueryParamName(key)) {
        parsed.searchParams.set(key, "***");
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : value;
  } catch {
    return value;
  }
}

export function redactSensitiveUrlLikeString(value: string): string {
  const redacted = redactSensitiveUrl(value);
  if (redacted !== value) {
    return redacted;
  }
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, (match) => redactSensitiveUrl(match))
    .replace(/\/\/([^@/?#]+)@/, "//***:***@")
    .replace(/([?&])([^=&]+)=([^&]*)/g, (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=***` : match,
    );
}
