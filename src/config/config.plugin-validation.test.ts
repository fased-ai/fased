import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

async function writePluginFixture(params: {
  dir: string;
  id: string;
  schema: Record<string, unknown>;
  channels?: string[];
}) {
  await fs.mkdir(params.dir, { recursive: true });
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf-8",
  );
  const manifest: Record<string, unknown> = {
    id: params.id,
    configSchema: params.schema,
  };
  if (params.channels) {
    manifest.channels = params.channels;
  }
  await fs.writeFile(
    path.join(params.dir, "fased.plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

describe("config plugin validation", () => {
  const fixtureRoot = path.join(os.tmpdir(), "fased-config-plugin-validation");
  let caseIndex = 0;

  function createCaseHome() {
    const home = path.join(fixtureRoot, `case-${caseIndex++}`);
    return fs.mkdir(home, { recursive: true }).then(() => home);
  }

  const validateInHome = (home: string, raw: unknown) => {
    process.env.FASED_STATE_DIR = path.join(home, ".fased");
    return validateConfigObjectWithPlugins(raw);
  };

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("rejects missing plugin load paths", async () => {
    const home = await createCaseHome();
    const missingPath = path.join(home, "missing-plugin");
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: { enabled: false, load: { paths: [missingPath] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hasIssue = res.issues.some(
        (issue) =>
          issue.path === "plugins.load.paths" && issue.message.includes("plugin path not found"),
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("warns for missing plugin ids in entries instead of failing validation", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: { enabled: false, entries: { "missing-plugin": { enabled: true } } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toContainEqual({
        path: "plugins.entries.missing-plugin",
        message:
          "plugin not found: missing-plugin (stale config entry ignored; remove it from plugins config)",
      });
    }
  });

  it("accepts explicit read-only plugin runtime helper permission config", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        entries: {
          "session-reader": {
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
    });
    expect(res.ok).toBe(true);
  });

  it("accepts explicit plugin admin RPC action permission config", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        entries: {
          "trusted-admin-plugin": {
            enabled: true,
            runtime: {
              adminRpcActions: {
                allow: [
                  {
                    method: "push.test",
                    sources: ["origin:bundled"],
                    requireOperatorApproval: true,
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown plugin admin RPC action methods", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        entries: {
          "bad-admin-plugin": {
            runtime: {
              adminRpcActions: {
                allow: [
                  {
                    method: "gateway.call",
                    sources: ["origin:bundled"],
                    requireOperatorApproval: true,
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects generic admin RPC dispatch helper config", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        entries: {
          "bad-admin-plugin": {
            runtime: {
              helpers: {
                adminRpc: {
                  call: true,
                },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects missing plugin ids in allow/deny/slots", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        allow: ["missing-allow"],
        deny: ["missing-deny"],
        slots: { memory: "missing-slot" },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual(
        expect.arrayContaining([
          { path: "plugins.allow", message: "plugin not found: missing-allow" },
          { path: "plugins.deny", message: "plugin not found: missing-deny" },
          { path: "plugins.slots.memory", message: "plugin not found: missing-slot" },
        ]),
      );
    }
  });

  it("surfaces plugin config diagnostics", async () => {
    const home = await createCaseHome();
    const pluginDir = path.join(home, "bad-plugin");
    await writePluginFixture({
      dir: pluginDir,
      id: "bad-plugin",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "boolean" },
        },
        required: ["value"],
      },
    });

    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [pluginDir] },
        entries: { "bad-plugin": { config: { value: "nope" } } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hasIssue = res.issues.some(
        (issue) =>
          issue.path === "plugins.entries.bad-plugin.config" &&
          issue.message.includes("invalid config"),
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("allows disabled plugin entries without requiring plugin config", async () => {
    const home = await createCaseHome();
    const pluginDir = path.join(home, "required-config-plugin");
    await writePluginFixture({
      dir: pluginDir,
      id: "required-config-plugin",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          token: { type: "string" },
        },
        required: ["token"],
      },
    });

    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [pluginDir] },
        entries: {
          "required-config-plugin": {
            enabled: false,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("still validates explicit config on disabled plugin entries", async () => {
    const home = await createCaseHome();
    const pluginDir = path.join(home, "disabled-invalid-config-plugin");
    await writePluginFixture({
      dir: pluginDir,
      id: "disabled-invalid-config-plugin",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          token: { type: "string" },
        },
        required: ["token"],
      },
    });

    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [pluginDir] },
        entries: {
          "disabled-invalid-config-plugin": {
            enabled: false,
            config: {},
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({
        path: "plugins.entries.disabled-invalid-config-plugin.config",
        message: expect.stringContaining("invalid config"),
      });
    }
  });

  it("accepts SAT mining sweep and token runtime config", async () => {
    const home = await createCaseHome();
    const satMiningPluginDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../extensions/sat-mining",
    );
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [satMiningPluginDir] },
        entries: {
          "sat-mining": {
            enabled: true,
            config: {
              enabled: true,
              network: "devnet",
              automation: {
                autoFinalizeEpoch: true,
                autoClaim: true,
                satSweep: {
                  enabled: true,
                  destinationWalletId: "solana-2",
                  destinationAddress: "DSUtCCvUExampleRgmE4b",
                  mode: "all",
                  percentage: 100,
                  minRaw: "1",
                  keepRaw: "0",
                },
              },
              tokenConfig: {
                programId: "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75",
                mintAddress: "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa",
                mintProgramId: "TokenzQdBNbLqP5VEhdkAS6EPF5NTPZ4c88AuE9HnJQh",
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts known plugin ids", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      plugins: { enabled: false, entries: { discord: { enabled: true } } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts channels.modelByChannel", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { list: [{ id: "pi" }] },
      channels: {
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.2",
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts plugin heartbeat targets", async () => {
    const home = await createCaseHome();
    const pluginDir = path.join(home, "bluebubbles-plugin");
    await writePluginFixture({
      dir: pluginDir,
      id: "bluebubbles-plugin",
      channels: ["bluebubbles"],
      schema: { type: "object" },
    });

    const res = validateInHome(home, {
      agents: { defaults: { heartbeat: { target: "bluebubbles" } }, list: [{ id: "pi" }] },
      plugins: { enabled: false, load: { paths: [pluginDir] } },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown heartbeat targets", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: { defaults: { heartbeat: { target: "not-a-channel" } }, list: [{ id: "pi" }] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({
        path: "agents.defaults.heartbeat.target",
        message: "unknown heartbeat target: not-a-channel",
      });
    }
  });

  it("accepts heartbeat directPolicy enum values", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: {
        defaults: { heartbeat: { target: "last", directPolicy: "block" } },
        list: [{ id: "pi", heartbeat: { directPolicy: "allow" } }],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid heartbeat directPolicy values", async () => {
    const home = await createCaseHome();
    const res = validateInHome(home, {
      agents: {
        defaults: { heartbeat: { directPolicy: "maybe" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hasIssue = res.issues.some(
        (issue) => issue.path === "agents.defaults.heartbeat.directPolicy",
      );
      expect(hasIssue).toBe(true);
    }
  });
});
