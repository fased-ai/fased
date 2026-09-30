package main

import (
	"encoding/json"
	"testing"
)

func TestWENDescriptorSlotMatchesV1(t *testing.T) {
	for _, tt := range []struct {
		name  string
		value any
		want  bool
	}{
		{"canonical-number", json.Number("503658704"), true},
		{"retained-string", "503658704", true},
		{"other-number", json.Number("503658705"), false},
		{"fraction", json.Number("503658704.0"), false},
		{"exponent", json.Number("5.03658704e8"), false},
		{"leading-zero", "0503658704", false},
		{"rounded-float", float64(503658704), false},
		{"missing", nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := wenDescriptorSlotMatchesV1(tt.value, 503658704); got != tt.want {
				t.Fatalf("match = %v, want %v", got, tt.want)
			}
		})
	}
	if wenDescriptorSlotMatchesV1(json.Number("0"), 0) {
		t.Fatal("zero deployment accepted")
	}
}
