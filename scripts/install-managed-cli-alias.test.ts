import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileManagedCliAlias } from "./install-managed-cli-alias.mjs";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-cli-alias-"));
  const home = path.join(root, "home");
  const source = path.join(home, "fased", "fased.mjs");
  const target = path.join(home, ".fased", "install-cache", "npm-global", "bin", "fased");
  const alias = path.join(home, ".local", "bin", "fased");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.writeFileSync(source, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(target, "#!/usr/bin/env bash\nprintf 'managed\\n'\n", { mode: 0o755 });
  return { root, home, source, target, alias };
}

function installAlias(fixture: ReturnType<typeof createFixture>) {
  return reconcileManagedCliAlias({
    target: fixture.target,
    sourceLauncher: fixture.source,
    aliasPath: fixture.alias,
  });
}

describe("managed Fased CLI alias", () => {
  it("replaces an installer-owned source symlink with the managed CLI", () => {
    const fixture = createFixture();
    fs.symlinkSync(fixture.source, fixture.alias);

    installAlias(fixture);

    expect(fs.realpathSync(fixture.alias)).toBe(fs.realpathSync(fixture.target));
    expect(fs.readFileSync(fs.realpathSync(fixture.alias), "utf8")).toContain("managed");
  });

  it("replaces a relative symlink to the legacy source launcher", () => {
    const fixture = createFixture();
    fs.symlinkSync(path.relative(path.dirname(fixture.alias), fixture.source), fixture.alias);

    installAlias(fixture);

    expect(fs.realpathSync(fixture.alias)).toBe(fs.realpathSync(fixture.target));
  });

  it("replaces the wrapper emitted by the legacy source installer", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.alias, `#!/usr/bin/env bash\nexec '${fixture.source}' "$@"\n`, {
      mode: 0o755,
    });

    installAlias(fixture);

    expect(fs.realpathSync(fixture.alias)).toBe(fs.realpathSync(fixture.target));
  });

  it("does not overwrite an unrelated user-managed command", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.alias, "#!/usr/bin/env bash\nprintf 'custom\\n'\n", { mode: 0o755 });

    installAlias(fixture);

    expect(fs.lstatSync(fixture.alias).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(fixture.alias, "utf8")).toContain("custom");
  });
});
