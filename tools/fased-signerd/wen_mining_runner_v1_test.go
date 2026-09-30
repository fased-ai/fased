package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestWENMiningRunnerV1(t *testing.T) {
	for _, tc := range []struct {
		name     string
		states   []string
		terminal string
	}{
		{"commit", []string{"waiting-open", "finalized-success"}, "finalized-success"},
		{"reveal", []string{"waiting-reveal", "submission-uncertain", "finalized-success"}, "finalized-success"},
		{"recovery", []string{"signed", "submission-uncertain", "finalized-failed"}, "finalized-failed"},
		{"interrupted", []string{"recovery-required"}, "recovery-required"},
		{"cancelled", []string{"cancelled"}, "cancelled"},
		{"missed", []string{"missed-commit"}, "missed-commit"},
		{"expired", []string{"expired"}, "expired"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, waits := 0, 0
			digest, status, e := runWENMiningOperationV1(context.Background(), time.Second, 10, func(context.Context) (string, string, error) {
				state := tc.states[calls]
				calls++
				d := ""
				if state != "waiting-open" && state != "waiting-reveal" {
					d = "fixed"
				}
				return d, state, nil
			}, func(_ context.Context, d time.Duration) error {
				waits++
				if d != time.Second {
					t.Fatal("cadence")
				}
				return nil
			})
			if e != nil || status != tc.terminal || digest != "fixed" || calls != len(tc.states) || waits != calls-1 {
				t.Fatal(status, e, calls, waits)
			}
		})
	}
	for _, mode := range []string{"cancel-before", "cancel-wait", "limit", "error", "unknown", "changed-digest", "bad-interval", "bad-limit"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel-before" {
				cancel()
			}
			calls, waits := 0, 0
			interval := time.Second
			limit := 3
			if mode == "bad-interval" {
				interval = 0
			}
			if mode == "bad-limit" {
				limit = 0
			}
			_, _, e := runWENMiningOperationV1(ctx, interval, limit, func(context.Context) (string, string, error) {
				calls++
				if mode == "error" {
					return "fixed", "signed", errors.New("rpc")
				}
				if mode == "unknown" {
					return "", "unexpected", nil
				}
				if mode == "changed-digest" && calls == 2 {
					return "changed", "signed", nil
				}
				return "fixed", "signed", nil
			}, func(ctx context.Context, _ time.Duration) error {
				waits++
				if mode == "cancel-wait" {
					cancel()
					return ctx.Err()
				}
				return nil
			})
			if e == nil {
				t.Fatal("runner ignored stopping condition")
			}
			switch mode {
			case "cancel-before", "bad-interval", "bad-limit":
				if calls != 0 {
					t.Fatal("invalid runner executed")
				}
			case "error", "unknown", "cancel-wait":
				if calls != 1 {
					t.Fatal("runner retried terminal error")
				}
			case "limit":
				if calls != 3 || waits != 2 {
					t.Fatal("unbounded polls")
				}
			case "changed-digest":
				if calls != 2 {
					t.Fatal("identity fence")
				}
			}
		})
	}
}
func TestWENMiningRunnerTimerCancellationV1(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if e := waitWENMiningTickV1(ctx, time.Minute); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}
