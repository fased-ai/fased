import { withFileLock } from "../../infra/file-lock.js";
import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();
const STORE_FILE_LOCK_OPTIONS = {
  retries: {
    retries: 80,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 60_000,
};

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(() =>
    withFileLock(storePath, STORE_FILE_LOCK_OPTIONS, fn),
  );

  // Keep the chain alive even when the operation fails.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  return (await next) as T;
}
