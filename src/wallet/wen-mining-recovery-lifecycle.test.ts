import { expect, it, vi } from "vitest";
import {
  createWenMiningRecoveryLifecycle,
  type WenRecoveryLifecycleConfig,
} from "./wen-mining-recovery-lifecycle.js";
import { scheduleWenMiningRecovery } from "./wen-mining-recovery.js";
vi.mock("./wen-mining-recovery.js", () => ({ scheduleWenMiningRecovery: vi.fn() }));
const result = {
  items: [],
  scanned: 0,
  scanComplete: true,
  nextCursor: "",
  signingEnabled: false as const,
};
const config = (): WenRecoveryLifecycleConfig => ({
  socketPath: "/socket",
  walletId: "miner",
  ticks: 1,
  intervalMs: 5000,
  request: vi.fn(),
  onResult: vi.fn(),
  onError: vi.fn(),
});
it("starts only explicitly and forwards a result", async () => {
  vi.mocked(scheduleWenMiningRecovery).mockImplementation(async function* () {
    yield result;
  });
  const life = createWenMiningRecoveryLifecycle();
  const c = config();
  await life.start(c);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(c.onResult).toHaveBeenCalledWith(result);
  await life.stop();
});
it("stop drains in-flight work and discards its result", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(scheduleWenMiningRecovery).mockImplementation(async function* () {
    await pending;
    yield result;
  });
  const life = createWenMiningRecoveryLifecycle(),
    c = config();
  await life.start(c);
  let stopped = false;
  const done = life.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await done;
  expect(c.onResult).not.toHaveBeenCalled();
  expect(c.onError).not.toHaveBeenCalled();
});
it("replacement drains old work before starting new configuration", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wallets: string[] = [];
  vi.mocked(scheduleWenMiningRecovery).mockImplementation(async function* (_socket, wallet) {
    wallets.push(wallet);
    if (wallet === "miner") {
      await pending;
    }
    yield result;
  });
  const life = createWenMiningRecoveryLifecycle(),
    old = config(),
    next = { ...config(), walletId: "next" };
  await life.start(old);
  const replaced = life.start(next);
  await Promise.resolve();
  expect(wallets).toEqual(["miner"]);
  release();
  await replaced;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(old.onResult).not.toHaveBeenCalled();
  expect(next.onResult).toHaveBeenCalledOnce();
  await life.stop();
});
it("stop invalidates queued starts", async () => {
  const c = config(),
    life = createWenMiningRecoveryLifecycle();
  const start = life.start(c);
  await life.stop();
  await start;
  expect(c.onResult).not.toHaveBeenCalled();
});
it("reports failure without an unhandled stop rejection", async () => {
  vi.mocked(scheduleWenMiningRecovery).mockImplementation(async function* () {
    throw Error("read failed");
    yield result;
  });
  const c = config();
  c.onError = vi.fn(() => {
    throw Error("callback failed");
  });
  const life = createWenMiningRecoveryLifecycle();
  await life.start(c);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(life.stop()).resolves.toBeUndefined();
  expect(c.onError).toHaveBeenCalledOnce();
});
