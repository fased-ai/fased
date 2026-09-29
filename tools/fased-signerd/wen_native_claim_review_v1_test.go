package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"testing"
)

func TestWENNativeClaimAdmission(t *testing.T) {
	for _, mode := range []string{"ok", "wallet", "intent", "budget", "rent-budget", "policy", "pin", "mode", "symlink", "missing-descriptor", "bad-descriptor", "changed-review", "changed-descriptor"} {
		t.Run(mode, func(t *testing.T) {
			raw, pins := nativeClaimDescriptorFixture(t, "ok")
			v := nativeClaimIntentFixture()
			v.ProgramID = pins.ProgramID
			v.Genesis = pins.Genesis
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			v.MinFinalizedSlot = "100"
			v.ExpiresSlot = "200"
			sale := solana.MustPublicKeyFromBase58(v.Sale)
			prog := solana.MustPublicKeyFromBase58(v.ProgramID)
			mint, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), sale[:]}, prog)
			if err != nil {
				t.Fatal(err)
			}
			v.Mint = mint.String()
			r := wenNativeClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: solana.PublicKey{5}.String(), Intent: v, Pins: pins, Policy: solana.PublicKey{6}.String(), MaxSlotLag: 2, MaxTotalCostLamports: 5000}
			if mode == "rent-budget" {
				v.MaxRentLamports = "1"
				r.Intent = v
			}
			switch mode {
			case "wallet":
				r.WalletPublicKey = "bad"
			case "intent":
				r.Intent.MinimumReceived = "2"
			case "budget":
				r.MaxTotalCostLamports = 4999
			case "policy":
				r.Policy = "bad"
			case "pin":
				r.Pins.Genesis = r.Policy
			}
			db := filepath.Join(t.TempDir(), "state.db")
			root := filepath.Join(filepath.Dir(db), "wen-native-claim", wenHashV1([]byte("miner")))
			if e := os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(root, wenNativeClaimAdmissionNameV1(v))
			write := func() {
				b, _ := json.Marshal(r)
				if e := os.WriteFile(path, b, 0600); e != nil {
					t.Fatal(e)
				}
			}
			write()
			descriptor := filepath.Join(root, pins.DescriptorSHA256)
			if e := os.WriteFile(descriptor, raw, 0600); e != nil {
				t.Fatal(e)
			}
			switch mode {
			case "mode":
				os.Chmod(path, 0666)
			case "symlink":
				os.Rename(path, path+"-real")
				os.Symlink(path+"-real", path)
			case "missing-descriptor":
				os.Remove(descriptor)
			case "bad-descriptor":
				os.WriteFile(descriptor, []byte("{}"), 0600)
			}
			c, w, e := loadWENNativeClaimAdmissionV1(db, "miner", v)
			good := mode == "ok" || mode == "changed-review" || mode == "changed-descriptor"
			if (e == nil) != good {
				t.Fatal(e)
			}
			if !good {
				return
			}
			if mode == "changed-review" {
				r.MaxSlotLag++
				write()
			}
			if mode == "changed-descriptor" {
				os.WriteFile(descriptor, []byte("{}"), 0600)
			}
			if e = recheckWENNativeClaimReviewV1(db, "miner", v, c, w); (e == nil) != (mode != "changed-review" && mode != "changed-descriptor") {
				t.Fatal("recheck", e)
			}
		})
	}
}
