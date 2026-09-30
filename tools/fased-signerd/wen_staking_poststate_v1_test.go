package main

import (
	"encoding/binary"
	"testing"
)

func TestWENStakingPoststateV1(t *testing.T) {
	for _, same := range []bool{false, true} {
		for _, op := range []string{"deposit", "requestExit"} {
			v, w, before := stakingHistoryFixture(t, same)
			v.Operation = op
			v.Amount = "100"
			if op == "requestExit" {
				v.Amount = "0"
			}
			_, _, after := stakingHistoryFixture(t, true)
			put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
			if !same {
				_, _, old := stakingHistoryFixture(t, false)
				after.History = old.History
				after.Point = old.Point
				put(after.History, 88, 11)
				put(after.Point, 88, 11)
			}
			if op == "deposit" {
				put(after.Position, 80, 197)
				put(after.NextHistory, 96, 197)
				put(after.Pool, 96, 197)
				put(after.Pool, 104, 197)
				put(after.NextPoint, 96, 197)
			} else {
				put(after.Position, 88, 11)
				put(after.NextHistory, 96, 0)
				put(after.Pool, 96, 0)
				put(after.NextPoint, 96, 0)
			}
			after.Slot = 150
			accounts := []*signerWENBTCAccountV1{after.Pool, after.Position, after.History, after.NextHistory, after.Index, after.Point, after.NextPoint}
			for _, a := range accounts {
				a.Slot = 150
			}
			if e := validateWENStakingPoststateV1(v, w, before, after, 150); e != nil {
				t.Fatal(same, op, e)
			}
			for _, a := range accounts {
				for _, offset := range []int{11, 80, 88, 96} {
					if offset >= len(a.Data) {
						continue
					}
					a.Data[offset] ^= 1
					if e := validateWENStakingPoststateV1(v, w, before, after, 150); e == nil {
						t.Fatal("changed historical field accepted", same, op, offset)
					}
					a.Data[offset] ^= 1
				}
			}
			after.Position.Slot = 149
			if e := validateWENStakingPoststateV1(v, w, before, after, 150); e == nil {
				t.Fatal("mixed slots")
			}
			after.Position.Slot = 150
			if e := validateWENStakingPoststateV1(v, w, before, after, 151); e == nil {
				t.Fatal("pre-receipt snapshot")
			}
		}
	}
}
