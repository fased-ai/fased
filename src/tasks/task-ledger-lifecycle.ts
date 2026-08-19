import { closeTaskDefinitionLedgerForLifecycle } from "./task-definition-ledger.js";
import { acknowledgeTaskLedgerQuiesceRequest } from "./task-ledger-quiesce.js";
import { fenceTaskLedgerWritersForLifecycle } from "./task-ledger-store.js";
import { closeTaskRegistryLedgerForLifecycle } from "./task-registry.js";

/**
 * Flush the two independently cached task-ledger handles in a deterministic
 * order. Attempt both closures so a later cache cannot survive a prior
 * failure, then surface the first failure to abort Gateway/systemd shutdown.
 */
export function checkpointAndCloseTaskLedgersForLifecycle(opts?: { managedStop?: boolean }): void {
  if (opts?.managedStop) {
    // This is deliberately after ingress/HTTP/reload/cron drains but before
    // checkpoint: no late completion can write or reopen the captured ledger.
    fenceTaskLedgerWritersForLifecycle();
  }
  let firstFailure: unknown;
  for (const close of [
    closeTaskRegistryLedgerForLifecycle,
    closeTaskDefinitionLedgerForLifecycle,
  ]) {
    try {
      close();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
  if (opts?.managedStop) {
    acknowledgeTaskLedgerQuiesceRequest();
  }
}
