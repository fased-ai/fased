import { describe, expect, it, vi } from "vitest";
import {
  renderChatComposerControls,
  resolveChatThinkingSelectState,
} from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  createModelCatalog,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../chat-model.test-helpers.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";
import { buildCommandRouteDraft, renderChat, type ChatProps } from "./chat.ts";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  });
  vi.stubGlobal("navigator", { language: "en-US" });
});

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      return [
        ...Array.from(template.strings),
        ...template.values.map((entry) => flattenTemplateText(entry)),
      ].join(" ");
    }
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: 200_000 },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          modelProvider: "openai",
          model: "gpt-5",
          thinkingLevel: "medium",
        },
      ],
    },
    focusMode: false,
    assistantName: "Fased",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    ...overrides,
  };
}

function createComposerState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    models?: ModelCatalogEntry[];
  } = {},
): AppViewState {
  const model = overrides.model ?? "gpt-5.5";
  const modelProvider = overrides.modelProvider ?? "openai";
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const request = vi.fn(async () => ({ ok: true }));
  return {
    sessionKey: "main",
    connected: true,
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider, model, contextTokens: 200_000 },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          modelProvider,
          model,
        },
      ],
    },
    chatModelCatalog: catalog,
    chatModelOverrides: {},
    chatModelPatchPending: null,
    chatModelPatchInFlight: false,
    chatModelPatchSessionKey: null,
    chatModelPatchLabel: null,
    chatModelsLoading: false,
    chatLoading: false,
    chatSending: false,
    chatRunId: null,
    chatStream: null,
    client: { request } as unknown as GatewayBrowserClient,
    configAuthStatus: null,
    configModelCatalogStatus: null,
  } as unknown as AppViewState;
}

describe("chat terminal controls", () => {
  it("keeps command routes out of the toolbar and renders icon-only upload affordance", () => {
    const text = flattenTemplateText(renderChat(createProps({ thinkingLevel: "medium" })));

    expect(text).not.toContain("@wallet");
    expect(text).not.toContain("@trade");
    expect(text).not.toContain("@offers");
    expect(text).not.toContain("@mining");
    expect(text).toContain("Attach image");
    expect(text).not.toContain("Upload");
  });

  it("builds deterministic command-route drafts without changing routing behavior", () => {
    expect(buildCommandRouteDraft("@wallet", "balance")).toBe("@wallet balance");
    expect(buildCommandRouteDraft("@trade", "  swap SOL USDC")).toBe("@trade swap SOL USDC");
    expect(buildCommandRouteDraft("@mining", "@mining status")).toBe("@mining status");
    expect(buildCommandRouteDraft("@offers", "")).toBe("@offers ");
  });

  it("renders supported OpenAI thinking levels from model metadata", () => {
    const state = createComposerState({
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    const text = flattenTemplateText(renderChatComposerControls(state));
    const thinking = resolveChatThinkingSelectState(state);

    expect(text).toContain("Capabilities");
    expect(thinking.defaultLabel).toBe("Default (low)");
    expect(thinking.options.map((entry) => entry.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("hides thinking controls for non-reasoning chat models", () => {
    const text = flattenTemplateText(
      renderChatComposerControls(
        createComposerState({
          model: "deepseek-chat",
          modelProvider: "deepseek",
          models: createModelCatalog(DEEPSEEK_CHAT_MODEL),
        }),
      ),
    );

    expect(text).not.toContain("Capabilities");
    expect(text).not.toContain("Default (low)");
  });

  it("renders binary thinking labels for Z.AI models", () => {
    const state = createComposerState({
      model: "glm-5.1",
      modelProvider: "zai",
      models: createModelCatalog({
        id: "glm-5.1",
        name: "GLM-5.1",
        provider: "zai",
        reasoning: true,
        metadata: {
          provider: "zai",
          model: "glm-5.1",
          label: "GLM-5.1",
          features: ["text", "reasoning"],
          thinkingLevels: ["off", "low"],
          defaultThinkingLevel: "low",
          thinkingMode: "zai-binary",
          authMode: "api-key",
          privateNetwork: false,
          privateNetworkAllowed: false,
          streaming: true,
          capabilityConfidence: "declared",
        },
      }),
    });
    const text = flattenTemplateText(renderChatComposerControls(state));
    const thinking = resolveChatThinkingSelectState(state);

    expect(text).toContain("Capabilities");
    expect(thinking.defaultLabel).toBe("Default (low)");
    expect(thinking.options).toEqual([
      { value: "off", label: "Off" },
      { value: "low", label: "On" },
    ]);
  });
});
