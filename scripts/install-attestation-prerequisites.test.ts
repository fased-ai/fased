import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(path.resolve(import.meta.dirname, "..", "install.sh"), "utf8");

function shellFunction(name: string): string {
  const start = installer.indexOf(`${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = installer.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return installer.slice(start, end + 3);
}

describe("official release attestation prerequisites", () => {
  it("automatically provisions a current GitHub CLI on macOS through Homebrew", () => {
    const fn = shellFunction("install_current_github_cli_bootstrap");
    expect(fn).toContain("brew install gh || brew upgrade gh");
    expect(fn).toContain("gh attestation verify --help");
  });

  it("does not silently skip attestation verification when auto-install is disabled", () => {
    const fn = shellFunction("install_current_github_cli_bootstrap");
    expect(fn).toContain('[[ "$auto_install" -eq 1 ]] || return 1');
    expect(fn).toContain("return 1");
  });
});
