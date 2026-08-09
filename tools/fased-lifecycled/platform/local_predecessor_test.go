package platform

import (
	"context"
	"reflect"
	"testing"

	"fased-lifecycled/model"
)

type fakeUserSystemd struct {
	active bool
	calls  []string
}

func (systemd *fakeUserSystemd) IsActive(context.Context, string) (bool, error) {
	systemd.calls = append(systemd.calls, "is-active")
	return systemd.active, nil
}
func (systemd *fakeUserSystemd) Stop(context.Context, string) error {
	systemd.calls = append(systemd.calls, "stop")
	systemd.active = false
	return nil
}
func (systemd *fakeUserSystemd) Start(context.Context, string) error {
	systemd.calls = append(systemd.calls, "start")
	systemd.active = true
	return nil
}

func localBridgeFixture(t *testing.T, active bool) (*LocalPredecessor, model.Transaction, *fakeUserSystemd) {
	t.Helper()
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	systemd := &fakeUserSystemd{active: active}
	tx, _ := manifestTransaction(t, true)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	return &LocalPredecessor{Config: config, Systemd: systemd, rootPrefix: t.TempDir()}, tx, systemd
}

func TestLocalPublicStablePredecessorRestoresExactActiveState(t *testing.T) {
	bridge, tx, systemd := localBridgeFixture(t, true)
	ctx := context.Background()
	if err := bridge.Prepare(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Quiesce(ctx, tx); err != nil || systemd.active {
		t.Fatalf("predecessor was not fenced: active=%v err=%v", systemd.active, err)
	}
	if err := bridge.Restore(ctx, tx); err != nil || !systemd.active {
		t.Fatalf("predecessor was not restored: active=%v err=%v", systemd.active, err)
	}
	if !reflect.DeepEqual(systemd.calls, []string{"is-active", "stop", "start"}) {
		t.Fatalf("unexpected predecessor operations: %v", systemd.calls)
	}
	if err := bridge.Discard(ctx, tx); err != nil {
		t.Fatal(err)
	}
}

func TestLocalPublicStablePredecessorPreservesInactiveState(t *testing.T) {
	bridge, tx, systemd := localBridgeFixture(t, false)
	ctx := context.Background()
	if err := bridge.Prepare(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Quiesce(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Restore(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(systemd.calls, []string{"is-active"}) {
		t.Fatalf("inactive predecessor state changed: %v", systemd.calls)
	}
	if err := bridge.Commit(ctx, tx); err != nil {
		t.Fatal(err)
	}
}

func TestNoPredecessorRejectsPublicStableBridge(t *testing.T) {
	_, tx, _ := localBridgeFixture(t, false)
	if err := (NoPredecessor{}).Prepare(context.Background(), tx); err == nil {
		t.Fatal("public-stable bridge proceeded without a predecessor adapter")
	}
}
