package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeMiningReviewFixture(t *testing.T, db string, r wenMiningReviewV1) string {
	t.Helper()
	root := filepath.Join(filepath.Dir(db), "wen-mining", wenHashV1([]byte(r.WalletID)))
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	raw, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, "admission.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	return root
}
func TestWENMiningReviewV1(t *testing.T) {
	for _, mode := range []string{"valid", "wallet", "intent", "program", "code", "slot", "version", "file-mode", "parent-mode", "parent-link", "unknown", "duplicate", "missing", "size"} {
		t.Run(mode, func(t *testing.T) {
			f := miningFixture(t)
			db := filepath.Join(t.TempDir(), "state.db")
			r := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: f.Intent, Pins: wenMiningPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, DescriptorSHA256: f.Intent.DescriptorSHA256, CapabilitySHA256: f.Intent.CapabilitySHA256, CodeSHA256: wenHashV1([]byte{1, 2, 3}), DeploymentSlot: 50}, MaxSlotLag: 2}
			switch mode {
			case "wallet":
				r.WalletPublicKey = "bad"
			case "intent":
				r.Intent.Capital = "2"
			case "program":
				r.Pins.ProgramID = f.Wallet
			case "code":
				r.Pins.CodeSHA256 = "bad"
			case "slot":
				r.Pins.DeploymentSlot = 101
			case "version":
				r.Version = 2
			}
			root := writeMiningReviewFixture(t, db, r)
			p := filepath.Join(root, "admission.json")
			switch mode {
			case "file-mode":
				if e := os.Chmod(p, 0666); e != nil {
					t.Fatal(e)
				}
			case "parent-mode":
				if e := os.Chmod(filepath.Dir(root), 0777); e != nil {
					t.Fatal(e)
				}
			case "parent-link":
				parent := filepath.Dir(root)
				if e := os.Rename(parent, parent+"-real"); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(parent+"-real", parent); e != nil {
					t.Fatal(e)
				}
			case "unknown":
				raw, _ := json.Marshal(r)
				raw = append([]byte(`{"extra":1,`), raw[1:]...)
				if e := os.WriteFile(p, raw, 0600); e != nil {
					t.Fatal(e)
				}
			case "duplicate":
				raw, _ := json.Marshal(r)
				raw = append([]byte(`{"version":1,`), raw[1:]...)
				if e := os.WriteFile(p, raw, 0600); e != nil {
					t.Fatal(e)
				}
			case "missing":
				if e := os.Remove(p); e != nil {
					t.Fatal(e)
				}
			case "size":
				if e := os.WriteFile(p, make([]byte, 16385), 0600); e != nil {
					t.Fatal(e)
				}
			}
			config, wallet, e := loadWENMiningReviewV1(db, "miner", f.Intent)
			if (e == nil) != (mode == "valid") {
				t.Fatal("unexpected review", e)
			}
			if e == nil && (config.Root != root || wallet.String() != f.Wallet || !wenReservationHashV1(config.reviewSHA)) {
				t.Fatal("unbound review")
			}
		})
	}
}

func TestWENMiningScopedReviewsV2(t *testing.T) {
	f := miningFixture(t)
	db := filepath.Join(t.TempDir(), "state.db")
	r := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: f.Intent, Pins: wenMiningPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, DescriptorSHA256: f.Intent.DescriptorSHA256, CapabilitySHA256: f.Intent.CapabilitySHA256, CodeSHA256: wenHashV1([]byte{1, 2, 3}), DeploymentSlot: 50}, MaxSlotLag: 2}
	root := writeMiningReviewFixture(t, db, r)
	second := r
	second.Version = 2
	second.Intent.Economy = f.Wallet
	second.Intent.Entry = f.Wallet
	name := wenMiningAdmissionNameV2(second.Intent)
	if name == wenMiningAdmissionNameV2(r.Intent) {
		t.Fatal("launch collision")
	}
	raw, _ := json.Marshal(second)
	if e := os.WriteFile(filepath.Join(root, name), raw, 0600); e != nil {
		t.Fatal(e)
	}
	a, _, e := loadWENMiningReviewV1(db, "miner", r.Intent)
	if e != nil || a.RequireLaunchBudget {
		t.Fatal("legacy changed", e)
	}
	b, _, e := loadWENMiningReviewV1(db, "miner", second.Intent)
	if e != nil || !b.RequireLaunchBudget {
		t.Fatal("scoped review missing", e)
	}
	// A malformed scoped review must not fall back to a matching legacy file.
	if e = os.WriteFile(filepath.Join(root, wenMiningAdmissionNameV2(r.Intent)), []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e = loadWENMiningReviewV1(db, "miner", r.Intent); e == nil {
		t.Fatal("invalid scoped review downgraded")
	}
}
