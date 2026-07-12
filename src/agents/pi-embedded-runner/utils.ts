import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh"; FasedAgent enables it for specific models.
  if (!level) {
    return "off";
  }
  // pi-agent-core does not model GPT-5.6's `max` value yet. Build the
  // upstream session as xhigh, then the OpenAI payload wrapper restores max.
  return level === "max" ? "xhigh" : level;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
