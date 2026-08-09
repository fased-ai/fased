package platform

import (
	"context"
	"reflect"
	"testing"

	"fased-lifecycled/model"
)

type fakeServiceState struct{ active map[string]bool }

func (state fakeServiceState) Active(_ context.Context, unit string) (bool, error) {
	return state.active[unit], nil
}

func TestHostingPredecessorUsesSharedTransactionAndExactRollback(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	tx, identity := manifestTransaction(t, true)
	tx.Profile = model.ProfileHosting
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "hosting-controller-v2-self-updating"
	tx.PlatformDigest, _ = identity.Digest(model.ProfileProtectedLocal)
	// The predecessor validates profile and transaction identity through the
	// shared transaction; the adapter itself binds the Hosting platform digest.
	calls := []string{}
	bridge := &HostingPredecessor{Config: config, Systemd: fakeSystemd{calls: &calls},
		State: fakeServiceState{active: map[string]bool{"fased-signerd.service": true, "fased-gateway.service": false}}, rootPrefix: t.TempDir()}
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
	want := []string{"systemd.stop:fased-signerd.service", "systemd.start:fased-signerd.service"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("Hosting predecessor changed inactive services: got=%v want=%v", calls, want)
	}
	if err := bridge.Commit(ctx, tx); err != nil {
		t.Fatal(err)
	}
}

func TestHostingNetworkPolicyRejectsPublicGatewayListeners(t *testing.T) {
	for _, exposed := range []string{
		"LISTEN 0 4096 0.0.0.0:18789 0.0.0.0:*",
		"LISTEN 0 4096 [::]:18789 [::]:*",
		"LISTEN 0 4096 *:18789 *:*",
	} {
		if err := RejectPublicGatewayListener(exposed, 18789); err == nil {
			t.Fatalf("public listener was accepted: %s", exposed)
		}
	}
	for _, private := range []string{
		"LISTEN 0 4096 127.0.0.1:18789 0.0.0.0:*",
		"LISTEN 0 4096 [::1]:18789 [::]:*",
		"LISTEN 0 4096 100.64.0.2:18789 0.0.0.0:*",
		"LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
	} {
		if err := RejectPublicGatewayListener(private, 18789); err != nil {
			t.Fatalf("private listener was rejected: %s: %v", private, err)
		}
	}
}
