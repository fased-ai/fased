package main

import (
	"bytes"
	"testing"
)

func TestWENBTCPreparationBuildsAndOwnsMessage(t *testing.T) {
	for _, operation := range []string{"acceptance", "acquisition"} {
		t.Run(operation, func(t *testing.T) {
			expected, intent, pins, snapshots, life := wenMessageFixture(t, operation)
			prepared, err := prepareWENBTCMessageV1(intent, pins, snapshots, life)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := prepared.revalidate(snapshots, 11)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(raw, expected) {
				t.Fatal("constructed message differs from independent fixture")
			}
			// Inputs and output belong to their callers. Mutating them must not replace
			// the prepared message, instruction, account ordering or approved ALT hash.
			intent.data[0] = 0
			intent.accounts[0].Pubkey = "bad"
			pins[0].digest = "bad"
			raw[0] = 0
			again, err := prepared.revalidate(snapshots, 12)
			if err != nil || !bytes.Equal(again, expected) {
				t.Fatalf("preparation aliases caller memory: %v", err)
			}
		})
	}
}
func TestWENBTCPreparationRejectsUnreadyInputs(t *testing.T) {
	for _, name := range []string{"expired", "units", "account", "signer", "opcode", "lookup-hash", "lookup-length", "lookup-missing", "no-lookups", "packet-size"} {
		t.Run(name, func(t *testing.T) {
			_, intent, pins, snapshots, life := wenMessageFixture(t, "acceptance")
			switch name {
			case "expired":
				life.currentHeight = life.lastValidHeight
			case "units":
				intent.units = 1400001
			case "account":
				intent.accounts[1].Pubkey = "bad"
			case "signer":
				intent.accounts[1].IsSigner = true
			case "opcode":
				intent.data[0] = 0
			case "lookup-hash":
				snapshots[0].Data[56] ^= 1
			case "lookup-length":
				snapshots[0].Data = []byte{1}
				pins[0].digest = wenHashV1(snapshots[0].Data)
			case "lookup-missing":
				snapshots[0] = nil
			case "no-lookups":
				pins = nil
				snapshots = nil
			case "packet-size":
				intent.data = make([]byte, 1232)
				intent.data[0] = 111
			}
			if p, err := prepareWENBTCMessageV1(intent, pins, snapshots, life); err == nil || p != nil {
				t.Fatal("invalid preparation returned")
			}
		})
	}
}
func TestWENBTCPreparationRechecksLifetimeAndTables(t *testing.T) {
	for _, name := range []string{"height-rollback", "expired", "table-change", "table-stale", "message-change", "empty"} {
		t.Run(name, func(t *testing.T) {
			_, intent, pins, snapshots, life := wenMessageFixture(t, "acquisition")
			p, err := prepareWENBTCMessageV1(intent, pins, snapshots, life)
			if err != nil {
				t.Fatal(err)
			}
			height := uint64(11)
			switch name {
			case "height-rollback":
				height = 9
			case "expired":
				height = 20
			case "table-change":
				snapshots[0].Data[56] ^= 1
			case "table-stale":
				snapshots[0].Slot = 156
			case "message-change":
				p.message[len(p.message)-1] ^= 1
			case "empty":
				p = nil
			}
			if raw, err := p.revalidate(snapshots, height); err == nil || raw != nil {
				t.Fatal("invalid revalidation returned message")
			}
		})
	}
}
