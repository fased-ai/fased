import { describe, expect, it } from "vitest";
import {
  classifyChangedTestPath,
  createChangedTestCommands,
  parseChangedTestPathsJson,
} from "./ci-run-changed-tests.mjs";

describe("exact changed-test runner", () => {
  it("routes root, Gateway, and extension tests through matching configs", () => {
    expect(
      createChangedTestCommands(["src/config/io.plugin-allowlist-repair.test.ts"], "unit")[0],
    ).toMatchObject({
      args: expect.arrayContaining([
        "--config",
        "vitest.config.ts",
        "src/config/io.plugin-allowlist-repair.test.ts",
      ]),
    });
    expect(
      createChangedTestCommands(["src/gateway/server-methods/agent.test.ts"], "gateway")[0],
    ).toMatchObject({
      args: expect.arrayContaining([
        "--config",
        "vitest.gateway.config.ts",
        "src/gateway/server-methods/agent.test.ts",
      ]),
    });
    expect(
      createChangedTestCommands(["extensions/slack/src/channel.test.ts"], "extensions")[0],
    ).toMatchObject({
      args: expect.arrayContaining([
        "--config",
        "vitest.extensions.config.ts",
        "extensions/slack/src/channel.test.ts",
      ]),
    });
  });

  it("runs UI node and ordinary tests separately from browser tests", () => {
    const commands = createChangedTestCommands(
      [
        "ui/src/ui/views/instances.test.ts",
        "ui/src/ui/views/mining-strategy-evidence.node.test.ts",
        "ui/src/ui/views/nodes.browser.test.ts",
      ],
      "ui",
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]?.args).toEqual(
      expect.arrayContaining([
        "--config",
        "vitest.changed-node.config.ts",
        "src/ui/views/instances.test.ts",
        "src/ui/views/mining-strategy-evidence.node.test.ts",
      ]),
    );
    expect(commands[1]?.args).toEqual(
      expect.arrayContaining([
        "--config",
        "vitest.config.ts",
        "src/ui/views/nodes.browser.test.ts",
      ]),
    );
  });

  it("rejects live, e2e, traversal, and unsupported test paths", () => {
    for (const path of [
      "src/gateway/server.live.test.ts",
      "test/install.e2e.test.ts",
      "src/config/io.live.spec.ts",
      "src/config/io.spec.ts",
      "../src/config/io.plugin-allowlist-repair.test.ts",
      "packages/sdk/src/io.test.ts",
      "tests/io.test.ts",
      "apps/ios/FasedAgentTests/FasedAgent.test.ts",
      "vendor/example.test.ts",
    ]) {
      expect(() => classifyChangedTestPath(path), path).toThrow();
    }
  });

  it("parses, sorts, and deduplicates trusted JSON without accepting an empty list", () => {
    expect(parseChangedTestPathsJson('["src/z.test.ts","src/a.test.ts","src/z.test.ts"]')).toEqual([
      "src/a.test.ts",
      "src/z.test.ts",
    ]);
    expect(() => parseChangedTestPathsJson("[]")).toThrow(/non-empty array/u);
  });
});
