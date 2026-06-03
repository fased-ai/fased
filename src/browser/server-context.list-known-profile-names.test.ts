import { describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import type { BrowserServerState } from "./server-context.js";
import { createBrowserRouteContext, listKnownProfileNames } from "./server-context.js";

vi.mock("./chrome.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chrome.js")>();
  return {
    ...actual,
    isChromeReachable: vi.fn(async () => false),
  };
});

describe("browser server-context listKnownProfileNames", () => {
  it("includes configured and runtime-only profile names", () => {
    const resolved = resolveBrowserConfig({
      defaultProfile: "fased",
      profiles: {
        fased: { cdpPort: 18800, color: "#FF4500" },
      },
    });
    const fased = resolveProfile(resolved, "fased");
    if (!fased) {
      throw new Error("expected fased profile");
    }

    const state: BrowserServerState = {
      server: null as unknown as BrowserServerState["server"],
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "stale-removed",
          {
            profile: { ...fased, name: "stale-removed" },
            running: null,
          },
        ],
      ]),
    };

    expect(listKnownProfileNames(state).toSorted()).toEqual(["chrome", "fased", "stale-removed"]);
  });

  it("redacts profile CDP URLs in profile status output", async () => {
    const resolved = resolveBrowserConfig({
      defaultProfile: "remote",
      profiles: {
        remote: {
          cdpUrl: "https://user:pass@browserless.example/chrome?token=abc&launch=headless",
          color: "#0066CC",
        },
      },
    });
    const state: BrowserServerState = {
      server: null as unknown as BrowserServerState["server"],
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    const ctx = createBrowserRouteContext({
      getState: () => state,
      refreshConfigFromDisk: false,
    });
    const profiles = await ctx.listProfiles();
    const remote = profiles.find((profile) => profile.name === "remote");

    expect(remote?.cdpUrl).toBe(
      "https://redacted:redacted@browserless.example/chrome?token=redacted&launch=redacted",
    );
  });
});
