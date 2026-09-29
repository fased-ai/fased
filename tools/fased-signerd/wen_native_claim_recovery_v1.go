package main

import "context"

// Reconcile and settle the existing signature only; never sign or send.
func (s *signerStoreV2) recoverWENNativeClaimExecutionV1(ctx context.Context, c interface {
	signerWENBTCReconcileRPCV1
	signerWENBTCReadRPCV1
}, request, digest string) (string, error) {
	outcome, e := s.reconcileWENTransactionV1(ctx, c, request, digest)
	if e != nil {
		return outcome, e
	}
	if outcome == "finalized-success" {
		return outcome, s.settleWENNativeClaimSuccessV1(request, digest)
	}
	if outcome == "finalized-failed" {
		return outcome, s.settleWENFailedBudgetV1(request, digest)
	}
	return outcome, nil
}
