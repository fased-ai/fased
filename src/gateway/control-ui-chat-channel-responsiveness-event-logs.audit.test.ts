import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(gatewayDir, "..");
const repoRoot = resolve(gatewayDir, "../..");

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), "utf8");
}

function readRepoSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function repoSourceExists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

describe("Lane 6 Control UI/TUI chat/channel responsiveness event-log audit", () => {
  it("maps bounded Control UI gateway and debug event visibility", () => {
    const appGateway = readRepoSource("ui/src/ui/app-gateway.ts");
    const appGatewayTest = readRepoSource("ui/src/ui/app-gateway.node.test.ts");
    const debugView = readRepoSource("ui/src/ui/views/debug.ts");
    const debugLongFrameTest = readRepoSource(
      "ui/src/ui/views/debug.long-frame-diagnostics.test.ts",
    );

    expect(appGateway).toContain("eventLogBuffer: EventLogEntry[];");
    expect(appGateway).toContain("eventLog: EventLogEntry[];");
    expect(appGateway).toContain("].slice(0, 250);");
    expect(appGateway).toContain('if (host.tab === "debug")');
    expect(appGateway).toContain("host.eventLog = host.eventLogBuffer;");
    expect(appGateway).not.toContain("PerformanceObserver");

    expect(debugView).toContain('<div class="card-title">Event Log</div>');
    expect(debugView).toContain("Latest gateway events.");
    expect(debugView).toContain("debug-event-log");
    expect(debugView).toContain("props.eventLog.map");
    expect(debugView).toContain("formatEventPayload(evt.payload)");
    expect(debugView).toContain("events.toReversed().slice(0, 8)");
    expect(debugView).toContain("Diagnostic Stability");

    expect(appGatewayTest).toContain("bounds long-frame-style debug event visibility");
    expect(appGatewayTest).toContain("control-ui.long-frame");
    expect(debugLongFrameTest).toContain(
      "renders only the bounded latest diagnostic rows for long-frame-style events",
    );
    expect(repoSourceExists("ui/src/ui/control-ui-performance.ts")).toBe(false);
  });

  it("maps WebSocket reconnect and WebChat responsiveness guards before adding event logs", () => {
    const appGateway = readRepoSource("ui/src/ui/app-gateway.ts");
    const appGatewayTest = readRepoSource("ui/src/ui/app-gateway.node.test.ts");
    const webChatResponsiveness = readRepoSource(
      "ui/src/ui/app-chat.webchat-responsiveness.test.ts",
    );
    const webChatParity = readSource("gateway/server-methods/chat.webchat-command-parity.test.ts");

    expect(appGateway).toContain("if (host.client !== client)");
    expect(appGateway).toContain('connectGateway(host, { reason: "seq-gap" })');
    expect(appGateway).toContain("clearPendingQueueItemsForRun");
    expect(appGateway).toContain("flushChatQueueForEvent");

    expect(appGatewayTest).toContain("ignores stale client onGap callbacks after reconnect");
    expect(appGatewayTest).toContain("ignores stale client onEvent callbacks after reconnect");
    expect(appGatewayTest).toContain(
      "preserves approval prompts, clears stale run indicators, and resumes queued work",
    );

    expect(webChatResponsiveness).toContain("coalesces duplicate send attempts");
    expect(webChatResponsiveness).toContain("preserves queued draft text and attachments");
    expect(webChatResponsiveness).toContain("keeps stop-after-reconnect on the abort path");

    expect(webChatParity).toContain("@wallet");
    expect(webChatParity).toContain("@trade");
    expect(webChatParity).toContain("@offers");
    expect(webChatParity).toContain("@mining");
  });

  it("maps channel status/control responsiveness without adding channel event logging", () => {
    const channelController = readRepoSource("ui/src/ui/controllers/channels.ts");
    const channelControllerTest = readRepoSource("ui/src/ui/controllers/channels.test.ts");
    const channelView = readRepoSource("ui/src/ui/views/channels.ts");
    const channelSharedView = readRepoSource("ui/src/ui/views/channels.shared.ts");

    expect(channelController).toContain('"channels.status"');
    expect(channelController).toContain("timeoutMs: 8000");
    expect(channelController).toContain("if (state.channelsLoading)");
    expect(channelController).toContain("channelRuntimeBusy");
    expect(channelController).toContain('"channels.start" | "channels.stop"');
    expect(channelController).toContain("await loadChannels(state, false)");
    expect(channelController).toContain("state.channelsError = String(err)");
    expect(channelController).not.toContain("control-ui.long-frame");
    expect(channelController).not.toContain("PerformanceObserver");

    expect(channelControllerTest).toContain(
      "starts a channel account and refreshes channel status",
    );
    expect(channelControllerTest).toContain("stops a channel and refreshes channel status");
    expect(channelControllerTest).toContain(
      "surfaces runtime control errors without leaving the control busy",
    );

    expect(channelView).toContain("If we have recent inbound activity");
    expect(channelView).toContain("the channel is effectively running");
    expect(channelSharedView).toContain("renderChannelRuntimeControls");
    expect(channelSharedView).toContain("channelRuntimeControlKey");
    expect(`${channelView}\n${channelSharedView}`).not.toContain("control-ui.long-frame");
  });

  it("keeps diagnostics separate from channel delivery, wallet routing, and session tools", () => {
    const webChatParity = readSource("gateway/server-methods/chat.webchat-command-parity.test.ts");
    const walletCommandTest = readSource("wallet/chat-command.test.ts");
    const tradeCommandTest = readSource("wallet/trade-chat-command.test.ts");
    const sessionsListTool = readSource("agents/tools/sessions-list-tool.ts");
    const sessionsHistoryTool = readSource("agents/tools/sessions-history-tool.ts");

    expect(webChatParity).toContain("@wallet");
    expect(webChatParity).toContain("@trade");
    expect(webChatParity).toContain("@offers");
    expect(webChatParity).toContain("@mining");
    expect(walletCommandTest).toContain("@wallet:agent");
    expect(tradeCommandTest).toContain("@trade");

    expect(sessionsListTool).toContain("createSessionVisibilityGuard");
    expect(sessionsHistoryTool).toContain("createSessionVisibilityGuard");
    expect(`${sessionsListTool}\n${sessionsHistoryTool}`).not.toContain("control-ui.long-frame");
    expect(`${walletCommandTest}\n${tradeCommandTest}`).not.toContain("control-ui.long-frame");
  });

  it.skip("adds runtime chat/channel responsiveness event logging only after a reproduced Fased UI regression", () => {});
});
