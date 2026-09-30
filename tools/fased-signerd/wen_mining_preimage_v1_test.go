package main

import (
	"bytes"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningProtectedPreimageV1(t *testing.T) {
	for _, mode := range []string{"valid", "missing", "directory-mode", "file-mode", "symlink", "corrupt", "duplicate", "scope", "salt", "digest", "allocation", "size"} {
		t.Run(mode, func(t *testing.T) {
			f := miningFixture(t)
			wallet := solana.MustPublicKeyFromBase58(f.Wallet)
			root := t.TempDir()
			if e := os.Chmod(root, 0700); e != nil {
				t.Fatal(e)
			}
			if wenMiningPreimageKeyV1(f.Intent, wallet) != f.PreimageKey {
				t.Fatal("portable filename parity")
			}
			p := filepath.Join(root, f.PreimageKey+".json")
			record := f.Preimage
			switch mode {
			case "scope":
				record.Scope.Capital = "1"
			case "salt":
				record.Salt = "00" + record.Salt[2:]
			case "digest":
				record.Digest = "00" + record.Digest[2:]
			case "allocation":
				record.Allocation = []uint16{1, 2, 3, 4}
			}
			raw, _ := json.Marshal(record)
			if mode == "corrupt" {
				raw = []byte("bad")
			}
			if mode == "duplicate" {
				raw = bytes.Replace(raw, []byte(`"schema":`), []byte(`"schema":"bad","schema":`), 1)
			}
			if mode == "size" {
				raw = make([]byte, 4097)
			}
			if mode != "missing" {
				if e := os.WriteFile(p, raw, 0600); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "directory-mode" {
				os.Chmod(root, 0755)
			}
			if mode == "file-mode" {
				os.Chmod(p, 0644)
			}
			if mode == "symlink" {
				os.Remove(p)
				os.Symlink(filepath.Join(root, "missing"), p)
			}
			material, e := loadWENMiningPreimageV1(root, f.Intent, wallet)
			if (e == nil) != (mode == "valid") {
				t.Fatal("unexpected preimage", e)
			}
			if e == nil && !bytes.Equal(material, f.Vectors["revealed"][232:]) {
				t.Fatal("portable reveal parity")
			}
			zeroBytes(material)
		})
	}
}

func TestWENMiningProtectedMessageV1(t *testing.T) {
	for _, op := range []string{"commit", "reveal"} {
		t.Run(op, func(t *testing.T) {
			f := miningFixture(t)
			v := f.Intent
			v.Operation = op
			data, now, index := f.Vectors["admitted"], uint64(1000), 0
			if op == "reveal" {
				data, now, index = f.Vectors["committed"], 1180, 1
			}
			v.EntrySHA256 = wenHashV1(data)
			wallet := solana.MustPublicKeyFromBase58(f.Wallet)
			snap := wenMiningEntrySnapshotV1{solana.MustPublicKeyFromBase58(v.Entry), solana.MustPublicKeyFromBase58(v.ProgramID), false, data, 150, now}
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			verify := func(message []byte) error {
				return verifyWENMiningProtectedMessageV1(root, v, wallet, snap, message, solana.MustHashFromBase58(f.Blockhash), 100, 200, 5000)
			}
			if verify(f.Messages[index]) == nil {
				t.Fatal("missing preimage accepted")
			}
			raw, err := json.Marshal(f.Preimage)
			if err != nil {
				t.Fatal(err)
			}
			p := filepath.Join(root, f.PreimageKey+".json")
			if err := os.WriteFile(p, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := verify(f.Messages[index]); err != nil {
				t.Fatal(err)
			}
			altered := append([]byte(nil), f.Messages[index]...)
			altered[len(altered)-1] ^= 1
			if verify(altered) == nil {
				t.Fatal("altered message accepted")
			}
			if err := os.Remove(p); err != nil {
				t.Fatal(err)
			}
			if verify(f.Messages[index]) == nil {
				t.Fatal("removed preimage accepted")
			}
		})
	}
}
