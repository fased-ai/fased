import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";

describe("fixed managed lifecycle update client", () => {
  it("binds root and unprivileged invocations to the same fixed bootstrap", () => {
    const bootstrap = "/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap";
    expect(__testing.fixedInvocation(bootstrap, ["--channel", "beta"], 0)).toEqual({
      command: bootstrap,
      args: ["update", "--channel", "beta"],
    });
    expect(__testing.fixedInvocation(bootstrap, ["--channel", "stable"], 1000)).toEqual({
      command: "/usr/bin/sudo",
      args: [bootstrap, "update", "--channel", "stable"],
    });
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
