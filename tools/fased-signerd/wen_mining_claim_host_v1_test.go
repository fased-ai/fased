package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"testing"
)

func TestWENMiningClaimHost(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "pins-change", "network-change", "journal-change", "index-change", "wrong-wallet", "nil-client", "cancelled"} {
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
				saved := wenBudgetReservationV1{WalletID: "miner", WalletPublicKey: owner.String(), Genesis: v.Genesis, State: "submission-uncertain", MiningIntent: &mining, MiningEntry: &entry, MiningPins: &wenMiningPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: pins.CodeSHA256, DeploymentSlot: pins.DeploymentSlot}}
				index := []byte("mining-action:" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+mining.Entry+":commit")))
				encoded, _ := json.Marshal(saved)
				if e := store.db.Update(func(tx *bolt.Tx) error {
					b, e := tx.CreateBucketIfNotExists(wenBudgetBucketV1)
					if e != nil {
						return e
					}
					if e = b.Put(index, []byte("accepted-request")); e != nil {
						return e
					}
					return b.Put([]byte("request:accepted-request"), encoded)
				}); e != nil {
					t.Fatal(e)
				}
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
					case "journal-change", "index-change":
						if e := store.db.Update(func(tx *bolt.Tx) error {
							b := tx.Bucket(wenBudgetBucketV1)
							if mode == "index-change" {
								return b.Put(index, []byte("wrong-request"))
							}
							return b.Put([]byte("request:accepted-request"), []byte("{}"))
						}); e != nil {
							t.Fatal(e)
						}
					}
					return &miningClaimLocatorFake{f, "ok"}
				}
				out, e := svc.proposeJournalWENMiningClaimV1(ctx, cfg, id, "accepted-request", op, callPins, raw, 100, 132, 5000, 2, factory)
				if (e == nil) != (mode == "ok") {
					t.Fatal(mode, e)
				}
				if mode == "pins-change" && calls != 0 {
					t.Fatal("changed deployment reached RPC")
				}
				if client.sends != 0 {
					t.Fatal("host sent")
				}
				if mode == "ok" && (out.SigningEnabled || out.Status != "requires-review" || out.Intent.ExpectedGross != v.ExpectedGross) {
					t.Fatal("host proposal")
				}
			})
		}
	}
}
