package main

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func TestSignerApplicationPolicyCanOnlyTightenAtomically(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destinationA := solana.NewWallet().PublicKey().String()
	destinationB := solana.NewWallet().PublicKey().String()
	_, current := createTestSignerWalletV2(t, store, keys, "agent", destinationA, 100, 500)

	candidate := current
	candidate.Assets = []signerPolicyAssetV2{{
		Asset: "solana:native", Destinations: []string{destinationA}, MaxPerTx: "50", MaxDaily: "200",
	}}
	tightened, err := store.tightenPolicy(candidate, current.Version)
	if err != nil {
		t.Fatalf("tighten policy: %v", err)
	}
	if tightened.Version != current.Version+1 || tightened.Hash == current.Hash {
		t.Fatalf("tightened policy did not advance its acknowledged version/hash: %#v", tightened)
	}
	if tightened.Assets[0].MaxPerTx != "50" || tightened.Assets[0].MaxDaily != "200" {
		t.Fatalf("tightened caps were not stored exactly: %#v", tightened.Assets[0])
	}

	tests := []struct {
		name   string
		mutate func(*signerPolicyV2)
		want   string
	}{
		{
			name: "operation expansion",
			mutate: func(policy *signerPolicyV2) {
				policy.Operations = append(policy.Operations, intentSolanaSPLTransferChecked)
			},
			want: "cannot add operations",
		},
		{
			name: "program expansion",
			mutate: func(policy *signerPolicyV2) {
				policy.Programs = append(policy.Programs, solana.TokenProgramID.String())
			},
			want: "cannot add programs",
		},
		{
			name: "destination expansion",
			mutate: func(policy *signerPolicyV2) {
				policy.Assets[0].Destinations = append(policy.Assets[0].Destinations, destinationB)
			},
			want: "cannot add destinations",
		},
		{
			name:   "per transaction cap expansion",
			mutate: func(policy *signerPolicyV2) { policy.Assets[0].MaxPerTx = "51" },
			want:   "cannot raise per-transaction cap",
		},
		{
			name:   "daily cap expansion",
			mutate: func(policy *signerPolicyV2) { policy.Assets[0].MaxDaily = "201" },
			want:   "cannot raise daily cap",
		},
		{
			name: "asset expansion",
			mutate: func(policy *signerPolicyV2) {
				policy.Assets = append(policy.Assets, signerPolicyAssetV2{
					Asset:        "solana:spl:" + solana.NewWallet().PublicKey().String(),
					Destinations: []string{destinationA}, MaxPerTx: "1", MaxDaily: "1",
				})
			},
			want: "cannot add asset",
		},
		{
			name:   "role change",
			mutate: func(policy *signerPolicyV2) { policy.Role = "vault" },
			want:   "cannot alter wallet identity or role",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			attempt := tightened
			attempt.Operations = append([]string(nil), tightened.Operations...)
			attempt.Programs = append([]string(nil), tightened.Programs...)
			attempt.Assets = append([]signerPolicyAssetV2(nil), tightened.Assets...)
			attempt.Assets[0].Destinations = append([]string(nil), tightened.Assets[0].Destinations...)
			test.mutate(&attempt)
			if _, err := store.tightenPolicy(attempt, tightened.Version); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q rejection, got %v", test.want, err)
			}
		})
	}
}

func TestSignerApplicationPolicyTighteningUsesVersionFence(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, current := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 500)
	candidate := current
	candidate.Assets = []signerPolicyAssetV2{{
		Asset: "solana:native", Destinations: []string{destination}, MaxPerTx: "50", MaxDaily: "250",
	}}

	var wait sync.WaitGroup
	errorsSeen := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := store.tightenPolicy(candidate, current.Version)
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(errorsSeen)
	successes := 0
	conflicts := 0
	for err := range errorsSeen {
		switch {
		case err == nil:
			successes++
		case strings.Contains(err.Error(), "version conflict"):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent tightening result: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("expected one atomic winner and one version conflict, got success=%d conflict=%d", successes, conflicts)
	}
}

func TestSignerApplicationSocketPolicyTightenAndRoleBoundaries(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, current := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 500)
	service := &signerServiceV2{store: store, keys: keys}
	candidate := current
	candidate.Assets = []signerPolicyAssetV2{{
		Asset: "solana:native", Destinations: []string{destination}, MaxPerTx: "25", MaxDaily: "100",
	}}
	body, err := json.Marshal(signerPolicyPutRequestV2{ExpectedVersion: current.Version, Policy: candidate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.policy.tighten", WalletID: "agent", Request: body}, signerConfig{}, false); err != nil {
		t.Fatalf("application socket rejected strict policy tightening: %v", err)
	}

	vaultPolicy := testSignerPolicyV2("vault", destination, 100, 500)
	vaultPolicy.Role = "vault"
	_, vaultStored, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "vault", ExpectedVersion: 0, Policy: vaultPolicy,
	})
	if err != nil {
		t.Fatalf("create Vault fixture: %v", err)
	}
	_, err = service.execute(signerExecuteRequestV2{
		RequestID: "vault-direct-request", PolicyHash: vaultStored.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "vault",
	})
	if err == nil || !strings.Contains(err.Error(), "requires signer-reviewed authorization") {
		t.Fatalf("Vault direct execution did not fail closed: %v", err)
	}

	miningPolicy := testSignerPolicyV2("mining", destination, 100, 500)
	miningPolicy.Role = "mining"
	_, miningStored, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "mining", ExpectedVersion: 0, Policy: miningPolicy,
	})
	if err != nil {
		t.Fatalf("create Mining fixture: %v", err)
	}
	_, err = service.execute(signerExecuteRequestV2{
		RequestID: "mining-send-request", PolicyHash: miningStored.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "mining",
	})
	if err == nil || !strings.Contains(err.Error(), "restricted to typed SAT operations") {
		t.Fatalf("Mining generic autonomous transfer did not fail closed: %v", err)
	}

	if err := requireAutonomousRoleV2(signerPolicyV2{Role: "agent"}, normalizedIntentV2{Intent: signerIntentV2{Type: intentSolanaSATAction}}); err == nil || !strings.Contains(err.Error(), "require a Mining wallet") {
		t.Fatalf("Agent accepted typed SAT automation: %v", err)
	}
}
