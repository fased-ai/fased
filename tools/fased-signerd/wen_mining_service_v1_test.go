package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type miningPreviewHook struct {
	*miningPrepareFake
	after func()
}

func (m *miningPreviewHook) SimulateRawTransactionWithOpts(ctx context.Context, wire []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	r, e := m.miningPrepareFake.SimulateRawTransactionWithOpts(ctx, wire, o)
	if m.after != nil {
		m.after()
	}
	return r, e
}
func TestWENMiningConfiguredPreviewV1(t *testing.T) {
	for _, mode := range []string{"valid", "state", "chain", "wallet", "policy", "missing-network", "genesis", "network-change", "policy-change", "review-change"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			f := miningFixture(t)
			record, old := createTestSignerWalletV2(t, store, keys, "miner", f.Intent.Economy, 100, 100)
			wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
			f = miningWalletFixture(t, wallet)
			p, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningV1 + ".commit"}, Programs: []string{f.Intent.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{f.Intent.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			prep, pins, v := miningPrepareSetup(t, f, "commit", "ok")
			review := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: v, Pins: pins, MaxSlotLag: 2}
			if mode == "wallet" {
				review.WalletPublicKey = solana.NewWallet().PublicKey().String()
			}
			root := writeMiningReviewFixture(t, store.db.Path(), review)
			data, e := os.ReadFile(filepath.Join(prep.root, f.PreimageKey+".json"))
			if e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(filepath.Join(root, f.PreimageKey+".json"), data, 0600); e != nil {
				t.Fatal(e)
			}
			prep.root = root
			keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
			if mode == "genesis" {
				keys.genesisHash = func(string) (string, error) { return "11111111111111111111111111111111", nil }
			}
			endpoint := "https://fixture.invalid/mining?token=fixture-only"
			if mode != "missing-network" {
				if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
					t.Fatal(e)
				}
			}
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			if mode == "state" {
				cfg.stateDBPath += "-other"
			}
			if mode == "chain" {
				cfg.chains = []string{"ethereum"}
			}
			changePolicy := func() {
				p.Operations = []string{intentWENMiningV1 + ".reveal"}
				if _, e = store.putPolicy(p, p.Version); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "policy" {
				changePolicy()
			}
			client := &miningPreviewHook{miningPrepareFake: prep}
			switch mode {
			case "network-change":
				client.after = func() {
					if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://different.invalid"}); e != nil {
						t.Fatal(e)
					}
				}
			case "policy-change":
				client.after = changePolicy
			case "review-change":
				client.after = func() {
					if e = os.Remove(filepath.Join(root, "admission.json")); e != nil {
						t.Fatal(e)
					}
				}
			}
			called := false
			service := &signerServiceV2{store: store, keys: keys}
			result, e := service.prepareConfiguredMiningWithFactoryV1(context.Background(), cfg, "miner", v, func(url string) wenMiningPrepareRPCV1 {
				called = true
				if url != endpoint {
					t.Fatal("request endpoint override")
				}
				return client
			})
			if (e == nil) != (mode == "valid") {
				t.Fatal("unexpected preview", e)
			}
			if mode == "valid" {
				if !called || result.SigningEnabled || result.NetworkFee != 5000 || result.Slot != 150 {
					t.Fatal("invalid preview")
				}
				raw, _ := json.Marshal(result)
				if strings.Contains(string(raw), endpoint) || strings.Contains(string(raw), f.Preimage.Salt) {
					t.Fatal("private material in preview")
				}
			}
		})
	}
}

func TestWENMiningPreparationDispatchV1(t *testing.T) {
	store, keys := openTestSignerV2(t)
	f := miningFixture(t)
	service := &signerServiceV2{store: store, keys: keys}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	raw, _ := json.Marshal(f.Intent)
	if !applicationUpdateGateReadOperations["v2.wenMining.prepare"] {
		t.Fatal("preparation must remain read-only")
	}
	_, e := service.handle(request{Op: "v2.wenMining.prepare", WalletID: "miner", Request: raw}, cfg, false)
	if e == nil || !strings.Contains(e.Error(), "mining review") {
		t.Fatal("dispatch did not fail at absent protected review", e)
	}
	raw = append([]byte(`{"rpcUrl":"https://attacker.invalid",`), raw[1:]...)
	_, e = service.handle(request{Op: "v2.wenMining.prepare", WalletID: "miner", Request: raw}, cfg, false)
	if e == nil {
		t.Fatal("request endpoint accepted")
	}
}
