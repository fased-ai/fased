package main

import (
	"context"
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

// Explicit local integration entry point. Sends only with the execution opt-in,
// using a disposable fixture key and loopback bank.
func TestWENSharedBankReadback(t *testing.T) {
	endpoint := os.Getenv("WEN_SHARED_BANK_RPC")
	if endpoint == "" {
		t.Skip("requires explicit running local bank")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("loopback bank required")
	}
	var input struct {
		Intent     signerWENWithdrawalIntentV1 `json:"intent"`
		Owner      string                      `json:"owner"`
		Descriptor string                      `json:"descriptor"`
		Code       string                      `json:"code"`
	}
	if err := json.Unmarshal([]byte(os.Getenv("WEN_SHARED_BANK_INPUT")), &input); err != nil {
		t.Fatal(err)
	}
	if err := validateWENWithdrawalIntentV1(input.Intent); err != nil {
		t.Fatal(err)
	}
	owner, err := solana.PublicKeyFromBase58(input.Owner)
	if err != nil {
		t.Fatal(err)
	}
	v := input.Intent
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: input.Code, DeploymentSlot: 1}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := readWENWithdrawalRPCV1(ctx, rpc.New(endpoint), pins, v, owner, 0)
	if err != nil {
		t.Fatal(err)
	}
	if out.Preview.Gross != 1000 || out.Preview.Net != 970 || out.Preview.Fee != 30 || out.Preview.RemainingCustodied != 0 {
		t.Fatal("incorrect bank preview", out.Preview)
	}
	descriptor, err := base64.StdEncoding.DecodeString(input.Descriptor)
	if err != nil {
		t.Fatal(err)
	}
	store, keys := openTestSignerV2(t)
	keyBytes, err := base64.StdEncoding.DecodeString(os.Getenv("WEN_SHARED_BANK_TEST_KEY"))
	if err != nil {
		t.Fatal("invalid disposable key encoding")
	}
	private := solana.PrivateKey(keyBytes)
	if len(private) != 64 || private.PublicKey() != owner {
		t.Fatal("disposable key does not match fixture")
	}
	policy := signerPolicyV2{WalletID: "bank_test", Role: "agent", Operations: []string{intentWENWithdrawalV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "5000"}}}
	_, storedPolicy, err := keys.storeNewKeyWithPolicy("bank_test", private, policy, 0)
	if err != nil {
		t.Fatal(err)
	}
	keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
	const configuredEndpoint = "https://local-bank-fixture.invalid"
	if _, err := keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: configuredEndpoint}); err != nil {
		t.Fatal(err)
	}
	db := store.db.Path()
	review := wenWithdrawalReviewV1{Version: 1, WalletID: "bank_test", WalletPublicKey: owner.String(), Intent: v, Pins: pins, MaxTotalCostLamports: 5000, MaxSlotLag: 0}
	root := writeWithdrawalReviewFixture(t, db, review)
	descriptorPath := filepath.Join(root, v.DescriptorSHA256)
	if err := os.WriteFile(descriptorPath, descriptor, 0600); err != nil {
		t.Fatal(err)
	}
	prepared, err := prepareReviewedWENWithdrawalV1(ctx, rpc.New(endpoint), db, "bank_test", v)
	if err != nil {
		t.Fatal("protected bank preparation", err)
	}
	if prepared.fee != 5000 || prepared.rent != 0 || prepared.total != 5000 || prepared.units == 0 || prepared.state.Preview.Net != 970 {
		t.Fatal("incorrect protected preparation")
	}
	service := &signerServiceV2{store: store, keys: keys}
	cfg := signerConfig{stateDBPath: db, chains: []string{"solana"}}
	factory := func(selected string) wenMiningPrepareRPCV1 {
		if selected != configuredEndpoint {
			t.Fatal("unconfigured RPC selected")
		}
		return rpc.New(endpoint)
	}
	preview, err := service.prepareConfiguredWithdrawalWithFactoryV1(ctx, cfg, "bank_test", v, factory)
	if err != nil {
		t.Fatal("configured bank preparation", err)
	}
	if preview.SigningEnabled || preview.NetworkFee != 5000 || preview.DescriptorSHA256 != v.DescriptorSHA256 {
		t.Fatal("incorrect service preview")
	}
	_, err = service.prepareConfiguredWithdrawalWithFactoryV1(ctx, cfg, "bank_test", v, func(selected string) wenMiningPrepareRPCV1 {
		if _, e := keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-bank-fixture.invalid"}); e != nil {
			t.Fatal(e)
		}
		return factory(selected)
	})
	if err == nil {
		t.Fatal("network change during preparation accepted")
	}
	t.Log("PASS: configured Fased key/store/policy/network preparation remains unsigned")
	if err := os.WriteFile(descriptorPath, append(descriptor, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareReviewedWENWithdrawalV1(ctx, rpc.New(endpoint), db, "bank_test", v); err == nil {
		t.Fatal("changed protected descriptor accepted")
	}
	t.Log("PASS: protected Fased preparation simulated compiled withdrawal; changed descriptor rejected")
	t.Log("PASS: actual Fased withdrawal reader verified compiled bank state; gross=1000 net=970 fee=30")
	if os.Getenv("WEN_FASED_EXECUTE") == "1" {
		if err := os.WriteFile(descriptorPath, descriptor, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(2), PrimaryRPCURL: configuredEndpoint}); err != nil {
			t.Fatal(err)
		}
		scopes := []string{wenMiningNativeScopeV1("bank_test", v.Genesis), wenWithdrawalLaunchScopeV1("bank_test", v)}
		for _, scope := range scopes {
			if err := store.configureWENBudgetV1(scope, 5000); err != nil {
				t.Fatal(err)
			}
		}
		c := &sharedBankExecutionRPC{Client: rpc.New(endpoint), lost: os.Getenv("WEN_LOST_RESPONSE") == "1"}
		deniedStore, deniedKeys := openTestSignerV2(t)
		_, deniedPolicy, err := deniedKeys.storeNewKeyWithPolicy("bank_test", solana.PrivateKey(keyBytes), policy, 0)
		if err != nil {
			t.Fatal(err)
		}
		deniedRoot := writeWithdrawalReviewFixture(t, deniedStore.db.Path(), review)
		if err := os.WriteFile(filepath.Join(deniedRoot, v.DescriptorSHA256), descriptor, 0600); err != nil {
			t.Fatal(err)
		}
		for _, scope := range scopes {
			if err := deniedStore.configureWENBudgetV1(scope, 4999); err != nil {
				t.Fatal(err)
			}
		}
		deniedService := &signerServiceV2{store: deniedStore, keys: deniedKeys}
		if _, _, err := deniedService.executeWENWithdrawalWithRPCV1(ctx, c, "bank-denied", "bank_test", deniedPolicy.Hash, v); err == nil || err.Error() != "WEN withdrawal policy or fee reservation rejected" || c.sends != 0 {
			t.Fatal("expected budget rejection before send", err)
		}
		for _, scope := range scopes {
			used, err := deniedStore.wenBudgetReservedV1(scope)
			if err != nil || used != 0 {
				t.Fatal("denied budget consumed capacity", used, err)
			}
		}
		digest, outcome, err := service.executeWENWithdrawalWithRPCV1(ctx, c, "bank-execute", "bank_test", storedPolicy.Hash, v)
		if err != nil || outcome != "finalized-success" || digest == "" {
			t.Fatalf("execution: %s %v", outcome, err)
		}
		if _, _, err := service.executeWENWithdrawalWithRPCV1(ctx, c, "bank-execute", "bank_test", storedPolicy.Hash, v); err == nil || c.sends != 1 {
			t.Fatal("replayed execution")
		}
		persisted := wenRestartRecord(t, store, "bank-execute")
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
		verifyWENFreshProcess(t, db, "bank-execute", persisted)
		reopened, err := openSignerStoreV2(db)
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		for i := 0; i < 2; i++ {
			state, err := reopened.recoverWENWithdrawalExecutionV1(ctx, c, "bank-execute", digest)
			if err != nil || state != "finalized-success" {
				t.Fatalf("recovery: %s %v", state, err)
			}
		}
		for _, scope := range scopes {
			spent, err := reopened.wenBudgetReservedV1(scope)
			if err != nil || spent != 5000 {
				t.Fatalf("fee reconciliation: %d %v", spent, err)
			}
		}
		if c.sends != 1 {
			t.Fatalf("duplicate send: %d", c.sends)
		}
		t.Log("PASS: Fased reserved, signed, submitted and reconciled compiled-bank withdrawal; restart recovery sends=1 fee=5000 net=970")
	}

}

// Preserve the real bank result while exercising an uncertain transport response.
type sharedBankExecutionRPC struct {
	*rpc.Client
	sends int
	lost  bool
}

func (c *sharedBankExecutionRPC) SendRawTransactionWithOpts(ctx context.Context, wire []byte, opts rpc.TransactionOpts) (solana.Signature, error) {
	c.sends++
	sig, err := c.Client.SendRawTransactionWithOpts(ctx, wire, opts)
	if err == nil && c.lost {
		return sig, errors.New("fixture lost response after bank acceptance")
	}
	return sig, err
}
