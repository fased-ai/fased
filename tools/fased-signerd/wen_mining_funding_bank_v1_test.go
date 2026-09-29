package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fundingLostBank struct {
	*rpc.Client
	lost  bool
	sends int
}

func (c *fundingLostBank) SendRawTransactionWithOpts(ctx context.Context, b []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	c.sends++
	sig, e := c.Client.SendRawTransactionWithOpts(ctx, b, o)
	if e == nil && c.lost {
		return sig, errors.New("fixture lost reply after bank acceptance")
	}
	return sig, e
}
func TestWENMiningFundingCompiledBank(t *testing.T) {
	if os.Getenv("WEN_FUNDING_BANK_EXECUTE") != "1" {
		t.Skip("requires explicit ephemeral local compiled bank")
	}
	var input struct {
		Endpoint, Owner, Code, Descriptor, Authority string
		Seed                                         []byte
		Lost                                         bool
		Intent                                       signerWENMiningFundingIntentV1
	}
	if e := json.NewDecoder(os.Stdin).Decode(&input); e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(input.Endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("loopback bank required")
	}
	if len(input.Seed) != 32 {
		t.Fatal("ephemeral seed required")
	}
	key := solana.PrivateKey(ed25519.NewKeyFromSeed(input.Seed))
	zeroBytes(input.Seed)
	input.Seed = nil
	defer zeroBytes(key)
	if key.PublicKey().String() != input.Owner {
		t.Fatal("ephemeral owner mismatch")
	}
	v := input.Intent
	if e = validateWENMiningFundingIntentV1(v); e != nil {
		t.Fatal(e)
	}
	store, keys := openTestSignerV2(t)
	store.now = time.Now
	policy := signerPolicyV2{WalletID: "bank_test", Role: "agent", Operations: []string{intentWENMiningFundingV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "10000"}}}
	_, policy, e = keys.storeNewKeyWithPolicy("bank_test", key, policy, 0)
	if e != nil {
		t.Fatal(e)
	}
	zeroBytes(key)
	for _, scope := range []string{wenMiningNativeScopeV1("bank_test", v.Genesis), wenMiningFundingLaunchScopeV1("bank_test", v)} {
		if e = store.configureWENBudgetV1(scope, 10000); e != nil {
			t.Fatal(e)
		}
	}
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: input.Code, DeploymentSlot: 1, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256}
	if input.Authority != "" {
		a, e := solana.PublicKeyFromBase58(input.Authority)
		if e != nil {
			t.Fatal(e)
		}
		pins.UpgradeAuthority = &a
	}
	review := wenMiningFundingReviewV1{Version: 1, WalletID: "bank_test", WalletPublicKey: input.Owner, Intent: v, Pins: pins, MaxSlotLag: 32, MaxTotalCostLamports: 5000}
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining-funding", wenHashV1([]byte("bank_test")))
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(review)
	if e = os.WriteFile(filepath.Join(root, wenMiningFundingAdmissionNameV1(v)), raw, 0600); e != nil {
		t.Fatal(e)
	}
	descriptor, e := base64.StdEncoding.DecodeString(input.Descriptor)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, v.DescriptorSHA256), descriptor, 0600); e != nil {
		t.Fatal(e)
	}
	client := &fundingLostBank{Client: rpc.New(input.Endpoint), lost: input.Lost}
	service := &signerServiceV2{store: store, keys: keys}
	keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
	const configuredEndpoint = "https://funding-local-bank.invalid"
	if _, e = keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: configuredEndpoint}); e != nil {
		t.Fatal(e)
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	preview, e := service.prepareConfiguredMiningFundingWithFactoryV1(context.Background(), cfg, "bank_test", v, func(selected string) wenMiningPrepareRPCV1 {
		if selected != configuredEndpoint {
			t.Fatal("wrong configured endpoint")
		}
		return client
	})
	if e != nil || preview.SigningEnabled || preview.CapitalLamports != v.Amount || preview.NetworkFee != 5000 {
		t.Fatal("configured compiled preview", e)
	}
	digest, status, e := service.executeConfiguredMiningFundingWithFactoryV1(context.Background(), cfg, "state-request", "bank_test", v, func(selected string) wenMiningFundingExecutionRPCV1 {
		if selected != configuredEndpoint {
			t.Fatal("wrong configured endpoint")
		}
		return client
	})
	if e != nil || status != "finalized-success" || client.sends != 1 {
		t.Fatalf("compiled bank execution: status=%s sends=%d error=%v", status, client.sends, e)
	}
	saved := readWENState(t, store)
	if !saved.SuccessBudgetSettled || saved.OutcomeFee != 5000 || saved.SuccessNativeDebit != 5000 || saved.MiningFundingEffectsSHA256 == "" {
		t.Fatal("unreconciled compiled funding effects")
	}
	keys.Close()
	path := store.db.Path()
	if e = store.Close(); e != nil {
		t.Fatal(e)
	}
	store, e = openSignerStoreV2(path)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	if status, e = store.recoverWENMiningFundingExecutionV1(context.Background(), client, "state-request", digest); e != nil || status != "finalized-success" {
		t.Fatal("keyless bank recovery", status, e)
	}
	if _, e = store.prepareWENMiningFundingSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
		t.Fatal("replayed compiled funding")
	}
	if client.sends != 1 {
		t.Fatal("recovery resent")
	}
	t.Logf("PASS: configured compiled bank funding, %s capital, 5000 fee, no rent, lostReply=%t; keyless reopened recovery, no resend", v.Amount, input.Lost)
}
