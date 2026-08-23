import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const source = (path: string) => readFile(resolve(repoRoot, path), "utf8");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(resolve(repoRoot, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("version-neutral lifecycle release architecture", () => {
  it("builds one tag-shaped Linux-x64 artifact from package and git identity", async () => {
    const builder = await source("scripts/build-linux-x64-release-artifact.sh");
    expect(builder).toContain("package.json");
    expect(builder).toContain('git -C "$ROOT_DIR" rev-parse HEAD');
    expect(builder).toContain('git -C "$ROOT_DIR" rev-parse "${COMMIT}^{tree}"');
    expect(builder).toContain("pnpm-lock.yaml");
    expect(builder).toContain('FASED_SIGNER_TARGETS="linux/amd64"');
    expect(builder).toContain('FASED_LIFECYCLE_TARGETS="linux/amd64"');
    expect(builder).not.toMatch(/0\.1\.\d+-rc\.\d+/u);
  });

  it("keeps simulated acceptance out of release authority", async () => {
    for (const removed of [
      "scripts/run-lifecycle-local0.sh",
      "scripts/test-lifecycle-local-acceptance.sh",
      "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh",
      ".github/workflows/candidate-p1-replay.yml",
      ".github/workflows/candidate-publication-replay.yml",
    ]) {
      expect(await exists(removed), removed).toBe(false);
    }
    const preTag = await source(".github/workflows/pre-tag-p1.yml");
    expect(preTag).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(preTag).not.toContain("test-lifecycle-local-acceptance.sh");
  });

  it("marks every substituted fixture contract as SUPPORTING", async () => {
    const contract = JSON.parse(await source("config/lifecycle-acceptance.v2.json")) as {
      evidencePolicy: {
        branch: { evidenceClass: string; acquisitionEvidenceClass: string };
      };
    };
    expect(contract.evidencePolicy.branch).toMatchObject({
      evidenceClass: "SUPPORTING",
      acquisitionEvidenceClass: "SUPPORTING",
    });
  });

  it("keeps candidate identity immutable without a historical-version branch", async () => {
    const preCandidate = await source(".github/workflows/pre-candidate.yml");
    const preTag = await source(".github/workflows/pre-tag-p1.yml");
    const release = await source(".github/workflows/hosted-runtime-release.yml");
    expect(preCandidate).toContain("NEXT_RELEASE_VERSION");
    expect(preCandidate).toContain(
      '! gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/v$NEXT_RELEASE_VERSION"',
    );
    expect(preTag).toContain(
      'test "$(node -p "require(\'./package.json\').version")" = "$RELEASE_VERSION"',
    );
    expect(release).toContain('test "$remote_tag_commit" = "$SOURCE_COMMIT"');
    for (const value of [preCandidate, preTag, release]) {
      expect(value).not.toMatch(/case\s+[^\n]*RELEASE_VERSION/u);
    }
  });

  it("builds optional component packs outside the core artifact", async () => {
    const builder = await source("scripts/build-linux-x64-release-artifact.sh");
    const packageJson = await source("package.json");
    expect(builder).not.toContain("hosted:component-packs");
    expect(packageJson).toContain('"hosted:component-packs"');
  });
});
