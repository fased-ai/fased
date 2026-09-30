package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type stakingExecutionObservationFake struct {
	*stakingExecuteFake
	post  []*rpc.Account
	reads int
}

func (f *stakingExecutionObservationFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	f.reads++
	if len(keys) != 10 || o.MinContextSlot == nil || *o.MinContextSlot != 150 || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 {
		f.t.Fatal("unbound post-state request")
	}
	for i, k := range keys {
		if k != f.addresses[i] {
			f.t.Fatal("post-state key")
		}
	}
	return &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: f.post}, nil
}

func checkStakingExecutionObservation(t *testing.T, s *signerStoreV2, c *stakingExecuteFake, digest, state string) {
	t.Helper()
	must := func(e error) {
		t.Helper()
		if e != nil {
			t.Fatal(e)
		}
	}
	r := readWENState(t, s)
	v := *r.StakingIntent
	w := solana.MustPublicKeyFromBase58(r.WalletPublicKey)
	// Construct an independent post-change history using the fixture writer.
	_, _, post := stakingHistoryFixture(t, true, solana.MustPublicKeyFromBase58(v.Sale), w)
	_, _, old := stakingHistoryFixture(t, false, solana.MustPublicKeyFromBase58(v.Sale), w)
	put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
	post.History = old.History
	post.Point = old.Point
	put(post.History, 88, 11)
	put(post.Point, 88, 11)
	put(post.Position, 80, 197)
	put(post.NextHistory, 96, 197)
	put(post.Pool, 96, 197)
	put(post.Pool, 104, 197)
	put(post.NextPoint, 96, 197)
	if v.Operation == "requestExit" {
		put(post.Position, 80, 100)
		put(post.Position, 88, 11)
		put(post.NextHistory, 96, 0)
		put(post.Pool, 96, 0)
		put(post.Pool, 104, 100)
		put(post.NextPoint, 96, 0)
	}

	values := []*rpc.Account{}
	for _, a := range []*signerWENBTCAccountV1{post.Pool, post.Position, post.History, post.NextHistory, post.Index, post.Point, post.NextPoint} {
		values = append(values, &rpc.Account{Owner: a.Owner, Data: rpc.DataBytesOrJSONFromBytes(a.Data)})
	}
	values = append(values, c.page.Value[7:10]...)
	observed := &stakingExecutionObservationFake{stakingExecuteFake: c, post: values}
	outcome, observation, e := s.recoverAndObserveWENStakingV1(context.Background(), observed, "state-request", digest, 2)
	must(e)
	if outcome != state {
		t.Fatal("outcome changed")
	}
	if state != "finalized-success" {
		if observation != nil || observed.reads != 0 {
			t.Fatal("non-success observed")
		}
		return
	}
	if observation == nil || !observation.MatchesExpectedTransition {
		t.Fatal("staking history not joined")
	}
	// Fresh process reads the exact durable linkage before the reopened store replays.
	raw := wenRestartRecord(t, s, "state-request")
	path := s.db.Path()
	must(s.Close())
	verifyWENFreshProcess(t, path, "state-request", raw)
	reopened, e := openSignerStoreV2(path)
	must(e)
	defer reopened.Close()
	outcome, observation, e = reopened.recoverAndObserveWENStakingV1(context.Background(), observed, "state-request", digest, 2)
	must(e)
	if outcome != state || observation == nil || !observation.MatchesExpectedTransition || c.sends != 1 {
		t.Fatal("restart recovery changed/resubmitted")
	}
	// A later differing snapshot cannot overwrite the first recorded observation.
	post.Position.Data[80] ^= 1
	_, observation, e = reopened.recoverAndObserveWENStakingV1(context.Background(), observed, "state-request", digest, 2)
	if e == nil || observation != nil {
		t.Fatal("different observation overwritten")
	}
	saved := readWENState(t, reopened)
	if saved.StakingObservation == nil || !saved.StakingObservation.Observation.MatchesExpectedTransition || !saved.SuccessBudgetSettled {
		t.Fatal("original evidence lost")
	}
	for scope := range r.Scopes {
		n, e := reopened.wenBudgetReservedV1(scope)
		must(e)
		if n != 6000 {
			t.Fatal("observation changed settled costs")
		}
	}
}
