package main

import "context"

// Reconcile and settle the existing signature only; never sign or send.
func (s *signerStoreV2) recoverWENWithdrawalExecutionV1(ctx context.Context, c signerWENBTCReconcileRPCV1, request, digest string) (string, error) {
	outcome, e := s.reconcileWENTransactionV1(ctx, c, request, digest)
	if e != nil {
		return outcome, e
	}
	if outcome == "finalized-success" {
		return outcome, s.settleWENWithdrawalSuccessV1(request, digest)
	}
	if outcome == "finalized-failed" {
		return outcome, s.settleWENFailedBudgetV1(request, digest)
	}
	return outcome, nil
}
