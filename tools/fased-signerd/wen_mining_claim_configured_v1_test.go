package main

import (
	"context"
	"encoding/json"
	"fmt"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningClaimConfiguredService(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, human := range []bool{false, true} {
		for _, op := range []string{"sol", "sat"} {
			for _, mode := range []string{"success", "lost-success", "wrong-db", "read-only", "disallowed-chain", "nil-client", "network-change", "policy-change", "review-change", "cancelled", "wrong-proof"} {
				t.Run(fmt.Sprintf("%s/%s/human=%t", op, mode, human), func(t *testing.T) {
					if mode == "wrong-proof" && !human {
						return
					}
					store, keys, v, policy, client := miningClaimExecutionFixture(t, raw, pins, op, mode)
					endpoint := "https://claim-configured-fixture.invalid"
					keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
					if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
					var authService *signerWebAuthnServiceV2
					var proof *signerWebAuthnProofReferenceV2
					if human {
						prepared, err := prepareReviewedWENMiningClaimV1(context.Background(), client, store.db.Path(), "miner", v)
						if err != nil {
							t.Fatal(err)
						}
						a, _, err := newWENMiningClaimReviewArtifactV1("state-request", "miner", policy.Hash, v, prepared)
						if err != nil {
							t.Fatal(err)
						}
						if _, err := store.storeWENMiningClaimReviewV1(a); err != nil {
							t.Fatal(err)
						}
						authService, err = newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
						if err != nil {
							t.Fatal(err)
						}
						auth := newTestWebAuthnAuthenticatorV2(t)
						fixture := &testSignerWebAuthnFixtureV2{store: store, service: authService, walletID: "miner"}
						fixture.enroll(t, auth)
						begin, err := authService.beginReviewAuthorization("miner", signerReviewAuthorizationBeginRequestV2{RequestID: "state-request"})
						if err != nil {
							t.Fatal(err)
						}
						finish, err := fixture.finishReview(t, begin, auth, 2)
						if err != nil {
							t.Fatal(err)
						}
						proof = &finish.Authorization.Proof
						if mode == "wrong-proof" {
							proof.ProofID = "invalid-proof"
						}
					}
					service := &signerServiceV2{store: store, keys: keys, webauthn: authService}
					cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
					if mode == "read-only" {
						cfg.readOnly = true
					}
					if mode == "wrong-db" {
						cfg.stateDBPath += ".other"
					}
					if mode == "disallowed-chain" {
						cfg.chains = []string{"ethereum"}
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					if mode == "cancelled" {
						cancel()
					}
					factories := 0
					factory := func(selected string) wenMiningClaimExecutionRPCV1 {
						factories++
						if selected != endpoint {
							t.Fatal("unconfigured endpoint")
						}
						switch mode {
						case "nil-client":
							return nil
						case "network-change":
							if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-claim.invalid"}); e != nil {
								t.Fatal(e)
							}
						case "policy-change":
							p := policy
							p.Assets[0].MaxDaily = "20000"
							if _, e := store.putPolicy(p, policy.Version); e != nil {
								t.Fatal(e)
							}
						case "review-change":
							path := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining-claim", wenHashV1([]byte("miner")), wenMiningClaimAdmissionNameV1(v))
							if e := os.WriteFile(path, []byte("{}"), 0600); e != nil {
								t.Fatal(e)
							}
						}
						return client
					}
					var digest, status string
					var e error
					if human {
						body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: "state-request", Action: "execute", Proof: proof})
						var encoded []byte
						encoded, e = service.miningClaimJourneyWithFactoryV1(ctx, request{WalletID: "miner", Request: body}, cfg, factory)
						if e == nil {
							var envelope struct {
								Result wenMiningClaimJourneyResultV1 `json:"result"`
							}
							if err := json.Unmarshal(encoded, &envelope); err != nil {
								t.Fatal(err)
							}
							result := envelope.Result
							digest, status = result.Digest, result.Outcome
							if mode == "wrong-proof" {
								t.Fatal("invalid proof reached a reservation", result)
							}
							if result.RequestID != "state-request" || result.WalletID != "miner" || result.RecoveryRequired {
								t.Fatal("unexpected journey identity/outcome", result)
							}
							// The same execute request after a lost reply reconciles; it cannot send again.
							if _, err := service.miningClaimJourneyWithFactoryV1(ctx, request{WalletID: "miner", Request: body}, cfg, factory); err != nil {
								t.Fatal(err)
							}
							recovery, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: "state-request", Action: "recover"})
							if _, err := service.miningClaimJourneyWithFactoryV1(ctx, request{WalletID: "miner", Request: recovery}, cfg, factory); err != nil {
								t.Fatal(err)
							}
							if client.sends != 1 {
								t.Fatal("journey recovery resent")
							}
						}
					} else {
						digest, status, e = service.executeConfiguredMiningClaimWithFactoryV1(ctx, cfg, "state-request", "miner", v, factory)
					}
					if mode == "wrong-proof" {
						if e == nil || client.sends != 0 {
							t.Fatal("invalid proof accepted")
						}
						if err := store.db.View(func(tx *bolt.Tx) error {
							b := tx.Bucket(wenBudgetBucketV1)
							if b != nil && b.Get([]byte("request:state-request")) != nil {
								t.Fatal("invalid proof reserved claim")
							}
							return nil
						}); err != nil {
							t.Fatal(err)
						}
					}
					good := mode == "success" || mode == "lost-success"
					if (e == nil) != good {
						t.Fatal(mode, status, e)
					}
					if good {
						if digest == "" || status != "finalized-success" || client.sends != 1 {
							t.Fatal("configured execution", status, e)
						}
						if _, e = store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", digest); e != nil {
							t.Fatal(e)
						}
					} else if digest != "" || client.sends != 0 {
						t.Fatal("changed admission reserved or sent", digest, status)
					}
					if (mode == "wrong-db" || mode == "read-only" || mode == "disallowed-chain") && factories != 0 {
						t.Fatal("invalid config reached RPC")
					}
				})
			}
		}
	}

}
