import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldSkipRespawnForArgv } from "../cli/respawn-policy.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function pathExists(relativePath: string): Promise<boolean> {
  const stat = await fs.stat(path.join(repoRoot, relativePath)).catch(() => null);
  return Boolean(stat);
}

describe("Lane 3 TUI respawn and session restore audit", () => {
  it("maps current Fased entry respawn ownership before adopting upstream split helpers", async () => {
    const entry = await readSource("src/entry.ts");
    const policy = await readSource("src/cli/respawn-policy.ts");

    await expect(pathExists("src/entry.respawn.ts")).resolves.toBe(false);
    await expect(pathExists("src/entry.respawn.test.ts")).resolves.toBe(false);
    expect(entry).toContain('from "node:child_process"');
    expect(entry).toContain("attachChildProcessBridge(child)");
    expect(entry).toContain("[fased] Failed to respawn CLI:");
    expect(entry).not.toContain("buildCliRespawnPlan");
    expect(entry).not.toContain("runCliRespawnPlan");

    expect(policy).toContain("export function shouldSkipRespawnForArgv");
    expect(policy).not.toContain("INTERACTIVE_TTY_COMMANDS");
    expect(policy).not.toContain("shouldSkipStartupEnvironmentRespawnForArgv");
  });

  it("keeps current respawn skip behavior explicit for TUI and gateway invocations", () => {
    expect(shouldSkipRespawnForArgv(["node", "fased", "gateway"])).toBe(true);
    expect(shouldSkipRespawnForArgv(["node", "fased", "gateway", "run"])).toBe(true);
    expect(shouldSkipRespawnForArgv(["node", "fased", "--help"])).toBe(true);

    expect(shouldSkipRespawnForArgv(["node", "fased", "tui"])).toBe(false);
    expect(shouldSkipRespawnForArgv(["node", "fased", "terminal"])).toBe(false);
    expect(shouldSkipRespawnForArgv(["node", "fased", "chat"])).toBe(false);
  });

  it("maps current TUI session restore ownership without upstream last-session store", async () => {
    const tui = await readSource("src/tui/tui.ts");
    const sessionActions = await readSource("src/tui/tui-session-actions.ts");

    await expect(pathExists("src/tui/tui-last-session.ts")).resolves.toBe(false);
    await expect(pathExists("src/tui/tui-backend.ts")).resolves.toBe(false);
    expect(tui).toContain("currentSessionKey = resolveSessionKey(initialSessionInput)");
    expect(tui).not.toContain("readTuiLastSessionKey");
    expect(tui).not.toContain("writeTuiLastSessionKey");
    expect(tui).not.toContain("resolveRememberedTuiSessionKey");
    expect(tui).not.toContain("installTuiTerminalLossExitHandler");
    expect(tui).not.toContain("createDeferredTuiFinish");

    expect(sessionActions).toContain("const setSession = async");
    expect(sessionActions).toContain("state.currentSessionKey = nextKey");
    expect(sessionActions).not.toContain("writeTuiLastSessionKey");
    expect(sessionActions).not.toContain("isHeartbeatLikeTuiSession");
  });

  it("maps current TUI session-list recency behavior before adopting upstream bounds", async () => {
    const commandHandlers = await readSource("src/tui/tui-command-handlers.ts");
    const sessionActions = await readSource("src/tui/tui-session-actions.ts");
    const gatewayChat = await readSource("src/tui/gateway-chat.ts");

    await expect(pathExists("src/tui/tui-session-list-policy.ts")).resolves.toBe(false);
    expect(commandHandlers).toContain("includeDerivedTitles: true");
    expect(commandHandlers).toContain("includeLastMessage: true");
    expect(commandHandlers).toContain("agentId: state.currentAgentId");
    expect(commandHandlers).not.toContain("TUI_SESSION_PICKER_LIMIT");
    expect(commandHandlers).not.toContain("TUI_RECENT_SESSIONS_ACTIVE_MINUTES");
    expect(commandHandlers).not.toMatch(/activeMinutes:\s*TUI_RECENT_SESSIONS_ACTIVE_MINUTES/);
    expect(commandHandlers).not.toMatch(/limit:\s*TUI_SESSION_PICKER_LIMIT/);

    expect(sessionActions).not.toContain("TUI_SESSION_LOOKUP_LIMIT");
    expect(sessionActions).not.toMatch(/search:\s*state\.currentSessionKey/);
    expect(gatewayChat).toContain("activeMinutes: opts?.activeMinutes");
    expect(gatewayChat).toContain("limit: opts?.limit");
  });

  it.skip("adopts Fased-local TUI session list bounds only after recency policy is approved", () => {});

  it.skip("adds TUI last-session restore only after heartbeat and channel-session safety is approved", () => {});
});
