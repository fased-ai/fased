package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeStakingReviewFixture(t *testing.T, db string, r wenStakingReviewV1) string {
	t.Helper()
	root := filepath.Join(filepath.Dir(db), "wen-staking", wenHashV1([]byte(r.WalletID)))
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	raw, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, wenStakingAdmissionNameV1(r.Intent)), raw, 0600); e != nil {
		t.Fatal(e)
	}
	return root
}
func TestWENStakingReviewV1(t *testing.T) {
	for _, mode := range []string{"valid", "wallet", "intent", "program", "code", "slot", "version", "file-mode", "parent-mode", "parent-link", "unknown", "duplicate", "missing", "size", "budget", "mint", "capability"} {
		t.Run(mode, func(t *testing.T) {
			f := stakingReviewFixture(t)
			db := filepath.Join(t.TempDir(), "state.db")
			r := wenStakingReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: f.Intent, Pins: wenStakingPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, DescriptorSHA256: f.Intent.DescriptorSHA256, CapabilitySHA256: f.Intent.CapabilitySHA256, CodeSHA256: wenHashV1([]byte{1, 2, 3}), DeploymentSlot: 50}, MaxSlotLag: 2, MaxTotalCostLamports: 10000000}
			switch mode {
			case "budget":
				r.MaxTotalCostLamports = 4999
			case "mint":
				r.Intent.Mint = f.Wallet
			case "capability":
				r.Pins.CapabilitySHA256 = wenHashV1([]byte("other"))
			case "wallet":
				r.WalletPublicKey = "bad"
			case "intent":
				r.Intent.Amount = "2"
			case "program":
				r.Pins.ProgramID = f.Wallet
			case "code":
				r.Pins.CodeSHA256 = "bad"
			case "slot":
				r.Pins.DeploymentSlot = 101
			case "version":
				r.Version = 2
			}
			root := writeStakingReviewFixture(t, db, r)
			p := filepath.Join(root, wenStakingAdmissionNameV1(r.Intent))
			requestedPath := filepath.Join(root, wenStakingAdmissionNameV1(f.Intent))
			if p != requestedPath {
				if e := os.Rename(p, requestedPath); e != nil {
					t.Fatal(e)
				}
				p = requestedPath
			}
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
			config, wallet, e := loadWENStakingReviewV1(db, "miner", f.Intent)
			if (e == nil) != (mode == "valid") {
				t.Fatal("unexpected review", e)
			}
			if e == nil && (config.root != root || wallet.String() != f.Wallet || !wenReservationHashV1(config.reviewSHA)) {
				t.Fatal("unbound review")
			}
		})
	}
}

func stakingReviewFixture(t *testing.T) struct {
	Wallet string
	Intent signerWENStakingIntentV1
} {
	t.Helper()
	raw, e := os.ReadFile("testdata/wen-staking-candidate.json")
	if e != nil {
		t.Fatal(e)
	}
	var rows []struct {
		Wallet string
		Intent signerWENStakingIntentV1
	}
	if e = json.Unmarshal(raw, &rows); e != nil || len(rows) == 0 {
		t.Fatal("fixture", e)
	}
	return rows[0]
}
func TestWENStakingReviewRecheckV1(t *testing.T) {
	f := stakingReviewFixture(t)
	db := filepath.Join(t.TempDir(), "state.db")
	r := wenStakingReviewV1{Version: 1, WalletID: "staker", WalletPublicKey: f.Wallet, Intent: f.Intent, Pins: wenStakingPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, DescriptorSHA256: f.Intent.DescriptorSHA256, CapabilitySHA256: f.Intent.CapabilitySHA256, CodeSHA256: wenHashV1([]byte("code")), DeploymentSlot: 50}, MaxSlotLag: 2, MaxTotalCostLamports: 10000000}
	root := writeStakingReviewFixture(t, db, r)
	config, owner, e := loadWENStakingReviewV1(db, "staker", f.Intent)
	if e != nil {
		t.Fatal(e)
	}
	if e = recheckWENStakingReviewV1(db, "staker", f.Intent, config, owner); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*wenStakingReviewedConfigV1){func(c *wenStakingReviewedConfigV1) { c.maxTotalCostLamports++ }, func(c *wenStakingReviewedConfigV1) { c.maxSlotLag++ }, func(c *wenStakingReviewedConfigV1) { c.pins.CodeSHA256 = wenHashV1([]byte("changed")) }} {
		bad := config
		mutate(&bad)
		if recheckWENStakingReviewV1(db, "staker", f.Intent, bad, owner) == nil {
			t.Fatal("caller override accepted")
		}
	}
	second := r
	second.Intent.Amount = "2"
	if wenStakingAdmissionNameV1(second.Intent) == wenStakingAdmissionNameV1(r.Intent) {
		t.Fatal("task collision")
	}
	writeStakingReviewFixture(t, db, second)
	if _, _, e = loadWENStakingReviewV1(db, "staker", second.Intent); e != nil {
		t.Fatal(e)
	}
	if e = recheckWENStakingReviewV1(db, "staker", f.Intent, config, owner); e != nil {
		t.Fatal("parallel task changed first", e)
	}
	r.MaxTotalCostLamports++
	writeStakingReviewFixture(t, db, r)
	if recheckWENStakingReviewV1(db, "staker", f.Intent, config, owner) == nil {
		t.Fatal("changed review accepted")
	}
	if e = os.Remove(filepath.Join(root, wenStakingAdmissionNameV1(r.Intent))); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(r)
	if e = os.WriteFile(filepath.Join(root, "admission.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e = loadWENStakingReviewV1(db, "staker", f.Intent); e == nil {
		t.Fatal("legacy fallback accepted")
	}
}

func TestWENStakingReviewScopeV1(t *testing.T) {
	f := stakingReviewFixture(t)
	baseline := wenStakingAdmissionNameV1(f.Intent)
	fields := []func(*signerWENStakingIntentV1){
		func(v *signerWENStakingIntentV1) { v.Sale = f.Wallet },
		func(v *signerWENStakingIntentV1) { v.Mint = f.Wallet },
		func(v *signerWENStakingIntentV1) { v.Operation = "requestExit"; v.Amount = "0" },
		func(v *signerWENStakingIntentV1) { v.ExpiresSlot = "201" },
		func(v *signerWENStakingIntentV1) { v.Last = "1" },
		func(v *signerWENStakingIntentV1) { v.TokenAccount = f.Wallet },
		func(v *signerWENStakingIntentV1) { v.CapabilitySHA256 = wenHashV1([]byte("new")) },
	}
	seen := map[string]bool{baseline: true}
	for _, change := range fields {
		v := f.Intent
		change(&v)
		name := wenStakingAdmissionNameV1(v)
		if seen[name] {
			t.Fatal("scope collision")
		}
		seen[name] = true
	}
}
