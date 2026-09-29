package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"reflect"

	"strconv"
	"testing"
)

func TestWENMiningClaimPoll(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "scoped", "pins-change", "network-change", "review-change", "descriptor-change", "wrong-wallet", "nil-client", "cancelled", "missing", "malformed", "cancel-during", "limit", "operation"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				store, keys, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
				f := client.miningClaimRPCFake
				owner := client.expectedOwner
				program := solana.MustPublicKeyFromBase58(v.ProgramID)
				sale := solana.MustPublicKeyFromBase58(v.Economy)
				if op == "sat" {
					mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), sale[:]}, program)
					dest, _, _ := solana.FindProgramAddress([][]byte{owner[:], solana.Token2022ProgramID[:], mint[:]}, solana.SPLAssociatedTokenAccountProgramID)
					f.addresses[13] = dest
				}
				data := append([]byte(nil), f.page.Value[1].Data.GetBinary()...)
				number := func(n uint64) string { return strconv.FormatUint(n, 10) }
				var capital solana.PublicKey
				copy(capital[:], data[144:176])
				open := binary.LittleEndian.Uint64(data[192:])
				mining := signerWENMiningIntentV1{Operation: "commit", DescriptorSHA256: pins.DescriptorSHA256, CapabilitySHA256: pins.CapabilitySHA256, EntrySHA256: wenHashV1(data), CommitmentSHA256: wenHashV1([]byte("uncommitted")), Genesis: v.Genesis, ProgramID: v.ProgramID, Economy: v.Economy, Offer: f.addresses[0].String(), Entry: f.addresses[1].String(), CapitalVault: capital.String(), Nonce: v.Nonce, Capital: number(binary.LittleEndian.Uint64(data[184:])), Open: number(open), MaxFeeLamports: "5000", MinFinalizedSlot: "100", ExpiresSlot: "132"}
				entry := wenMiningEntrySnapshotV1{Address: f.addresses[1], Owner: program, Data: data, Slot: 101, Now: open}
				if _, e := prepareWENMiningInstructionV1(mining, owner, entry, nil); e != nil {
					t.Fatal("accepted fixture", e)
				}
				miningRaw, miningPins := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: pins.CodeSHA256, DeploymentSlot: pins.DeploymentSlot, UpgradeAuthority: pins.UpgradeAuthority})
				mining.DescriptorSHA256 = miningPins.DescriptorSHA256
				mining.CapabilitySHA256 = miningPins.CapabilitySHA256
				review := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: owner.String(), Intent: mining, Pins: miningPins, MaxSlotLag: 2}
				root := writeMiningReviewFixture(t, store.db.Path(), review)
				path := filepath.Join(root, "admission.json")
				if mode == "scoped" {
					review.Version = 2
					encoded, _ := json.Marshal(review)
					path = filepath.Join(root, wenMiningAdmissionNameV2(mining))
					if e := os.WriteFile(path, encoded, 0600); e != nil {
						t.Fatal(e)
					}
				}
				object := filepath.Join(root, miningPins.DescriptorSHA256)
				if e := os.WriteFile(object, miningRaw, 0600); e != nil {
					t.Fatal(e)
				}
				if mode == "missing" {
					if e := os.Remove(path); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "malformed" {
					if e := os.WriteFile(path, []byte("{}"), 0600); e != nil {
						t.Fatal(e)
					}
				}
				journalVersion := func() int {
					var id int
					if err := store.db.View(func(tx *bolt.Tx) error { id = tx.ID(); return nil }); err != nil {
						t.Fatal(err)
					}
					return id
				}
				var beforeTx int
				keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
				endpoint := "https://claim-host.invalid"
				if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
					t.Fatal(e)
				}
				svc := &signerServiceV2{store: store, keys: keys}
				cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}, readOnly: true}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				id := "miner"
				if mode == "wrong-wallet" {
					id = "other"
				}
				if mode == "cancelled" {
					cancel()
				}
				callPins := pins
				if mode == "pins-change" {
					callPins.CodeSHA256 = wenHashV1([]byte("other-binary"))
				}
				calls := 0
				factory := func(selected string) signerWENBTCReadRPCV1 {
					calls++
					if selected != endpoint {
						t.Fatal("endpoint")
					}
					switch mode {
					case "cancel-during":
						cancel()
					case "nil-client":
						return nil
					case "network-change":
						if _, e := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://changed.invalid"}); e != nil {
							t.Fatal(e)
						}
					case "review-change":
						review.MaxSlotLag++
						encoded, _ := json.Marshal(review)
						if e := os.WriteFile(path, encoded, 0600); e != nil {
							t.Fatal(e)
						}
					case "descriptor-change":
						if e := os.WriteFile(object, []byte("{}"), 0600); e != nil {
							t.Fatal(e)
						}

					}
					if mode == "network-change" {
						beforeTx = journalVersion()
					}
					return &miningClaimLocatorFake{f, "ok"}
				}
				beforeTx = journalVersion()
				limit, operation := 10, op
				if mode == "limit" {
					limit = 11
				}
				if mode == "operation" {
					operation = "invalid"
				}
				batch, e := svc.pollWENMiningAdmissionClaimsV1(ctx, cfg, id, "", limit, operation, callPins, raw, 100, 132, 5000, 2, factory)
				outerFailure := mode == "wrong-wallet" || mode == "cancelled" || mode == "malformed" || mode == "network-change" || mode == "cancel-during" || mode == "limit" || mode == "operation"
				if (e != nil) != outerFailure {
					t.Fatal(mode, e)
				}
				if mode == "missing" {
					if e != nil || len(batch.Items) != 0 || !batch.ScanComplete || batch.NextCursor != "" || calls != 0 {
						t.Fatal(batch, e)
					}
				}
				if !outerFailure && mode != "missing" {
					if !batch.ScanComplete || batch.NextCursor != "" || batch.SigningEnabled || len(batch.Items) != 1 {
						t.Fatal(batch)
					}
					item := batch.Items[0]
					if mode == "ok" || mode == "scoped" {
						if item.Status != "requires-review" || item.ReviewDraft == nil || item.Proposal == nil || item.Proposal.SigningEnabled || item.Proposal.Intent.ExpectedGross != v.ExpectedGross {
							t.Fatal(item)
						}
						// Pass the draft to the actual installer in this isolated test fixture.
						// Application/read-only contexts must reject it before publication.
						execFactory := func(string) wenMiningClaimExecutionRPCV1 { return &miningClaimDraftInstallerFake{client} }
						if _, err := svc.installMiningClaimBootstrapV1(ctx, cfg, id, *item.ReviewDraft, false, execFactory); err == nil {
							t.Fatal("application installed draft")
						}
						if _, err := svc.installMiningClaimBootstrapV1(ctx, cfg, id, *item.ReviewDraft, true, execFactory); err == nil {
							t.Fatal("readonly installed draft")
						}
						installCfg := cfg
						installCfg.readOnly = false
						exported, err := json.Marshal(item.ReviewDraft)
						if err != nil {
							t.Fatal(err)
						}
						server := startSignerAdminTestServer(t, func(req request) ([]byte, error) {
							if req.Op != "v2.wenMining.claimReview.install" || req.WalletID != id {
								return nil, fmt.Errorf("wrong admission dispatch")
							}
							var transported wenMiningClaimBootstrapV1
							if err := decodeSignerAdminStrictJSON(req.Request, &transported); err != nil {
								return nil, err
							}
							if !reflect.DeepEqual(transported, *item.ReviewDraft) {
								return nil, fmt.Errorf("draft changed in transit")
							}
							admitted, err := svc.installMiningClaimBootstrapV1(ctx, installCfg, id, transported, true, execFactory)
							if err != nil {
								return nil, err
							}
							return marshalSignerResultV2(admitted)
						})
						var stdout bytes.Buffer
						err = runSignerAdminCLI([]string{"wen-mining", "install-claim-review", "--control-socket", server.path, "--wallet-id", id}, bytes.NewReader(exported), &stdout, nil)
						waitSignerAdminTestServer(t, server)
						if err != nil {
							t.Fatal("CLI draft handoff", err)
						}
						var receipt wenMiningReviewReceiptV1
						if err := json.Unmarshal(stdout.Bytes(), &receipt); err != nil || receipt.SigningEnabled || receipt.Status != "review-installed" {
							t.Fatal("CLI receipt", err)
						}
						repeated, err := svc.installMiningClaimBootstrapV1(ctx, installCfg, id, *item.ReviewDraft, true, execFactory)
						if err != nil || repeated != receipt {
							t.Fatal("CLI installed receipt mismatch", err)
						}
						if _, _, err := loadWENMiningClaimAdmissionV1(cfg.stateDBPath, id, item.ReviewDraft.Review.Intent); err != nil {
							t.Fatal(err)
						}
						body, err := json.Marshal(wenMiningClaimRecoveryRequestV1{Limit: 10, Operation: op, Pins: callPins, Descriptor: raw, MinFinalizedSlot: "100", ExpiresSlot: "132", MaxFeeLamports: "5000", MaxSlotLag: "2"})
						if err != nil {
							t.Fatal(err)
						}
						wire, err := svc.recoverWENMiningClaimsWithFactoryV1(ctx, request{WalletID: id, Request: body}, cfg, factory)
						if err != nil {
							t.Fatal("recovery service", err)
						}
						var envelope struct {
							OK     bool                 `json:"ok"`
							Result wenMiningClaimPollV1 `json:"result"`
						}
						if err := json.Unmarshal(wire, &envelope); err != nil || !envelope.OK {
							t.Fatal("response envelope", err)
						}
						transported := envelope.Result
						if len(transported.Items) != 1 || transported.Items[0].ReviewDraft == nil || transported.SigningEnabled {
							t.Fatal("recovery wire", string(wire))
						}
						// A repeated tick can reproduce a proposal, but never submits.
						retry, err := svc.pollWENMiningAdmissionClaimsV1(ctx, cfg, id, batch.NextCursor, 10, op, callPins, raw, 100, 132, 5000, 2, factory)
						if err != nil || len(retry.Items) != 1 || retry.Items[0].Status != "requires-review" {
							t.Fatal(retry, err)
						}
					} else if item.Status != "readback-rejected" || item.ReviewDraft != nil || item.Proposal != nil {
						t.Fatal(item)
					}
				}
				if mode == "pins-change" && calls != 0 {
					t.Fatal("changed deployment reached RPC")
				}

				if journalVersion() != beforeTx {
					t.Fatal("host wrote journal")
				}
				if client.sends != 0 {
					t.Fatal("host sent")
				}
			})
		}
	}
}

// The recovered proposal advances its minimum to the observed finalized slot.
type miningClaimDraftInstallerFake struct{ *miningClaimExecutorFake }

func (f *miningClaimDraftInstallerFake) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, opts *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	return (&miningClaimLocatorFake{f.miningClaimRPCFake, "ok"}).GetMultipleAccountsWithOpts(ctx, keys, opts)
}
