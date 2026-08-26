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

func TestFrozenSATGeneration2ReleaseAcknowledgementIsComplete(t *testing.T) {
	ack := signerSATReleaseAcknowledgementGeneration2
	if ack.Schema != "fased.sat-release-acknowledgement.v1" || ack.State != "FROZEN_NOT_ACTIVE" {
		t.Fatalf("unexpected SAT release acknowledgement: %+v", ack)
	}
	if ack.ComponentGenerations.Schema != "SAT-SCHEMA-GEN-002" || ack.ComponentGenerations.SignerCapability != "FSD-SIGNER-GEN-002" {
		t.Fatalf("unexpected SAT component tuple: %+v", ack.ComponentGenerations)
	}
	for name, digest := range map[string]string{
		"interface":     ack.InterfaceContractSHA256,
		"idl":           ack.IDLSHA256,
		"account-order": ack.AccountOrderSHA256,
		"state-layouts": ack.StateLayoutsSHA256,
		"signer-codecs": ack.SignerCodecsSHA256,
	} {
		if len(digest) != 71 || digest[:7] != "sha256:" {
			t.Fatalf("invalid %s digest %q", name, digest)
		}
	}
}
