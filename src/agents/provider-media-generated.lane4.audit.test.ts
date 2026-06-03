import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MODEL_PROVIDER_CATALOG,
  listCurrentModelCatalogRows,
} from "./current-model-catalog.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import {
  classifyFailoverReason,
  isContextOverflowError,
  isTransientHttpError,
} from "./pi-embedded-helpers/errors.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function pathExists(relativePath: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(repoRoot, relativePath)).catch(() => null));
}

describe("Lane 4 provider/media/generated-files audit", () => {
  it("maps adopted xAI responses reasoning policy", async () => {
    const policySource = await readSource("src/agents/openai-responses-payload-policy.ts");
    const transportSource = await readSource("src/agents/openai-transport-stream.ts");

    expect(policySource).toContain("shouldStripDisabledReasoningPayload");
    expect(policySource).toContain("shouldStripAllOpenAIResponsesReasoningPayload");
    expect(policySource).toContain("shouldStripReasoningPayload");
    expect(transportSource).toContain("resolveOpenAIResponsesPayloadPolicy");

    const payload = {
      reasoning: {
        effort: "high",
        summary: "auto",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "xai",
          id: "grok-4.1-fast",
          baseUrl: "https://api.x.ai/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      store: false,
    });
  });

  it("maps current xAI system-role routing and provider config shape explicitly", async () => {
    const transportTestSource = await readSource("src/agents/openai-transport-stream.test.ts");

    expect(transportTestSource).toContain(
      "uses system role instead of developer for responses providers that disable developer role",
    );
    expect(transportTestSource).toContain('id: "grok-4.1-fast"');
    expect(transportTestSource).toContain('provider: "xai"');
    expect(transportTestSource).toContain('baseUrl: "https://api.x.ai/v1"');
    expect(transportTestSource).toContain("expect(params.input?.[0]).toMatchObject");
    expect(transportTestSource).not.toContain('id: "grok-4.3"');
  });

  it("classifies wrapped provider HTTP 5xx errors as retryable server drift", () => {
    expect(isTransientHttpError("HTTP 500 upstream server exploded")).toBe(true);
    expect(classifyFailoverReason("HTTP 500 upstream server exploded")).toBe("timeout");

    expect(isTransientHttpError("provider failed (HTTP 500): upstream apiKey is empty")).toBe(true);
    expect(classifyFailoverReason("provider failed (HTTP 500): upstream apiKey is empty")).toBe(
      "timeout",
    );

    expect(classifyFailoverReason("provider failed (HTTP 500): invalid api key")).toBe("auth");
    expect(classifyFailoverReason("provider failed (HTTP 500): payment required")).toBe("billing");
    expect(classifyFailoverReason("provider failed (HTTP 503): rate limit exceeded")).toBe(
      "rate_limit",
    );

    const overflow = "provider failed (HTTP 500): context length exceeded";
    expect(isTransientHttpError(overflow)).toBe(false);
    expect(isContextOverflowError(overflow)).toBe(true);
  });

  it("strips xAI responses reasoning payloads after Fased provider policy review", () => {
    const payload = {
      reasoning: {
        effort: "high",
        summary: "auto",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "xai",
          id: "grok-4.1-fast",
          baseUrl: "https://api.x.ai/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).not.toHaveProperty("reasoning");
    expect((payload as Record<string, unknown>).store).toBe(false);
  });

  it("keeps wrapped provider HTTP 4xx errors out of retryable server drift", () => {
    expect(isTransientHttpError("provider failed (HTTP 404): model not found")).toBe(false);
    expect(classifyFailoverReason("provider failed (HTTP 404): model not found")).toBe(
      "model_not_found",
    );
  });

  it("maps Fireworks provider metadata through Fased current catalog only", async () => {
    expect(await pathExists("extensions/fireworks/thinking-policy.ts")).toBe(false);
    expect(await pathExists("extensions/fireworks/provider-policy-api.ts")).toBe(false);
    expect(await pathExists("extensions/fireworks/fased.plugin.json")).toBe(false);

    const catalogSource = await readSource("src/agents/current-model-catalog.ts");
    expect(catalogSource).toContain("const FIREWORKS_MODELS");

    const provider = CURRENT_MODEL_PROVIDER_CATALOG.fireworks;
    expect(provider).toMatchObject({
      baseUrl: "https://api.fireworks.ai/inference/v1",
      api: "openai-completions",
    });

    const kimi26 = provider.models.find(
      (model) => model.id === "accounts/fireworks/models/kimi-k2p6",
    );
    expect(kimi26).toMatchObject({
      name: "Kimi K2.6",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 262_144,
      cost: { input: 0.95, output: 4, cacheRead: 0, cacheWrite: 0 },
    });

    const kimi25 = provider.models.find(
      (model) => model.id === "accounts/fireworks/routers/kimi-k2p5-turbo",
    );
    expect(kimi25).toMatchObject({
      name: "Kimi K2.5 Turbo",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 256_000,
      maxTokens: 256_000,
    });
  });

  it("keeps Fireworks rows in current-preview model catalog semantics", () => {
    const rows = listCurrentModelCatalogRows().filter((row) => row.provider === "fireworks");

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "accounts/fireworks/models/kimi-k2p6",
          name: "Kimi K2.6",
          provider: "fireworks",
          source: "current-preview",
          status: "preview",
          input: ["text", "image"],
          contextWindow: 262_144,
          maxTokens: 262_144,
          reasoning: false,
          baseUrl: "https://api.fireworks.ai/inference/v1",
          api: "openai-completions",
        }),
        expect.objectContaining({
          id: "accounts/fireworks/routers/kimi-k2p5-turbo",
          name: "Kimi K2.5 Turbo",
          provider: "fireworks",
          source: "current-preview",
          status: "preview",
          input: ["text", "image"],
          contextWindow: 256_000,
          maxTokens: 256_000,
          reasoning: false,
          baseUrl: "https://api.fireworks.ai/inference/v1",
          api: "openai-completions",
        }),
      ]),
    );
  });

  it.skip("adds Fireworks Kimi payload reasoning stripping only after Fased provider hook review", () => {});

  it("maps video-generation fallback params against Fased plugin-backed runtime", async () => {
    expect(await pathExists("src/agents/tools/video-generate-tool.ts")).toBe(false);
    expect(await pathExists("src/video-generation/normalization.ts")).toBe(false);
    expect(await pathExists("extensions/google/video-generation-provider.ts")).toBe(false);
    expect(await pathExists("extensions/google/generation-provider-metadata.ts")).toBe(false);
    expect(await pathExists("extensions/minimax/video-generation-provider.ts")).toBe(false);

    const compatToolsSource = await readSource("src/agents/fased-tools.compat.ts");
    expect(compatToolsSource).toContain('name: "video_generate"');
    expect(compatToolsSource).toContain('status: "unsupported"');
    expect(compatToolsSource).toContain("shouldRegisterVideoGenerateTool");

    const registrySource = await readSource("src/video-generation/provider-registry.ts");
    expect(registrySource).toContain(
      "const BUILTIN_VIDEO_GENERATION_PROVIDERS: readonly VideoGenerationProviderPlugin[] = []",
    );
    expect(registrySource).toContain('key: "videoGenerationProviders"');

    const runtimeSource = await readSource("src/video-generation/runtime.ts");
    expect(runtimeSource).toContain("resolveProviderVideoGenerationOverrides");
    expect(runtimeSource).toContain('ignoredOverrides.push({ key: "resolution"');
    expect(runtimeSource).not.toContain("resolveClosestResolution");
    expect(runtimeSource).not.toContain("requestedResolution");
    expect(runtimeSource).not.toContain("normalizedResolution");

    const typesSource = await readSource("src/video-generation/types.ts");
    expect(typesSource).toContain(
      'export type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";',
    );
    expect(typesSource).not.toContain("string & {}");

    const dashscopeSource = await readSource("src/video-generation/dashscope-compatible.ts");
    expect(dashscopeSource).toContain('"720P": "1280*720"');
    expect(dashscopeSource).toContain("req.resolution ? resolutionToSize[req.resolution]");
  });

  it.skip("normalizes video resolutions to provider-supported values after Fased plugin-provider review", () => {});

  it.skip("ignores unparseable video resolution hints before plugin-provider dispatch", () => {});

  it.skip("keeps Google video audio disabled only if a Fased Google video provider is approved", () => {});

  it("maps generated media fallback suppression against Fased delivery surfaces", async () => {
    expect(await pathExists("src/agents/subagent-announce-delivery.ts")).toBe(false);

    const dispatchSource = await readSource("src/agents/subagent-announce-dispatch.ts");
    expect(dispatchSource).toContain(
      'export type SubagentDeliveryPath = "queued" | "steered" | "direct" | "none"',
    );
    expect(dispatchSource).toContain(
      'export type SubagentAnnounceDispatchPhase = "queue-primary" | "direct-primary" | "queue-fallback"',
    );
    expect(dispatchSource).toContain("if (primaryDirect.delivered)");
    expect(dispatchSource).toContain('appendPhase("queue-fallback", fallbackQueue)');
    expect(dispatchSource).not.toContain("direct-fallback");
    expect(dispatchSource).not.toContain("isGatewayAgentRunPending");
    expect(dispatchSource).not.toContain("hasGatewayAgentMessagingToolDelivery");

    const announceSource = await readSource("src/agents/subagent-announce.ts");
    expect(announceSource).toContain("runSubagentAnnounceDispatch");
    expect(announceSource).toContain("buildCompletionDeliveryMessage");
    expect(announceSource).toContain("completionRouteMode");
    expect(announceSource).toContain("delivery.delivered");
    expect(announceSource).not.toContain("sendCompletionFallback");
    expect(announceSource).not.toContain("extractThreadCompletionFallbackText");

    const messagingSource = await readSource("src/agents/pi-embedded-messaging.ts");
    expect(messagingSource).toContain(
      'const CORE_MESSAGING_TOOLS = new Set(["sessions_send", "message"])',
    );
    expect(messagingSource).toContain('return action === "send" || action === "thread-reply"');
    expect(messagingSource).not.toContain("isMessageToolSendActionName");
    expect(messagingSource).not.toContain("upload-file");
    expect(messagingSource).not.toContain("sendAttachment");

    const subscribeToolsSource = await readSource("src/agents/pi-embedded-subscribe.tools.ts");
    expect(subscribeToolsSource).toContain("export function extractMessagingToolSend");
    expect(subscribeToolsSource).toContain('if (action !== "send" && action !== "thread-reply")');
    expect(subscribeToolsSource).toContain("normalizeTargetForProvider(provider, toRaw)");
    expect(subscribeToolsSource).not.toContain("isMessageToolSendActionName");
    expect(subscribeToolsSource).not.toContain("sendAttachment");

    const handlerTestSource = await readSource(
      "src/agents/pi-embedded-subscribe.handlers.tools.test.ts",
    );
    expect(handlerTestSource).toContain("tracks media arg from messaging tool as pending");
    expect(handlerTestSource).toContain("commits pending media URL on tool success");
    expect(handlerTestSource).toContain("discards pending media URL on tool error");
  });

  it.skip("suppresses generated media completion fallback while direct announce is pending", () => {});

  it.skip("uses generated media completion fallback only when message-tool delivery lacks evidence", () => {});

  it.skip("recognizes attachment-style message sends as generated media delivery evidence", () => {});

  it("maps Codex generated image media staging against Fased media access policy", async () => {
    expect(await pathExists("src/gateway/server-methods/chat-reply-media.ts")).toBe(false);

    const chatSource = await readSource("src/gateway/server-methods/chat.ts");
    expect(chatSource).toContain("parseMessageWithAttachments");
    expect(chatSource).toContain("images: parsedImages.length > 0 ? parsedImages : undefined");
    expect(chatSource).toContain('const text = payload.text?.trim() ?? ""');
    expect(chatSource).toContain("finalReplyParts.push(text)");
    expect(chatSource).toContain("broadcastChatFinal");
    expect(chatSource).not.toContain("normalizeWebchatReplyMediaPathsForDisplay");
    expect(chatSource).not.toContain("createManagedOutgoingImageBlocks");
    expect(chatSource).not.toContain("deliveredReplies");
    expect(chatSource).not.toContain("appendedWebchatAgentMedia");

    const mediaRootsSource = await readSource("src/media/local-roots.ts");
    expect(mediaRootsSource).toContain("resolvePreferredFasedAgentTmpDir");
    expect(mediaRootsSource).toContain('path.join(resolvedStateDir, "media")');
    expect(mediaRootsSource).toContain('path.join(resolvedStateDir, "agents")');
    expect(mediaRootsSource).toContain('path.join(resolvedStateDir, "workspace")');
    expect(mediaRootsSource).toContain('path.join(resolvedStateDir, "sandboxes")');
    expect(mediaRootsSource).toContain("resolveAgentWorkspaceDir");
    expect(mediaRootsSource).not.toContain("codex-home");

    const attachmentsSource = await readSource("src/media-understanding/attachments.ts");
    expect(attachmentsSource).toContain("DEFAULT_LOCAL_PATH_ROOTS");
    expect(attachmentsSource).toContain("getDefaultMediaLocalRoots()");
    expect(attachmentsSource).toContain("isInboundPathAllowed");
    expect(attachmentsSource).toContain("canonicalized attachment path outside allowed roots");
    expect(attachmentsSource).not.toContain("normalizeWebchatReplyMediaPathsForDisplay");

    const sandboxStagingSource = await readSource("src/auto-reply/reply/stage-sandbox-media.ts");
    expect(sandboxStagingSource).toContain("Local paths must be restricted to the media directory");
    expect(sandboxStagingSource).toContain("getMediaDir()");
    expect(sandboxStagingSource).toContain("assertSandboxPath");
    expect(sandboxStagingSource).not.toContain("codex-home");

    const defaultsSource = await readSource("src/media-understanding/defaults.ts");
    const imageProvidersBlock =
      defaultsSource.match(
        /export const AUTO_IMAGE_KEY_PROVIDERS = \[([\s\S]*?)\] as const;/,
      )?.[1] ?? "";
    const audioProvidersBlock =
      defaultsSource.match(
        /export const AUTO_AUDIO_KEY_PROVIDERS = \[([\s\S]*?)\] as const;/,
      )?.[1] ?? "";
    expect(audioProvidersBlock).toContain('"openai-codex"');
    expect(imageProvidersBlock).not.toContain('"openai-codex"');

    const replyPayloadSource = await readSource("src/auto-reply/types.ts");
    expect(replyPayloadSource).toContain("mediaUrl?: string");
    expect(replyPayloadSource).toContain("mediaUrls?: string[]");
    expect(replyPayloadSource).not.toContain("sensitiveMedia");

    const pluginPayloadSource = await readSource("src/plugin-sdk/reply-payload.ts");
    expect(pluginPayloadSource).toContain("resolveOutboundMediaUrls");
    expect(pluginPayloadSource).not.toContain("sensitiveMedia");
  });

  it.skip("stages Fased-approved Codex-home generated images before WebChat display", () => {});

  it.skip("does not stage sensitive generated media before display suppression", () => {});

  it.skip("preserves inline data image replies while staging mixed local generated images", () => {});

  it.skip("suppresses mixed-media warnings when an inline generated image remains visible", () => {});
});
