import type { z } from "zod";

export function safeParseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function safeParseJsonWithSchema<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    return safeParseWithSchema(schema, JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
