import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyAuthChoiceManifestPluginProvider } from "./auth-choice.apply.plugin-manifest.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
}));

vi.mock("./auth-choice.apply.plugin-provider.js", () => ({
  applyAuthChoicePluginProvider: vi.fn(),
}));

function createParams(
  authChoice: ApplyAuthChoiceParams["authChoice"],
  overrides: Partial<ApplyAuthChoiceParams> = {},
): ApplyAuthChoiceParams {
  return {
    authChoice,
    config: {},
    prompter: createWizardPrompter({}, { defaultSelect: "" }),
    runtime: createExitThrowingRuntime(),
    setDefaultModel: true,
    ...overrides,
  };
}

describe("applyAuthChoiceManifestPluginProvider", () => {
  const mockedApplyAuthChoicePluginProvider = vi.mocked(applyAuthChoicePluginProvider);

  beforeEach(() => {
    resolveManifestProviderAuthChoice.mockReset();
    resolveManifestDeprecatedProviderAuthChoice.mockReset();
    mockedApplyAuthChoicePluginProvider.mockReset();
  });

  it("returns null when no manifest choice matches", async () => {
    const params = createParams("openrouter-api-key");

    const result = await applyAuthChoiceManifestPluginProvider(params);

    expect(result).toBeNull();
    expect(mockedApplyAuthChoicePluginProvider).not.toHaveBeenCalled();
  });

  it("routes direct manifest choices through the shared plugin provider executor", async () => {
    const params = createParams("acme-cloud-oauth");
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "acme-auth",
      providerId: "acme-cloud",
      methodId: "oauth",
      choiceId: "acme-cloud-oauth",
      choiceLabel: "Acme Cloud OAuth",
      groupLabel: "Acme Cloud",
    });
    mockedApplyAuthChoicePluginProvider.mockResolvedValue({ config: { auth: {} } });

    const result = await applyAuthChoiceManifestPluginProvider(params);

    expect(result).toEqual({ config: { auth: {} } });
    expect(mockedApplyAuthChoicePluginProvider).toHaveBeenCalledWith(
      {
        ...params,
        authChoice: "acme-cloud-oauth",
      },
      {
        authChoice: "acme-cloud-oauth",
        pluginId: "acme-auth",
        providerId: "acme-cloud",
        methodId: "oauth",
        label: "Acme Cloud",
      },
    );
  });

  it("maps deprecated manifest aliases onto the canonical plugin auth choice", async () => {
    const params = createParams("legacy-acme");
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      pluginId: "acme-auth",
      providerId: "acme-cloud",
      methodId: "oauth",
      choiceId: "acme-cloud-oauth",
      choiceLabel: "Acme Cloud OAuth",
    });
    mockedApplyAuthChoicePluginProvider.mockResolvedValue({ config: { auth: { profiles: {} } } });

    const result = await applyAuthChoiceManifestPluginProvider(params);

    expect(result).toEqual({ config: { auth: { profiles: {} } } });
    expect(mockedApplyAuthChoicePluginProvider).toHaveBeenCalledWith(
      {
        ...params,
        authChoice: "acme-cloud-oauth",
      },
      {
        authChoice: "acme-cloud-oauth",
        pluginId: "acme-auth",
        providerId: "acme-cloud",
        methodId: "oauth",
        label: "Acme Cloud OAuth",
      },
    );
  });
});
