declare module "@mariozechner/pi-ai/oauth" {
  import type { OAuthCredentials, OAuthProviderInterface } from "@mariozechner/pi-ai";

  export function getOAuthApiKey(
    providerId: string,
    credentials: Record<string, OAuthCredentials>,
  ): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
  export function getOAuthProviders(): OAuthProviderInterface[];
}
