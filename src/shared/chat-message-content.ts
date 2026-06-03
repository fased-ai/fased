export type AssistantTextPhase = "commentary" | "final_answer";

export type AssistantTextSignature = {
  id: string;
  phase?: AssistantTextPhase;
};

export function normalizeAssistantPhase(value: unknown): AssistantTextPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

export function encodeAssistantTextSignature(signature: AssistantTextSignature): string {
  return JSON.stringify({
    v: 1,
    id: signature.id,
    ...(signature.phase ? { phase: signature.phase } : {}),
  });
}

export function parseAssistantTextSignature(value: unknown): AssistantTextSignature | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (!value.startsWith("{")) {
    return { id: value };
  }
  try {
    const parsed = JSON.parse(value) as { v?: unknown; id?: unknown; phase?: unknown };
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !parsed.id) {
      return undefined;
    }
    const phase = normalizeAssistantPhase(parsed.phase);
    return {
      id: parsed.id,
      ...(phase ? { phase } : {}),
    };
  } catch {
    return { id: value };
  }
}
