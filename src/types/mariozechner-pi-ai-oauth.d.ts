declare module "@mariozechner/pi-ai/oauth" {
  export function getOAuthApiKey(...args: unknown[]): string | undefined;
  export function getOAuthProviders(...args: unknown[]): unknown[];
}
