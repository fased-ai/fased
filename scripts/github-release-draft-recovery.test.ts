import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const discoveryLibrary = resolve(repoRoot, "scripts/lib/github-release-draft.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createMockGh(): Promise<{ directory: string; state: string }> {
  const directory = await mkdtemp(join(tmpdir(), "fased-channel-draft-test."));
  temporaryDirectories.push(directory);
  const state = join(directory, "calls");
  const gh = join(directory, "gh");
  await writeFile(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$MOCK_STATE" ]]; then
  count="$(<"$MOCK_STATE")"
fi
count=$((count + 1))
printf '%s\\n' "$count" >"$MOCK_STATE"
if (( count < MOCK_VISIBLE_AFTER )); then
  printf '[[]]\\n'
  exit 0
fi
jq -cn \\
  --arg tag "$MOCK_TAG" \\
  --arg target "$MOCK_TARGET" \\
  --arg title "$MOCK_TITLE" \\
  --argjson id "$MOCK_DRAFT_ID" \\
  '[[{id:$id,tag_name:$tag,target_commitish:$target,name:$title,draft:true,prerelease:true}]]'
`,
    "utf8",
  );
  await chmod(gh, 0o755);
  return { directory, state };
}

async function discoverDraft(options: {
  attempts: number;
  draftId?: number;
  expectedTarget: string;
  observedTarget?: string;
  visibleAfter: number;
}): Promise<{ calls: number; stderr: string; stdout: string }> {
  const mock = await createMockGh();
  const tag = "fased-channel-beta-v1";
  const title = "Fased signed beta channel v1";
  const result = await execFileAsync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; fased_discover_github_release_draft "$2" "$3" "$4" "$5" "$6" 0',
      "fased-channel-draft-test",
      discoveryLibrary,
      "fased-ai/fased",
      tag,
      options.expectedTarget,
      title,
      String(options.attempts),
    ],
    {
      env: {
        ...process.env,
        MOCK_DRAFT_ID: String(options.draftId ?? 371108156),
        MOCK_STATE: mock.state,
        MOCK_TAG: tag,
        MOCK_TARGET: options.observedTarget ?? options.expectedTarget,
        MOCK_TITLE: title,
        MOCK_VISIBLE_AFTER: String(options.visibleAfter),
        PATH: `${mock.directory}:${process.env.PATH ?? ""}`,
      },
    },
  );
  return {
    calls: Number.parseInt(await readFile(mock.state, "utf8"), 10),
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

describe("GitHub channel draft recovery", () => {
  it("waits through delayed list visibility and returns the exact draft identity", async () => {
    const target = "f3f5570a8d89965c02ee578511e5647eb7e5071b";
    const result = await discoverDraft({
      attempts: 5,
      expectedTarget: target,
      visibleAfter: 3,
    });

    expect(result.stdout.trim()).toBe("371108156");
    expect(result.stderr).toBe("");
    expect(result.calls).toBe(3);
  });

  it("rejects a same-tag draft with a different source identity", async () => {
    const target = "f3f5570a8d89965c02ee578511e5647eb7e5071b";

    await expect(
      discoverDraft({
        attempts: 2,
        expectedTarget: target,
        observedTarget: "0000000000000000000000000000000000000000",
        visibleAfter: 1,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("conflicts with expected identity"),
    });
  });
});
