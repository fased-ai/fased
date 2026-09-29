package main

import (
	"encoding/binary"
	"testing"
)

func TestWENSaleScheduleVersions(t *testing.T) {
	const open = uint64(2_000_000_000)
	const day = uint64(86400)
	build := func(version byte, total, threshold uint64) []byte {
		length := map[byte]int{1: 192, 2: 200, 3: 208}[version]
		d := make([]byte, length)
		copy(d, "WENGEN01")
		d[8] = version
		put := func(at int, value uint64) { binary.LittleEndian.PutUint64(d[at:], value) }
		closeAt := open + 7*day
		if version == 3 {
			closeAt = open + 21*day
			if threshold != 0 && threshold+3*day < closeAt {
				closeAt = threshold + 3*day
			}
			put(192, threshold)
		} else if version == 2 {
			put(192, 1)
		}
		put(144, open)
		put(152, closeAt)
		put(160, open+23*day)
		put(168, total)
		return d
	}
	for _, version := range []byte{1, 2} {
		if !validWENSaleScheduleV1(build(version, 50_000_000_000, 0)) {
			t.Fatalf("existing version %d rejected", version)
		}
	}
	for _, tc := range []struct {
		name      string
		threshold uint64
		total     uint64
	}{
		{"unfunded hard close", 0, 49_999_999_999},
		{"early threshold", open + day, 50_000_000_000},
		{"late threshold", open + 21*day - 60, 200_000_000_001},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if !validWENSaleScheduleV1(build(3, tc.total, tc.threshold)) {
				t.Fatal("valid rolling sale rejected")
			}
		})
	}
	for _, tc := range []struct {
		name string
		edit func([]byte)
	}{
		{"missing threshold", func(d []byte) { binary.LittleEndian.PutUint64(d[192:], 0) }},
		{"altered close", func(d []byte) { d[152]++ }},
		{"unfunded threshold", func(d []byte) { binary.LittleEndian.PutUint64(d[168:], 1) }},
		{"threshold after hard close", func(d []byte) { binary.LittleEndian.PutUint64(d[192:], open+21*day) }},
		{"oversized cutover", func(d []byte) { binary.LittleEndian.PutUint64(d[200:], ^uint64(0)) }},
		{"truncated layout", func(d []byte) { d[8] = 1 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := build(3, 50_000_000_000, open+day)
			tc.edit(d)
			if validWENSaleScheduleV1(d) {
				t.Fatal("invalid rolling sale accepted")
			}
		})
	}
}
