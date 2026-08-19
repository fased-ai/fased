import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registryClose: vi.fn(),
  definitionClose: vi.fn(),
  fence: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock("./task-registry.js", () => ({
  closeTaskRegistryLedgerForLifecycle: mocks.registryClose,
}));

vi.mock("./task-definition-ledger.js", () => ({
  closeTaskDefinitionLedgerForLifecycle: mocks.definitionClose,
}));

vi.mock("./task-ledger-store.js", () => ({
  fenceTaskLedgerWritersForLifecycle: mocks.fence,
}));

vi.mock("./task-ledger-quiesce.js", () => ({
  acknowledgeTaskLedgerQuiesceRequest: mocks.acknowledge,
}));

import { checkpointAndCloseTaskLedgersForLifecycle } from "./task-ledger-lifecycle.js";

describe("task ledger lifecycle closure", () => {
  it("closes registry then definitions deterministically", () => {
    const calls: string[] = [];
    mocks.registryClose.mockImplementation(() => calls.push("registry"));
    mocks.definitionClose.mockImplementation(() => calls.push("definitions"));

    checkpointAndCloseTaskLedgersForLifecycle();

    expect(calls).toEqual(["registry", "definitions"]);
  });

  it("attempts both handles and propagates the first checkpoint failure", () => {
    const failure = new Error("registry WAL checkpoint failed");
    const calls: string[] = [];
    mocks.registryClose.mockImplementation(() => {
      calls.push("registry");
      throw failure;
    });
    mocks.definitionClose.mockImplementation(() => calls.push("definitions"));

    expect(() => checkpointAndCloseTaskLedgersForLifecycle()).toThrow(failure);
    expect(calls).toEqual(["registry", "definitions"]);
  });

  it("fences before managed checkpoint and acknowledges only a managed stop", () => {
    const calls: string[] = [];
    mocks.fence.mockImplementation(() => calls.push("fence"));
    mocks.registryClose.mockImplementation(() => calls.push("registry"));
    mocks.definitionClose.mockImplementation(() => calls.push("definitions"));
    mocks.acknowledge.mockImplementation(() => calls.push("ack"));

    checkpointAndCloseTaskLedgersForLifecycle({ managedStop: true });
    expect(calls).toEqual(["fence", "registry", "definitions", "ack"]);

    calls.length = 0;
    checkpointAndCloseTaskLedgersForLifecycle({ managedStop: false });
    expect(calls).toEqual(["registry", "definitions"]);
  });
});
