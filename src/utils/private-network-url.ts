function isIpv4InCidr(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

export function isPrivateNetworkBaseUrl(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim();
  if (!raw) {
    return false;
  }
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return true;
    }
    if (isIpv4InCidr(host)) {
      return true;
    }
    return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  } catch {
    return false;
  }
}
