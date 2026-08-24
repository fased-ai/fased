import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts/prepare-hosting-staging-overlay.sh");

describe("real Hosting staging overlay", () => {
  it("is executable, non-publishable, loopback-only, and identity-bound", async () => {
    const [source, metadata] = await Promise.all([readFile(scriptPath, "utf8"), stat(scriptPath)]);

    expect(metadata.mode & 0o111).not.toBe(0);
    expect(source).toContain('metadata_base="https://127.0.0.1:${LOOPBACK_PORT}/v${version}"');
    expect(source).toContain('role:"fased-hosting-staging-overlay",publishable:false');
    expect(source).toContain("fased-hosting-candidate.json");
    expect(source).toContain("fased-lifecycled-release.json");
    expect(source).toContain("fased-branch-trust");
    expect(source).toContain("fased-lifecycle-root-v1.json");
    expect(source).toContain("fased-release-index-v1.json.attestation.json");
    expect(source).toContain("fased-release-index-v2.json.attestation.json");
    expect(source).toContain("main.branchFixturePinnedRootSHA256");
    expect(source).toContain("staging installer release base is not unique");
    expect(source).toContain('source.replace(expected, `release_base="${replacement}"`)');
    expect(source).not.toContain("gh release");
  });
});
