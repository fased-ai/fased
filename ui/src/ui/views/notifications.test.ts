import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../storage.ts";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function flattenTemplateText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
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
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function makeSettings(overrides: Partial<UiSettings>): UiSettings {
  return {
    gatewayUrl: "ws://127.0.0.1:18789",
    token: "",
    authStorage: "local",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatCommandHelpersCollapsed: false,
    chatSessionUsageVisible: true,
    chatDeliveryMode: "operator",
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    notificationRouteMode: "ui-only",
    notificationRouteChannel: "",
    notificationRouteAccountId: "",
    notificationRouteTo: "",
    notificationEventPrefs: {},
    ...overrides,
  };
}

describe("renderNotifications", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders delivery settings, routing prefs, and recent event history", async () => {
    const { renderNotifications } = await import("./notifications.ts");
    const result = renderNotifications({
      settings: makeSettings({
        notificationRouteMode: "channel",
        notificationRouteChannel: "telegram",
        notificationRouteAccountId: "ops",
        notificationRouteTo: "@fc_ops",
        notificationEventPrefs: {
          "mining.rpc_fallback": true,
          "wallet.rpc_quota": false,
        },
      }),
      snapshot: {
        ts: Date.now(),
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channels: {},
        channelAccounts: {
          telegram: [{ accountId: "ops", name: "Ops Bot", enabled: true, configured: true }],
        },
        channelDefaultAccountId: { telegram: "ops" },
      },
      events: [
        {
          id: "evt-1",
          code: "federation.payment_verified",
          category: "federation",
          level: "success",
          title: "Marketplace payment verified",
          message: "Payment verified for task task-1.",
          createdAt: "2026-04-11T16:00:00.000Z",
          routeStatus: "sent",
          routeChannel: "telegram",
          routeAccountId: "ops",
          routeTo: "@fc_ops",
          routedAt: "2026-04-11T16:00:05.000Z",
          routeError: null,
        },
      ],
      onSettingsChange: () => {},
      onDismiss: () => {},
      onSendTest: () => {},
    });

    const text = flattenTemplateText(result);
    expect(text).toContain("Delivery");
    expect(text).toContain("Ready");
    expect(text).toContain("Test");
    expect(text).not.toContain("Send test");
    expect(text).toContain("Events");
    expect(text).toContain("Mining");
    expect(text).toContain("Wallet");
    expect(text).toContain("Fased Network");
    expect(text).toContain("Tasks");
    expect(text).not.toContain("External routing prefs");
    expect(text).toContain("Recent events");
    expect(text).toContain("Telegram");
    expect(text).toContain("Ops Bot");
    expect(text).toContain("Marketplace payment verified");
    expect(text).toContain("Routed");
  });

  it("treats the channel account default audience as the delivery destination", async () => {
    const { renderNotifications } = await import("./notifications.ts");
    const result = renderNotifications({
      settings: makeSettings({
        notificationRouteMode: "channel",
        notificationRouteChannel: "telegram",
        notificationRouteAccountId: "ops",
        notificationRouteTo: "",
      }),
      snapshot: {
        ts: Date.now(),
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channels: {},
        channelAccounts: {
          telegram: [
            {
              accountId: "ops",
              name: "Ops Bot",
              enabled: true,
              configured: true,
              audience: "397848047",
            },
          ],
        },
        channelDefaultAccountId: { telegram: "ops" },
      },
      events: [],
      onSettingsChange: () => {},
      onDismiss: () => {},
      onSendTest: () => {},
    });

    const text = flattenTemplateText(result);
    expect(text).toContain("Ready");
    expect(text).toContain("destination");
    expect(text).toContain("397848047");
    expect(text).not.toContain("Incomplete");
    expect(text).not.toContain("Set a destination before routed alerts can leave the dashboard.");
  });

  it("uses the selected channel binding peer as the delivery destination", async () => {
    const { renderNotifications } = await import("./notifications.ts");
    const result = renderNotifications({
      settings: makeSettings({
        notificationRouteMode: "channel",
        notificationRouteChannel: "telegram",
        notificationRouteAccountId: "default",
        notificationRouteTo: "",
      }),
      snapshot: {
        ts: Date.now(),
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channels: {},
        channelAccounts: {
          telegram: [{ accountId: "default", enabled: true, configured: true }],
        },
        channelDefaultAccountId: { telegram: "default" },
      },
      configForm: {
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "telegram",
              peer: { kind: "direct", id: "397848047" },
            },
          },
        ],
      },
      events: [],
      onSettingsChange: () => {},
      onDismiss: () => {},
      onSendTest: () => {},
    });

    const text = flattenTemplateText(result);
    expect(text).toContain("Ready");
    expect(text).toContain("destination");
    expect(text).toContain("397848047");
    expect(text).not.toContain("Incomplete");
  });
});
