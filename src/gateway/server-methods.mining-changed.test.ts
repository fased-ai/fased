import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listTaskRecords, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { GATEWAY_EVENT_MINING_CHANGED } from "./events.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-mining-methods-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests();
  await rm(stateDir, { recursive: true, force: true });
});

function buildContext(broadcast = vi.fn()) {
  return {
    broadcast,
    logGateway: {
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
}

async function runMiningMethod(params: { method: string; handler: GatewayRequestHandler }) {
  const respond = vi.fn();
  const context = buildContext();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "req-1",
      method: params.method,
      params: {},
    },
    respond,
    client: null,
    isWebchatConnect: noWebchat,
    context,
    extraHandlers: {
      [params.method]: params.handler,
    },
  });
  return { respond, context };
}

describe("gateway mining change events", () => {
  it("broadcasts mining.changed after a successful mining mutation", async () => {
    const { respond, context } = await runMiningMethod({
      method: "sat.startMining",
      handler: ({ respond }) =>
        respond(true, {
          ok: true,
          payload: {
            started: true,
            status: { running: true, enabledWanted: true },
          },
        }),
    });

    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      payload: {
        started: true,
        status: { running: true, enabledWanted: true },
      },
    });
    expect(context.broadcast).toHaveBeenCalledWith(
      GATEWAY_EVENT_MINING_CHANGED,
      expect.objectContaining({
        method: "sat.startMining",
        atMs: expect.any(Number),
        started: true,
        status: { running: true, enabledWanted: true },
      }),
      { dropIfSlow: true },
    );
    expect(listTaskRecords({ source: "mining" }).tasks).toHaveLength(0);
  });

  it("does not broadcast mining.changed after a failed mining mutation", async () => {
    const { context } = await runMiningMethod({
      method: "sat.stopMining",
      handler: ({ respond }) =>
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "blocked",
        }),
    });

    expect(context.broadcast).not.toHaveBeenCalled();
    expect(listTaskRecords({ source: "mining" }).tasks).toHaveLength(0);
  });
});
