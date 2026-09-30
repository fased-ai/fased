package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func wenRestartRecord(t *testing.T, s *signerStoreV2, request string) []byte {
	t.Helper()
	var raw []byte
	if err := s.db.View(func(tx *bolt.Tx) error {
		raw = append([]byte(nil), tx.Bucket(wenBudgetBucketV1).Get([]byte("request:"+request))...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 {
		t.Fatal("missing restart reservation")
	}
	return raw
}

// Run against only the parent test's disposable database, after its handle closes.
// A new test process has no in-memory signer cache or owner wallet keys.
func verifyWENFreshProcess(t *testing.T, dbPath, request string, raw []byte) {
	t.Helper()
	sum := sha256.Sum256(raw)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWENFreshProcessReservation$", "-test.v")
	cmd.Env = append(os.Environ(), "TMPDIR="+os.TempDir(), "WEN_TEST_RESTART_DB="+dbPath, "WEN_TEST_RESTART_REQUEST="+request, "WEN_TEST_RESTART_HASH="+hex.EncodeToString(sum[:]))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fresh process recovery: %v\n%s", err, output)
	} else if !strings.Contains(string(output), "--- PASS: TestWENFreshProcessReservation") {
		t.Fatal("fresh process assertion did not run")
	}
	badSum := sum
	badSum[0] ^= 1
	negative := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWENFreshProcessReservation$", "-test.v")
	negative.Env = append(os.Environ(), "TMPDIR="+os.TempDir(), "WEN_TEST_RESTART_DB="+dbPath, "WEN_TEST_RESTART_REQUEST="+request, "WEN_TEST_RESTART_HASH="+hex.EncodeToString(badSum[:]))
	output, err := negative.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "persisted reservation changed across process restart") {
		t.Fatalf("wrong journal digest was not rejected: %v\n%s", err, output)
	}
	var record wenBudgetReservationV1
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	if record.MiningIntent != nil {
		recovery := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWENFreshProcessReservation$", "-test.v")
		recovery.Env = append(cmd.Env, "WEN_TEST_RESTART_RECONCILE=1")
		output, err := recovery.CombinedOutput()
		if err != nil || !strings.Contains(string(output), "child mining reconciliation passed") {
			t.Fatalf("child reconciliation: %v\n%s", err, output)
		}
	}
}

func TestWENFreshProcessReservation(t *testing.T) {
	dbPath := os.Getenv("WEN_TEST_RESTART_DB")
	if dbPath == "" {
		t.Skip("parent subprocess fixture only")
	}
	tempRoot := os.TempDir()
	if configured := os.Getenv("GOTMPDIR"); configured != "" {
		rel, err := filepath.Rel(tempRoot, configured)
		if err != nil || !filepath.IsAbs(configured) || strings.HasPrefix(rel, "..") {
			t.Fatal("Go test temporary root is outside OS temporary directory")
		}
		tempRoot = configured
	}
	relative, err := filepath.Rel(tempRoot, dbPath)
	if err != nil || !strings.HasPrefix(relative, "TestWEN") || strings.HasPrefix(relative, "..") {
		t.Fatalf("restart database is not a disposable WEN test fixture: relative=%q temp=%q", relative, os.TempDir())
	}
	s, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	request := os.Getenv("WEN_TEST_RESTART_REQUEST")
	raw := wenRestartRecord(t, s, request)
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != os.Getenv("WEN_TEST_RESTART_HASH") {
		t.Fatal("persisted reservation changed across process restart")
	}
	var record wenBudgetReservationV1
	if err = json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	// Keep the original accounting day: expiry must not mask replay rejection.
	day, err := time.Parse("2006-01-02", record.UsageDay)
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return day.Add(12 * time.Hour) }
	switch record.State {
	case "signing", "signed", "submission-uncertain":
		if err = s.cancelWENReservationV1(request, record.Digest); err == nil {
			t.Fatal("restart released an in-flight reservation")
		}
		if err = s.beginWENSigningV1(request, record.Digest, wenHashV1([]byte("replacement-message"))); err == nil {
			t.Fatal("restart allowed signing twice")
		}
	}
	if os.Getenv("WEN_TEST_RESTART_RECONCILE") == "1" {
		if record.MiningIntent == nil {
			t.Fatal("missing mining intent")
		}
		fixture := miningWalletFixture(t, solana.MustPublicKeyFromBase58(record.WalletPublicKey))
		prep, _, _ := miningPrepareSetup(t, fixture, record.MiningIntent.Operation, "ok")
		wire, err := wenSignedWireV1(record, record.SignedMessage)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
		envelope := &rpc.TransactionResultEnvelope{}
		if err = json.Unmarshal(encoded, envelope); err != nil {
			t.Fatal(err)
		}
		client := &miningExecutionFake{miningPrepareFake: prep, store: s, request: request, signature: solana.MustSignatureFromBase58(record.Signature), result: &rpc.GetTransactionResult{Slot: 150, Transaction: envelope, Meta: &rpc.TransactionMeta{Fee: 4000, PreBalances: []uint64{10000, 1000, 1}, PostBalances: []uint64{6000, 1000, 1}}}}
		if record.State == "submission-uncertain" {
			client.failure = "missing"
			_, _ = s.recoverWENMiningExecutionV1(context.Background(), client, request, record.Digest)
			if sha256.Sum256(wenRestartRecord(t, s, request)) != sum {
				t.Fatal("missing receipt changed held journal")
			}
			reserved, err := s.wenBudgetReservedV1(wenMiningNativeScopeV1(record.WalletID, record.MiningIntent.Genesis))
			if err != nil || reserved != 5000 || client.sends != 0 {
				t.Fatal("missing receipt released budget or resent")
			}
			client.failure = "success"
		}
		for i := 0; i < 2; i++ {
			outcome, err := s.recoverWENMiningExecutionV1(context.Background(), client, request, record.Digest)
			if err != nil || outcome != "finalized-success" {
				t.Fatalf("child recovery: %s %v", outcome, err)
			}
			reserved, err := s.wenBudgetReservedV1(wenMiningNativeScopeV1(record.WalletID, record.MiningIntent.Genesis))
			if err != nil || reserved != 4000 || client.sends != 0 {
				t.Fatalf("child recovery accounting/resend: %d %d %v", reserved, client.sends, err)
			}
		}
		t.Log("child mining reconciliation passed")
		return
	}
	after := sha256.Sum256(wenRestartRecord(t, s, request))
	if after != sum {
		t.Fatal("rejected recovery operation changed reservation")
	}
}
