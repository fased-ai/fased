package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestWENNativeClaimCompiledBank(t *testing.T) {
	if os.Getenv("WEN_FASED_NATIVE_RUN") != "1" {
		t.Skip("explicit compiled bank required")
	}
	var input struct {
		Endpoint                                  string
		Intent                                    signerWENNativeClaimIntentV1
		Seed                                      []byte
		Authority, Policy, USDC, Descriptor, Code string
	}
	if e := json.NewDecoder(os.Stdin).Decode(&input); e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(input.Endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("loopback required")
	}
	if len(input.Seed) != 32 {
		t.Fatal("fixture seed")
	}
	private := solana.PrivateKey(ed25519.NewKeyFromSeed(input.Seed))
	w := private.PublicKey()
	store, keys := openTestSignerV2(t)
	v := input.Intent
	_, _, e = keys.storeNewKeyWithPolicy("bankclaim", private, signerPolicyV2{WalletID: "bankclaim", Role: "agent", Operations: []string{intentWENNativeClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "2005000", MaxDaily: "2005000"}}}, 0)
	if e != nil {
		t.Fatal(e)
	}
	var authority *solana.PublicKey
	if input.Authority != "" {
		parsed, err := solana.PublicKeyFromBase58(input.Authority)
		if err != nil {
			t.Fatal(err)
		}
		authority = &parsed
	}
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: input.Code, DeploymentSlot: 1, UpgradeAuthority: authority}
	review := wenNativeClaimReviewV1{Version: 1, WalletID: "bankclaim", WalletPublicKey: w.String(), Intent: v, Policy: input.Policy, Pins: pins, MaxSlotLag: 0, MaxTotalCostLamports: 2005000}
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-native-claim", wenHashV1([]byte("bankclaim")))
	os.MkdirAll(root, 0700)
	raw, _ := json.Marshal(review)
	if e = os.WriteFile(filepath.Join(root, wenNativeClaimAdmissionNameV1(v)), raw, 0600); e != nil {
		t.Fatal(e)
	}
	descriptor, e := base64.StdEncoding.DecodeString(input.Descriptor)
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(root, v.DescriptorSHA256), descriptor, 0600)
	for _, scope := range []string{wenMiningNativeScopeV1("bankclaim", v.Genesis), wenNativeClaimLaunchScopeV1("bankclaim", v)} {
		if e = store.configureWENBudgetV1(scope, 2005000); e != nil {
			t.Fatal(e)
		}
	}
	c := &claimBankRPC{Client: rpc.New(input.Endpoint)}
	info, e := c.GetMultipleAccountsWithOpts(context.Background(), []solana.PublicKey{solana.Token2022ProgramID}, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized})
	if e != nil {
		t.Fatal(e)
	}
	t.Log("fixture Token-2022 program owner:", info.Value[0].Owner.String())
	service := &signerServiceV2{store: store, keys: keys}
	keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
	const savedEndpoint = "https://compiled-claim-fixture.invalid"
	if _, e = keys.PutNetworkV2("bankclaim", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: savedEndpoint}); e != nil {
		t.Fatal(e)
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	digest, outcome, e := service.executeConfiguredNativeClaimWithFactoryV1(context.Background(), cfg, "bank-claim", "bankclaim", v, func(selected string) wenNativeClaimExecutionRPCV1 {
		if selected != savedEndpoint {
			t.Fatal("unconfigured bank endpoint")
		}
		return c
	})
	if e != nil || outcome != "finalized-success" || c.sends != 1 {
		t.Fatalf("bank execution: outcome=%s sends=%d err=%v", outcome, c.sends, e)
	}
	if _, e = store.recoverWENNativeClaimExecutionV1(context.Background(), c, "bank-claim", digest); e != nil {
		t.Fatal(e)
	}
	if c.sends != 1 {
		t.Fatal("recovery resent")
	}
	var r wenBudgetReservationV1
	if e = store.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:bank-claim")), &r)
	}); e != nil {
		t.Fatal(e)
	}
	fmt.Println("BANK_CLAIM_SIGNATURE:" + r.Signature)
	t.Log("PASS compiled-bank configured Fased SAT claim and keyless lost-response recovery")
}
