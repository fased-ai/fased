import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());
const cleanStaleGatewayProcessesSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("./restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync: vi.fn(),
}));

import { triggerFasedAgentRestart } from "./restart.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("managed restart boundary", () => {
  it("refuses host service mutation before cleanup or supervisor commands", () => {
    vi.stubEnv("FASED_RUNTIME_SOURCE", "go-lifecycle");

    expect(triggerFasedAgentRestart()).toMatchObject({
      ok: false,
      method: "supervisor",
      detail: expect.stringContaining("verified Go lifecycle"),
    });
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
