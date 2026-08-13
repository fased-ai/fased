package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"fased-lifecycled/model"
)

type fakeLegacyControllerState struct {
	active  bool
	enabled bool
}

type failingPredecessor struct {
	err   error
	calls *[]string
}

func (predecessor failingPredecessor) Prepare(context.Context, model.Transaction) error {
	*predecessor.calls = append(*predecessor.calls, "public.prepare")
	return predecessor.err
}
func (predecessor failingPredecessor) Quiesce(context.Context, model.Transaction) error {
	*predecessor.calls = append(*predecessor.calls, "public.quiesce")
	return predecessor.err
}
func (predecessor failingPredecessor) Restore(context.Context, model.Transaction) error {
	*predecessor.calls = append(*predecessor.calls, "public.restore")
	return predecessor.err
}
func (predecessor failingPredecessor) Commit(context.Context, model.Transaction) error {
	*predecessor.calls = append(*predecessor.calls, "public.commit")
	return predecessor.err
}
func (predecessor failingPredecessor) Discard(context.Context, model.Transaction) error {
	*predecessor.calls = append(*predecessor.calls, "public.discard")
	return predecessor.err
}

func (state fakeLegacyControllerState) Active(context.Context, string) (bool, error) {
	return state.active, nil
}
func (state fakeLegacyControllerState) Enabled(context.Context, string) (bool, error) {
	return state.enabled, nil
}

func legacyControllerFixture(t *testing.T) (*LegacyControllerPredecessor, model.Transaction, *fakeSystemd, string, []byte) {
	t.Helper()
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	target, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	legacyIdentity, err := model.LegacyControllerPlatformIdentity(config.Profile, target.InstanceID, target.ConfigurationDigest)
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := manifestTransaction(t, false)
	tx.PlanAction = "UPDATE"
	tx.PredecessorManifestSchema = 1
	tx.PredecessorPlatform = &legacyIdentity
	tx.Previous = &model.Generation{ID: digestB, Version: "0.1.76-rc.72", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB}
	root := t.TempDir()
	unit := legacyIdentity.Services["controller"]
	unitPath := filepath.Join(root, config.UnitRoot, unit)
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	data := []byte("[Service]\nExecStart=/opt/fased/legacy-controller\n")
	if err := os.WriteFile(unitPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	systemd := &fakeSystemd{calls: &calls, inactive: map[string]bool{}}
	legacy := &LegacyControllerPredecessor{Config: config, Systemd: systemd, State: fakeLegacyControllerState{active: true, enabled: true}, rootPrefix: root}
	return legacy, tx, systemd, unitPath, data
}

func TestLegacyControllerPredecessorRetiresOnlyAfterTargetVerification(t *testing.T) {
	legacy, tx, systemd, unitPath, _ := legacyControllerFixture(t)
	ctx := context.Background()
	if err := legacy.Prepare(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Quiesce(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(unitPath); err != nil {
		t.Fatalf("legacy unit was removed before commit: %v", err)
	}
	if err := legacy.Commit(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Commit(ctx, tx); err != nil {
		t.Fatalf("legacy controller retirement was not recovery-idempotent: %v", err)
	}
	if _, err := os.Lstat(unitPath); !os.IsNotExist(err) {
		t.Fatalf("legacy controller unit survived commit: %v", err)
	}
	want := []string{
		"systemd.stop:" + tx.PredecessorPlatform.Services["controller"],
		"systemd.disable:" + tx.PredecessorPlatform.Services["controller"],
		"systemd.reload",
	}
	if !reflect.DeepEqual(*systemd.calls, want) {
		t.Fatalf("unexpected controller retirement order: %v", *systemd.calls)
	}
	if err := legacy.Discard(ctx, tx); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyControllerPredecessorRestoresExactUnitAndState(t *testing.T) {
	legacy, tx, systemd, unitPath, original := legacyControllerFixture(t)
	ctx := context.Background()
	if err := legacy.Prepare(ctx, tx); err != nil || legacy.Quiesce(ctx, tx) != nil {
		t.Fatal(err)
	}
	if err := os.Remove(unitPath); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Restore(ctx, tx); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(unitPath)
	if err != nil || string(restored) != string(original) {
		t.Fatalf("legacy unit was not restored exactly: %q err=%v", restored, err)
	}
	wantTail := []string{
		"systemd.reload",
		"systemd.enable:" + tx.PredecessorPlatform.Services["controller"],
		"systemd.start:" + tx.PredecessorPlatform.Services["controller"],
	}
	calls := *systemd.calls
	if len(calls) < len(wantTail) || !reflect.DeepEqual(calls[len(calls)-len(wantTail):], wantTail) {
		t.Fatalf("legacy controller active state was not restored: %v", calls)
	}
}

func TestLegacyControllerPredecessorRejectsReboundPlatform(t *testing.T) {
	legacy, tx, _, _, _ := legacyControllerFixture(t)
	if err := legacy.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	rebound, err := model.LegacyControllerPlatformIdentity(tx.Profile, "another", tx.PredecessorPlatform.ConfigurationDigest)
	if err != nil {
		t.Fatal(err)
	}
	tx.PredecessorPlatform = &rebound
	if err := legacy.Quiesce(context.Background(), tx); err == nil {
		t.Fatal("legacy controller predecessor accepted a rebound platform")
	}
}

func TestCombinedPredecessorStopsForwardMutationAfterFirstFailure(t *testing.T) {
	legacy, tx, systemd, _, _ := legacyControllerFixture(t)
	calls := []string{}
	wantErr := os.ErrPermission
	combined := CombinedPredecessor{
		Public: failingPredecessor{err: wantErr, calls: &calls},
		Legacy: legacy,
	}
	if err := combined.Prepare(context.Background(), tx); !errors.Is(err, wantErr) {
		t.Fatalf("prepare error = %v, want %v", err, wantErr)
	}
	if _, err := os.Lstat(legacy.recordPath(tx)); !os.IsNotExist(err) {
		t.Fatalf("legacy prepare ran after public failure: %v", err)
	}
	if err := combined.Quiesce(context.Background(), tx); !errors.Is(err, wantErr) {
		t.Fatalf("quiesce error = %v, want %v", err, wantErr)
	}
	if len(*systemd.calls) != 0 {
		t.Fatalf("legacy quiesce ran after public failure: %v", *systemd.calls)
	}
	if !reflect.DeepEqual(calls, []string{"public.prepare", "public.quiesce"}) {
		t.Fatalf("unexpected public predecessor calls: %v", calls)
	}
}
