package main

import "testing"

func TestFrozenSATGeneration2RevealCodecIsExactAndInactive(t *testing.T) {
	codec, ok := signerSATCodecsGeneration2["revealCycleV2"]
	if !ok {
		t.Fatal("missing generated generation-2 reveal codec")
	}
	if codec.Active || codec.Discriminator != 114 || codec.DataLength != 105 || codec.AllocationChannels != 16 {
		t.Fatalf("unexpected generation-2 reveal codec: %+v", codec)
	}
	data := make([]byte, codec.DataLength)
	data[0] = codec.Discriminator
	if !isCanonicalFrozenSATGeneration2Data(codec.Action, data) {
		t.Fatal("exact frozen generation-2 reveal payload was not recognized")
	}
	if isCanonicalFrozenSATGeneration2Data(codec.Action, data[:len(data)-1]) {
		t.Fatal("short generation-2 reveal payload was recognized")
	}
}
