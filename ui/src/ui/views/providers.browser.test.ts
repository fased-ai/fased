import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { listProviderBrandManifests } from "../../../../src/providers/registry.ts";
import { renderProviders, type ProvidersProps } from "./providers.ts";

function createProps(overrides: Partial<ProvidersProps> = {}): ProvidersProps {
  return {
    connected: true,
    loading: false,
    error: null,
    formValue: {},
    originalValue: null,
    authStatus: null,
    modelCatalogStatus: null,
    modelCatalog: [],
    configSaving: false,
    configDirty: false,
    authActionBusyProfileId: null,
    authAction: null,
    onRefresh: vi.fn(),
    onOpenConfigSection: vi.fn(),
    onStoreProviderApiKey: vi.fn(),
    onStoreManualProvider: vi.fn(),
    onRunProviderSignIn: vi.fn(),
    onAuthPromptSubmit: vi.fn(),
    onAuthPromptCancel: vi.fn(),
    onAuthActionDismiss: vi.fn(),
    onStoreProfileCredential: vi.fn(),
    onRunInteractiveProfileAuth: vi.fn(),
    onClearProfileCredential: vi.fn(),
    onDefaultModelChange: vi.fn(),
    onSaveConfig: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
}

function getInput(form: HTMLFormElement, name: string): HTMLInputElement {
  const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(input).toBeInstanceOf(HTMLInputElement);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input ${name}`);
  }
  return input;
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

function expectMethodHelp(card: HTMLElement, methodId: string, text: string) {
  const node = card.querySelector<HTMLElement>(`[data-provider-method-help="${methodId}"]`);
  expect(node, methodId).toBeInstanceOf(HTMLElement);
  expect(node!.getAttribute("data-provider-method-help-text")).toContain(text);
  expect(node!.title).toBe("");
}

describe("Providers setup flow", () => {
  it("renders every shared manifest auth method on the matching provider card", () => {
    const container = document.createElement("div");
    render(renderProviders(createProps()), container);
    const manifests = listProviderBrandManifests();

    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-provider-card]")).map(
        (node) => node.getAttribute("data-provider-card") ?? "",
      ),
    ).toEqual(manifests.map((manifest) => manifest.id));

    for (const manifest of manifests) {
      const card = container.querySelector<HTMLElement>(`[data-provider-card="${manifest.id}"]`);
      expect(card, manifest.id).toBeInstanceOf(HTMLElement);
      expect(
        card!.querySelector<HTMLElement>(".providers-provider__name")?.textContent?.trim(),
        manifest.id,
      ).toBe(manifest.label);
      const renderedMethodIds = Array.from(
        card!.querySelectorAll<HTMLElement>("[data-provider-method-id]"),
      )
        .map((node) => node.getAttribute("data-provider-method-id")?.trim() ?? "")
        .filter(Boolean);
      expect(renderedMethodIds, manifest.id).toEqual(manifest.methods.map((method) => method.id));
    }
  });

  it("renders Agent model setup as the last card inside each provider", () => {
    const container = document.createElement("div");
    render(
      renderProviders(
        createProps({
          providerSetupExtra: (provider) => html`
            <div class="providers-setup-card" data-agent-provider-extra=${provider.id}>
              Agent models
            </div>
          `,
        }),
      ),
      container,
    );

    const openaiSetup = container.querySelector<HTMLElement>(
      '[data-provider-card="openai"] .providers-provider__setup',
    );
    expect(openaiSetup).toBeInstanceOf(HTMLElement);
    expect(openaiSetup!.lastElementChild?.getAttribute("data-agent-provider-extra")).toBe("openai");
  });

  it("shows provider model counts inline with provider names", () => {
    const container = document.createElement("div");
    render(renderProviders(createProps()), container);

    const openrouterRow = container.querySelector<HTMLElement>(
      '[data-provider-card="openrouter"] .providers-provider__name-row',
    );
    expect(openrouterRow).toBeInstanceOf(HTMLElement);
    expect(openrouterRow!.textContent?.replace(/\s+/g, " ").trim()).toMatch(
      /^OpenRouter \d+ models?$/,
    );
  });

  it("hides local quick explainer cards when embedded in Agent Models", () => {
    const container = document.createElement("div");
    render(renderProviders(createProps({ surface: "agent" })), container);

    expect(container.querySelector(".providers-local-quick")).toBeNull();
    expect(container.querySelector('[data-provider-card="ollama"]')).toBeInstanceOf(HTMLElement);
  });

  it("submits provider API keys and sign-in requests from /providers", () => {
    const props = createProps({
      modelCatalog: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
      modelCatalogStatus: {
        checkedAtMs: Date.now(),
        cache: { modelCatalog: "runtime", providerExtensionCatalog: "runtime" },
        totalProviders: 2,
        totalModels: 1,
        configuredProviders: 1,
        availableProviders: 0,
        reasoningModels: 1,
        visionModels: 0,
        capabilityCounts: {
          textModels: 1,
          visionModels: 0,
          reasoningModels: 1,
          toolsModels: 0,
          jsonModels: 0,
          audioModels: 0,
        },
        sourceCounts: {},
        providers: [
          {
            provider: "openai",
            configured: true,
            totalModels: 1,
            reasoningModels: 1,
            visionModels: 0,
            sources: ["runtime"],
            sourceConfidence: "runtime",
            capabilityCounts: {
              textModels: 1,
              visionModels: 0,
              reasoningModels: 1,
              toolsModels: 0,
              jsonModels: 0,
              audioModels: 0,
            },
            authModes: ["api-key"],
            privateNetwork: { models: 0, allowed: 0, blocked: 0 },
            probeStatus: "not-run",
          },
          {
            provider: "anthropic",
            configured: true,
            totalModels: 0,
            reasoningModels: 0,
            visionModels: 0,
            sources: ["runtime"],
            sourceConfidence: "runtime",
            capabilityCounts: {
              textModels: 0,
              visionModels: 0,
              reasoningModels: 0,
              toolsModels: 0,
              jsonModels: 0,
              audioModels: 0,
            },
            authModes: ["oauth"],
            privateNetwork: { models: 0, allowed: 0, blocked: 0 },
            probeStatus: "not-run",
          },
        ],
        providerExtensionCatalog: {
          totalEntries: 0,
          loadedEntries: 0,
          skippedUntrustedEntries: 0,
          emptyEntries: 0,
          errorEntries: 0,
          modelCount: 0,
          loadedProviderIds: [],
          warnings: [],
          entries: [],
        },
        providerExtensionManifest: {
          upstreamProviderCount: 0,
          mappedProviderCount: 0,
          deferredProviderCount: 0,
          mappedProviderIds: [],
          deferredProviderIds: [],
          missingMappedProviderIds: [],
        },
      },
    });
    const container = document.createElement("div");
    render(renderProviders(props), container);

    const text = container.textContent ?? "";
    expect(text).not.toContain("Default model");

    const anthropicCard = container.querySelector<HTMLElement>('[data-provider-card="anthropic"]');
    expect(anthropicCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(anthropicCard!, "anthropic-oauth", "Sign in (Claude Code)");
    expectMethodHelp(anthropicCard!, "token", "Token (setup-token)");

    const openaiCard = container.querySelector<HTMLElement>('[data-provider-card="openai"]');
    expect(openaiCard).toBeInstanceOf(HTMLElement);
    const apiKeyForm = openaiCard!.querySelector<HTMLFormElement>(
      'form[data-provider-api-key-form="true"]',
    );
    expect(apiKeyForm).toBeInstanceOf(HTMLFormElement);
    getInput(apiKeyForm!, "secret").value = "sk-test";
    submit(apiKeyForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "openai",
      secret: "sk-test",
    });

    container
      .querySelector<HTMLButtonElement>('[data-provider-sign-in-button="anthropic"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "anthropic",
      profileId: "anthropic:default",
      methodId: "anthropic-oauth",
    });

    container
      .querySelector<HTMLButtonElement>(
        '[data-provider-sign-in-button="anthropic"][data-provider-method-id="token"]',
      )
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "anthropic",
      profileId: "anthropic:default",
      methodId: "token",
    });

    const chutesCard = container.querySelector<HTMLElement>('[data-provider-card="chutes"]');
    expect(chutesCard).toBeInstanceOf(HTMLElement);
    expect(chutesCard!.textContent).toContain("Sign in");
    expect(
      chutesCard!
        .querySelector<HTMLElement>('[data-provider-method-help="chutes"]')
        ?.getAttribute("data-provider-method-help-text"),
    ).toContain("Requires a Chutes OAuth app client id");
    expect(chutesCard!.textContent).toContain("API key");
    const chutesApiKeyForm = chutesCard!.querySelector<HTMLFormElement>(
      'form[data-provider-api-key-form="true"]',
    );
    expect(chutesApiKeyForm).toBeInstanceOf(HTMLFormElement);
    getInput(chutesApiKeyForm!, "secret").value = "cpk-test";
    submit(chutesApiKeyForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "chutes",
      secret: "cpk-test",
    });
    chutesCard!
      .querySelector<HTMLButtonElement>('[data-provider-sign-in-button="chutes"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "chutes",
      profileId: "chutes:default",
      methodId: "chutes",
    });

    const ollamaCard = container.querySelector<HTMLElement>('[data-provider-card="ollama"]');
    expect(ollamaCard).toBeInstanceOf(HTMLElement);
    expect(ollamaCard!.textContent).toContain("Ollama native URL + model");
    const ollamaForm = ollamaCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="ollama"]',
    );
    expect(ollamaForm).toBeInstanceOf(HTMLFormElement);
    getInput(ollamaForm!, "baseUrl").value = "http://127.0.0.1:11434";
    getInput(ollamaForm!, "modelId").value = "llama3.3";
    submit(ollamaForm!);
    expect(props.onStoreManualProvider).toHaveBeenCalledWith({
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      modelId: "llama3.3",
    });

    const lmStudioCard = container.querySelector<HTMLElement>('[data-provider-card="lmstudio"]');
    expect(lmStudioCard).toBeInstanceOf(HTMLElement);
    expect(lmStudioCard!.textContent).toContain("LM Studio URL + model");
    const lmStudioForm = lmStudioCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="lmstudio"]',
    );
    expect(lmStudioForm).toBeInstanceOf(HTMLFormElement);
    getInput(lmStudioForm!, "baseUrl").value = "http://127.0.0.1:1234/v1";
    getInput(lmStudioForm!, "modelId").value = "qwen/qwen3.5-9b";
    getInput(lmStudioForm!, "secret").value = "lm-token";
    submit(lmStudioForm!);
    expect(props.onStoreManualProvider).toHaveBeenCalledWith({
      provider: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "qwen/qwen3.5-9b",
      secret: "lm-token",
    });

    const vllmCard = container.querySelector<HTMLElement>('[data-provider-card="vllm"]');
    expect(vllmCard).toBeInstanceOf(HTMLElement);
    expect(vllmCard!.textContent).toContain("vLLM-compatible URL + model");
    const vllmForm = vllmCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="vllm"]',
    );
    expect(vllmForm).toBeInstanceOf(HTMLFormElement);
    getInput(vllmForm!, "baseUrl").value = "http://127.0.0.1:8000/v1";
    getInput(vllmForm!, "modelId").value = "local-llama";
    getInput(vllmForm!, "secret").value = "local-key";
    submit(vllmForm!);
    expect(props.onStoreManualProvider).toHaveBeenCalledWith({
      provider: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-llama",
      secret: "local-key",
    });

    const customCard = container.querySelector<HTMLElement>('[data-provider-card="custom"]');
    expect(customCard).toBeInstanceOf(HTMLElement);
    const customForm = customCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="custom-api-key"]',
    );
    expect(customForm).toBeInstanceOf(HTMLFormElement);
    getInput(customForm!, "baseUrl").value = "http://127.0.0.1:8080/v1";
    getInput(customForm!, "modelId").value = "local-frontier";
    getInput(customForm!, "customProviderId").value = "local-openai";
    getInput(customForm!, "alias").value = "local";
    getInput(customForm!, "secret").value = "custom-key";
    const customCompatibility = customForm!.querySelector<HTMLSelectElement>(
      'select[name="compatibility"]',
    );
    expect(customCompatibility).toBeInstanceOf(HTMLSelectElement);
    expect(Array.from(customCompatibility!.options).map((option) => option.value)).toEqual([
      "openai",
      "anthropic",
      "unknown",
    ]);
    customCompatibility!.value = "unknown";
    const allowPrivateNetwork = customForm!.querySelector<HTMLInputElement>(
      'input[name="allowPrivateNetwork"]',
    );
    expect(allowPrivateNetwork).toBeInstanceOf(HTMLInputElement);
    allowPrivateNetwork!.checked = true;
    submit(customForm!);
    expect(props.onStoreManualProvider).toHaveBeenLastCalledWith({
      provider: "custom",
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: "local-frontier",
      compatibility: "unknown",
      customProviderId: "local-openai",
      alias: "local",
      secret: "custom-key",
      allowPrivateNetwork: true,
    });

    const minimaxCard = container.querySelector<HTMLElement>('[data-provider-card="minimax"]');
    expect(minimaxCard).toBeInstanceOf(HTMLElement);
    expect(minimaxCard!.textContent).toContain("Sign in");
    expect(minimaxCard!.textContent).toContain("Requires MiniMax portal/coding-plan access");
    expect(minimaxCard!.textContent).toContain("API key");
    expectMethodHelp(minimaxCard!, "minimax-api-key-cn", "API key (CN)");
    expectMethodHelp(minimaxCard!, "minimax-api-lightning", "Highspeed API key");
    minimaxCard!
      .querySelector<HTMLButtonElement>('[data-provider-sign-in-button="minimax-portal"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "minimax-portal",
      profileId: "minimax-portal:default",
      methodId: "minimax-portal",
    });
    const minimaxApiForm = minimaxCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="minimax-api"]',
    );
    expect(minimaxApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(minimaxApiForm!, "secret").value = "mm-api";
    submit(minimaxApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "minimax",
      secret: "mm-api",
    });
    const minimaxCnForm = minimaxCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="minimax-api-key-cn"]',
    );
    expect(minimaxCnForm).toBeInstanceOf(HTMLFormElement);
    getInput(minimaxCnForm!, "secret").value = "mm-cn";
    submit(minimaxCnForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "minimax-cn",
      secret: "mm-cn",
    });
    const minimaxHighspeedForm = minimaxCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="minimax-api-lightning"]',
    );
    expect(minimaxHighspeedForm).toBeInstanceOf(HTMLFormElement);
    getInput(minimaxHighspeedForm!, "secret").value = "mm-highspeed";
    submit(minimaxHighspeedForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "minimax-lightning",
      secret: "mm-highspeed",
    });

    const moonshotCard = container.querySelector<HTMLElement>('[data-provider-card="moonshot"]');
    expect(moonshotCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(moonshotCard!, "moonshot-api-key", "Kimi API key (.ai)");
    expectMethodHelp(moonshotCard!, "moonshot-api-key-cn", "Kimi API key (.cn)");
    expectMethodHelp(moonshotCard!, "kimi-code-api-key", "Kimi Code API key (subscription)");
    const moonshotAiForm = moonshotCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="moonshot-api-key"]',
    );
    expect(moonshotAiForm).toBeInstanceOf(HTMLFormElement);
    getInput(moonshotAiForm!, "secret").value = "kimi-ai";
    submit(moonshotAiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "moonshot",
      secret: "kimi-ai",
    });
    const moonshotCnForm = moonshotCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="moonshot-api-key-cn"]',
    );
    expect(moonshotCnForm).toBeInstanceOf(HTMLFormElement);
    getInput(moonshotCnForm!, "secret").value = "kimi-cn";
    submit(moonshotCnForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "moonshot-cn",
      secret: "kimi-cn",
    });
    const kimiCodeForm = moonshotCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="kimi-code-api-key"]',
    );
    expect(kimiCodeForm).toBeInstanceOf(HTMLFormElement);
    getInput(kimiCodeForm!, "secret").value = "kimi-code";
    submit(kimiCodeForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "kimi-coding",
      secret: "kimi-code",
    });

    const googleCard = container.querySelector<HTMLElement>('[data-provider-card="google"]');
    expect(googleCard).toBeInstanceOf(HTMLElement);
    expect(googleCard!.textContent).toContain("API key");
    expect(googleCard!.textContent).toContain("Sign in");
    expect(googleCard!.textContent).toContain("Requires gemini-cli installed");
    expectMethodHelp(googleCard!, "gemini-api-key", "Gemini API key");
    expectMethodHelp(googleCard!, "google-gemini-cli", "Sign in (Gemini CLI)");
    expect(googleCard!.textContent).toContain("14 models");
    const googleApiForm = googleCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="gemini-api-key"]',
    );
    expect(googleApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(googleApiForm!, "secret").value = "gemini-key";
    submit(googleApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "google",
      secret: "gemini-key",
    });
    googleCard!
      .querySelector<HTMLButtonElement>('[data-provider-sign-in-button="google-gemini-cli"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "google-gemini-cli",
      profileId: "google-gemini-cli:default",
      methodId: "google-gemini-cli",
    });

    const xaiCard = container.querySelector<HTMLElement>('[data-provider-card="xai"]');
    expect(xaiCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(xaiCard!, "xai-oauth", "xAI sign-in");
    expectMethodHelp(xaiCard!, "xai-device-code", "xAI device code");
    expectMethodHelp(xaiCard!, "xai-api-key", "xAI API key");
    expect(xaiCard!.textContent).toContain("4 models");
    xaiCard!.querySelector<HTMLButtonElement>('[data-provider-method-id="xai-oauth"]')?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "xai",
      profileId: "xai:default",
      methodId: "xai-oauth",
    });
    xaiCard!
      .querySelector<HTMLButtonElement>('[data-provider-method-id="xai-device-code"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "xai",
      profileId: "xai:default",
      methodId: "xai-device-code",
    });
    const xaiApiForm = xaiCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="xai-api-key"]',
    );
    expect(xaiApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(xaiApiForm!, "secret").value = "xai-key";
    submit(xaiApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "xai",
      secret: "xai-key",
    });

    const mistralCard = container.querySelector<HTMLElement>('[data-provider-card="mistral"]');
    expect(mistralCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(mistralCard!, "mistral-api-key", "Mistral API key");
    expect(mistralCard!.textContent).toContain("10 models");
    const mistralApiForm = mistralCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="mistral-api-key"]',
    );
    expect(mistralApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(mistralApiForm!, "secret").value = "mistral-key";
    submit(mistralApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "mistral",
      secret: "mistral-key",
    });

    const volcengineCard = container.querySelector<HTMLElement>(
      '[data-provider-card="volcengine"]',
    );
    expect(volcengineCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(volcengineCard!, "volcengine-api-key", "Volcano Engine API key");
    expect(volcengineCard!.textContent).toContain("24 models");
    const volcengineApiForm = volcengineCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="volcengine-api-key"]',
    );
    expect(volcengineApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(volcengineApiForm!, "secret").value = "volcengine-key";
    submit(volcengineApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "volcengine",
      secret: "volcengine-key",
    });

    const byteplusCard = container.querySelector<HTMLElement>('[data-provider-card="byteplus"]');
    expect(byteplusCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(byteplusCard!, "byteplus-api-key", "BytePlus API key");
    expect(byteplusCard!.textContent).toContain("24 models");
    const byteplusApiForm = byteplusCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="byteplus-api-key"]',
    );
    expect(byteplusApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(byteplusApiForm!, "secret").value = "byteplus-key";
    submit(byteplusApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "byteplus",
      secret: "byteplus-key",
    });

    const openrouterCard = container.querySelector<HTMLElement>(
      '[data-provider-card="openrouter"]',
    );
    expect(openrouterCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(openrouterCard!, "openrouter-api-key", "OpenRouter API key");
    expect(openrouterCard!.textContent).toContain("25 models");
    const openrouterApiForm = openrouterCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="openrouter-api-key"]',
    );
    expect(openrouterApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(openrouterApiForm!, "secret").value = "openrouter-key";
    submit(openrouterApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "openrouter",
      secret: "openrouter-key",
    });

    const qwenCard = container.querySelector<HTMLElement>('[data-provider-card="qwen"]');
    expect(qwenCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(qwenCard!, "qwen-coding-plan-api-key", "Coding Plan API key");
    expectMethodHelp(qwenCard!, "qwen-api-key", "DashScope API key");
    expect(qwenCard!.querySelector('[data-provider-method-id="qwen-portal"]')).toBeNull();
    expect(qwenCard!.textContent).toContain("17 models");
    const qwenCodingPlanForm = qwenCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="qwen-coding-plan-api-key"]',
    );
    expect(qwenCodingPlanForm).toBeInstanceOf(HTMLFormElement);
    getInput(qwenCodingPlanForm!, "secret").value = "qwen-plan-key";
    submit(qwenCodingPlanForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "qwen-coding-plan",
      secret: "qwen-plan-key",
    });
    const qwenApiForm = qwenCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="qwen-api-key"]',
    );
    expect(qwenApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(qwenApiForm!, "secret").value = "qwen-api-key";
    submit(qwenApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "qwen",
      secret: "qwen-api-key",
    });
    const qianfanCard = container.querySelector<HTMLElement>('[data-provider-card="qianfan"]');
    expect(qianfanCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(qianfanCard!, "qianfan-api-key", "Qianfan API key");
    expect(qianfanCard!.textContent).toContain("11 models");
    const qianfanApiForm = qianfanCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="qianfan-api-key"]',
    );
    expect(qianfanApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(qianfanApiForm!, "secret").value = "qianfan-key";
    submit(qianfanApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "qianfan",
      secret: "qianfan-key",
    });

    const copilotCard = container.querySelector<HTMLElement>('[data-provider-card="copilot"]');
    expect(copilotCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(copilotCard!, "github-copilot", "GitHub sign in");
    expectMethodHelp(copilotCard!, "copilot-proxy", "Proxy sign in");
    expect(copilotCard!.textContent).toContain("42 models");
    copilotCard!
      .querySelector<HTMLButtonElement>('[data-provider-sign-in-button="github-copilot"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "github-copilot",
      profileId: "github-copilot:default",
      methodId: "github-copilot",
    });
    copilotCard!
      .querySelector<HTMLButtonElement>('[data-provider-sign-in-button="copilot-proxy"]')
      ?.click();
    expect(props.onRunProviderSignIn).toHaveBeenCalledWith({
      provider: "copilot-proxy",
      profileId: "copilot-proxy:default",
      methodId: "copilot-proxy",
    });

    const vercelCard = container.querySelector<HTMLElement>('[data-provider-card="ai-gateway"]');
    expect(vercelCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(vercelCard!, "ai-gateway-api-key", "Vercel AI API key");
    expect(vercelCard!.textContent).toContain("26 models");
    const vercelApiForm = vercelCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="ai-gateway-api-key"]',
    );
    expect(vercelApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(vercelApiForm!, "secret").value = "vercel-gateway-key";
    submit(vercelApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "vercel-ai-gateway",
      secret: "vercel-gateway-key",
    });

    const opencodeCard = container.querySelector<HTMLElement>(
      '[data-provider-card="opencode-zen"]',
    );
    expect(opencodeCard).toBeInstanceOf(HTMLElement);
    expectMethodHelp(opencodeCard!, "opencode-zen", "OpenCode Zen API key");
    expect(opencodeCard!.textContent).toContain("22 models");
    const opencodeApiForm = opencodeCard!.querySelector<HTMLFormElement>(
      'form[data-provider-method-id="opencode-zen"]',
    );
    expect(opencodeApiForm).toBeInstanceOf(HTMLFormElement);
    getInput(opencodeApiForm!, "secret").value = "opencode-zen-key";
    submit(opencodeApiForm!);
    expect(props.onStoreProviderApiKey).toHaveBeenCalledWith({
      provider: "opencode",
      secret: "opencode-zen-key",
    });

    expect(
      openaiCard!.querySelector<HTMLFormElement>('form[data-provider-default-model-form="true"]'),
    ).toBeNull();
  });

  it("enables only the auth methods that match the provider route", () => {
    const props = createProps({
      modelCatalogStatus: {
        checkedAtMs: Date.now(),
        cache: { modelCatalog: "runtime", providerExtensionCatalog: "runtime" },
        totalProviders: 2,
        totalModels: 2,
        configuredProviders: 2,
        availableProviders: 0,
        reasoningModels: 2,
        visionModels: 0,
        capabilityCounts: {
          textModels: 2,
          visionModels: 0,
          reasoningModels: 2,
          toolsModels: 0,
          jsonModels: 0,
          audioModels: 0,
        },
        sourceCounts: {},
        providers: [
          {
            provider: "openai",
            configured: true,
            totalModels: 1,
            reasoningModels: 1,
            visionModels: 0,
            sources: ["runtime"],
            sourceConfidence: "runtime",
            capabilityCounts: {
              textModels: 1,
              visionModels: 0,
              reasoningModels: 1,
              toolsModels: 0,
              jsonModels: 0,
              audioModels: 0,
            },
            authModes: ["api-key"],
            privateNetwork: { models: 0, allowed: 0, blocked: 0 },
            probeStatus: "not-run",
          },
          {
            provider: "openai-codex",
            configured: true,
            totalModels: 1,
            reasoningModels: 1,
            visionModels: 0,
            sources: ["runtime"],
            sourceConfidence: "runtime",
            capabilityCounts: {
              textModels: 1,
              visionModels: 0,
              reasoningModels: 1,
              toolsModels: 0,
              jsonModels: 0,
              audioModels: 0,
            },
            authModes: ["api-key"],
            privateNetwork: { models: 0, allowed: 0, blocked: 0 },
            probeStatus: "not-run",
          },
        ],
        providerExtensionCatalog: {
          totalEntries: 0,
          loadedEntries: 0,
          skippedUntrustedEntries: 0,
          emptyEntries: 0,
          errorEntries: 0,
          modelCount: 0,
          loadedProviderIds: [],
          warnings: [],
          entries: [],
        },
        providerExtensionManifest: {
          upstreamProviderCount: 0,
          mappedProviderCount: 0,
          deferredProviderCount: 0,
          mappedProviderIds: [],
          deferredProviderIds: [],
          missingMappedProviderIds: [],
        },
      },
    });
    const container = document.createElement("div");
    render(renderProviders(props), container);

    const openaiCard = container.querySelector<HTMLElement>('[data-provider-card="openai"]');
    expect(openaiCard).toBeInstanceOf(HTMLElement);
    expect(openaiCard!.textContent).toContain("Sign in");
    expect(openaiCard!.textContent).toContain("API key");
    expect(container.textContent).toContain("Cloudflare AI");
    expect(openaiCard!.querySelector<HTMLInputElement>('input[name="secret"]')?.disabled).toBe(
      false,
    );
    expect(
      openaiCard!.querySelector<HTMLButtonElement>('[data-provider-sign-in-button="openai-codex"]')
        ?.disabled,
    ).toBe(false);
    expect(container.querySelector('[data-provider-card="openai-codex"]')).toBeNull();
  });

  it("keeps global default model controls out of provider rows", () => {
    const props = createProps({
      modelCatalog: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.1", name: "GPT-5.1", provider: "openai" },
      ],
    });
    const container = document.createElement("div");
    render(renderProviders(props), container);

    const openaiCard = container.querySelector<HTMLElement>('[data-provider-card="openai"]');
    expect(openaiCard).toBeInstanceOf(HTMLElement);
    expect(
      openaiCard!.querySelector<HTMLFormElement>('form[data-provider-default-model-form="true"]'),
    ).toBeNull();
    expect(props.onDefaultModelChange).not.toHaveBeenCalled();
    expect(props.onSaveConfig).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Use in Chat");
    expect(container.textContent).not.toContain("Attach in Agents");
  });

  it("keeps long OAuth URLs behind copy/open controls in the sign-in modal", () => {
    const signInUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEE773fCkXaXp7hran&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Foauth%2Fcallback&scope=openid+profile+email+offline_access";
    const props = createProps({
      authAction: {
        profileId: "openai-codex:default",
        provider: "openai-codex",
        actionKind: "interactive",
        tone: "info",
        title: "Continue sign-in",
        message: "Open the sign-in link, then return here.",
        active: true,
        hasUrl: true,
        url: signInUrl,
      },
    });
    const container = document.createElement("div");
    render(renderProviders(props), container);

    expect(container.textContent).toContain("auth.openai.com/oauth/authorize");
    expect(container.textContent).toContain("full URL hidden");
    expect(container.textContent).not.toContain("response_type=code");
    expect(container.textContent).not.toContain("client_id=app_EMoamEE773fCkXaXp7hran");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Copy sign-in link"]'),
    ).toBeInstanceOf(HTMLButtonElement);
    const openLink = container.querySelector<HTMLAnchorElement>('[aria-label="Open sign-in link"]');
    expect(openLink).toBeInstanceOf(HTMLAnchorElement);
    expect(openLink?.href).toBe(signInUrl);

    container.querySelector<HTMLButtonElement>(".providers-auth-dialog__head button")?.click();
    expect(props.onAuthActionDismiss).toHaveBeenCalledTimes(1);
  });
});
