const DATA_URL_PREFIX = "data:";
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "blob:"]);
const BLOCKED_DATA_IMAGE_MIME_TYPES = new Set(["image/svg+xml"]);

function isAllowedDataImageUrl(url: string): boolean {
  if (!url.toLowerCase().startsWith(DATA_URL_PREFIX)) {
    return false;
  }

  const commaIndex = url.indexOf(",");
  if (commaIndex < DATA_URL_PREFIX.length) {
    return false;
  }

  const metadata = url.slice(DATA_URL_PREFIX.length, commaIndex);
  const mimeType = metadata.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("image/")) {
    return false;
  }

  return !BLOCKED_DATA_IMAGE_MIME_TYPES.has(mimeType);
}

export type ResolveSafeExternalUrlOptions = {
  allowDataImage?: boolean;
};

export function resolveSafeExternalUrl(
  rawUrl: string,
  baseHref: string,
  opts: ResolveSafeExternalUrlOptions = {},
): string | null {
  const candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (opts.allowDataImage === true && isAllowedDataImageUrl(candidate)) {
    return candidate;
  }

  if (candidate.toLowerCase().startsWith(DATA_URL_PREFIX)) {
    return null;
  }

  try {
    const parsed = new URL(candidate, baseHref);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export type OpenExternalUrlSafeOptions = ResolveSafeExternalUrlOptions & {
  baseHref?: string;
};

export function openExternalUrlSafe(
  rawUrl: string,
  opts: OpenExternalUrlSafeOptions = {},
): WindowProxy | null {
  const baseHref = opts.baseHref ?? window.location.href;
  const safeUrl = resolveSafeExternalUrl(rawUrl, baseHref, opts);
  if (!safeUrl) {
    return null;
  }

  const opened = window.open(safeUrl, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

export function openBlankWindowSafe(features = "noopener,noreferrer"): WindowProxy | null {
  const opened = window.open("", "_blank", features);
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

// Reserve the tab inside the owner's click, before the gateway request loses
// browser user activation. Never give the provider an opener into the dashboard.
export function reserveProviderSignInWindow(provider: string) {
  const hosts: Record<string, readonly string[]> = {
    "openai-codex": ["auth.openai.com"],
    anthropic: ["claude.ai", "console.anthropic.com"],
    xai: ["auth.x.ai", "accounts.x.ai"],
  };
  const allowed = hosts[provider];
  if (!allowed || typeof window === "undefined" || typeof window.open !== "function") {
    return null;
  }
  let popup: Window | null;
  try {
    popup = window.open("about:blank", "_blank");
    if (!popup) {
      return null;
    }
    popup.opener = null;
  } catch {
    return null;
  }
  let navigated = false;
  return {
    navigate(value: string) {
      if (navigated || popup.closed) {
        return false;
      }
      try {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !allowed.includes(url.hostname)
        ) {
          return false;
        }
        popup.location.replace(url.href);
        navigated = true;
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      if (!navigated && !popup.closed) {
        popup.close();
      }
    },
  };
}
