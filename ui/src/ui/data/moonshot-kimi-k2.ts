export const MOONSHOT_KIMI_K2_DEFAULT_ID = "kimi-k2.6";
export const MOONSHOT_KIMI_K2_CONTEXT_WINDOW = 262144;
export const MOONSHOT_KIMI_K2_MAX_TOKENS = 32768;
export const MOONSHOT_KIMI_K2_INPUT = ["text", "image"] as const;
export const MOONSHOT_KIMI_K2_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export const MOONSHOT_KIMI_K2_MODELS = [
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    alias: "Kimi K2.6",
    reasoning: true,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    alias: "Kimi K2.5",
    reasoning: true,
  },
] as const;

export type MoonshotKimiK2Model = (typeof MOONSHOT_KIMI_K2_MODELS)[number];
