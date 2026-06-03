import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createIMessageTestPlugin } from "../test-utils/imessage-test-plugin.js";
import { formatGatewayChannelsStatusLines } from "./channels/status.js";

describe("channels command", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("surfaces Signal runtime errors in channels status output", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/signal/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("surfaces WhatsApp linked-disconnected diagnostics without repair side effects", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: whatsappPlugin,
        },
      ]),
    );

    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        whatsapp: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            linked: true,
            running: true,
            connected: false,
            reconnectAttempts: 3,
            lastError: "socket closed",
          },
        ],
      },
    });
    const output = lines.join("\n");

    expect(output).toMatch(/Warnings:/);
    expect(output).toMatch(/whatsapp/i);
    expect(output).toContain("Linked but disconnected (reconnectAttempts=3): socket closed");
    expect(output).toContain("Run: fased doctor");
  });

  it("surfaces iMessage runtime errors in channels status output", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imsg permission denied",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/imessage/i);
    expect(lines.join("\n")).toMatch(/Channel error/i);
  });

  it("omits installable catalog output when no external channel catalog entries are available", () => {
    const lines = formatGatewayChannelsStatusLines({ channelAccounts: {} });
    const output = lines.join("\n");
    expect(output).not.toContain("Installable channel catalog:");
    expect(output).not.toContain("install plugin to enable");
  });
});
