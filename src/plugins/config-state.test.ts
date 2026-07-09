import { describe, expect, it } from "vitest";
import {
  isPluginRuntimeSessionReadAllowed,
  normalizePluginsConfig,
  resolvePluginAdminRpcActionGrant,
  resolveEffectiveEnableState,
} from "./config-state.js";

describe("normalizePluginsConfig", () => {
  it("uses default memory slot when not specified", () => {
    const result = normalizePluginsConfig({});
    expect(result.slots.memory).toBe("memory-core");
  });

  it("respects explicit memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "custom-memory" },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("disables memory slot when set to 'none' (case insensitive)", () => {
    expect(
      normalizePluginsConfig({
        slots: { memory: "none" },
      }).slots.memory,
    ).toBeNull();
    expect(
      normalizePluginsConfig({
        slots: { memory: "None" },
      }).slots.memory,
    ).toBeNull();
  });

  it("trims whitespace from memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "  custom-memory  " },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("uses default when memory slot is empty string", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "" },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("uses default when memory slot is whitespace only", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "   " },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("normalizes read-only plugin runtime helper permissions", () => {
    const normalized = normalizePluginsConfig({
      entries: {
        trusted: {
          runtime: {
            helpers: {
              sessions: {
                read: true,
              },
            },
          },
        },
        denied: {
          runtime: {
            helpers: {
              sessions: {
                read: false,
              },
            },
          },
        },
      },
    });

    expect(isPluginRuntimeSessionReadAllowed(normalized, "trusted")).toBe(true);
    expect(isPluginRuntimeSessionReadAllowed(normalized, "denied")).toBe(false);
    expect(isPluginRuntimeSessionReadAllowed(normalized, "missing")).toBe(false);
  });

  it("normalizes plugin admin RPC action grants but keeps them deny-by-default", () => {
    const normalized = normalizePluginsConfig({
      entries: {
        trusted: {
          runtime: {
            adminRpcActions: {
              allow: [
                {
                  method: "push.test",
                  sources: ["origin:bundled", " source:/opt/fased/plugins/demo "],
                  requireOperatorApproval: true,
                },
                {
                  method: "chat.inject",
                  sources: ["origin:bundled"],
                  requireOperatorApproval: false,
                },
                {
                  method: "not.a.real.method" as "push.test",
                  sources: ["origin:bundled"],
                  requireOperatorApproval: true,
                },
              ],
            },
          },
        },
        missingSource: {
          runtime: {
            adminRpcActions: {
              allow: [{ method: "web.login.start", requireOperatorApproval: true }],
            },
          },
        },
      },
    });

    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "trusted",
        method: "push.test",
        source: { origin: "bundled" },
      }),
    ).toMatchObject({
      allowed: true,
      matchedSource: "origin:bundled",
      method: "push.test",
    });
    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "trusted",
        method: "push.test",
        source: { source: "/opt/fased/plugins/demo" },
      }),
    ).toMatchObject({
      allowed: true,
      matchedSource: "source:/opt/fased/plugins/demo",
    });
    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "trusted",
        method: "push.test",
        source: { origin: "workspace" },
      }),
    ).toMatchObject({ allowed: false, reason: "source-not-allowlisted" });
    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "trusted",
        method: "chat.inject",
        source: { origin: "bundled" },
      }),
    ).toMatchObject({ allowed: false, reason: "operator-approval-required" });
    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "missingSource",
        method: "web.login.start",
        source: { origin: "bundled" },
      }),
    ).toMatchObject({ allowed: false, reason: "missing-source-allowlist" });
    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "trusted",
        method: "web.login.wait",
        source: { origin: "bundled" },
      }),
    ).toMatchObject({ allowed: false, reason: "missing-runtime-admin-rpc-grant" });
    expect(
      resolvePluginAdminRpcActionGrant({
        config: normalized,
        pluginId: "trusted",
        method: "gateway.call",
        source: { origin: "bundled" },
      }),
    ).toMatchObject({ allowed: false, reason: "invalid-admin-rpc-method" });
  });
});

describe("resolveEffectiveEnableState", () => {
  it("keeps bundled chat channel plugins opt-in by default", () => {
    const normalized = normalizePluginsConfig({
      enabled: true,
    });

    expect(
      resolveEffectiveEnableState({
        id: "telegram",
        origin: "bundled",
        config: normalized,
        rootConfig: {},
      }),
    ).toEqual({ enabled: false, reason: "bundled (disabled by default)" });
    expect(
      resolveEffectiveEnableState({
        id: "discord",
        origin: "bundled",
        config: normalized,
        rootConfig: {},
      }),
    ).toEqual({ enabled: false, reason: "bundled (disabled by default)" });
    expect(
      resolveEffectiveEnableState({
        id: "slack",
        origin: "bundled",
        config: normalized,
        rootConfig: {},
      }),
    ).toEqual({ enabled: false, reason: "bundled (disabled by default)" });
    expect(
      resolveEffectiveEnableState({
        id: "signal",
        origin: "bundled",
        config: normalized,
        rootConfig: {},
      }),
    ).toEqual({ enabled: false, reason: "bundled (disabled by default)" });
  });

  it("enables bundled channels when channels.<id>.enabled=true", () => {
    const normalized = normalizePluginsConfig({
      enabled: true,
    });
    const state = resolveEffectiveEnableState({
      id: "telegram",
      origin: "bundled",
      config: normalized,
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
    expect(state).toEqual({ enabled: true });
  });

  it("keeps explicit plugin-level disable authoritative", () => {
    const normalized = normalizePluginsConfig({
      enabled: true,
      entries: {
        slack: {
          enabled: false,
        },
      },
    });
    const state = resolveEffectiveEnableState({
      id: "slack",
      origin: "bundled",
      config: normalized,
      rootConfig: {
        channels: {
          slack: {
            enabled: true,
          },
        },
      },
    });
    expect(state).toEqual({ enabled: false, reason: "disabled in config" });
  });
});
