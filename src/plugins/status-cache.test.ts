import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import { readValidPluginStatusCache, writePluginStatusCache } from "./status-cache.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin status cache", () => {
  it("accepts matching config, version, and source mtimes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-plugin-status-"));
    roots.push(root);
    const configPath = path.join(root, "fased.json");
    const source = path.join(root, "index.js");
    const cachePath = path.join(root, "plugin-status.json");
    fs.writeFileSync(configPath, "{}\n");
    fs.writeFileSync(source, "export default {};\n");
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "test",
      name: "Test",
      source,
      origin: "bundled",
      enabled: true,
      status: "loaded",
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    });
    writePluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3", registry });
    expect(
      readValidPluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3" })?.plugins[0]
        ?.id,
    ).toBe("test");
  });

  it("rejects stale versions and changed sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-plugin-status-"));
    roots.push(root);
    const configPath = path.join(root, "fased.json");
    const source = path.join(root, "index.js");
    const cachePath = path.join(root, "plugin-status.json");
    fs.writeFileSync(configPath, "{}\n");
    fs.writeFileSync(source, "export default {};\n");
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "test",
      name: "Test",
      source,
      origin: "bundled",
      enabled: true,
      status: "loaded",
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    });
    writePluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3", registry });
    expect(
      readValidPluginStatusCache({ cachePath, configPath, packageVersion: "2.0.0" }),
    ).toBeNull();
    fs.appendFileSync(source, "// changed\n");
    expect(
      readValidPluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3" }),
    ).toBeNull();
  });

  it("ignores unrelated config rewrites and rejects plugin config changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-plugin-status-"));
    roots.push(root);
    const configPath = path.join(root, "fased.json");
    const cachePath = path.join(root, "plugin-status.json");
    fs.writeFileSync(configPath, '{"plugins":{"entries":{}},"gateway":{"port":1}}\n');
    const registry = createEmptyPluginRegistry();
    writePluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3", registry });
    fs.writeFileSync(configPath, '{"gateway":{"port":2},"plugins":{"entries":{}}}\n');
    expect(
      readValidPluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3" }),
    ).not.toBeNull();
    fs.writeFileSync(
      configPath,
      '{"gateway":{"port":2},"plugins":{"entries":{"sat-mining":{"enabled":true}}}}\n',
    );
    expect(
      readValidPluginStatusCache({ cachePath, configPath, packageVersion: "1.2.3" }),
    ).toBeNull();
  });
});
