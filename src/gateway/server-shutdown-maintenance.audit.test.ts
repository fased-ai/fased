import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));

function readGatewaySource(file: string): string {
  return readFileSync(join(gatewayDir, file), "utf8");
}

describe("gateway shutdown maintenance audit", () => {
  it("keeps Fased maintenance startup synchronous instead of post-ready delayed", () => {
    const serverImpl = readGatewaySource("server.impl.ts");

    expect(serverImpl).not.toContain("scheduleGatewayPostReadyMaintenance");
    expect(serverImpl).not.toContain("postReadyMaintenanceTimer");
    expect(serverImpl).not.toContain("closePreludeStarted");

    const maintenanceStart = serverImpl.indexOf('"maintenance.start"');
    const closeFactory = serverImpl.indexOf("const close = createGatewayCloseHandler({");

    expect(maintenanceStart).toBeGreaterThan(-1);
    expect(closeFactory).toBeGreaterThan(-1);
    expect(maintenanceStart).toBeLessThan(closeFactory);
  });

  it("cancels delayed local refresh work before the core close handler runs", () => {
    const serverImpl = readGatewaySource("server.impl.ts");
    const closeStart = serverImpl.indexOf("return {\n    close: async (opts) => {");
    const hookStart = serverImpl.indexOf("runGlobalGatewayStopSafely", closeStart);
    const clearSkillsRefresh = serverImpl.indexOf("clearTimeout(skillsRefreshTimer)", closeStart);
    const unsubscribeSkills = serverImpl.indexOf("skillsChangeUnsub();", closeStart);
    const coreClose = serverImpl.indexOf("await close(opts);", closeStart);

    expect(closeStart).toBeGreaterThan(-1);
    expect(hookStart).toBeGreaterThan(closeStart);
    expect(clearSkillsRefresh).toBeGreaterThan(hookStart);
    expect(unsubscribeSkills).toBeGreaterThan(clearSkillsRefresh);
    expect(coreClose).toBeGreaterThan(unsubscribeSkills);
  });

  it("keeps channel, plugin, cron, and HTTP close boundaries in the close handler", () => {
    const serverClose = readGatewaySource("server-close.ts");
    const channelStop = serverClose.indexOf("for (const plugin of listChannelPlugins())");
    const pluginStop = serverClose.indexOf("params.pluginServices.stop()", channelStop);
    const reloadStop = serverClose.indexOf("await params.configReloader.stop()", pluginStop);
    const cronStop = serverClose.indexOf("params.cron.stopAndDrainForLifecycle()", reloadStop);
    const heartbeatStop = serverClose.indexOf("params.heartbeatRunner.stop()", cronStop);
    const clearTick = serverClose.indexOf("clearInterval(params.tickInterval)", heartbeatStop);
    const websocketClose = serverClose.indexOf("params.wss.close", clearTick);
    const httpClose = serverClose.indexOf("httpServer.close", websocketClose);
    const pluginCheckpoint = serverClose.indexOf(
      "params.pluginServices.checkpointForLifecycle()",
      httpClose,
    );
    const ledgerFenceAndCheckpoint = serverClose.indexOf(
      "checkpointAndCloseTaskLedgersForLifecycle({ managedStop: restartExpectedMs === null })",
      pluginCheckpoint,
    );

    expect(channelStop).toBeGreaterThan(-1);
    expect(pluginStop).toBeGreaterThan(channelStop);
    expect(reloadStop).toBeGreaterThan(pluginStop);
    expect(cronStop).toBeGreaterThan(reloadStop);
    expect(heartbeatStop).toBeGreaterThan(cronStop);
    expect(clearTick).toBeGreaterThan(heartbeatStop);
    expect(websocketClose).toBeGreaterThan(clearTick);
    expect(httpClose).toBeGreaterThan(websocketClose);
    expect(pluginCheckpoint).toBeGreaterThan(httpClose);
    expect(ledgerFenceAndCheckpoint).toBeGreaterThan(pluginCheckpoint);
    expect(ledgerFenceAndCheckpoint).toBeGreaterThan(httpClose);
  });

  it("documents the current Promise<void> close contract before timeout import", () => {
    const serverImpl = readGatewaySource("server.impl.ts");
    const serverClose = readGatewaySource("server-close.ts");
    const gatewayServerType = serverImpl.slice(
      serverImpl.indexOf("export type GatewayServer"),
      serverImpl.indexOf("export type GatewayServerOptions"),
    );
    const httpCloseStart = serverClose.indexOf("httpServer.close((err)");
    const httpCloseBlock = serverClose.slice(httpCloseStart - 120, httpCloseStart + 260);

    expect(gatewayServerType).toContain("Promise<void>");
    expect(serverClose).not.toContain("ShutdownResult");
    expect(serverClose).not.toContain("HTTP_CLOSE_GRACE_MS");
    expect(serverClose).not.toContain("closeAllConnections");
    expect(serverClose).not.toContain("Promise.race");
    expect(httpCloseStart).toBeGreaterThan(-1);
    expect(httpCloseBlock).toContain("err ? reject(err) : resolve()");
  });
});
