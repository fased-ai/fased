import type {
  WenMiningRecoveryRequest,
  WenMiningRecoveryResult,
} from "./wen-mining-recovery-contract.js";
import { scheduleWenMiningRecovery } from "./wen-mining-recovery.js";

export type WenRecoveryLifecycleConfig = {
  socketPath: string;
  walletId: string;
  ticks: number;
  intervalMs: number;
  request: (signal: AbortSignal) => Promise<WenMiningRecoveryRequest>;
  onResult: (result: WenMiningRecoveryResult) => void;
  onError: (error: unknown) => void;
};

// Explicit WEN configuration only. Serial transitions drain the old socket call
// before starting its replacement; stop aborts immediately, even when queued.
export function createWenMiningRecoveryLifecycle() {
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  let transitions = Promise.resolve();
  let generation = 0;
  const stopActive = async () => {
    const old = active;
    if (old) {
      old.controller.abort();
      await old.done;
      if (active === old) {
        active = undefined;
      }
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    const task = transitions.then(work);
    transitions = task.catch(() => {});
    return task;
  };
  return {
    start(config: WenRecoveryLifecycleConfig) {
      if (
        !config.socketPath ||
        !config.walletId.trim() ||
        config.walletId !== config.walletId.trim() ||
        !Number.isInteger(config.ticks) ||
        config.ticks < 1 ||
        config.ticks > 100 ||
        !Number.isInteger(config.intervalMs) ||
        config.intervalMs < 5000 ||
        config.intervalMs > 60000
      ) {
        return Promise.reject(Error("Invalid WEN recovery lifecycle configuration"));
      }
      const selected = { ...config };
      const version = ++generation;
      active?.controller.abort();
      return enqueue(async () => {
        await stopActive();
        if (version !== generation) {
          return;
        }
        const controller = new AbortController();
        const done = (async () => {
          try {
            for await (const result of scheduleWenMiningRecovery(
              selected.socketPath,
              selected.walletId,
              {
                ticks: selected.ticks,
                intervalMs: selected.intervalMs,
                signal: controller.signal,
                request: selected.request,
              },
            )) {
              if (controller.signal.aborted || version !== generation) {
                return;
              }
              selected.onResult(result);
            }
          } catch (error) {
            if (!controller.signal.aborted && version === generation) {
              selected.onError(error);
            }
          }
        })();
        // An error callback must not create an unhandled rejection or defeat stop.
        active = { controller, done: done.catch(() => {}) };
      });
    },
    stop() {
      generation++;
      active?.controller.abort();
      return enqueue(stopActive);
    },
  };
}
