import { describe, expect, it, vi } from "vitest";
import type { OnboardProviderAuthFlag } from "../../onboard-provider-auth-flags.js";

const resolveOnboardProviderAuthFlags = vi.hoisted(() =>
  vi.fn<() => OnboardProviderAuthFlag[]>(() => []),
);

vi.mock("../../onboard-provider-auth-flags.js", () => ({
  resolveOnboardProviderAuthFlags,
}));

import { inferAuthChoiceFromFlags } from "./auth-choice-inference.js";

describe("inferAuthChoiceFromFlags", () => {
  it("infers manifest-driven provider auth choices from dynamic CLI flags", () => {
    resolveOnboardProviderAuthFlags.mockReturnValue([
      {
        optionKey: "acmeApiKey",
        authChoice: "acme-api-key",
        cliFlag: "--acme-api-key",
        cliOption: "--acme-api-key <key>",
        description: "Acme API key",
      },
    ]);

    const result = inferAuthChoiceFromFlags({
      acmeApiKey: "sk-acme-test",
    });

    expect(result).toEqual({
      choice: "acme-api-key",
      matches: [
        {
          optionKey: "acmeApiKey",
          authChoice: "acme-api-key",
          label: "--acme-api-key",
        },
      ],
    });
  });
});
