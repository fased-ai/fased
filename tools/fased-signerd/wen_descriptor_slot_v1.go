package main

import (
	"encoding/json"
	"strconv"
)

// WEN's reviewed descriptors have used both decimal JSON strings and canonical
// integer JSON numbers. Compare exact decimal text to avoid float rounding.
func wenDescriptorSlotMatchesV1(value any, expected uint64) bool {
	if expected == 0 {
		return false
	}
	decimal := strconv.FormatUint(expected, 10)
	switch slot := value.(type) {
	case string:
		return slot == decimal
	case json.Number:
		return string(slot) == decimal
	default:
		return false
	}
}
