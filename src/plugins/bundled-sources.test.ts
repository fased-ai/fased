import { beforeEach, describe, expect, it, vi } from "vitest";
import { findBundledPluginByNpmSpec, resolveBundledPluginSources } from "./bundled-sources.js";

const discoverFasedAgentPluginsMock = vi.fn();
const loadPluginManifestMock = vi.fn();

vi.mock("./discovery.js", () => ({
  discoverFasedAgentPlugins: (...args: unknown[]) => discoverFasedAgentPluginsMock(...args),
}));

vi.mock("./manifest.js", () => ({
  loadPluginManifest: (...args: unknown[]) => loadPluginManifestMock(...args),
}));

describe("bundled plugin sources", () => {
  beforeEach(() => {
    discoverFasedAgentPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });

  it("resolves bundled sources keyed by plugin id", () => {
    discoverFasedAgentPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "global",
          rootDir: "/global/feishu",
          packageName: "@fased/feishu",
          packageManifest: { install: { localPath: "extensions/feishu" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/feishu",
          packageName: "@fased/feishu",
          packageManifest: { install: { localPath: "extensions/feishu" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/feishu-dup",
          packageName: "@fased/feishu",
          packageManifest: { install: { localPath: "extensions/feishu" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/msteams",
          packageName: "@fased/msteams",
          packageManifest: { install: { npmSpec: "@fased/msteams" } },
        },
      ],
      diagnostics: [],
    });

    loadPluginManifestMock.mockImplementation((rootDir: string) => {
      if (rootDir === "/app/extensions/feishu") {
        return { ok: true, manifest: { id: "feishu" } };
      }
      if (rootDir === "/app/extensions/msteams") {
        return { ok: true, manifest: { id: "msteams" } };
      }
      return {
        ok: false,
        error: "invalid manifest",
        manifestPath: `${rootDir}/fased.plugin.json`,
      };
    });

    const map = resolveBundledPluginSources({});

    expect(Array.from(map.keys())).toEqual(["feishu", "msteams"]);
    expect(map.get("feishu")).toEqual({
      pluginId: "feishu",
      localPath: "/app/extensions/feishu",
      npmSpec: undefined,
    });
  });

  it("finds bundled source by npm spec", () => {
    discoverFasedAgentPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "bundled",
          rootDir: "/app/extensions/msteams",
          packageName: "@fased/msteams",
          packageManifest: { install: { npmSpec: "@fased/msteams" } },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestMock.mockReturnValue({ ok: true, manifest: { id: "msteams" } });

    const resolved = findBundledPluginByNpmSpec({ spec: "@fased/msteams" });
    const missing = findBundledPluginByNpmSpec({ spec: "@fased/not-found" });

    expect(resolved?.pluginId).toBe("msteams");
    expect(resolved?.localPath).toBe("/app/extensions/msteams");
    expect(missing).toBeUndefined();
  });
});
