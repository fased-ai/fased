package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENStakingPoststateRPCV1(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "code", "clock", "history", "after-expiry", "before-receipt", "unsigned"} {
		t.Run(mode, func(t *testing.T) {
			v, w, before := stakingHistoryFixture(t, false)
			v.Amount = "100"
			_, _, s := stakingHistoryFixture(t, true)
			put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
			s.History = before.History
			s.Point = before.Point
			// Preserve the authenticated pre-state independently from the returned page.
			h := *s.History
			h.Data = append([]byte(nil), h.Data...)
			s.History = &h
			pt := *s.Point
			pt.Data = append([]byte(nil), pt.Data...)
			s.Point = &pt
			put(s.History, 88, 11)
			put(s.Point, 88, 11)
			put(s.Position, 80, 197)
			put(s.NextHistory, 96, 197)
			put(s.Pool, 96, 197)
			put(s.Pool, 104, 197)
			put(s.NextPoint, 96, 197)
			if mode == "after-expiry" {
				v.ExpiresSlot = "140"
			}
			r := wenBudgetReservationV1{State: "finalized-success", OutcomeSlot: 150, WalletID: "staker", WalletPublicKey: w.String(), Genesis: v.Genesis, StakingIntent: &v, StakingEffectsSHA256: wenHashV1([]byte("fixture receipt")), Scopes: map[string]uint64{wenMiningNativeScopeV1("staker", v.Genesis): 7000, wenStakingLaunchScopeV1("staker", v): 7000}, WalletClaims: map[string]uint64{"solana:native": 7000, "solana:spl:" + v.Mint: 100}}
			if mode == "after-expiry" {
				r.OutcomeSlot = 130
			}
			if mode == "before-receipt" {
				r.OutcomeSlot = 151
			}
			if mode == "unsigned" {
				r.State = "signed"
			}
			p := solana.MustPublicKeyFromBase58(v.ProgramID)
			loader := solana.BPFLoaderUpgradeableProgramID
			pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, loader)
			code := []byte{1, 2, 3}
			pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: wenHashV1(code), DeploymentSlot: 50}
			program := make([]byte, 36)
			binary.LittleEndian.PutUint32(program, 2)
			copy(program[4:], pd[:])
			body := make([]byte, 48)
			binary.LittleEndian.PutUint32(body, 3)
			binary.LittleEndian.PutUint64(body[4:], 50)
			copy(body[45:], code)
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 150)
			binary.LittleEndian.PutUint64(clock[32:], s.Now)
			if mode == "code" {
				body[45] ^= 1
			}
			if mode == "clock" {
				clock[0] ^= 1
			}
			if mode == "history" {
				s.History.Data[96] ^= 1
			}
			ix, e := buildWENStakingInstructionV1(v, w)
			if e != nil {
				t.Fatal(e)
			}
			m := ix.Accounts()
			keys := []solana.PublicKey{m[3].PublicKey, m[4].PublicKey, m[5].PublicKey, m[6].PublicKey, m[12].PublicKey, m[13].PublicKey, m[14].PublicKey, p, pd, solana.SysVarClockPubkey}
			account := func(d []byte, o solana.PublicKey, ex bool) *rpc.Account {
				return &rpc.Account{Owner: o, Executable: ex, Data: rpc.DataBytesOrJSONFromBytes(d)}
			}
			vals := []*rpc.Account{}
			for _, a := range []*signerWENBTCAccountV1{s.Pool, s.Position, s.History, s.NextHistory, s.Index, s.Point, s.NextPoint} {
				if a == nil {
					vals = append(vals, nil)
				} else {
					vals = append(vals, account(a.Data, a.Owner, false))
				}
			}
			vals = append(vals, account(program, loader, true), account(body, loader, false), account(clock, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), false))
			page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: vals}
			client := &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(v.Genesis), page: page, addresses: keys, change: mode}
			result, e := readWENStakingPoststateRPCV1(context.Background(), &stakingPostRPCFake{client, r.OutcomeSlot}, pins, r, before, 2)
			if (e == nil) != (mode == "ok" || mode == "after-expiry" || mode == "history") {
				t.Fatal("unexpected historical readback", e)
			}
			if e == nil && result.Snapshot.Slot != 150 {
				t.Fatal("slot")
			}
			if e == nil {
				checkStakingObservationJournal(t, r, before, pins, client, result.MatchesExpectedTransition)
			}
			if e == nil && result.MatchesExpectedTransition != (mode != "history") {
				t.Fatal("incorrect transition classification")
			}
		})
	}
}

type stakingPostRPCFake struct {
	*wenReadRPCFake
	min uint64
}

func (f *stakingPostRPCFake) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.MinContextSlot == nil || *o.MinContextSlot != f.min {
		f.t.Fatal("receipt slot not bound")
	}
	copy := *o
	min := uint64(100)
	copy.MinContextSlot = &min
	return f.wenReadRPCFake.GetMultipleAccountsWithOpts(ctx, keys, &copy)
}

func checkStakingObservationJournal(t *testing.T, r wenBudgetReservationV1, before wenStakingHistorySnapshotV1, pins wenStakingPinsV1, client *wenReadRPCFake, match bool) {
	t.Helper()
	s, base := wenStateFixture(t)
	defer func() { s.Close() }()
	r.Version = 1
	r.PolicyHash = base.PolicyHash
	r.Digest = base.Digest
	r.UsageDay = base.UsageDay
	r.MinFinalizedSlot = "100"
	w := solana.MustPublicKeyFromBase58(r.WalletPublicKey)
	ix, e := buildWENStakingInstructionV1(*r.StakingIntent, w)
	if e != nil {
		t.Fatal(e)
	}
	block := solana.MustHashFromBase58(r.Genesis)
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(w))
	if e != nil {
		t.Fatal(e)
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, e := tx.Message.MarshalBinary()
	if e != nil {
		t.Fatal(e)
	}
	r.StakingPrepared = &wenStakingMessageBindingV1{Message: message, Blockhash: block, ReviewSHA: wenHashV1([]byte("fixture review")), Slot: 100, Fee: 5000, Rent: 2000, LastValidHeight: 200, Evidence: &wenStakingPreparedEvidenceV1{Pins: pins, Before: before}}
	save := func(r wenBudgetReservationV1) {
		raw, _ := json.Marshal(r)
		if e := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw) }); e != nil {
			t.Fatal(e)
		}
	}
	save(r)
	read := func() (wenStakingPoststateObservationV1, error) {
		client.calls = 0
		return s.observeWENStakingPoststateV1(context.Background(), &stakingPostRPCFake{client, r.OutcomeSlot}, "state-request", r.Digest, 2)
	}
	observed, e := read()
	if e != nil || observed.MatchesExpectedTransition != match {
		t.Fatal("journal observation", e)
	}
	saved := readWENState(t, s)
	if saved.StakingObservation == nil || !wenReservationHashV1(saved.StakingObservation.BindingSHA256) {
		t.Fatal("observation missing")
	}
	raw := wenRestartRecord(t, s, "state-request")
	path := s.db.Path()
	if e = s.Close(); e != nil {
		t.Fatal(e)
	}
	verifyWENFreshProcess(t, path, "state-request", raw)
	s, e = openSignerStoreV2(path)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = read(); e != nil {
		t.Fatal("observation replay", e)
	}
	// A different receipt cannot reuse the first observation binding.
	saved = readWENState(t, s)
	saved.OutcomeFee++
	save(saved)
	if _, e = read(); e == nil {
		t.Fatal("changed receipt reused observation")
	}
	// Legacy reservations without pre-state cannot silently fabricate it.
	saved.StakingPrepared.Evidence = nil
	save(saved)
	if _, e = read(); e == nil {
		t.Fatal("missing pre-state accepted")
	}
}
