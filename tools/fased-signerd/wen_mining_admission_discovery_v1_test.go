package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestWENMiningAdmissionDiscovery(t *testing.T) {
	for _, mode := range []string{"legacy", "scoped", "pagination", "wrong-owner", "bad-json", "wrong-name", "descriptor", "symlink", "cursor", "limit", "cancelled", "overflow", "empty", "scoped-corrupt", "missing-root", "bad-filename"} {
		t.Run(mode, func(t *testing.T) {
			f := miningFixture(t)
			raw, pins := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, CodeSHA256: wenHashV1([]byte{1, 2, 3}), DeploymentSlot: 50})
			v := f.Intent
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			db := filepath.Join(t.TempDir(), "state.db")
			review := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: v, Pins: pins, MaxSlotLag: 2}
			root := writeMiningReviewFixture(t, db, review)
			write := func(name string, data []byte) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			write(pins.DescriptorSHA256, raw)
			owner, cursor, limit := f.Wallet, "", 1
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "scoped", "pagination":
				review.Version = 2
				data, _ := json.Marshal(review)
				write(wenMiningAdmissionNameV2(v), data)
			case "scoped-corrupt":
				write(wenMiningAdmissionNameV2(v), []byte("{}"))
			case "missing-root":
				if err := os.Rename(root, root+"-moved"); err != nil {
					t.Fatal(err)
				}
			case "bad-filename":
				write("admission-invalid.json", []byte("{}"))
			case "wrong-owner":
				owner = v.ProgramID
			case "bad-json":
				write("admission.json", []byte("{}"))
			case "wrong-name":
				data, _ := json.Marshal(review)
				write("admission-"+wenHashV1([]byte("wrong"))+".json", data)
			case "descriptor":
				write(pins.DescriptorSHA256, []byte("{}"))
			case "symlink":
				if err := os.Remove(filepath.Join(root, "admission.json")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(root, pins.DescriptorSHA256), filepath.Join(root, "admission.json")); err != nil {
					t.Fatal(err)
				}
			case "cursor":
				cursor = "../admission.json"
			case "limit":
				limit = 101
			case "cancelled":
				cancel()
			case "overflow":
				for i := 0; i < wenMiningAdmissionDirectoryLimitV1; i++ {
					write(fmt.Sprintf("object-%04d", i), nil)
				}
			case "empty":
				if err := os.Remove(filepath.Join(root, "admission.json")); err != nil {
					t.Fatal(err)
				}
			}
			out, err := discoverWENMiningAdmissionsV1(ctx, db, "miner", owner, cursor, limit)
			success := mode == "legacy" || mode == "scoped" || mode == "pagination" || mode == "empty"
			if (err == nil) != success {
				t.Fatal(mode, err)
			}
			if !success {
				if len(out.Candidates) != 0 {
					t.Fatal("partial result on error")
				}
				return
			}
			if out.SigningEnabled {
				t.Fatal("signing enabled")
			}
			if mode == "empty" {
				if !out.Complete || out.Scanned != 0 || len(out.Candidates) != 0 {
					t.Fatal(out)
				}
				return
			}
			if len(out.Candidates) != 1 || out.Candidates[0].Intent != v || out.Candidates[0].CommitRequest != "" || out.Candidates[0].Source != "protected-admission" {
				t.Fatal(out)
			}
			if mode == "legacy" {
				if !out.Complete {
					t.Fatal(out)
				}
				return
			}
			if out.Complete || out.Scanned != 1 {
				t.Fatal(out)
			}
			next, err := discoverWENMiningAdmissionsV1(ctx, db, "miner", owner, out.Cursor, 1)
			if err != nil || !next.Complete || next.Scanned != 1 || len(next.Candidates) != 0 {
				t.Fatal(next, err)
			}
			end, err := discoverWENMiningAdmissionsV1(ctx, db, "miner", owner, next.Cursor, 1)
			if err != nil || !end.Complete || end.Scanned != 0 {
				t.Fatal(end, err)
			}
		})
	}
}
