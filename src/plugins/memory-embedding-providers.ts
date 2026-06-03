export type MemoryEmbeddingProviderId =
  | "openai"
  | "gemini"
  | "local"
  | "voyage"
  | "mistral"
  | "ollama";

export type MemoryEmbeddingProviderRegistration = {
  id: MemoryEmbeddingProviderId;
  defaultModel?: string;
  transport?: "local" | "remote";
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  create?: () => Promise<{ provider: unknown }>;
};

const providers = new Map<MemoryEmbeddingProviderId, MemoryEmbeddingProviderRegistration>();

export function registerMemoryEmbeddingProvider(
  provider: MemoryEmbeddingProviderRegistration,
): void {
  providers.set(provider.id, provider);
}

export function clearMemoryEmbeddingProviders(): void {
  providers.clear();
}

export function getMemoryEmbeddingProvider(
  id: string | undefined,
): MemoryEmbeddingProviderRegistration | undefined {
  if (!id) {
    return undefined;
  }
  return providers.get(id as MemoryEmbeddingProviderId);
}
