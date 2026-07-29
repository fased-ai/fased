import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stampReleaseInstaller } from "./stamp-release-installer.mjs";

describe("immutable release installer stamping", () => {
  it("binds the streamed entrypoint to one exact release identity", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-installer-stamp-"));
    const source = path.join(root, "install.sh");
    const output = path.join(root, "release-install.sh");
    await fsp.writeFile(
      source,
      '#!/usr/bin/env bash\ninstall_entry_release_identity="__FASED_RELEASE_IDENTITY__"\n',
    );

    await stampReleaseInstaller({ source, output, version: "1.2.3-rc.4" });

    expect(await fsp.readFile(output, "utf8")).toContain(
      'install_entry_release_identity="1.2.3-rc.4"',
    );
    expect((await fsp.stat(output)).mode & 0o777).toBe(0o755);
  });

  it("rejects malformed versions and ambiguous source markers", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-installer-stamp-"));
    const source = path.join(root, "install.sh");
    const output = path.join(root, "release-install.sh");
    const marker = 'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"\n';
    await fsp.writeFile(source, `${marker}${marker}`);

    await expect(stampReleaseInstaller({ source, output, version: "1.2.3" })).rejects.toThrow(
      "missing or ambiguous",
    );
    await expect(stampReleaseInstaller({ source, output, version: "latest" })).rejects.toThrow(
      "not canonical",
    );
  });
});
