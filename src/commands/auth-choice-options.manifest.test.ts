import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<() => ProviderAuthChoiceMetadata[]>(() => []),
);

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

import {
  buildAuthChoiceGroups,
  buildAuthChoiceOptions,
  formatAuthChoiceChoicesForCli,
} from "./auth-choice-options.js";

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

describe("auth-choice options manifest integration", () => {
  it("surfaces visible manifest choices in grouped onboarding selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "acme-auth",
        providerId: "acme-cloud",
        methodId: "oauth",
        choiceId: "acme-cloud-oauth",
        choiceLabel: "Acme Cloud OAuth",
        choiceHint: "OAuth for Acme Cloud",
        groupId: "acme-cloud",
        groupLabel: "Acme Cloud",
        groupHint: "Plugin provider",
      },
      {
        pluginId: "manual-only-auth",
        providerId: "hidden",
        methodId: "oauth",
        choiceId: "hidden-oauth",
        choiceLabel: "Hidden OAuth",
        assistantVisibility: "manual-only",
      },
    ]);

    const options = buildAuthChoiceOptions({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const cliChoices = formatAuthChoiceChoicesForCli().split("|");

    expect(options.some((option) => option.value === "acme-cloud-oauth")).toBe(true);
    expect(options.some((option) => option.value === "hidden-oauth")).toBe(false);
    expect(cliChoices).toContain("acme-cloud-oauth");
    expect(cliChoices).not.toContain("hidden-oauth");

    const acmeGroup = groups.find((group) => group.value === "acme-cloud");
    expect(acmeGroup).toMatchObject({
      label: "Acme Cloud",
      hint: "Plugin provider",
    });
    expect(acmeGroup?.options).toEqual([
      {
        value: "acme-cloud-oauth",
        label: "Acme Cloud OAuth",
        hint: "OAuth for Acme Cloud",
      },
    ]);
  });

  it("deduplicates manifest choices already present in the static catalog", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai-auth",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
    ]);

    const options = buildAuthChoiceOptions({
      store: EMPTY_STORE,
      includeSkip: false,
    }).filter((option) => option.value === "openai-api-key");

    expect(options).toHaveLength(1);
  });
});
