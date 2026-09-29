package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"strings"
	"testing"
)

type wenMiningFixture struct {
	Preimage     wenMiningPreimageV1     `json:"preimage"`
	PreimageKey  string                  `json:"preimageKey"`
	Blockhash    string                  `json:"blockhash"`
	Messages     [][]byte                `json:"messages"`
	Intent       signerWENMiningIntentV1 `json:"intent"`
	Wallet       string                  `json:"wallet"`
	Vectors      map[string][]byte       `json:"vectors"`
	Instructions []struct {
		Vector struct {
			Data []byte `json:"data"`
		} `json:"vector"`
	} `json:"instructions"`
}

func miningFixture(t *testing.T) wenMiningFixture {
	t.Helper()
	raw, e := os.ReadFile("testdata/wen-mining-candidate.json")
	if e != nil {
		t.Fatal(e)
	}
	var f wenMiningFixture
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	return f
}
func TestWENMiningInstructionV1(t *testing.T) {
	f := miningFixture(t)
	for _, op := range []string{"commit", "reveal"} {
		t.Run(op, func(t *testing.T) {
			v := f.Intent
			v.Operation = op
			data := f.Vectors["admitted"]
			now := uint64(1000)
			index := 0
			var material []byte
			if op == "reveal" {
				data = f.Vectors["committed"]
				now = 1180
				material = f.Vectors["revealed"][232:]
				index = 1
			}
			sum := sha256.Sum256(data)
			v.EntrySHA256 = hex.EncodeToString(sum[:])
			wallet := solana.MustPublicKeyFromBase58(f.Wallet)
			snap := wenMiningEntrySnapshotV1{solana.MustPublicKeyFromBase58(v.Entry), solana.MustPublicKeyFromBase58(v.ProgramID), false, data, 150, now}
			ix, e := prepareWENMiningInstructionV1(v, wallet, snap, material)
			if e != nil {
				t.Fatal(e)
			}
			wire, _ := ix.Data()
			if string(wire) != string(f.Instructions[index].Vector.Data) {
				t.Fatal("Rust instruction parity")
			}
			message := f.Messages[index]
			blockhash := solana.MustHashFromBase58(f.Blockhash)
			if e := verifyWENMiningMessageV1(v, wallet, snap, material, message, blockhash, 100, 200, 5000); e != nil {
				t.Fatal("portable message parity", e)
			}
			for i := range message {
				bad := append([]byte(nil), message...)
				bad[i] ^= 1
				if verifyWENMiningMessageV1(v, wallet, snap, material, bad, blockhash, 100, 200, 5000) == nil {
					t.Fatalf("message byte %d accepted", i)
				}
			}
			if verifyWENMiningMessageV1(v, wallet, snap, material, message, blockhash, 200, 200, 5000) == nil {
				t.Fatal("expired message")
			}
			if verifyWENMiningMessageV1(v, wallet, snap, material, message, blockhash, 100, 200, 5001) == nil {
				t.Fatal("excess fee")
			}
			accounts := ix.Accounts()
			if len(accounts) != 2 || !accounts[0].IsSigner || accounts[0].IsWritable || accounts[1].IsSigner || !accounts[1].IsWritable || accounts[0].PublicKey != wallet || accounts[1].PublicKey != snap.Address {
				t.Fatal("account roles")
			}
			// Update the external byte pin too, so this exercises canonical validation.
			for i := range data {
				if op == "reveal" && i >= 200 && i < 232 {
					continue
				}
				bad := snap
				bad.Data = append([]byte(nil), data...)
				bad.Data[i] ^= 1
				copy := v
				h := sha256.Sum256(bad.Data)
				copy.EntrySHA256 = hex.EncodeToString(h[:])
				if _, e := prepareWENMiningInstructionV1(copy, wallet, bad, material); e == nil {
					t.Fatalf("accepted byte mutation %d", i)
				}
			}
			for _, n := range []uint64{999, 1180, 1899, 1900} {
				copy := snap
				copy.Now = n
				_, e := prepareWENMiningInstructionV1(v, wallet, copy, material)
				want := op == "reveal" && (n == 1180 || n == 1899)
				if (e == nil) != want {
					t.Fatalf("time %d", n)
				}
			}
			for _, mutate := range []func(*wenMiningEntrySnapshotV1){func(s *wenMiningEntrySnapshotV1) { s.Executable = true }, func(s *wenMiningEntrySnapshotV1) { s.Owner = wallet }, func(s *wenMiningEntrySnapshotV1) { s.Address = wallet }, func(s *wenMiningEntrySnapshotV1) { s.Slot = 99 }, func(s *wenMiningEntrySnapshotV1) { s.Slot = 201 }} {
				copy := snap
				mutate(&copy)
				if _, e := prepareWENMiningInstructionV1(v, wallet, copy, material); e == nil {
					t.Fatal("snapshot substitution")
				}
			}
			if _, e := prepareWENMiningInstructionV1(v, solana.PublicKey{}, snap, material); e == nil {
				t.Fatal("wrong wallet")
			}
			if op == "reveal" {
				bad := append([]byte(nil), material...)
				bad[39] ^= 1
				if _, e := prepareWENMiningInstructionV1(v, wallet, snap, bad); e == nil {
					t.Fatal("wrong reveal")
				}
			}
		})
	}
}
func TestWENMiningIntentV1(t *testing.T) {
	f := miningFixture(t)
	raw, _ := json.Marshal(f.Intent)
	if _, e := decodeWENMiningIntentV1(raw); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{string(raw) + "{}", strings.Replace(string(raw), `"operation":"commit"`, `"operation":"commit","operation":"reveal"`, 1), strings.Replace(string(raw), `"operation":"commit"`, `"Operation":"commit"`, 1), strings.Replace(string(raw), `"operation":"commit"`, `"operation":"commit","salt":"secret"`, 1)} {
		if _, e := decodeWENMiningIntentV1([]byte(bad)); e == nil {
			t.Fatal("noncanonical request")
		}
	}
	for _, mutate := range []func(*signerWENMiningIntentV1){func(v *signerWENMiningIntentV1) { v.Operation = "admit" }, func(v *signerWENMiningIntentV1) { v.Nonce = "01" }, func(v *signerWENMiningIntentV1) { v.Capital = "0" }, func(v *signerWENMiningIntentV1) { v.Open = "9223372036854774908" }, func(v *signerWENMiningIntentV1) { v.MaxFeeLamports = "0" }, func(v *signerWENMiningIntentV1) { v.ExpiresSlot = v.MinFinalizedSlot }, func(v *signerWENMiningIntentV1) { v.CommitmentSHA256 = "ABC" }, func(v *signerWENMiningIntentV1) { v.ProgramID = "11111111111111111111111111111111" }} {
		v := f.Intent
		mutate(&v)
		if validateWENMiningIntentV1(v) == nil {
			t.Fatal("invalid intent accepted")
		}
	}
	if _, e := normalizeSignerIntentV2(signerIntentV2{Type: intentWENMiningV1}); e == nil {
		t.Fatal("public mining enabled")
	}
	for _, kind := range signerV2Capabilities.IntentTypes {
		if kind == intentWENMiningV1 {
			t.Fatal("advertised mining")
		}
	}
}
