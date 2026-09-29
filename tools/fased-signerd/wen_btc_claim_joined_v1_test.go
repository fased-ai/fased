package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
)

func claimJoinedFixture(t *testing.T, owners ...solana.PublicKey) (signerWENBTCClaimIntentV1, wenStakingPinsV1, *wenReadRPCFake) {
	wallet := solana.PublicKey{5}
	if len(owners) > 0 {
		wallet = owners[0]
	}
	v, s := claimHistoryFixture(t, true, wallet)
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	code := []byte{9, 8, 7}
	program := make([]byte, 36)
	binary.LittleEndian.PutUint32(program, 2)
	copy(program[4:], pd[:])
	data := make([]byte, 48)
	binary.LittleEndian.PutUint32(data, 3)
	binary.LittleEndian.PutUint64(data[4:], 1)
	copy(data[45:], code)
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock, 150)
	binary.LittleEndian.PutUint64(clock[32:], s.Now)
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, DeploymentSlot: 1, CodeSHA256: wenHashV1(code)}
	ix, _ := buildWENBTCClaimInstructionV1(v, wallet)
	keys := []solana.PublicKey{}
	for _, i := range []int{3, 4, 5, 6, 7, 8} {
		keys = append(keys, ix.Accounts()[i].PublicKey)
	}
	keys = append(keys, p, pd, solana.SysVarClockPubkey)
	for _, i := range []int{12, 9, 10, 14, 1, 2} {
		keys = append(keys, ix.Accounts()[i].PublicKey)
	}
	account := func(owner solana.PublicKey, d []byte, ex bool) *rpc.Account {
		return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(d), Executable: ex}
	}
	values := []*rpc.Account{}
	for _, a := range []*signerWENBTCAccountV1{s.Funding, s.Cohort, s.History, s.Settlement} {
		values = append(values, account(a.Owner, a.Data, false))
	}
	values = append(values, nil, nil, account(solana.BPFLoaderUpgradeableProgramID, program, true), account(solana.BPFLoaderUpgradeableProgramID, data, false), account(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false))
	mint, vault, destination, token := claimCustodyFixture(t, v, wallet)
	for _, a := range []*signerWENBTCAccountV1{mint, vault, destination, token} {
		values = append(values, account(a.Owner, a.Data, a.Executable))
	}
	saleAccount, activation := claimActivationFixture(t, v)
	for _, a := range []*signerWENBTCAccountV1{saleAccount, activation} {
		values = append(values, account(a.Owner, a.Data, false))
	}
	f := wenReadRPCFake{t: t, genesis: solana.Hash{1}, addresses: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: values}, change: "ok"}
	return v, pins, &f
}

type claimJoinedFake struct {
	*claimCostFake
	reader *wenReadRPCFake
	after  func()
}

func (f *claimJoinedFake) GetGenesisHash(c context.Context) (solana.Hash, error) {
	return f.reader.GetGenesisHash(c)
}
func (f *claimJoinedFake) GetSlot(c context.Context, k rpc.CommitmentType) (uint64, error) {
	return f.reader.GetSlot(c, k)
}
func (f *claimJoinedFake) GetMultipleAccountsWithOpts(c context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	return f.reader.GetMultipleAccountsWithOpts(c, k, o)
}
func (f *claimJoinedFake) SimulateRawTransactionWithOpts(c context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	r, e := f.claimCostFake.SimulateRawTransactionWithOpts(c, b, o)
	if f.after != nil {
		f.after()
	}
	return r, e
}
func TestWENBTCClaimJoinedPreparation(t *testing.T) {
	for _, mode := range []string{"ok", "balance-change", "vault-change", "review-change", "descriptor-change", "paid-during", "clock-advance", "slot-rollback", "height-rollback", "height-expired", "reserve", "cancel", "restart", "review-before-reserve", "submit", "submit-review-change", "execute-failed", "execute-uncertain", "execute-success", "execute-lost-success"} {
		t.Run(mode, func(t *testing.T) {
			key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{17}, 32))
			wallet := solana.PublicKey{5}
			if mode == "submit" || mode == "submit-review-change" || mode == "execute-failed" || mode == "execute-uncertain" || mode == "execute-success" || mode == "execute-lost-success" {
				wallet = solana.PublicKeyFromBytes(key.Public().(ed25519.PublicKey))
			}
			v, pins, reader := claimJoinedFixture(t, wallet)
			v.MaxRentLamports = "1000"
			raw, dp := btcClaimDescriptorFixture(t, "ok")
			var d map[string]any
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			if e := dec.Decode(&d); e != nil {
				t.Fatal(e)
			}
			dep := d["deployment"].(map[string]any)["btcClaim"].(map[string]any)
			p := solana.MustPublicKeyFromBase58(v.ProgramID)
			dep["program"] = hex.EncodeToString(p[:])
			dep["genesis"] = v.Genesis
			dep["deploymentSlot"] = "1"
			dep["deployedBytesHash"] = pins.CodeSHA256
			dep["upgradeAuthority"] = nil
			delete(d, "descriptorDigest")
			raw, _ = wenJSONV1(d)
			d["descriptorDigest"] = "sha256:" + wenHashV1(raw)
			raw, _ = wenJSONV1(d)
			pins.DescriptorSHA256 = wenHashV1(raw)
			pins.CapabilitySHA256 = dp.CapabilitySHA256
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			store, keyManager := openTestSignerV2(t)
			db := store.db.Path()
			root := filepath.Join(filepath.Dir(db), "wen-btc-claim", wenHashV1([]byte("miner")))
			if e := os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			descriptor := filepath.Join(root, pins.DescriptorSHA256)
			if e := os.WriteFile(descriptor, raw, 0600); e != nil {
				t.Fatal(e)
			}
			review := wenBTCClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: wallet.String(), Intent: v, Policy: solana.PublicKey{6}.String(), USDC: solana.PublicKey{7}.String(), Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 6000}
			reviewPath := filepath.Join(root, wenBTCClaimAdmissionNameV1(v))
			write := func() {
				b, _ := json.Marshal(review)
				if e := os.WriteFile(reviewPath, b, 0600); e != nil {
					t.Fatal(e)
				}
			}
			write()
			client := &claimJoinedFake{claimCostFake: &claimCostFake{t: t, mode: "ok"}, reader: reader}
			client.after = func() {
				switch mode {
				case "balance-change", "vault-change":
					index := 11
					if mode == "vault-change" {
						index = 10
					}
					a := reader.page.Value[index]
					b := append([]byte(nil), a.Data.GetBinary()...)
					b[64] ^= 1
					a.Data = rpc.DataBytesOrJSONFromBytes(b)
				case "review-change":
					review.MaxSlotLag++
					write()
				case "descriptor-change":
					os.WriteFile(descriptor, []byte("{}"), 0600)
				case "paid-during":
					reader.page.Value[5] = reader.page.Value[0]
				case "clock-advance":
					a := reader.page.Value[8]
					b := append([]byte(nil), a.Data.GetBinary()...)
					binary.LittleEndian.PutUint64(b[32:], 43*86400+1)
					a.Data = rpc.DataBytesOrJSONFromBytes(b)
				case "height-rollback", "height-expired":
					client.claimCostFake.mode = mode
				case "slot-rollback":
					reader.page.Context.Slot = 149
				}
			}
			out, e := prepareReviewedWENBTCClaimV1(context.Background(), client, db, "miner", v)
			good := mode == "ok" || mode == "clock-advance" || mode == "reserve" || mode == "cancel" || mode == "restart" || mode == "review-before-reserve" || mode == "submit" || mode == "submit-review-change" || mode == "execute-failed" || mode == "execute-uncertain" || mode == "execute-success" || mode == "execute-lost-success"
			if (e == nil) != good {
				t.Fatal(e)
			}
			if good && (out.total != 6000 || out.state.Amount != 250 || out.wallet != wallet) {
				t.Fatal("unbound preparation")
			}
			if mode == "ok" {
				bound := wenBTCClaimMessageBindingV1{Amount: 250, Weight: 25, Message: out.message, Blockhash: out.blockhash, ReviewSHA: out.review.reviewSHA, StateHash: out.state.StateHash, Slot: out.slot, Fee: out.fee, Rent: out.rent, LastValidHeight: out.lastValidHeight}
				checked, e := preparePinnedWENBTCClaimV1(context.Background(), client, db, "miner", v, &bound)
				if e != nil || checked == nil || !bytes.Equal(checked.message, out.message) {
					t.Fatal("joined original-message revalidation", e)
				}
			}
			if mode == "reserve" || mode == "cancel" || mode == "restart" || mode == "review-before-reserve" || mode == "submit" || mode == "submit-review-change" || mode == "execute-failed" || mode == "execute-uncertain" || mode == "execute-success" || mode == "execute-lost-success" {
				policy, e := store.putWalletAndPolicy(signerWalletRecordV2{WalletID: "miner", PublicKey: review.WalletPublicKey}, signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENBTCClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "6000", MaxDaily: "6000"}}}, 0)
				if e != nil {
					t.Fatal(e)
				}
				scopes := []string{wenMiningNativeScopeV1("miner", v.Genesis), wenBTCClaimLaunchScopeV1("miner", v)}
				for _, scope := range scopes {
					if e = store.configureWENBudgetV1(scope, 6000); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "review-before-reserve" {
					review.MaxSlotLag++
					write()
				}

				if mode == "execute-failed" || mode == "execute-uncertain" || mode == "execute-success" || mode == "execute-lost-success" {
					_, _, e := keyManager.storeNewKeyWithPolicy("executor", solana.PrivateKey(key), signerPolicyV2{WalletID: "executor", Role: "agent", Operations: []string{intentWENBTCClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "6000", MaxDaily: "6000"}}}, 0)
					if e != nil {
						t.Fatal(e)
					}
					review.WalletID = "executor"
					eroot := filepath.Join(filepath.Dir(db), "wen-btc-claim", wenHashV1([]byte("executor")))
					os.MkdirAll(eroot, 0700)
					rb, _ := json.Marshal(review)
					os.WriteFile(filepath.Join(eroot, wenBTCClaimAdmissionNameV1(v)), rb, 0600)
					os.WriteFile(filepath.Join(eroot, pins.DescriptorSHA256), raw, 0600)
					for _, scope := range []string{wenMiningNativeScopeV1("executor", v.Genesis), wenBTCClaimLaunchScopeV1("executor", v)} {
						if e = store.configureWENBudgetV1(scope, 6000); e != nil {
							t.Fatal(e)
						}
					}
					keyManager.genesisHash = func(string) (string, error) { return v.Genesis, nil }
					const endpoint = "https://claim-fixture.invalid"
					if _, e = keyManager.PutNetworkV2("executor", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
					servicePreview := &signerServiceV2{store: store, keys: keyManager}
					cfg := signerConfig{stateDBPath: db, chains: []string{"solana"}}
					factory := func(selected string) wenStakingPrepareRPCV1 {
						if selected != endpoint {
							t.Fatal("unconfigured RPC")
						}
						return client
					}
					preview, e := servicePreview.prepareConfiguredBTCClaimWithFactoryV1(context.Background(), cfg, "executor", v, factory)
					if e != nil || preview.SigningEnabled || preview.NetBTC != 250 || preview.Rent != 1000 {
						t.Fatal("configured preview", e)
					}
					badConfig := cfg
					badConfig.stateDBPath += ".other"
					if _, e = servicePreview.prepareConfiguredBTCClaimWithFactoryV1(context.Background(), badConfig, "executor", v, func(string) wenStakingPrepareRPCV1 { t.Fatal("wrong store reached RPC"); return client }); e == nil {
						t.Fatal("wrong store accepted")
					}
					if _, e = servicePreview.prepareConfiguredBTCClaimWithFactoryV1(context.Background(), cfg, "executor", v, func(selected string) wenStakingPrepareRPCV1 {
						if _, e := keyManager.PutNetworkV2("executor", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed-claim.invalid"}); e != nil {
							t.Fatal(e)
						}
						return client
					}); e == nil {
						t.Fatal("network change accepted")
					}
					if _, e = keyManager.PutNetworkV2("executor", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(2), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
					c := &claimExecutorFake{claimJoinedFake: client, store: store, mode: mode}
					service := &signerServiceV2{store: store, keys: keyManager}

					rejectedDigest, _, guardErr := service.executeConfiguredBTCClaimWithFactoryV1(context.Background(), cfg, "changed-network-claim", "executor", v, func(selected string) wenBTCClaimExecutionRPCV1 {
						if _, e := keyManager.PutNetworkV2("executor", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(3), PrimaryRPCURL: "https://execution-change.invalid"}); e != nil {
							t.Fatal(e)
						}
						return c
					})
					if guardErr == nil || rejectedDigest != "" || c.sends != 0 {
						t.Fatal("changed execution network admitted", guardErr)
					}
					if _, e = keyManager.PutNetworkV2("executor", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(4), PrimaryRPCURL: endpoint}); e != nil {
						t.Fatal(e)
					}
					digest, outcome, e := service.executeConfiguredBTCClaimWithFactoryV1(context.Background(), cfg, "execution-claim", "executor", v, func(selected string) wenBTCClaimExecutionRPCV1 {
						if selected != endpoint {
							t.Fatal("execution endpoint")
						}
						return c
					})
					if c.sends != 1 || digest == "" {
						t.Fatal("executor", e, c.sends)
					}
					if mode == "execute-failed" {
						if e != nil || outcome != "finalized-failed" {
							t.Fatal(outcome, e)
						}
					} else if mode == "execute-success" || mode == "execute-lost-success" {
						if e != nil || outcome != "finalized-success" {
							t.Fatal(outcome, e)
						}
					} else if e == nil || outcome != "submission-uncertain" {
						t.Fatal(outcome, e)
					}
					want := uint64(6000)
					if mode == "execute-success" || mode == "execute-lost-success" {
						want = 5500
					}
					if mode == "execute-failed" {
						want = 5000
					}
					if e = store.db.View(func(tx *bolt.Tx) error {
						for _, scope := range []string{wenMiningNativeScopeV1("executor", v.Genesis), wenBTCClaimLaunchScopeV1("executor", v)} {
							var b wenBudgetBalanceV1
							if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
								return e
							}
							if b.Reserved != want {
								t.Fatal("execution budget", b.Reserved, want)
							}
						}
						return nil
					}); e != nil {
						t.Fatal(e)
					}
					if _, e = store.recoverWENBTCClaimExecutionV1(context.Background(), c, "execution-claim", digest); e != nil {
						t.Fatal(e)
					}
					if c.sends != 1 {
						t.Fatal("recovery resent")
					}
					return
				}
				digest, replay, e := store.reservePreparedWENBTCClaimV1("joined-claim", "miner", policy.Hash, v, out)
				if mode == "review-before-reserve" {
					if e == nil {
						t.Fatal("changed review reserved")
					}
					return
				}
				if e != nil || replay {
					t.Fatal("reserve", e)
				}
				if mode == "restart" {
					if e = store.db.Close(); e != nil {
						t.Fatal(e)
					}
					store, e = openSignerStoreV2(db)
					if e != nil {
						t.Fatal(e)
					}
					defer store.db.Close()
				}
				d, again, e := store.reservePreparedWENBTCClaimV1("joined-claim", "miner", policy.Hash, v, out)
				if e != nil || !again || d != digest {
					t.Fatal("durable replay", e)
				}

				if mode == "submit" || mode == "submit-review-change" || mode == "execute-failed" || mode == "execute-uncertain" || mode == "execute-success" || mode == "execute-lost-success" {
					ix, _ := buildWENBTCClaimInstructionV1(v, wallet)
					tx, _ := solana.NewTransaction([]solana.Instruction{ix}, out.blockhash, solana.TransactionPayer(wallet))
					tx.Message.SetVersion(solana.MessageVersionV0)
					all, _ := tx.Message.GetAllKeys()
					keys := make([]string, len(all))
					for i, k := range all {
						keys[i] = k.String()
					}
					if e = store.beginWENSigningAccountsV1("joined-claim", digest, wenHashV1(out.message), keys, out.slot); e != nil {
						t.Fatal(e)
					}
					var sig solana.Signature
					copy(sig[:], ed25519.Sign(key, out.message))
					if e = store.recordWENSignatureV1("joined-claim", digest, out.message, sig.String()); e != nil {
						t.Fatal(e)
					}
					if mode == "submit-review-change" {
						review.MaxSlotLag++
						write()
					}
					wire, e := store.prepareWENBTCClaimSubmissionV1(context.Background(), client, "joined-claim", digest)
					if mode == "submit-review-change" {
						if e == nil {
							t.Fatal("changed signed review submitted")
						}
						return
					}
					if e != nil || !bytes.Equal(wire[65:], out.message) {
						t.Fatal("joined signed submission", e)
					}
					if _, e = store.prepareWENBTCClaimSubmissionV1(context.Background(), client, "joined-claim", digest); e == nil {
						t.Fatal("duplicate submission")
					}
					if e = store.Close(); e != nil {
						t.Fatal(e)
					}
					store, e = openSignerStoreV2(db)
					if e != nil {
						t.Fatal(e)
					}
					defer store.Close()
					if _, e = store.prepareWENBTCClaimSubmissionV1(context.Background(), client, "joined-claim", digest); e == nil {
						t.Fatal("restart duplicate submission")
					}
				}
				want := uint64(6000)
				if mode == "execute-success" || mode == "execute-lost-success" {
					want = 5500
				}
				if mode == "cancel" {
					for i := 0; i < 2; i++ {
						if e = store.cancelWENReservationV1("joined-claim", digest); e != nil {
							t.Fatal("cancel", e)
						}
					}
					want = 0
					if _, _, e = store.reservePreparedWENBTCClaimV1("other-claim", "miner", policy.Hash, v, out); e == nil {
						t.Fatal("cancel reused entitlement")
					}
				}
				if e = store.db.View(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					for _, scope := range scopes {
						var balance wenBudgetBalanceV1
						if e := json.Unmarshal(b.Get([]byte("limit:"+scope)), &balance); e != nil {
							return e
						}
						if balance.Reserved != want {
							t.Fatalf("budget %d want %d", balance.Reserved, want)
						}
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
			}

		})
	}
}

func (f *claimJoinedFake) GetBlockHeight(c context.Context, k rpc.CommitmentType) (uint64, error) {
	if f.claimCostFake.heightCalls >= 2 {
		if f.mode == "height-rollback" {
			return 99, nil
		}
		if f.mode == "height-expired" {
			return 200, nil
		}
	}
	return f.claimCostFake.GetBlockHeight(c, k)
}
