export function formatLineIdForLog(value?: string | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.length <= 6) {
    return "<redacted>";
  }
  return `${normalized.slice(0, 3)}...${normalized.slice(-3)}`;
}

export function formatLineAddressForLog(value?: string | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "unknown";
  }
  const match = normalized.match(/^(line:(?:group|room|user):|line:)(.+)$/i);
  if (!match) {
    return formatLineIdForLog(normalized);
  }
  return `${match[1]}${formatLineIdForLog(match[2])}`;
}
