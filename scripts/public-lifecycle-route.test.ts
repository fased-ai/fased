import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = (path: string) => readFile(resolve(root, path), "utf8");

describe("D7 public lifecycle routing", () => {
  it("keeps the public installer a bounded static-bootstrap shim", async () => {
    const installer = await source("install.sh");
    expect(installer.split("\n").length).toBeLessThanOrEqual(300);
    expect(installer).toContain("fased-bootstrap-linux-");
    expect(installer).toContain("bootstrap_args=(\n  install");
    expect(installer).toContain('"$bootstrap" "${bootstrap_args[@]}"');
    expect(installer).toContain("__FASED_BOOTSTRAP_SHA256_X64__");
    expect(installer).toContain("__FASED_BOOTSTRAP_SHA256_ARM64__");
    expect(installer).toContain("scripts/install-development.sh");
    expect(installer).not.toMatch(/\b(?:node|nodejs|npm|pnpm|gh|jq)\b/u);
    expect(installer).not.toContain("generation-updater.mjs");
  });

  it("routes managed update through the fixed bootstrap before the application generation", async () => {
    const launcher = await source("tools/fased-lifecycled/platform/cli_launcher.go");
    const route = await source("tools/fased-lifecycled/cmd/fased-bootstrap/route.go");
    expect(launcher).toContain("/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap");
    expect(launcher).toContain("managed_update=0");
    expect(launcher).toContain('[[ "${1:-}" == "--update" ]]');
    expect(launcher.indexOf("managed_update=0")).toBeLessThan(
      launcher.indexOf('current="$install_root/current"'),
    );
    expect(route).toContain("discoverPublicReleaseVersion");
    expect(route).toContain("api.github.com/repos/fased-ai/fased/releases");
    expect(route).not.toContain("registry.npmjs.org");
  });

  it("keeps development installation explicit and outside the public shim", async () => {
    const developer = await source("scripts/install-development.sh");
    expect(developer).toContain("pnpm");
    expect(developer).toContain("build:fast");
    expect((await stat(resolve(root, "scripts/install-development.sh"))).isFile()).toBe(true);
  });

  it("keeps default output bounded and exposes an explicit verbose switch", async () => {
    const installer = await source("install.sh");
    expect(installer).toContain("--verbose");
    expect(installer).toContain("curl_args=(-fL --proto '=https' --tlsv1.2");
    expect(installer).toContain('if [[ "$verbose" -eq 0 ]]; then curl_args+=(-sS); fi');
    expect(installer).not.toContain("set -x");
  });
});
