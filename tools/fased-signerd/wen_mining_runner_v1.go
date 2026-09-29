package main

import (
	"context"
	"errors"
	"time"
)

// One bounded, reviewed operation. No background goroutine, automatic review,
// retry with fresh intent, or public signing capability is created here.
func runWENMiningOperationV1(ctx context.Context, interval time.Duration, maxTicks int, step func(context.Context) (string, string, error), wait func(context.Context, time.Duration) error) (string, string, error) {
	if interval < time.Second || interval > time.Minute || maxTicks < 1 || maxTicks > 1000 || step == nil || wait == nil {
		return "", "", errors.New("invalid mining runner bounds")
	}
	var digest, status string
	for tick := 0; tick < maxTicks; tick++ {
		if e := ctx.Err(); e != nil {
			return digest, status, e
		}
		nextDigest, nextStatus, e := step(ctx)
		if nextDigest != "" {
			if digest != "" && digest != nextDigest {
				return digest, status, errors.New("mining runner action changed")
			}
			digest = nextDigest
		}
		status = nextStatus
		if e != nil {
			return digest, status, e
		}
		switch status {
		case "finalized-success", "finalized-failed", "cancelled", "recovery-required", "missed-commit", "expired":
			return digest, status, nil
		case "waiting-open", "waiting-reveal", "signed", "submission-uncertain":
		default:
			return digest, status, errors.New("unexpected mining runner state")
		}
		if tick+1 == maxTicks {
			return digest, status, errors.New("mining runner tick limit reached")
		}
		if e = wait(ctx, interval); e != nil {
			return digest, status, e
		}
	}
	panic("unreachable mining runner")
}
func waitWENMiningTickV1(ctx context.Context, interval time.Duration) error {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (s *signerServiceV2) runConfiguredMiningWithFactoryV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningIntentV1, interval time.Duration, maxTicks int, factory func(string) wenMiningExecutionRPCV1) (string, string, error) {
	return runWENMiningOperationV1(ctx, interval, maxTicks, func(ctx context.Context) (string, string, error) {
		return s.stepConfiguredMiningWithFactoryV1(ctx, cfg, request, walletID, v, factory)
	}, waitWENMiningTickV1)
}
func (s *signerServiceV2) runConfiguredWENMiningV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningIntentV1, interval time.Duration, maxTicks int) (string, string, error) {
	return s.runConfiguredMiningWithFactoryV1(ctx, cfg, request, walletID, v, interval, maxTicks, func(endpoint string) wenMiningExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
}
