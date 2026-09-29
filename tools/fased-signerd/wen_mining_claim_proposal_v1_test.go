package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningClaimProposal(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "review", "bounds", "network-change", "review-change", "paid", "cancelled"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
				svc := &signerServiceV2{store: store, keys: keys}
				cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}, readOnly: true}
				c, _, e := loadWENMiningClaimAdmissionV1(cfg.stateDBPath, "miner", v)
				if e != nil {
					t.Fatal(e)
				}
				keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
				endpoint := "https://claim-proposal.invalid"
				if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
					t.Fatal(e)
				}
				before, e := os.ReadDir(c.root)
				if e != nil {
					t.Fatal(e)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				hash := c.reviewSHA
				expires := uint64(125)
				if mode == "review" {
					hash = wenHashV1([]byte("wrong"))
				}
				if mode == "bounds" {
					expires = 200
				}
				if mode == "cancelled" {
					cancel()
				}
				factory := func(selected string) signerWENBTCReadRPCV1 {
					if selected != endpoint {
						t.Fatal("endpoint")
					}
					switch mode {
					case "network-change":
						_, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed.invalid"})
						if e != nil {
							t.Fatal(e)
						}
					case "review-change":
						if e = os.WriteFile(filepath.Join(c.root, wenMiningClaimAdmissionNameV1(v)), []byte("{}"), 0600); e != nil {
							t.Fatal(e)
						}
					case "paid":
						d := client.page.Value[4].Data.GetBinary()
						if op == "sol" {
							d[10] |= 1
						} else {
							d[10] |= 2
						}
					}
					return client
				}
				out, e := svc.proposeConfiguredWENMiningClaimV1(ctx, cfg, "miner", v, hash, 100, expires, factory)
				if (e == nil) != (mode == "ok") {
					t.Fatal(mode, e)
				}
				if client.sends != 0 {
					t.Fatal("proposal sent")
				}
				after, e := os.ReadDir(c.root)
				if e != nil || len(before) != len(after) {
					t.Fatal("proposal published files")
				}
				if mode == "ok" {
					if out.SigningEnabled || out.ObservedSlot != 101 || out.BaseReviewSHA256 != c.reviewSHA || out.Intent.ExpiresSlot != "125" {
						t.Fatal("proposal")
					}
					expected := v
					expected.ExpiresSlot = "125"
					if !equalWENMiningClaimIntentV1(expected, out.Intent) {
						t.Fatal("proposal changed rights")
					}
					if _, _, e = loadWENMiningClaimAdmissionV1(cfg.stateDBPath, "miner", out.Intent); e == nil {
						t.Fatal("proposal self-admitted")
					}
				}
			})
		}
	}
}

func TestWENMiningClaimProposalWireAdmission(t *testing.T) {
	cfg := signerConfig{readOnly: true, chains: []string{"solana"}}
	req := request{Op: "v2.wenMining.claim.propose", WalletID: "miner", Request: json.RawMessage(`{}`)}
	if err := mustValidate(req, cfg); err != nil {
		t.Fatal("proposal wire rejected", err)
	}
	for _, change := range []request{{Op: req.Op, Request: req.Request}, {Op: req.Op, WalletID: req.WalletID}, {Op: req.Op, WalletID: req.WalletID, Request: req.Request, Chain: "solana"}} {
		if err := mustValidate(change, cfg); err == nil {
			t.Fatal("malformed proposal envelope accepted")
		}
	}
	if !applicationUpdateGateReadOperations[req.Op] {
		t.Fatal("proposal not classified read-only")
	}
}
