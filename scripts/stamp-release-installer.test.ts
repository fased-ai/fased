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
    const x64 = path.join(root, "bootstrap-x64");
    const arm64 = path.join(root, "bootstrap-arm64");
    await fsp.writeFile(x64, "x64-bootstrap");
    await fsp.writeFile(arm64, "arm64-bootstrap");
    await fsp.writeFile(
      source,
      '#!/usr/bin/env bash\ninstall_entry_release_identity="__FASED_RELEASE_IDENTITY__"\nbootstrap_sha256_x64="__FASED_BOOTSTRAP_SHA256_X64__"\nbootstrap_sha256_arm64="__FASED_BOOTSTRAP_SHA256_ARM64__"\n',
    );

    await stampReleaseInstaller({
      source,
      output,
      version: "1.2.3-rc.4",
      bootstrapX64: x64,
      bootstrapArm64: arm64,
    });

    const stamped = await fsp.readFile(output, "utf8");
    expect(stamped).toContain('install_entry_release_identity="1.2.3-rc.4"');
    expect(stamped).not.toContain("__FASED_BOOTSTRAP_SHA256_");
    expect((await fsp.stat(output)).mode & 0o777).toBe(0o755);
  });

  it("rejects malformed versions and ambiguous source markers", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-installer-stamp-"));
    const source = path.join(root, "install.sh");
    const output = path.join(root, "release-install.sh");
    const marker = 'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"\n';
    await fsp.writeFile(source, `${marker}${marker}`);

    await expect(
      stampReleaseInstaller({
        source,
        output,
        version: "1.2.3",
        bootstrapX64: source,
        bootstrapArm64: source,
      }),
    ).rejects.toThrow("missing or ambiguous");
    await expect(
      stampReleaseInstaller({
        source,
        output,
        version: "latest",
        bootstrapX64: source,
        bootstrapArm64: source,
      }),
    ).rejects.toThrow("not canonical");
  });
});
