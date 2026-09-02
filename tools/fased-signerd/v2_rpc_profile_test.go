package main

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestSignerRPCProfileIsReusableGenesisBoundAndSecretFreeInSummaries(t *testing.T) {
	store, keys := openTestSignerV2(t)
	for _, walletID := range []string{"profile", "strategy_solana"} {
		role := "profile"
		if walletID == "strategy_solana" {
			role = "strategy"
		}
		if _, _, err := keys.CreateWithRoleBaseline(
			walletID,
			0,
			signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: role},
			signerRoleBaselineRuntimeV1{},
		); err != nil {
			t.Fatal(err)
		}
	}
	genesis := solana.NewWallet().PublicKey().String()
	keys.genesisHash = func(string) (string, error) { return genesis, nil }
	secret := "rpc-profile-secret" // pragma: allowlist secret
	created, err := keys.CreateRPCProfileV1(signerRPCProfileCreateRequestV1{
		ProfileID:               "mainnet-primary",
		Name:                    "Mainnet Primary",
		PrimaryRPCURL:           "https://primary.example/rpc?token=" + secret,
		WebSocketRPCURL:         "wss://primary.example/ws?token=" + secret,
		ExecutionFallbackRPCURL: "https://fallback.example/rpc?token=" + secret,
		VerificationRPCURL:      "https://witness.example/rpc?token=" + secret,
		Commitment:              "finalized",
	})
	if err != nil {
		t.Fatalf("create reusable RPC profile: %v", err)
	}
	if created.ProfileID != "mainnet-primary" || created.Version != 1 || created.GenesisHash != genesis || created.EndpointCount != 4 || !created.Ready {
		t.Fatalf("unexpected profile summary: %#v", created)
	}
	if strings.Contains(created.Hash, secret) || strings.Contains(created.Name, secret) {
		t.Fatalf("profile summary leaked endpoint credentials: %#v", created)
	}
	if _, err := keys.CreateRPCProfileV1(signerRPCProfileCreateRequestV1{
		ProfileID: "mainnet-primary", Name: "Duplicate", PrimaryRPCURL: "https://other.example/rpc", Commitment: "finalized",
	}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("duplicate profile was accepted: %v", err)
	}

	for _, walletID := range []string{"profile", "strategy_solana"} {
		binding, bindErr := keys.BindRPCProfileV1(walletID, signerRPCProfileBindRequestV1{
			ProfileID: "mainnet-primary", ExpectedProfileVersion: created.Version, ExpectedProfileHash: created.Hash, ExpectedNetworkVersion: 0,
		})
		if bindErr != nil {
			t.Fatalf("bind reusable profile to %s: %v", walletID, bindErr)
		}
		if binding.WalletID != walletID || binding.ProfileID != created.ProfileID || binding.NetworkVersion != 1 || !binding.Ready {
			t.Fatalf("unexpected binding for %s: %#v", walletID, binding)
		}
		config, networkErr := keys.SolanaNetworkV2(walletID)
		if networkErr != nil || config.PrimaryRPCURL != "https://primary.example/rpc?token="+secret || config.ExecutionFallbackRPCURL != "https://fallback.example/rpc?token="+secret {
			t.Fatalf("bound network mismatch for %s: config=%#v err=%v", walletID, config, networkErr)
		}
	}
	rebound, err := keys.BindRPCProfileV1("profile", signerRPCProfileBindRequestV1{
		ProfileID: "mainnet-primary", ExpectedProfileVersion: created.Version, ExpectedProfileHash: created.Hash, ExpectedNetworkVersion: 1,
	})
	if err != nil || rebound.NetworkVersion != 2 {
		t.Fatalf("rebind reusable profile with exact network fence: binding=%#v err=%v", rebound, err)
	}
	if _, err := keys.BindRPCProfileV1("profile", signerRPCProfileBindRequestV1{
		ProfileID: "mainnet-primary", ExpectedProfileVersion: created.Version, ExpectedProfileHash: created.Hash, ExpectedNetworkVersion: 1,
	}); err == nil || !strings.Contains(err.Error(), "version conflict") {
		t.Fatalf("stale network fence was accepted: %v", err)
	}

	if err := store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerNetworksV2).Get(signerRPCProfileStorageKeyV1("mainnet-primary"))
		if len(raw) == 0 || bytes.Contains(raw, []byte(secret)) {
			t.Fatalf("stored profile missing or contains plaintext credentials: %q", raw)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSignerRPCProfileRejectsCrossGenesisFallback(t *testing.T) {
	_, keys := openTestSignerV2(t)
	keys.genesisHash = func(endpoint string) (string, error) {
		if strings.Contains(endpoint, "fallback") {
			return solana.NewWallet().PublicKey().String(), nil
		}
		return solanaMainnetGenesisHashV2, nil
	}
	_, err := keys.CreateRPCProfileV1(signerRPCProfileCreateRequestV1{
		ProfileID: "bad-profile", Name: "Bad Profile",
		PrimaryRPCURL: "https://primary.example/rpc", ExecutionFallbackRPCURL: "https://fallback.example/rpc",
		Commitment: "finalized",
	})
	if err == nil || !strings.Contains(err.Error(), "disagree on genesis") {
		t.Fatalf("cross-genesis fallback was accepted: %v", err)
	}
}

func TestSignerRPCProfileLimitAndStoredRecordFraming(t *testing.T) {
	store, keys := openTestSignerV2(t)
	keys.genesisHash = func(string) (string, error) { return solanaMainnetGenesisHashV2, nil }
	for index := 0; index < maxSignerRPCProfilesV1; index++ {
		profileID := fmt.Sprintf("profile-%02d", index)
		if _, err := keys.CreateRPCProfileV1(signerRPCProfileCreateRequestV1{
			ProfileID: profileID, Name: "Profile " + profileID,
			PrimaryRPCURL: "https://rpc.example/" + profileID, Commitment: "finalized",
		}); err != nil {
			t.Fatalf("create profile %d: %v", index, err)
		}
	}
	if _, err := keys.CreateRPCProfileV1(signerRPCProfileCreateRequestV1{
		ProfileID: "profile-overflow", Name: "Overflow",
		PrimaryRPCURL: "https://rpc.example/overflow", Commitment: "finalized",
	}); err == nil || !strings.Contains(err.Error(), "profile limit") {
		t.Fatalf("profile limit was not enforced: %v", err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerNetworksV2)
		key := signerRPCProfileStorageKeyV1("profile-00")
		raw := append([]byte(nil), bucket.Get(key)...)
		raw = append(raw, []byte(`{}`)...)
		return bucket.Put(key, raw)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.RPCProfileSummaryV1("profile-00"); err == nil || !strings.Contains(err.Error(), "invalid stored RPC profile") {
		t.Fatalf("trailing stored RPC profile content was accepted: %v", err)
	}
}
