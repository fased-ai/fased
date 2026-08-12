import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";

describe("fixed managed lifecycle update client", () => {
  it("binds root and unprivileged invocations to the same fixed bootstrap", () => {
    const bootstrap = "/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap";
    expect(__testing.fixedInvocation(bootstrap, ["--channel", "beta"], 0, "hosting")).toEqual({
      command: bootstrap,
      args: ["update", "--profile", "hosting", "--channel", "beta"],
    });
    expect(
      __testing.fixedInvocation(bootstrap, ["--channel", "stable"], 1000, "protected-local"),
    ).toEqual({
      command: "/usr/bin/sudo",
      args: [bootstrap, "update", "--profile", "protected-local", "--channel", "stable"],
    });
  });

  it("resolves a channel hint to an exact version before root bootstrap", async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      requested.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return new Response(JSON.stringify({ version: "0.1.76-rc.74" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      __testing.resolveLifecycleArgs(["--channel", "beta", "--json"], { fetchImpl }),
    ).resolves.toEqual(["--channel", "beta", "--json", "--version", "0.1.76-rc.74"]);
    expect(requested).toEqual(["https://registry.npmjs.org/@fased%2ffased/beta"]);
  });

  it("uses the GitHub release list when the optional npm hint is unavailable", async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      requested.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      if (requested.length === 1) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify([
          { tag_name: "v0.1.75", draft: false, prerelease: false },
          { tag_name: "v0.1.76-rc.74", draft: false, prerelease: true },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      __testing.resolveLifecycleArgs(["--channel", "beta"], { fetchImpl }),
    ).resolves.toEqual(["--channel", "beta", "--version", "0.1.76-rc.74"]);
    expect(requested).toEqual([
      "https://registry.npmjs.org/@fased%2ffased/beta",
      "https://api.github.com/repos/fased-ai/fased/releases?per_page=100",
    ]);
  });

  it("does not resolve or replace an explicit immutable version", async () => {
    const fetchImpl = async () => {
      throw new Error("unexpected channel lookup");
    };
    await expect(
      __testing.resolveLifecycleArgs(["--channel", "beta", "--version", "0.1.76-rc.74"], {
        fetchImpl,
      }),
    ).resolves.toEqual(["--channel", "beta", "--version", "0.1.76-rc.74"]);
  });

  it("rejects malformed channel hints before root invocation", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ version: "../../mutable" }), { status: 200 });
    await expect(
      __testing.resolveLifecycleArgs(["--channel", "beta"], { fetchImpl }),
    ).rejects.toThrow("exact immutable release");
  });

  it("accepts only canonical installed lifecycle profiles", () => {
    expect(__testing.requireInstalledProfile("hosting")).toBe("hosting");
    expect(__testing.requireInstalledProfile("protected-local")).toBe("protected-local");
    expect(() => __testing.requireInstalledProfile(undefined)).toThrow("profile");
    expect(() => __testing.requireInstalledProfile("portable")).toThrow("profile");
  });

  it("rejects mutable, linked, or wrongly-mode fixed clients", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-fixed-update-"));
    const client = path.join(root, "fased-bootstrap");
    await fsp.writeFile(client, "bootstrap", { mode: 0o555 });
    await expect(__testing.requireFixedBootstrap(client, process.getuid?.() ?? 0)).resolves.toBe(
      client,
    );
    await fsp.chmod(client, 0o755);
    await expect(__testing.requireFixedBootstrap(client, process.getuid?.() ?? 0)).rejects.toThrow(
      "unsafe",
    );
  });

  it("executes when the installed entrypoint traverses the current-generation symlink", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-fixed-update-main-"));
    const generation = path.join(root, "generations", "target");
    const entrypoint = path.join(generation, "scripts", "fased-managed-updater.mjs");
    await fsp.mkdir(path.dirname(entrypoint), { recursive: true });
    await fsp.writeFile(entrypoint, "// fixture\n");
    await fsp.symlink(generation, path.join(root, "current"));

    expect(
      __testing.isMainModule(
        path.join(root, "current", "scripts", "fased-managed-updater.mjs"),
        pathToFileURL(entrypoint).href,
      ),
    ).toBe(true);
  });
});
