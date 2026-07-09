import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUpdateStatus, compareSemverStrings, resolveNpmChannelTag } from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  let versionByTag: Record<string, string | null>;
  let requestedUrls: string[];

  beforeEach(() => {
    versionByTag = {};
    requestedUrls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(url);
        const tag = decodeURIComponent(url.split("/").pop() ?? "");
        const version = versionByTag[tag] ?? null;
        return {
          ok: version != null,
          status: version != null ? 200 : 404,
          json: async () => ({ version }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
    expect(requestedUrls.every((url) => url.includes("%40fased%2Ffased"))).toBe(true);
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });
});

describe("checkUpdateStatus", () => {
  it("reports hosted package-cache installs as npm even when package.json declares pnpm", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-update-check-"));
    const pkgRoot = path.join(
      root,
      ".fased",
      "install-cache",
      "npm-global",
      "lib",
      "node_modules",
      "@fased",
      "fased",
    );
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "@fased/fased", version: "1.0.0", packageManager: "pnpm@10.23.0" }),
      "utf-8",
    );

    try {
      const status = await checkUpdateStatus({
        root: pkgRoot,
        timeoutMs: 1000,
        fetchGit: false,
        includeRegistry: false,
      });

      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("npm");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
