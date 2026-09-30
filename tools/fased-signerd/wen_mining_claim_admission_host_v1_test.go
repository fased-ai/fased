package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"

	"strconv"
	"testing"
)

func TestWENMiningClaimAdmissionHost(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "scoped", "pins-change", "network-change", "review-change", "descriptor-change", "wrong-wallet", "nil-client", "cancelled", "missing", "malformed"} {
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
				if mode == "ok" || mode == "scoped" {
					found, err := svc.discoverConfiguredWENMiningAdmissionsV1(ctx, cfg, id, "", 10)
					if err != nil || len(found.Candidates) != 1 || !found.Complete || found.SigningEnabled {
						t.Fatal("configured discovery", found, err)
					}
					mining = found.Candidates[0].Intent
				}
				out, e := svc.proposeAdmissionWENMiningClaimV1(ctx, cfg, id, mining, op, callPins, raw, 100, 132, 5000, 2, factory)
				if (e == nil) != (mode == "ok" || mode == "scoped") {
					t.Fatal(mode, e)
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
				if (mode == "ok" || mode == "scoped") && (out.SigningEnabled || out.Status != "requires-review" || out.Intent.ExpectedGross != v.ExpectedGross) {
					t.Fatal("host proposal")
				}
			})
		}
	}
}
