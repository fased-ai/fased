package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningPreimageInstallV1(t *testing.T) {
	for _, mode := range []string{"valid", "application", "readonly", "scope", "salt", "allocation", "conflict", "symlink", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			store, keys := openTestSignerV2(t)
			base := miningFixture(t)
			record, _ := createTestSignerWalletV2(t, store, keys, "miner", base.Intent.Economy, 100, 100)
			f := miningWalletFixture(t, solana.MustPublicKeyFromBase58(record.PublicKey))
			prep, _, v := miningPrepareSetup(t, f, "commit", "ok")
			raw, e := os.ReadFile(filepath.Join(prep.root, f.PreimageKey+".json"))
			if e != nil {
				t.Fatal(e)
			}
			defer zeroBytes(raw)
			var preimage wenMiningPreimageV1
			if e = json.Unmarshal(raw, &preimage); e != nil {
				t.Fatal(e)
			}
			body := wenMiningPreimageInstallV1{Intent: v, Preimage: preimage}
			cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
			root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining", wenHashV1([]byte("miner")))
			target := filepath.Join(root, f.PreimageKey+".json")
			switch mode {
			case "readonly":
				cfg.readOnly = true
			case "scope":
				body.Preimage.Scope.Capital = "2"
			case "salt":
				body.Preimage.Salt = wenHashV1([]byte("wrong"))
			case "allocation":
				body.Preimage.Allocation = []uint16{10000, 0, 0, 0}
			case "conflict", "symlink":
				if e = os.MkdirAll(root, 0700); e != nil {
					t.Fatal(e)
				}
				if mode == "conflict" {
					e = os.WriteFile(target, []byte("{}"), 0600)
				} else {
					e = os.Symlink("unrelated", target)
				}
				if e != nil {
					t.Fatal(e)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			service := &signerServiceV2{store: store, keys: keys}
			receipt, e := service.installMiningPreimageV1(ctx, cfg, "miner", body, mode != "application")
			if (e == nil) != (mode == "valid") {
				t.Fatal("installation result", e)
			}
			if mode == "valid" {
				material, e := loadWENMiningPreimageV1(root, v, solana.MustPublicKeyFromBase58(f.Wallet))
				if e != nil {
					t.Fatal(e)
				}
				zeroBytes(material)
				again, e := service.installMiningPreimageV1(ctx, cfg, "miner", body, true)
				if e != nil || again != receipt {
					t.Fatal("retry", e)
				}
				if receipt.SigningEnabled || receipt.PreimageKey != f.PreimageKey {
					t.Fatal("receipt")
				}
				info, _ := os.Stat(root)
				if info.Mode().Perm() != 0700 {
					t.Fatal("root permissions")
				}
				info, _ = os.Stat(target)
				if info.Mode().Perm() != 0600 {
					t.Fatal("file permissions")
				}
			} else if mode == "conflict" {
				got, _ := os.ReadFile(target)
				if string(got) != "{}" {
					t.Fatal("conflict replaced")
				}
			} else if mode == "symlink" {
				if link, e := os.Readlink(target); e != nil || link != "unrelated" {
					t.Fatal("link replaced")
				}
			} else if _, e = os.Lstat(target); !os.IsNotExist(e) {
				t.Fatal("invalid import published")
			}
		})
	}
}
