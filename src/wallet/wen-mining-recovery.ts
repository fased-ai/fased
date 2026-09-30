import { setTimeout as delay } from "node:timers/promises";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningRecoveryResult,
  validateWenMiningRecoveryRequest,
  type WenMiningRecoveryRequest,
} from "./wen-mining-recovery-contract.js";
export async function recoverWenMiningWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid recovery wallet");
  }
  const request = validateWenMiningRecoveryRequest(input);
  return bindWenMiningRecoveryResult(
    await callLocalSocketSigner<unknown>(
      socketPath,
      { op: "v2.wenMining.claim.recover", walletId, request },
      { timeoutMs: 35_000, maxResponseBytes: 1_048_576 },
    ),
    request,
    walletId,
  );
}
// Explicitly consumed, sequential schedule. No install/sign operation is called.
// The owner of the loop supplies fresh slot bounds each tick; cursors are hints.
export async function* scheduleWenMiningRecovery(
  socketPath: string,
  walletId: string,
  options: {
    ticks: number;
    intervalMs: number;
    signal: AbortSignal;
    request: (signal: AbortSignal) => Promise<WenMiningRecoveryRequest>;
  },
) {
  if (
    !Number.isInteger(options.ticks) ||
    options.ticks < 1 ||
    options.ticks > 100 ||
    !Number.isInteger(options.intervalMs) ||
    options.intervalMs < 5000 ||
    options.intervalMs > 60000
  ) {
    throw Error("Invalid recovery schedule");
  }
  let cursor = "";
  for (let tick = 0; tick < options.ticks; tick++) {
    options.signal.throwIfAborted();
    if (tick) {
      await delay(options.intervalMs, undefined, { signal: options.signal });
    }
    const request = await readWenRecoveryRequest(options.request, options.signal);
    options.signal.throwIfAborted();
    const result = await recoverWenMiningWithSigner(socketPath, walletId, { ...request, cursor });
    options.signal.throwIfAborted();
    cursor = result.nextCursor;
    yield result;
  }
}

// Bound fresh-slot/configuration reads as well as socket calls. Providers receive
// the deadline signal; a late result is never sent to the signer after cancellation.
async function readWenRecoveryRequest(
  provider: (signal: AbortSignal) => Promise<WenMiningRecoveryRequest>,
  parent: AbortSignal,
): Promise<WenMiningRecoveryRequest> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(Error("Recovery request provider timed out")),
    10_000,
  );
  let rejectRead: ((reason: unknown) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const rejectAbort = () => rejectRead?.(controller.signal.reason);
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return provider(controller.signal);
      }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
