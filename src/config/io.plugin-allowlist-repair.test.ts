import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

async function waitForPersistedAllowlist(
  configPath: string,
  expectedAllowlist: string[],
): Promise<void> {
  const deadline = Date.now() + 3_000;
  let lastAllowlist: unknown = undefined;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      plugins?: { allow?: string[] };
    };
    lastAllowlist = parsed.plugins?.allow;
    if (JSON.stringify(parsed.plugins?.allow ?? []) === JSON.stringify(expectedAllowlist)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `timed out waiting for plugins.allow repair persistence; last=${JSON.stringify(lastAllowlist)}`,
  );
}

async function waitForPersistedAllowlistContaining(
  configPath: string,
  expectedPluginId: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  let lastAllowlist: unknown = undefined;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      plugins?: { allow?: string[] };
    };
    lastAllowlist = parsed.plugins?.allow;
    if (parsed.plugins?.allow?.includes(expectedPluginId) === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `timed out waiting for plugins.allow to include ${expectedPluginId}; last=${JSON.stringify(lastAllowlist)}`,
  );
}

describe("config io plugin allowlist repair", () => {
  it("pins previously installed plugins when plugins.allow is still empty", async () => {
    await withTempHome("fased-plugin-allowlist-repair-", async (home) => {
      const configPath = path.join(home, ".fased", "fased.json");
      const pluginPath = path.join(home, "extensions", "feishu", "index.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, 'export default { id: "feishu", register() {} };', "utf-8");
      await fs.writeFile(
        path.join(path.dirname(pluginPath), "fased.plugin.json"),
        JSON.stringify({ id: "feishu", configSchema: { type: "object", properties: {} } }),
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            plugins: {
              allow: [],
              load: { paths: [pluginPath] },
              entries: {
                feishu: { enabled: true },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });
      const cfg = io.loadConfig();

      expect(cfg.plugins?.allow).toEqual(["feishu", "memory-core"]);
      await waitForPersistedAllowlist(configPath, ["feishu", "memory-core"]);
    });
  });

  it("repairs existing allowlists that accidentally block the default memory plugin", async () => {
    await withTempHome("fased-memory-allowlist-repair-", async (home) => {
      const configPath = path.join(home, ".fased", "fased.json");
      const pluginPath = path.join(home, "extensions", "feishu", "index.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, 'export default { id: "feishu", register() {} };', "utf-8");
      await fs.writeFile(
        path.join(path.dirname(pluginPath), "fased.plugin.json"),
        JSON.stringify({ id: "feishu", configSchema: { type: "object", properties: {} } }),
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            plugins: {
              allow: ["feishu"],
              load: { paths: [pluginPath] },
              entries: {
                feishu: { enabled: true },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });
      const cfg = io.loadConfig();

      expect(cfg.plugins?.allow).toEqual(["feishu", "memory-core"]);
      await waitForPersistedAllowlistContaining(configPath, "memory-core");
    });
  });

  it("repairs configured plugin allowlist entries before validation warnings are emitted", async () => {
    await withTempHome("fased-configured-plugin-allowlist-repair-", async (home) => {
      const configPath = path.join(home, ".fased", "fased.json");
      const pluginPath = path.join(home, "extensions", "feishu", "index.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, 'export default { id: "feishu", register() {} };', "utf-8");
      await fs.writeFile(
        path.join(path.dirname(pluginPath), "fased.plugin.json"),
        JSON.stringify({ id: "feishu", configSchema: { type: "object", properties: {} } }),
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            plugins: {
              allow: ["memory-core"],
              load: { paths: [pluginPath] },
              entries: {
                feishu: {
                  enabled: true,
                  config: { appId: "cli_123" },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const warnings: string[] = [];
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: (msg) => warnings.push(String(msg)), error: () => {} },
      });
      const cfg = io.loadConfig();

      expect(cfg.plugins?.allow).toEqual(["feishu", "memory-core"]);
      expect(warnings.join("\n")).not.toContain("plugin disabled (not in allowlist)");
      await waitForPersistedAllowlist(configPath, ["feishu", "memory-core"]);
    });
  });
});
