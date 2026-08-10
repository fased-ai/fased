package platform

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"fased-lifecycled/model"
)

type fakeUserSystemd struct {
	active                 bool
	masked                 bool
	durableFenceLoaded     bool
	reactivateUnlessMasked bool
	calls                  []string
}

func (systemd *fakeUserSystemd) DaemonReload(context.Context) error {
	systemd.calls = append(systemd.calls, "daemon-reload")
	systemd.durableFenceLoaded = true
	return nil
}

func (systemd *fakeUserSystemd) IsActive(context.Context, string) (bool, error) {
	systemd.calls = append(systemd.calls, "is-active")
	return systemd.active, nil
}
func (systemd *fakeUserSystemd) Stop(context.Context, string) error {
	systemd.calls = append(systemd.calls, "stop")
	if systemd.reactivateUnlessMasked && !systemd.masked {
		return errors.New("job canceled by reverse dependency")
	}
	systemd.active = false
	return nil
}
func (systemd *fakeUserSystemd) Start(context.Context, string) error {
	systemd.calls = append(systemd.calls, "start")
	systemd.active = true
	return nil
}
func (systemd *fakeUserSystemd) MaskRuntime(context.Context, string) error {
	systemd.calls = append(systemd.calls, "mask-runtime")
	systemd.masked = true
	return nil
}
func (systemd *fakeUserSystemd) UnmaskRuntime(context.Context, string) error {
	systemd.calls = append(systemd.calls, "unmask-runtime")
	systemd.masked = false
	return nil
}
func (systemd *fakeUserSystemd) Disable(context.Context, string) error {
	systemd.calls = append(systemd.calls, "disable")
	return nil
}
func (systemd *fakeUserSystemd) ReactivateFromDependency() {
	if !systemd.masked && !systemd.durableFenceLoaded {
		systemd.active = true
	}
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
	tx.PublicPredecessorVersion = "0.1.75"
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
	if !reflect.DeepEqual(systemd.calls, []string{"is-active", "mask-runtime", "stop", "unmask-runtime", "start"}) {
		t.Fatalf("unexpected predecessor operations: %v", systemd.calls)
	}
	if err := bridge.Discard(ctx, tx); err != nil {
		t.Fatal(err)
	}
}

func TestLocalPredecessorRecordRejectsVersionRebinding(t *testing.T) {
	bridge, tx, _ := localBridgeFixture(t, true)
	if err := bridge.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	tx.PublicPredecessorVersion = "0.1.74"
	if err := bridge.Quiesce(context.Background(), tx); err == nil {
		t.Fatal("Local predecessor receipt was rebound to another version")
	}
}

func TestLocalPublicStablePredecessorPreservesInactiveState(t *testing.T) {
	bridge, tx, systemd := localBridgeFixture(t, false)
	systemd.reactivateUnlessMasked = true
	ctx := context.Background()
	if err := bridge.Prepare(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Quiesce(ctx, tx); err != nil {
		t.Fatal(err)
	}
	systemd.ReactivateFromDependency()
	if systemd.active || !systemd.masked {
		t.Fatalf("inactive predecessor was not fenced during retry: active=%v masked=%v", systemd.active, systemd.masked)
	}
	if err := bridge.Restore(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if systemd.active {
		t.Fatal("rollback started a predecessor that was inactive before retry")
	}
	if !reflect.DeepEqual(systemd.calls, []string{"is-active", "mask-runtime", "stop", "unmask-runtime"}) {
		t.Fatalf("inactive predecessor state changed: %v", systemd.calls)
	}
	systemd.calls = nil
	if err := bridge.Commit(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(systemd.calls, []string{"disable", "daemon-reload", "unmask-runtime"}) {
		t.Fatalf("predecessor was not retired after commit: %v", systemd.calls)
	}
}

func TestLocalPublicStablePredecessorFencesReverseDependencyReactivation(t *testing.T) {
	bridge, tx, systemd := localBridgeFixture(t, true)
	systemd.reactivateUnlessMasked = true
	ctx := context.Background()
	if err := bridge.Prepare(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Quiesce(ctx, tx); err != nil {
		t.Fatalf("predecessor was not fenced before stop: %v", err)
	}
	if systemd.active || !systemd.masked {
		t.Fatalf("predecessor remained runnable: active=%v masked=%v", systemd.active, systemd.masked)
	}
	if err := bridge.Commit(ctx, tx); err != nil {
		t.Fatal(err)
	}
	systemd.ReactivateFromDependency()
	if systemd.active || systemd.masked || !systemd.durableFenceLoaded {
		t.Fatalf("retired predecessor was not durably fenced: active=%v masked=%v loaded=%v", systemd.active, systemd.masked, systemd.durableFenceLoaded)
	}
	want := []string{"is-active", "mask-runtime", "stop", "disable", "daemon-reload", "unmask-runtime"}
	if !reflect.DeepEqual(systemd.calls, want) {
		t.Fatalf("durable fence ordering changed: got=%v want=%v", systemd.calls, want)
	}
}

func TestNoPredecessorRejectsPublicStableBridge(t *testing.T) {
	_, tx, _ := localBridgeFixture(t, false)
	if err := (NoPredecessor{}).Prepare(context.Background(), tx); err == nil {
		t.Fatal("public-stable bridge proceeded without a predecessor adapter")
	}
}
