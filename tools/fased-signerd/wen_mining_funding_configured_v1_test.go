package main

import (
	"bytes"
	"context"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWENMiningFundingConfiguredService(t *testing.T) {
	raw, pins := fundingDescriptorFixture(t)
	for _, action := range []string{"preview", "execute"} {
		t.Run(action, func(t *testing.T) {
			for _, mode := range []string{"success", "lost-success", "wrong-db", "disallowed-chain", "nil-client", "network-change", "policy-change", "review-change", "cancelled"} {
				t.Run(mode, func(t *testing.T) {
					store, keys, v, policy, client := fundingExecutionFixture(t, raw, pins, mode)
					endpoint := "https://funding-configured-fixture.invalid"
					keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
					if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
					service := &signerServiceV2{store: store, keys: keys}
					cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
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
					snapshot := func() []byte {
						var b bytes.Buffer
						if e := store.db.View(func(tx *bolt.Tx) error { _, e := tx.WriteTo(&b); return e }); e != nil {
							t.Fatal(e)
						}
						return b.Bytes()
					}
					before := snapshot()
					factories := 0
					factory := func(selected string) *fundingExecutorFake {
						factories++
						if selected != endpoint {
							t.Fatal("unconfigured RPC selected")
						}
						switch mode {
						case "nil-client":
							return nil
						case "network-change":
							if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-funding.invalid"}); e != nil {
								t.Fatal(e)
							}
						case "policy-change":
							p := policy
							p.Assets[0].MaxDaily = "20000"
							if _, e := store.putPolicy(p, policy.Version); e != nil {
								t.Fatal(e)
							}
						case "review-change":
							p := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining-funding", wenHashV1([]byte("miner")), wenMiningFundingAdmissionNameV1(v))
							if e := os.WriteFile(p, []byte("{}"), 0600); e != nil {
								t.Fatal(e)
							}
						}
						return client
					}
					good := mode == "success" || mode == "lost-success"
					if action == "preview" {
						out, e := service.prepareConfiguredMiningFundingWithFactoryV1(ctx, cfg, "miner", v, func(s string) wenMiningPrepareRPCV1 {
							c := factory(s)
							if c == nil {
								return nil
							}
							return c
						})
						if (e == nil) != good {
							t.Fatal(mode, e)
						}
						if e == nil {
							if out.SigningEnabled || out.CapitalLamports != "6000" || out.NetworkFee != 5000 || out.Rent != 0 || out.MessageSHA256 == "" || out.Operation != "portfolio-mining-funding" {
								t.Fatal("wrong preview", out)
							}
							data, _ := json.Marshal(out)
							for _, secret := range []string{"rpcUrl", "privateKey", "signature", "blockhash", "https://"} {
								if strings.Contains(string(data), secret) {
									t.Fatal("preview leaked execution material")
								}
							}
							if !bytes.Equal(before, snapshot()) {
								t.Fatal("preview mutated wallet state")
							}
						}
						if client.sends != 0 {
							t.Fatal("preview sent transaction")
						}
					} else {
						digest, status, e := service.executeConfiguredMiningFundingWithFactoryV1(ctx, cfg, "state-request", "miner", v, func(s string) wenMiningFundingExecutionRPCV1 {
							c := factory(s)
							if c == nil {
								return nil
							}
							return c
						})
						if (e == nil) != good {
							t.Fatal(mode, status, e)
						}
						if good {
							if digest == "" || status != "finalized-success" || client.sends != 1 {
								t.Fatal("configured execution", status, e)
							}
							if _, e = store.recoverWENMiningFundingExecutionV1(context.Background(), client, "state-request", digest); e != nil {
								t.Fatal(e)
							}
						} else if digest != "" || client.sends != 0 {
							t.Fatal("changed admission reserved or sent", digest, status)
						}
					}
					if (mode == "wrong-db" || mode == "disallowed-chain") && factories != 0 {
						t.Fatal("invalid config reached RPC")
					}
				})
			}
		})
	}
}
