const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
]);

export function stripXaiUnsupportedKeywords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripXaiUnsupportedKeywords(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (XAI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    out[key] = stripXaiUnsupportedKeywords(nested);
  }
  return out;
}
