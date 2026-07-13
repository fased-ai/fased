import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderServices } from "./services.ts";

describe("Services component actions", () => {
  it("installs, restarts, connects, and opens canonical docs from lifecycle rows", () => {
    const container = document.createElement("div");
    const onInstall = vi.fn();
    const onRestart = vi.fn();
    const onNavigate = vi.fn();
    render(
      renderServices({
        configForm: null,
        skillsReport: null,
        skillsLoading: false,
        pluginsMarketplace: null,
        capabilities: {
          entries: [
            {
              id: "telegram",
              label: "Telegram",
              category: "channel",
              delivery: "npm-addon",
              packageName: "@fased/telegram",
              pluginId: "telegram",
              channelId: "telegram",
              restartRequired: true,
              description: "Telegram transport.",
              docsPath: "/channels/telegram",
              surface: "Agent > Channels",
              state: "not-installed",
              action: "install",
              detail: "Optional add-on.",
            },
            {
              id: "media-runtime",
              label: "Media Runtime",
              category: "runtime",
              delivery: "npm-addon",
              packageName: "@fased/media-runtime",
              pluginId: "media-runtime",
              restartRequired: true,
              description: "Media tools.",
              docsPath: "/nodes/media-understanding",
              surface: "Services > Components",
              state: "installed",
              action: "configure",
              detail: "Installed.",
            },
          ],
          summary: {
            total: 2,
            coreIncluded: 0,
            optionalInstalled: 1,
            optionalConfigured: 0,
            externalRequired: 0,
            errors: 0,
          },
        },
        configSaving: false,
        configDirty: false,
        onNavigate,
        onConfigPatch: vi.fn(),
        onConfigSave: vi.fn(),
        onConfigReload: vi.fn(),
        onComponentInstall: onInstall,
        onComponentRestart: onRestart,
      }),
      container,
    );

    const telegram = container.querySelector("#service-capability-telegram");
    const media = container.querySelector("#service-capability-media-runtime");
    expect(telegram).not.toBeNull();
    expect(media).not.toBeNull();
    Array.from(telegram!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Install")
      ?.click();
    Array.from(media!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Restart")
      ?.click();
    Array.from(telegram!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Connect")
      ?.click();

    expect(onInstall).toHaveBeenCalledWith("telegram");
    expect(onRestart).toHaveBeenCalledWith("media-runtime");
    expect(onNavigate).toHaveBeenCalledWith("channels");
    expect(telegram!.querySelector("a")?.href).toBe("https://docs.fased.ai/channels/telegram");
  });
});
