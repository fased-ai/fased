import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { nodeHandlers } from "./nodes.js";

const mocks = vi.hoisted(() => ({
  approveNodePairing: vi.fn(),
  listNodePairing: vi.fn(),
  rejectNodePairing: vi.fn(),
  removePairedNode: vi.fn(),
  renamePairedNode: vi.fn(),
  requestNodePairing: vi.fn(),
  verifyNodeToken: vi.fn(),
}));

vi.mock("../../infra/node-pairing.js", () => ({
  approveNodePairing: mocks.approveNodePairing,
  listNodePairing: mocks.listNodePairing,
  rejectNodePairing: mocks.rejectNodePairing,
  removePairedNode: mocks.removePairedNode,
  renamePairedNode: mocks.renamePairedNode,
  requestNodePairing: mocks.requestNodePairing,
  verifyNodeToken: mocks.verifyNodeToken,
}));

describe("node pairing gateway methods", () => {
  it("removes a stale paired node and broadcasts the resolution", async () => {
    mocks.removePairedNode.mockResolvedValueOnce({ nodeId: "node-1" });
    const respond = vi.fn();
    const broadcast = vi.fn();

    await nodeHandlers["node.pair.remove"]({
      req: { type: "req", id: "req-node-remove", method: "node.pair.remove" },
      params: { nodeId: "node-1" },
      respond,
      context: { broadcast } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.removePairedNode).toHaveBeenCalledWith("node-1");
    expect(broadcast).toHaveBeenCalledWith(
      "node.pair.resolved",
      expect.objectContaining({ nodeId: "node-1", decision: "removed" }),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
  });

  it("returns invalid request when removing an unknown paired node", async () => {
    mocks.removePairedNode.mockResolvedValueOnce(null);
    const respond = vi.fn();

    await nodeHandlers["node.pair.remove"]({
      req: { type: "req", id: "req-node-remove-missing", method: "node.pair.remove" },
      params: { nodeId: "missing-node" },
      respond,
      context: { broadcast: vi.fn() } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as
      | [boolean, unknown, { code?: number; message?: string }]
      | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toBe("unknown nodeId");
  });
});
