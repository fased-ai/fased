package main

import (
	"bytes"
	"encoding/binary"
	"math"
)

// Accepts the two existing fixed-window layouts and the prospective rolling
// layout. This validates the sale's own schedule; callers still bind its PDA,
// owner, mint, phase and activation record to their action.
func validWENSaleScheduleV1(d []byte) bool {
	version := byte(0)
	switch {
	case len(d) == 192 && d[8] == 1:
		version = 1
	case len(d) == 200 && d[8] == 2:
		version = 2
	case len(d) == 208 && d[8] == 3:
		version = 3
	default:
		return false
	}
	if string(d[:8]) != "WENGEN01" || d[9] != 0 || d[10] > 3 || !bytes.Equal(d[12:16], make([]byte, 4)) {
		return false
	}
	n := func(at int) uint64 { return binary.LittleEndian.Uint64(d[at:]) }
	open, closeAt, deadline := n(144), n(152), n(160)
	total, accepted, refunded := n(168), n(176), n(184)
	if open > math.MaxInt64 || closeAt > math.MaxInt64 || deadline > math.MaxInt64 || deadline <= closeAt || accepted > total || refunded > total || accepted > 200_000_000_000 {
		return false
	}
	if version == 3 {
		const maximum = 21 * 86400
		const notice = 72 * 3600
		if open > math.MaxInt64-maximum {
			return false
		}
		hard, threshold := open+maximum, n(192)
		if threshold == 0 {
			if closeAt != hard || total >= 50_000_000_000 {
				return false
			}
		} else {
			if threshold < open || threshold >= hard || total < 50_000_000_000 {
				return false
			}
			expected := threshold + notice
			if expected > hard {
				expected = hard
			}
			if closeAt != expected {
				return false
			}
		}
		cutover := n(200)
		return cutover <= math.MaxInt64/28800
	}
	if open > math.MaxInt64-604800 || closeAt != open+604800 {
		return false
	}
	if version == 2 {
		cutover := n(192)
		return cutover > 0 && cutover <= math.MaxInt64/28800
	}
	return true
}
