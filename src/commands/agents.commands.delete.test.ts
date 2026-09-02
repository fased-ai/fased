import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const financialMocks = vi.hoisted(() => ({
  find: vi.fn(),
  detach: vi.fn(() => ({ detached: false })),
}));
const moveToTrashMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../agents/financial-agent-binding.js", () => ({
  findFinancialAgentBindingForLocalAgent: financialMocks.find,
  detachFinancialAgentWorkspace: financialMocks.detach,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  moveToTrash: moveToTrashMock,
}));

import { agentsDeleteCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents delete command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    financialMocks.detach.mockReturnValue({ detached: false });
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { list: [{ id: "wally", workspace: "/tmp/wally" }] } },
    });
  });

  it("detaches a financial identity before removing local Agent state", async () => {
    financialMocks.detach.mockReturnValue({
      detached: true,
      fasedAgentRecord: "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh",
    });

    await agentsDeleteCommand({ id: "wally", force: true, json: true }, runtime);

    expect(financialMocks.find).toHaveBeenCalledWith("wally");
    expect(financialMocks.detach).toHaveBeenCalledWith({ localAgentId: "wally" });
    expect(writeConfigFileMock).toHaveBeenCalledOnce();
    expect(moveToTrashMock).toHaveBeenCalledTimes(3);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"action": "detached"'));
  });

  it("fails closed before config or workspace deletion when binding state is unreadable", async () => {
    financialMocks.find.mockImplementationOnce(() => {
      throw new Error("financial Agent binding store is unreadable");
    });

    await expect(
      agentsDeleteCommand({ id: "wally", force: true, json: true }, runtime),
    ).rejects.toThrow("binding store is unreadable");
    expect(financialMocks.detach).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(moveToTrashMock).not.toHaveBeenCalled();
  });
});
