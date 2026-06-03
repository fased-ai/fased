import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
}));

import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    resolveManifestProviderAuthChoice.mockReset();
    resolveManifestDeprecatedProviderAuthChoice.mockReset();
  });

  it("keeps static provider mappings for built-in auth choices", () => {
    expect(resolvePreferredProviderForAuthChoice("openai-api-key")).toBe("openai");
    expect(resolveManifestProviderAuthChoice).not.toHaveBeenCalled();
  });

  it("returns the manifest provider for dynamic auth choices", () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      providerId: "acme-cloud",
      choiceId: "acme-cloud-oauth",
    });

    expect(resolvePreferredProviderForAuthChoice("acme-cloud-oauth", { config: {} })).toBe(
      "acme-cloud",
    );
  });

  it("supports deprecated manifest auth choice aliases", () => {
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      providerId: "acme-cloud",
      choiceId: "acme-cloud-oauth",
    });

    expect(resolvePreferredProviderForAuthChoice("legacy-acme-cloud", { config: {} })).toBe(
      "acme-cloud",
    );
  });
});
