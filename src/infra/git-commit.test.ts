import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

async function importFreshGitCommitModule() {
  vi.resetModules();
  return await import("./git-commit.js");
}

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `fased-${prefix}-`));
}

async function makeFakeGitRepo(
  root: string,
  options: {
    head: string;
    packedRefs?: Record<string, string>;
    refs?: Record<string, string>;
    gitdir?: string;
    commondir?: string;
  },
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const gitdir = options.gitdir ?? path.join(root, ".git");
  if (options.gitdir) {
    await fs.writeFile(path.join(root, ".git"), `gitdir: ${gitdir}\n`, "utf-8");
  }
  await fs.mkdir(gitdir, { recursive: true });
  await fs.writeFile(path.join(gitdir, "HEAD"), options.head, "utf-8");
  const refsBase = options.commondir ? path.resolve(gitdir, options.commondir) : gitdir;
  await fs.mkdir(refsBase, { recursive: true });
  if (options.commondir) {
    await fs.writeFile(path.join(gitdir, "commondir"), `${options.commondir}\n`, "utf-8");
  }
  for (const [refPath, commit] of Object.entries(options.refs ?? {})) {
    const targetPath = path.join(refsBase, refPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, `${commit}\n`, "utf-8");
  }
  const packedRefsEntries = Object.entries(options.packedRefs ?? {});
  if (packedRefsEntries.length > 0) {
    const packedRefsContents = [
      "# pack-refs with: peeled fully-peeled sorted",
      ...packedRefsEntries.map(([refPath, commit]) => `${commit} ${refPath}`),
    ].join("\n");
    await fs.writeFile(path.join(refsBase, "packed-refs"), `${packedRefsContents}\n`, "utf-8");
  }
}

describe("resolveCommitHash", () => {
  it("reads loose refs from the common git dir for worktree-style checkouts", async () => {
    const temp = await makeTempDir("git-commit-common-loose-ref");
    const checkoutRoot = path.join(temp, "checkout");
    const commonGitDir = path.join(temp, "git-common");
    const worktreeGitDir = path.join(commonGitDir, "worktrees", "checkout");

    await makeFakeGitRepo(checkoutRoot, {
      gitdir: worktreeGitDir,
      commondir: "../..",
      head: "ref: refs/heads/main\n",
      refs: {
        "refs/heads/main": "fedcba9876543210fedcba9876543210fedcba98",
      },
    });

    const { resolveCommitHash } = await importFreshGitCommitModule();

    expect(resolveCommitHash({ cwd: checkoutRoot, env: {} })).toBe("fedcba9");
  });

  it("reads packed refs from the common git dir for worktree-style checkouts", async () => {
    const temp = await makeTempDir("git-commit-packed-refs");
    const checkoutRoot = path.join(temp, "checkout");
    const commonGitDir = path.join(temp, "git-common");
    const worktreeGitDir = path.join(commonGitDir, "worktrees", "checkout");

    await makeFakeGitRepo(checkoutRoot, {
      gitdir: worktreeGitDir,
      commondir: "../..",
      head: "ref: refs/heads/main\n",
      packedRefs: {
        "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
      },
    });

    const { resolveCommitHash } = await importFreshGitCommitModule();

    expect(resolveCommitHash({ cwd: checkoutRoot, env: {} })).toBe("0123456");
  });

  it("rejects traversal in HEAD ref contents", async () => {
    const temp = await makeTempDir("git-commit-ref-traversal");
    const repoRoot = path.join(temp, "repo");

    await makeFakeGitRepo(repoRoot, {
      head: "ref: refs/heads/../../outside\n",
      refs: {
        outside: "1111111111111111111111111111111111111111",
      },
    });

    const { resolveCommitHash } = await importFreshGitCommitModule();

    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBeNull();
  });
});
