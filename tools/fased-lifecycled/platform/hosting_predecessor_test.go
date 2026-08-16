package platform

import (
	"context"
	"os"
	"path/filepath"
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
	tx.PublicPredecessorVersion = "0.1.75"
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

func TestHostingPredecessorRecordRejectsVersionRebinding(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := manifestTransaction(t, true)
	tx.Profile = model.ProfileHosting
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "hosting-controller-v2-self-updating"
	tx.PublicPredecessorVersion = "0.1.75"
	bridge := &HostingPredecessor{Config: config, Systemd: fakeSystemd{calls: &[]string{}}, State: fakeServiceState{active: map[string]bool{"fased-signerd.service": true, "fased-gateway.service": false}}, rootPrefix: t.TempDir()}
	if err := bridge.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	tx.PublicPredecessorVersion = "0.1.74"
	if err := bridge.Quiesce(context.Background(), tx); err == nil {
		t.Fatal("Hosting predecessor receipt was rebound to another version")
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

func TestHostingNetworkPolicyRequiresPrivateServeAndExactSignerIdentity(t *testing.T) {
	if !privateServeTargetsLoopback([]byte(`{"AllowFunnel":false,"Proxy":"http://127.0.0.1:18789"}`), 18789) {
		t.Fatal("private loopback Serve route was rejected")
	}
	if privateServeTargetsLoopback([]byte(`{"AllowFunnel":true,"Proxy":"http://127.0.0.1:18789"}`), 18789) ||
		privateServeTargetsLoopback([]byte(`{"Proxy":"http://0.0.0.0:18789"}`), 18789) {
		t.Fatal("public Serve route was accepted")
	}
	path := filepath.Join(t.TempDir(), "signerd-webauthn.env")
	dns := "fased.tailnet.ts.net"
	if err := os.WriteFile(path, []byte("FASED_WALLET_WEBAUTHN_RP_ID="+dns+"\nFASED_WALLET_WEBAUTHN_ORIGINS=https://"+dns+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifySignerWebAuthnFile(path, dns, uint32(os.Getuid())); err != nil {
		t.Fatal(err)
	}
	if err := verifySignerWebAuthnFile(path, "attacker.tailnet.ts.net", uint32(os.Getuid())); err == nil {
		t.Fatal("mismatched signer RP identity was accepted")
	}
}
