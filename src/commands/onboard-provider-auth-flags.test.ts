import { describe, expect, it, vi } from "vitest";
import type { ProviderOnboardAuthFlag } from "../plugins/provider-auth-choices.js";

const resolveManifestProviderOnboardAuthFlags = vi.hoisted(() =>
  vi.fn<() => ProviderOnboardAuthFlag[]>(() => []),
);

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderOnboardAuthFlags,
}));

import { resolveOnboardProviderAuthFlags } from "./onboard-provider-auth-flags.js";

describe("resolveOnboardProviderAuthFlags", () => {
  it("includes static flags and appends manifest-driven flags", () => {
    resolveManifestProviderOnboardAuthFlags.mockReturnValue([
      {
        optionKey: "acmeApiKey",
        authChoice: "acme-api-key",
        cliFlag: "--acme-api-key",
        cliOption: "--acme-api-key <key>",
        description: "Acme API key",
      },
    ]);

    const flags = resolveOnboardProviderAuthFlags();

    expect(flags.some((flag) => flag.authChoice === "openai-api-key")).toBe(true);
    expect(flags).toContainEqual({
      optionKey: "acmeApiKey",
      authChoice: "acme-api-key",
      cliFlag: "--acme-api-key",
      cliOption: "--acme-api-key <key>",
      description: "Acme API key",
    });
  });

  it("deduplicates manifest flags already covered by the static catalog", () => {
    resolveManifestProviderOnboardAuthFlags.mockReturnValue([
      {
        optionKey: "openaiApiKey",
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
      },
    ]);

    const flags = resolveOnboardProviderAuthFlags().filter(
      (flag) => flag.authChoice === "openai-api-key",
    );

    expect(flags).toHaveLength(1);
  });
});
