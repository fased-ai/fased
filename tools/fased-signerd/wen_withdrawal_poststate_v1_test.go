package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func checkWithdrawalPoststate(t *testing.T, s *signerStoreV2, base *wenReadRPCFake, request, digest string) {
	t.Helper()
	record := readWENState(t, s)
	v := *record.WithdrawalIntent
	before := record.WithdrawalPrepared.Evidence.Before
	raw, _ := json.Marshal(before)
	var after wenWithdrawalReadbackV1
	if e := json.Unmarshal(raw, &after); e != nil {
		t.Fatal(e)
	}
	// Fixture follows Rust withdraw: clear amount/exit, retain last; advance pool.
	put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
	put(after.Pool, 80, 11)
	put(after.Pool, 88, 0)
	put(after.Pool, 104, 0)
	put(after.Position, 80, 0)
	put(after.Position, 88, 0)
	put(after.Custody, 64, binary.LittleEndian.Uint64(before.Custody.Data[64:])-100)
	put(after.Destination, 64, binary.LittleEndian.Uint64(before.Destination.Data[64:])+97)
	ext, e := wenSatExtensionsV1(after.Destination.Data, 2, map[uint16]int{2: 8, 7: 0})
	if e != nil {
		t.Fatal(e)
	}
	binary.LittleEndian.PutUint64(ext[2], binary.LittleEndian.Uint64(ext[2])+3)
	w := solana.MustPublicKeyFromBase58(record.WalletPublicKey)
	if e = validateWENWithdrawalPoststateV1(v, w, before, after, record.OutcomeSlot); e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "before-receipt", "after-expiry", "position", "cursor", "pool", "custody", "destination", "withheld", "mint", "unsigned"} {
		t.Run("poststate/"+mode, func(t *testing.T) {
			raw, _ := json.Marshal(after)
			var candidate wenWithdrawalReadbackV1
			json.Unmarshal(raw, &candidate)
			switch mode {
			case "position":
				candidate.Position.Data[80] ^= 1
			case "cursor":
				candidate.Position.Data[96] ^= 1
			case "pool":
				candidate.Pool.Data[104] ^= 1
			case "custody":
				candidate.Custody.Data[64] ^= 1
			case "destination":
				candidate.Destination.Data[64] ^= 1
			case "withheld":
				x, _ := wenSatExtensionsV1(candidate.Destination.Data, 2, map[uint16]int{2: 8, 7: 0})
				x[2][0] ^= 1
			case "mint":
				candidate.Mint.Data[36] ^= 1
			}
			c := *base
			c.calls = 0
			c.change = mode
			page := *base.page
			page.Value = append([]*rpc.Account(nil), base.page.Value...)
			c.page = &page
			for i, a := range []*signerWENBTCAccountV1{candidate.Pool, candidate.Position, candidate.Custody, candidate.Mint, candidate.Destination, candidate.Sale, candidate.Activation} {
				copy := *page.Value[i]
				copy.Data = rpc.DataBytesOrJSONFromBytes(a.Data)
				page.Value[i] = &copy
			}
			r := record
			intent := v
			r.WithdrawalIntent = &intent
			if mode == "before-receipt" {
				r.OutcomeSlot = 151
			}
			if mode == "unsigned" {
				r.State = "signed"
			}
			if mode == "after-expiry" {
				intent.ExpiresSlot = "151"
			}
			client := &stakingPostRPCFake{wenReadRPCFake: &c, min: r.OutcomeSlot}
			out, err := readWENWithdrawalPoststateRPCV1(context.Background(), client, record.WithdrawalPrepared.Evidence.Pins, r, before, 2)
			reject := mode == "genesis" || mode == "genesis-change" || mode == "stale" || mode == "before-receipt" || mode == "unsigned"
			if (err != nil) != reject {
				t.Fatal("readback", err)
			}
			if reject {
				return
			}
			match := mode == "ok" || mode == "after-expiry"
			if out.MatchesExpectedTransition != match {
				t.Fatal("wrong consistency result")
			}
			if mode == "ok" {
				first, err := s.observeWENWithdrawalPoststateV1(context.Background(), client, request, digest, 2)
				if err != nil || !first.MatchesExpectedTransition {
					t.Fatal("journal", err)
				}
				if _, err = s.observeWENWithdrawalPoststateV1(context.Background(), client, request, digest, 2); err != nil {
					t.Fatal("replay", err)
				}
				changed := append([]byte(nil), page.Value[4].Data.GetBinary()...)
				changed[64] ^= 1
				copy := *page.Value[4]
				copy.Data = rpc.DataBytesOrJSONFromBytes(changed)
				page.Value[4] = &copy
				if _, err = s.observeWENWithdrawalPoststateV1(context.Background(), client, request, digest, 2); err == nil {
					t.Fatal("changed observation overwrote journal")
				}
			}
		})
	}
}
