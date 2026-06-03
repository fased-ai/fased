import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  getPluginRuntimeSessionReadGrant,
  setPluginAdminRpcActionGrant,
  setPluginRuntimeSessionReadGrant,
} from "./runtime-helper-grants.js";

describe("plugin runtime helper grants", () => {
  it("enables session read helper access without changing plugin enablement", () => {
    const config: FasedAgentConfig = {
      plugins: {
        entries: {
          demo: {
            enabled: false,
            config: {
              mode: "test",
            },
          },
        },
      },
    };

    const result = setPluginRuntimeSessionReadGrant(config, "demo", true);

    expect(result).toMatchObject({
      pluginId: "demo",
      enabled: true,
      changed: true,
    });
    expect(result.config.plugins?.entries?.demo).toEqual({
      enabled: false,
      config: {
        mode: "test",
      },
      runtime: {
        helpers: {
          sessions: {
            read: true,
          },
        },
      },
    });
    expect(getPluginRuntimeSessionReadGrant(result.config, "demo")).toBe(true);
  });

  it("disables session read helper access while preserving other runtime helper keys", () => {
    const config: FasedAgentConfig = {
      plugins: {
        entries: {
          demo: {
            runtime: {
              helpers: {
                sessions: {
                  read: true,
                },
              },
            },
          },
        },
      },
    };

    const result = setPluginRuntimeSessionReadGrant(config, "demo", false);

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.entries?.demo?.runtime?.helpers?.sessions?.read).toBe(false);
    expect(getPluginRuntimeSessionReadGrant(result.config, "demo")).toBe(false);
  });

  it("creates a plugin entry when granting a helper to a plugin without config yet", () => {
    const result = setPluginRuntimeSessionReadGrant({}, "new-plugin", true);

    expect(result.config.plugins?.entries?.["new-plugin"]?.runtime).toEqual({
      helpers: {
        sessions: {
          read: true,
        },
      },
    });
  });

  it("reports unchanged when the requested value is already configured", () => {
    const config = setPluginRuntimeSessionReadGrant({}, "demo", true).config;
    const result = setPluginRuntimeSessionReadGrant(config, "demo", true);

    expect(result.changed).toBe(false);
  });

  it("enables admin RPC action grants with source and operator approval gates", () => {
    const config: FasedAgentConfig = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
            runtime: {
              helpers: {
                sessions: {
                  read: true,
                },
              },
            },
          },
        },
      },
    };

    const result = setPluginAdminRpcActionGrant(config, "demo", "push.test", true, [
      "source:/workspace/plugins/demo",
      "origin:workspace",
      "origin:workspace",
    ]);

    expect(result).toMatchObject({
      pluginId: "demo",
      method: "push.test",
      enabled: true,
      sources: ["origin:workspace", "source:/workspace/plugins/demo"],
      changed: true,
    });
    expect(result.config.plugins?.entries?.demo?.runtime).toEqual({
      helpers: {
        sessions: {
          read: true,
        },
      },
      adminRpcActions: {
        allow: [
          {
            method: "push.test",
            sources: ["origin:workspace", "source:/workspace/plugins/demo"],
            requireOperatorApproval: true,
          },
        ],
      },
    });
  });

  it("disables one admin RPC action grant while preserving other grants", () => {
    const config = setPluginAdminRpcActionGrant(
      setPluginAdminRpcActionGrant({}, "demo", "push.test", true, ["origin:workspace"]).config,
      "demo",
      "web.login.start",
      true,
      ["origin:workspace"],
    ).config;

    const result = setPluginAdminRpcActionGrant(config, "demo", "push.test", false, []);

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.entries?.demo?.runtime?.adminRpcActions?.allow).toEqual([
      {
        method: "web.login.start",
        sources: ["origin:workspace"],
        requireOperatorApproval: true,
      },
    ]);
  });

  it("rejects broad admin RPC grants without source keys", () => {
    expect(() => setPluginAdminRpcActionGrant({}, "demo", "push.test", true, [])).toThrow(
      "at least one source key is required",
    );
  });
});
