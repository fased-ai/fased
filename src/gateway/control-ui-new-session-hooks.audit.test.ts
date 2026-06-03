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

describe("Lane 6 explicit Control UI /new hooks audit", () => {
  it("maps Control UI /new to the WebChat send path without direct session creation", () => {
    const appRender = readRepoSource("ui/src/ui/app-render.ts");
    const appChat = readRepoSource("ui/src/ui/app-chat.ts");
    const chatController = readRepoSource("ui/src/ui/controllers/chat.ts");
    const appGateway = readRepoSource("ui/src/ui/app-gateway.ts");

    expect(appRender).toContain(
      'onNewSession: () => state.handleSendChat("/new", { restoreDraft: true })',
    );
    expect(appChat).toContain("function isChatResetCommand");
    expect(appChat).toContain('normalized === "/new" || normalized === "/reset"');
    expect(appChat).toContain('normalized.startsWith("/new ")');
    expect(appChat).toContain("const refreshSessions = isChatResetCommand(message)");
    expect(appChat).toContain(
      "enqueueChatMessage(host, message, attachmentsToSend, refreshSessions)",
    );
    expect(appChat).toContain("host.refreshSessionsAfterChat.add(runId)");

    expect(chatController).toContain('await state.client.request("chat.send", {');
    expect(chatController).toContain("sessionKey: state.sessionKey");
    expect(chatController).toContain("deliver: false");
    expect(chatController).toContain("idempotencyKey: runId");

    expect(appGateway).toContain("host.refreshSessionsAfterChat.has(runId)");
    expect(appGateway).toContain("host.refreshSessionsAfterChat.delete(runId)");
    expect(appGateway).toContain("void loadSessions(host as unknown as FasedAgentApp");
    expect(appGateway).toContain("activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES");

    expect(`${appChat}\n${chatController}`).not.toContain("sessions.create");
    expect(`${appChat}\n${chatController}`).not.toContain("createSession(");
    expect(`${appChat}\n${chatController}`).not.toContain("SessionManager");
  });

  it("maps Fased reset state, previous-session context, and session-memory hook delivery", () => {
    const session = readSource("auto-reply/reply/session.ts");
    const getReply = readSource("auto-reply/reply/get-reply.ts");
    const commandsCore = readSource("auto-reply/reply/commands-core.ts");
    const sessionMemory = readSource("hooks/bundled/session-memory/handler.ts");
    const sessionMemoryTest = readSource("hooks/bundled/session-memory/handler.test.ts");

    expect(session).toContain("resetTriggered = true");
    expect(session).toContain("bodyStripped = strippedForReset.slice(trigger.length).trimStart()");
    expect(session).toContain("const previousSessionEntry = resetTriggered && entry");
    expect(session).toContain("archiveSessionTranscripts({");
    expect(session).toContain('reason: "reset"');
    expect(session).toContain('IsNewSession: isNewSession ? "true" : "false"');
    expect(session).toContain("runSessionEnd");
    expect(session).toContain("runSessionStart");

    expect(getReply).toContain("const maybeEmitMissingResetHooks = async () => {");
    expect(getReply).toContain("!resetTriggered || !command.isAuthorizedSender");
    expect(getReply).toContain("command.resetHookTriggered");
    expect(getReply).toContain("await emitResetCommandHooks({");
    expect(getReply).toContain("previousSessionEntry");

    expect(commandsCore).toContain('createInternalHookEvent("command", params.action');
    expect(commandsCore).toContain("previousSessionEntry: params.previousSessionEntry");
    expect(commandsCore).toContain("params.command.resetHookTriggered = true");
    expect(commandsCore).toContain('hookRunner?.hasHooks("before_reset")');
    expect(commandsCore).toContain("runBeforeReset");

    expect(sessionMemory).toContain('event.action === "new" || event.action === "reset"');
    expect(sessionMemory).toContain("const pendingSessionMemoryWrites = new Set<Promise<void>>()");
    expect(sessionMemory).toContain("flushSessionMemoryWritesForTest");
    expect(sessionMemory).toContain("context.previousSessionEntry || context.sessionEntry");
    expect(sessionMemory).toContain("getRecentSessionContentWithResetFallback");
    expect(sessionMemory).toContain("writeFileWithinRoot");
    expect(sessionMemoryTest).toContain(
      "handles reset-path session pointers from previousSessionEntry",
    );
    expect(sessionMemoryTest).toContain(
      "recovers transcript when previousSessionEntry.sessionFile",
    );
  });

  it("maps SDK parent session creation and keeps Control UI /new from bypassing it", () => {
    const session = readSource("auto-reply/reply/session.ts");
    const sessionTest = readSource("auto-reply/reply/session.test.ts");
    const getReply = readSource("auto-reply/reply/get-reply.ts");
    const appRender = readRepoSource("ui/src/ui/app-render.ts");

    expect(session).toContain("const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000");
    expect(session).toContain("function forkSessionFromParent");
    expect(session).toContain("SessionManager.open(parentSessionFile)");
    expect(session).toContain("manager.createBranchedSession(leafId)");
    expect(session).toContain("parentSession: parentSessionFile");
    expect(session).toContain("const parentSessionKey = ctx.ParentSessionKey?.trim()");
    expect(session).toContain("parentForkMaxTokens > 0 && parentTokens > parentForkMaxTokens");
    expect(session).toContain("sessionEntry.forkedFromParent = true");

    expect(getReply).toContain("parentSessionKey: sessionCtx.ParentSessionKey");
    expect(sessionTest).toContain("forks a new session from the parent session file");
    expect(sessionTest).toContain(
      "skips fork and creates fresh session when parent tokens exceed threshold",
    );
    expect(sessionTest).toContain("archives the old session store entry on /new");

    expect(appRender).toContain('state.handleSendChat("/new"');
    expect(appRender).not.toContain("ParentSessionKey");
    expect(appRender).not.toContain("createBranchedSession");
  });

  it("keeps custom hooks separate from channel delivery, wallet routing, and session tools", () => {
    const internalHooks = readSource("hooks/internal-hooks.ts");
    const commandsTest = readSource("auto-reply/reply/commands.test.ts");
    const webChatParity = readSource("gateway/server-methods/chat.webchat-command-parity.test.ts");
    const walletCommandTest = readSource("wallet/chat-command.test.ts");
    const sessionsListTool = readSource("agents/tools/sessions-list-tool.ts");
    const sessionsHistoryTool = readSource("agents/tools/sessions-history-tool.ts");

    expect(internalHooks).toContain("registerInternalHook");
    expect(internalHooks).toContain("triggerInternalHook");
    expect(internalHooks).toContain("handlers.get(event.type)");
    expect(internalHooks).toContain("handlers.get(`${event.type}:${event.action}`)");
    expect(internalHooks).toContain("createInternalHookEvent");

    expect(commandsTest).toContain("triggers hooks for /new with arguments");
    expect(commandsTest).toContain("triggers hooks for native /new routed to target sessions");

    expect(webChatParity).toContain("@wallet");
    expect(webChatParity).toContain("@trade");
    expect(webChatParity).toContain("@offers");
    expect(webChatParity).toContain("@mining");
    expect(walletCommandTest).toContain("@wallet");

    expect(sessionsListTool).toContain("createSessionVisibilityGuard");
    expect(sessionsHistoryTool).toContain("createSessionVisibilityGuard");
    expect(`${sessionsListTool}\n${sessionsHistoryTool}`).not.toContain("command:new");
    expect(walletCommandTest).not.toContain("command:new");
    expect(repoSourceExists("ui/src/ui/control-ui-new-session-hook.ts")).toBe(false);
  });

  it.skip("adds a Control UI-specific session creation hook only after Fased approves a runtime contract", () => {});
});
