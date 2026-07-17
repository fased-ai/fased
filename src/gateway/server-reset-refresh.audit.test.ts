import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(gatewayDir, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), "utf8");
}

function sourceExists(relativePath: string): boolean {
  return existsSync(join(srcDir, relativePath));
}

describe("gateway reset/refresh responsiveness audit", () => {
  it("maps upstream session-memory reset hot-path changes to current Fased hook shape", () => {
    const handler = readSource("hooks/bundled/session-memory/handler.ts");

    expect(handler).toContain("const pendingSessionMemoryWrites = new Set<Promise<void>>()");
    expect(handler).toContain("flushSessionMemoryWritesForTest");
    expect(handler).toContain("async function saveSessionMemoryNow");
    expect(handler).toContain("const saveSessionToMemory: HookHandler = (event) => {");
    expect(handler).toContain("await getRecentSessionContentWithResetFallback");
    expect(handler).toContain("await generateSlugViaLLM");
    expect(handler).toContain("hookConfig?.llmSlug === true");
    expect(handler).not.toContain("hookConfig?.llmSlug !== false");
  });

  it("keeps Fased session reset state and hook context boundaries visible", () => {
    const session = readSource("auto-reply/reply/session.ts");
    const reset = readSource("config/sessions/reset.ts");
    const hookMetadata = readSource("hooks/bundled/session-memory/HOOK.md");

    expect(session).toContain("previousSessionEntry");
    expect(session).toContain("resetTriggered");
    expect(session).toContain("getGlobalHookRunner");
    expect(session).toContain("commandSource");
    expect(reset).toContain("resolveChannelResetConfig");
    expect(reset).toContain("resolveSessionResetType");
    expect(hookMetadata).toContain("command:new");
    expect(hookMetadata).toContain("command:reset");
  });

  it("maps upstream gateway command fallback changes to current Fased agent CLI behavior", () => {
    const agentViaGateway = readSource("commands/agent-via-gateway.ts");

    expect(agentViaGateway).toContain("isGatewayTransportError");
    expect(agentViaGateway).toContain("isGatewayAgentEmbeddedFallbackError");
    expect(agentViaGateway).toContain("Gateway agent failed; falling back to embedded");
    expect(agentViaGateway).toContain("throw err");
    expect(agentViaGateway).not.toContain("GatewayClientRequestError");
  });

  it("maps upstream model catalog empty-cache behavior to current Fased wrapper", () => {
    const modelCatalog = readSource("gateway/server-model-catalog.ts");

    expect(modelCatalog).toContain("__resetModelCatalogCacheForTest");
    expect(modelCatalog).toContain("readOnlyModelCatalogCache");
    expect(modelCatalog).toContain("fullModelCatalogCache");
    expect(modelCatalog).toContain("lastSuccessfulCatalog");
    expect(modelCatalog).toContain("markGatewayModelCatalogStaleForReload");
    expect(modelCatalog).toContain("staleGeneration");
    expect(modelCatalog).toContain("useCache: false");
    expect(modelCatalog).not.toContain("loadModelCatalog({ config: loadConfig() })");
  });

  it("maps upstream CLI cleanup and keeps WhatsApp responsiveness doctor deferred", () => {
    const runMain = readSource("cli/run-main.ts");
    const whatsappStatus = readSource("channels/plugins/status-issues/whatsapp.ts");

    expect(runMain).toContain("pauseNonTtyStdinForCliExit");
    expect(runMain).toContain("stdin.pause()");
    expect(whatsappStatus).toContain("collectWhatsAppStatusIssues");
    expect(whatsappStatus).toContain("Linked but disconnected");
    expect(whatsappStatus).not.toContain("stale local TUI");
    expect(sourceExists("commands/doctor-whatsapp-responsiveness.ts")).toBe(false);
    expect(sourceExists("commands/doctor-whatsapp-responsiveness.test.ts")).toBe(false);
  });

  it("keeps WhatsApp responsiveness diagnostics-only until a local issue is reproduced", () => {
    const doctor = readSource("commands/doctor.ts");
    const channelStatus = readSource("commands/channels/status.ts");
    const whatsappStatusTest = readSource("channels/plugins/status-issues/whatsapp.test.ts");
    const whatsappGroupPolicyTest = readSource("web/inbound/access-control.group-policy.test.ts");
    const whatsappInboundContract = readSource(
      "web/auto-reply/monitor/process-message.inbound-contract.test.ts",
    );
    const serverChannelsTest = readSource("gateway/server-channels.test.ts");

    expect(doctor).not.toContain("doctor-whatsapp-responsiveness");
    expect(channelStatus).toContain("collectChannelStatusIssues");
    expect(whatsappStatusTest).toContain("does not infer stale local TUI responsiveness");
    expect(whatsappGroupPolicyTest).toContain("resolveWhatsAppRuntimeGroupPolicy");
    expect(whatsappInboundContract).toContain("passes a finalized MsgContext");
    expect(whatsappInboundContract).toContain("suppresses non-final WhatsApp payload delivery");
    expect(serverChannelsTest).toContain("limits whole-channel account startup fanout to four");
    expect(serverChannelsTest).toContain("deduplicates concurrent start requests");
    expect(serverChannelsTest).toContain("cancels a pending startup");
  });

  it("keeps WebChat, Control UI, wallet, and channel routing surfaces visible", () => {
    const webChatParity = readSource("gateway/server-methods/chat.webchat-command-parity.test.ts");
    const chatMethods = readSource("gateway/server-methods/chat.ts");
    const serverImpl = readSource("gateway/server.impl.ts");
    const serverRuntimeConfig = readSource("gateway/server-runtime-config.ts");
    const serverHttp = readSource("gateway/server-http.ts");
    const controlUi = readSource("gateway/control-ui.ts");
    const hooks = readSource("gateway/hooks.ts");

    expect(webChatParity).toContain("@wallet");
    expect(webChatParity).toContain("@trade");
    expect(webChatParity).toContain("@offers");
    expect(webChatParity).toContain("@mining");
    expect(chatMethods).toContain("nodeSendToSession(params.sessionKey");
    expect(chatMethods).toContain("executeMiningChatCommand");
    expect(serverImpl).toContain("startChannel");
    expect(serverImpl).toContain("stopChannel");
    expect(serverImpl).toContain("getRuntimeSnapshot");
    expect(serverImpl).toContain("nodeSendToSession");
    expect(serverImpl).toContain("resolveSessionKeyForRun");
    expect(serverRuntimeConfig).toContain("resolveWalletRuntimeConfig");
    expect(serverRuntimeConfig).toContain("wallet.execution.mode=autonomous");
    expect(serverHttp).not.toContain("/api/wallet/custody/");
    expect(serverHttp).toContain("/api/wallet/reset");
    expect(controlUi).toContain("normalizeControlUiBasePath");
    expect(controlUi).toContain("serveResolvedIndexHtml");
    expect(hooks).toContain("allowedAgentIds");
    expect(hooks).toContain("allowRequestSessionKey");
  });

  it.skip("keeps session-memory capture off the reset reply path and makes LLM slug opt-in", () => {});

  it.skip("does not fall back to embedded agent for gateway request or auth errors", () => {});

  it.skip("caches empty read-only gateway model catalogs until reload marks them stale", () => {});

  it.skip("adds a Fased-local WhatsApp responsiveness doctor check after reproducing a local issue", () => {});
});
