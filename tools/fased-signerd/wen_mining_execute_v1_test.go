package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type miningExecutionFake struct {
	simulations, hashes int
	*miningPrepareFake
	store            *signerStoreV2
	request, failure string
	sends            int
	result           *rpc.GetTransactionResult
	signature        solana.Signature
}

func (f *miningExecutionFake) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(keys) != 3 {
		return f.miningPrepareFake.GetMultipleAccountsWithOpts(ctx, keys, o)
	}
	if o.MinContextSlot == nil || *o.MinContextSlot != 150 || o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unbound entry observation")
	}
	for i, k := range keys {
		if k != f.addresses[i] {
			f.t.Fatal("entry address")
		}
	}
	out := *f.page
	out.Value = append([]*rpc.Account(nil), f.page.Value[:3]...)
	account := *out.Value[0]
	d := append([]byte(nil), account.Data.GetBinary()...)
	tx, e := solana.TransactionFromBytes(f.result.Transaction.GetBinary())
	if e != nil {
		f.t.Fatal(e)
	}
	data := tx.Message.Instructions[0].Data
	if data[0] == 54 {
		d[9] = 1
		copy(d[200:232], data[1:])
	} else {
		d[10] = 1
		copy(d[232:], data[1:])
	}
	if f.failure == "later-reveal" && data[0] == 54 {
		d[10] = 1
		copy(d[232:], f.fixture.Vectors["revealed"][232:])
	}
	if f.failure == "bad-owner" {
		account.Owner = solana.SystemProgramID
	}
	if f.failure == "bad-code" {
		changed := *out.Value[2]
		code := append([]byte(nil), changed.Data.GetBinary()...)
		code[45] ^= 1
		changed.Data = rpc.DataBytesOrJSONFromBytes(code)
		out.Value[2] = &changed
	}
	if f.failure == "bad-entry" {
		d[200] ^= 1
	}
	account.Data = rpc.DataBytesOrJSONFromBytes(d)
	out.Value[0] = &account
	return &out, nil
}
func (f *miningExecutionFake) GetLatestBlockhash(ctx context.Context, c rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	f.hashes++
	result, e := f.miningPrepareFake.GetLatestBlockhash(ctx, c)
	if e == nil && result != nil && result.Value != nil && f.hashes > 1 {
		result.Value.Blockhash = solana.Hash{44}
		result.Value.LastValidBlockHeight = 300
	}
	return result, e
}
func (f *miningExecutionFake) SimulateRawTransactionWithOpts(ctx context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	f.simulations++
	if f.failure == "review-admission" && f.simulations == 1 || f.failure == "review-pre-sign" && f.simulations == 2 || f.failure == "review-post-sign" && f.simulations == 3 {
		if e := os.Remove(filepath.Join(f.root, "admission.json")); e != nil {
			f.t.Fatal(e)
		}
	}

	if f.failure == "pre-sign-phase" && f.simulations == 2 || f.failure == "post-sign-phase" && f.simulations == 3 {
		f.mode = "phase-change"
	}
	if f.failure == "revoke" && f.simulations == 2 || f.failure == "post-sign-revoke" && f.simulations == 3 {
		p, e := f.store.getPolicy("miner")
		if e != nil {
			f.t.Fatal(e)
		}
		p.Operations = []string{intentWENMiningV1 + ".reveal"}
		if _, e = f.store.putPolicy(p, p.Version); e != nil {
			f.t.Fatal(e)
		}
	}
	return f.miningPrepareFake.SimulateRawTransactionWithOpts(ctx, b, o)
}
func (f *miningExecutionFake) SendRawTransactionWithOpts(_ context.Context, wire []byte, o rpc.TransactionOpts) (solana.Signature, error) {
	f.sends++
	var saved wenBudgetReservationV1
	if e := f.store.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:"+f.request)), &saved)
	}); e != nil {
		f.t.Fatal(e)
	}
	if saved.State != "submission-uncertain" || saved.Signature == "" || o.SkipPreflight || o.MaxRetries == nil || *o.MaxRetries != 0 || o.MinContextSlot == nil || *o.MinContextSlot != 150 {
		f.t.Fatal("unjournaled send")
	}
	expected, e := wenSignedWireV1(saved, saved.SignedMessage)
	if e != nil || string(expected) != string(wire) {
		f.t.Fatal("changed signed wire", e)
	}
	f.signature = solana.MustSignatureFromBase58(saved.Signature)
	encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	env := &rpc.TransactionResultEnvelope{}
	if e = json.Unmarshal(encoded, env); e != nil {
		f.t.Fatal(e)
	}
	meta := &rpc.TransactionMeta{Fee: 4000, PreBalances: []uint64{10000, 1000, 1}, PostBalances: []uint64{6000, 1000, 1}}
	if f.failure == "failed" {
		meta.Err = "instruction failed"
	}
	if f.failure == "bad-balances" {
		meta.PostBalances[1]++
	}
	f.result = &rpc.GetTransactionResult{Slot: 150, Transaction: env, Meta: meta}
	if f.failure == "send-error" || (f.failure == "missing" || f.failure == "missing-restart") {
		return solana.Signature{}, errors.New("connection lost")
	}
	return f.signature, nil
}
func (f *miningExecutionFake) GetTransaction(_ context.Context, sig solana.Signature, o *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig != f.signature || o.Commitment != rpc.CommitmentFinalized {
		f.t.Fatal("wrong recovery identity")
	}
	if f.failure == "receipt-error" {
		return nil, errors.New("receipt unavailable")
	}
	if f.failure == "missing" || f.failure == "missing-restart" {
		return nil, rpc.ErrNotFound
	}
	if f.failure == "receipt-error" {
		return nil, errors.New("receipt unavailable")
	}
	return f.result, nil
}

func miningWalletFixture(t *testing.T, wallet solana.PublicKey) wenMiningFixture {
	f := miningFixture(t)
	f.Wallet = wallet.String()
	f.Preimage.Scope.Owner = f.Wallet
	d := append([]byte(nil), f.Vectors["admitted"]...)
	copy(d[112:144], wallet[:])
	program := solana.MustPublicKeyFromBase58(f.Intent.ProgramID)
	entry, bump, e := solana.FindProgramAddress([][]byte{[]byte("wen-mining-entry-v1"), d[80:112], wallet[:], d[176:184]}, program)
	if e != nil {
		t.Fatal(e)
	}
	d[11] = bump
	f.Intent.Entry = entry.String()
	material := f.Vectors["revealed"][232:]
	proof := append([]byte("wen-mining-commitment-v1"), d[16:192]...)
	proof = append(proof, material...)
	digest := wenHashV1(proof)
	f.Intent.CommitmentSHA256 = digest
	f.Preimage.Digest = digest
	f.PreimageKey = wenMiningPreimageKeyV1(f.Intent, wallet)
	f.Vectors["admitted"] = d
	committed := append([]byte(nil), d...)
	committed[9] = 1
	hash, _ := hex.DecodeString(digest)
	copy(committed[200:232], hash)
	f.Vectors["committed"] = committed
	f.Intent.EntrySHA256 = wenHashV1(d)
	for i, op := range []string{"commit", "reveal"} {
		v := f.Intent
		v.Operation = op
		data := d
		now := uint64(1000)
		var reveal []byte
		if i == 1 {
			data = committed
			now = 1180
			reveal = material
		}
		v.EntrySHA256 = wenHashV1(data)
		ix, e := prepareWENMiningInstructionV1(v, wallet, wenMiningEntrySnapshotV1{entry, program, false, data, 150, now}, reveal)
		if e != nil {
			t.Fatal(e)
		}
		tx, e := solana.NewTransaction([]solana.Instruction{ix}, solana.MustHashFromBase58(f.Blockhash), solana.TransactionPayer(wallet))
		if e != nil {
			t.Fatal(e)
		}
		tx.Message.SetVersion(solana.MessageVersionV0)
		f.Messages[i], e = tx.Message.MarshalBinary()
		if e != nil {
			t.Fatal(e)
		}
	}
	return f
}

func TestWENMiningExecutionV1(t *testing.T) {
	for _, op := range []string{"commit", "reveal"} {
		for _, mode := range []string{"scoped-failed", "scoped-success", "scoped-restart", "scoped-missing-restart", "success", "failed", "send-error", "missing", "bad-balances", "phase-change", "pre-sign-phase", "post-sign-phase", "revoke", "restart", "bad-entry", "bad-owner", "bad-code", "later-reveal", "missing-restart", "post-sign-revoke", "receipt-error", "review-admission", "review-pre-sign", "review-post-sign"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				scoped := strings.HasPrefix(mode, "scoped-")
				mode = strings.TrimPrefix(mode, "scoped-")
				s, k := openTestSignerV2(t)
				base := miningFixture(t)
				record, old := createTestSignerWalletV2(t, s, k, "miner", base.Intent.Economy, 100, 100)
				wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
				f := miningWalletFixture(t, wallet)
				p, e := s.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningV1 + ".commit", intentWENMiningV1 + ".reveal"}, Programs: []string{f.Intent.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{f.Intent.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
				if e != nil {
					t.Fatal(e)
				}
				if e = s.configureWENBudgetV1(wenMiningNativeScopeV1("miner", f.Intent.Genesis), 10000); e != nil {
					t.Fatal(e)
				}
				prep, pins, v := miningPrepareSetup(t, f, op, "ok")
				if mode == "phase-change" {
					prep.mode = mode
				}
				client := &miningExecutionFake{miningPrepareFake: prep, store: s, request: "mining-execution", failure: mode}
				service := &signerServiceV2{store: s, keys: k}
				review := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: wallet.String(), Intent: v, Pins: pins, MaxSlotLag: 2}
				root := writeMiningReviewFixture(t, s.db.Path(), review)
				if scoped {
					review.Version = 2
					raw, _ := json.Marshal(review)
					if e = os.WriteFile(filepath.Join(root, wenMiningAdmissionNameV2(v)), raw, 0600); e != nil {
						t.Fatal(e)
					}
					if e = s.configureWENBudgetV1(wenMiningLaunchScopeV1("miner", v), 5000); e != nil {
						t.Fatal(e)
					}
				}

				preimage, e := os.ReadFile(filepath.Join(prep.root, f.PreimageKey+".json"))
				if e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(filepath.Join(root, f.PreimageKey+".json"), preimage, 0600); e != nil {
					t.Fatal(e)
				}
				prep.root = root
				if mode == "success" {
					config, _, e := loadWENMiningReviewV1(s.db.Path(), "miner", v)
					if e != nil {
						t.Fatal(e)
					}
					for _, kind := range []string{"unreviewed", "pin", "lag"} {
						changed := config
						switch kind {
						case "unreviewed":
							changed.reviewSHA = ""
						case "pin":
							changed.Pins.CodeSHA256 = wenHashV1([]byte("different"))
						case "lag":
							changed.MaxSlotLag++
						}
						if _, _, e = service.executeWENMiningWithRPCV1(context.Background(), client, changed, "rejected-"+kind, "miner", p.Hash, v, wallet); e == nil {
							t.Fatal("configuration bypass", kind)
						}
						if client.simulations != 0 || client.sends != 0 {
							t.Fatal("unreviewed network work")
						}
					}
				}

				digest, outcome, e := service.executeReviewedWENMiningV1(context.Background(), client, client.request, "miner", p.Hash, v)
				good := mode == "success" || mode == "failed" || mode == "send-error" || mode == "restart" || mode == "later-reveal"
				if (e == nil) != good {
					t.Fatal("unexpected execution", outcome, e)
				}
				var saved wenBudgetReservationV1
				read := func() {
					t.Helper()
					if e := s.db.View(func(tx *bolt.Tx) error {
						return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:"+client.request)), &saved)
					}); e != nil {
						t.Fatal(e)
					}
				}
				read()
				if mode == "phase-change" || mode == "pre-sign-phase" || mode == "revoke" || mode == "review-admission" || mode == "review-pre-sign" {
					if client.sends != 0 || saved.Signature != "" {
						t.Fatal("signed expired phase")
					}
					return
				}
				if mode == "post-sign-phase" || mode == "post-sign-revoke" || mode == "review-post-sign" {
					if client.sends != 0 || saved.State != "signed" || saved.Signature == "" {
						t.Fatal("post-sign fence")
					}
					return
				}
				if client.sends != 1 || saved.Signature == "" || saved.MiningEntry == nil {
					t.Fatal("missing durable execution")
				}
				if (saved.SuccessBudgetSettled || saved.FailedBudgetSettled) != (good || mode == "bad-entry" || mode == "bad-owner" || mode == "bad-code") {
					t.Fatal("incorrect fee settlement")
				}
				reserved, e := s.wenBudgetReservedV1(wenMiningNativeScopeV1("miner", v.Genesis))
				if e != nil {
					t.Fatal(e)
				}
				want := uint64(5000)
				if good || mode == "bad-entry" || mode == "bad-owner" || mode == "bad-code" {
					want = 4000
				}
				if scoped {
					launch, e := s.wenBudgetReservedV1(wenMiningLaunchScopeV1("miner", v))
					if e != nil || launch != want {
						t.Fatalf("launch settlement %d want %d: %v", launch, want, e)
					}
				}
				if reserved != want {
					t.Fatal("fee accounting", reserved, want)
				}
				if _, _, e = service.executeReviewedWENMiningV1(context.Background(), client, client.request, "miner", p.Hash, v); e == nil || client.sends != 1 {
					t.Fatal("replay resent")
				}
				if mode == "receipt-error" {
					if outcome != "submission-uncertain" {
						t.Fatal("lost uncertainty", outcome)
					}
					client.failure = "success"
				}
				if mode == "missing" || mode == "missing-restart" {
					client.failure = "success"
				}
				if mode == "restart" || mode == "missing-restart" {
					persisted := wenRestartRecord(t, s, client.request)
					path := s.db.Path()
					now := s.now
					if e = s.Close(); e != nil {
						t.Fatal(e)
					}
					verifyWENFreshProcess(t, path, client.request, persisted)
					s, e = openSignerStoreV2(path)
					if e != nil {
						t.Fatal(e)
					}
					defer s.Close()
					s.now = now
					client.store = s
				}
				if mode != "bad-balances" && mode != "bad-entry" && mode != "bad-owner" && mode != "bad-code" {
					if _, e = s.recoverWENMiningExecutionV1(context.Background(), client, client.request, digest); e != nil {
						t.Fatal("recovery", e)
					}
				}
				if scoped {
					launch, e := s.wenBudgetReservedV1(wenMiningLaunchScopeV1("miner", v))
					if e != nil || launch != 4000 {
						t.Fatalf("recovered launch settlement %d: %v", launch, e)
					}
				}
				if client.sends != 1 {
					t.Fatal("recovery sent")
				}
				if mode == "success" {
					read()
					original, _ := json.Marshal(saved)
					for _, damage := range []string{"entry-size", "owner", "intent", "pins", "signature"} {
						var altered wenBudgetReservationV1
						if e = json.Unmarshal(original, &altered); e != nil {
							t.Fatal(e)
						}
						switch damage {
						case "entry-size":
							altered.MiningEntry.Data = nil
						case "owner":
							altered.WalletPublicKey = "bad"
						case "intent":
							altered.MiningIntent.Entry = "bad"
						case "pins":
							altered.MiningPins.ProgramID = "bad"
						case "signature":
							altered.Signature = "bad"
						}
						raw, _ := json.Marshal(altered)
						if e = s.db.Update(func(tx *bolt.Tx) error {
							return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:"+client.request), raw)
						}); e != nil {
							t.Fatal(e)
						}
						if e = s.observeWENMiningEntryV1(context.Background(), client, client.request, digest); e == nil {
							t.Fatal("damaged observation accepted", damage)
						}
					}
					if e = s.db.Update(func(tx *bolt.Tx) error {
						return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:"+client.request), original)
					}); e != nil {
						t.Fatal(e)
					}
				}
				// Metadata inspection cannot confuse an entry snapshot with a receipt of a token award.
				if binary.LittleEndian.Uint64(saved.MiningEntry.Data[184:192]) != 1000000 {
					t.Fatal("capital binding")
				}
			})
		}
	}
}
