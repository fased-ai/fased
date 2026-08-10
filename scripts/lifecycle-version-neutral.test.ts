import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("version-neutral lifecycle acceptance", () => {
  it("requires explicit public predecessor identities and has no private-RC scenario", async () => {
    const wrapper = await readFile(
      resolve(repoRoot, "scripts/test-protected-local-systemd-container.sh"),
      "utf8",
    );
    const fixture = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/run.sh"),
      "utf8",
    );

    for (const source of [wrapper, fixture]) {
      expect(source).not.toMatch(/0\.1\.76-rc\./u);
      expect(source).not.toContain("legacy-takeover");
      expect(source).not.toContain("modern-update");
    }
    expect(wrapper).toContain("FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION");
    expect(wrapper).toContain("managed-update");
  });

  it("binds candidate P1 to an explicit supported public predecessor", async () => {
    const source = await readFile(
      resolve(repoRoot, ".github/workflows/hosted-runtime-release.yml"),
      "utf8",
    );
    const workflow = parse(source) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      jobs?: Record<string, { steps?: Array<{ env?: Record<string, string>; name?: string }> }>;
    };
    expect(workflow.on?.workflow_dispatch?.inputs).toHaveProperty("predecessor_version");
    expect(workflow.on?.workflow_dispatch?.inputs).not.toHaveProperty("predecessor_scenario");
    const update = workflow.jobs?.["p1-local-update"]?.steps?.find((candidate) =>
      candidate.name?.includes("supported-stable update P1"),
    );
    const fresh = workflow.jobs?.["p1-local-fresh"]?.steps?.find((candidate) =>
      candidate.name?.includes("fresh Local P1"),
    );
    expect(update?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "${{ needs.validate.outputs.p1_scenarios }}",
      FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION: "${{ inputs.predecessor_version }}",
    });
    expect(fresh?.env).toMatchObject({
      FASED_SYSTEMD_FIXTURE_SCENARIOS: "fresh-install",
    });
  });
});
