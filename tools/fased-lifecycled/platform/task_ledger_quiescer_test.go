package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

const quiesceTestDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type acknowledgingTaskLedgerSystemd struct {
	fakeSystemd
	quiescer *TaskLedgerQuiescer
	gateway  string
}

func (systemd acknowledgingTaskLedgerSystemd) Stop(ctx context.Context, unit string) error {
	if err := systemd.fakeSystemd.Stop(ctx, unit); err != nil {
		return err
	}
	if unit != systemd.gateway {
		return nil
	}
	request, found, err := systemd.quiescer.readExact(systemd.quiescer.requestPath())
	if err != nil || !found {
		return errors.New("Gateway stop did not observe task ledger quiesce request")
	}
	if err := systemd.quiescer.writeAtomic(systemd.quiescer.ackPath(), request, 0o600); err != nil {
		return err
	}
	*systemd.calls = append(*systemd.calls, "task-ledger.ack")
	return nil
}

func taskLedgerQuiescerFixture(t *testing.T) (*TaskLedgerQuiescer, model.Transaction) {
	t.Helper()
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	config, err := NewConfig(model.ProfileProtectedLocal, "task-ledger-proof", "/home/owner/.fased", operator,
		Principal{UID: operator.UID + 1, GID: operator.GID + 1}, Principal{UID: operator.UID + 2, GID: operator.GID + 2})
	if err != nil {
		t.Fatal(err)
	}
	quiescer := NewTaskLedgerQuiescer(config)
	quiescer.rootPrefix = t.TempDir()
	if err := os.MkdirAll(quiescer.tasksRoot(), 0o700); err != nil {
		t.Fatal(err)
	}
	return quiescer, model.Transaction{ID: "transaction-1", Target: model.Generation{ID: quiesceTestDigest}}
}

func writeTaskLedgerCapability(t *testing.T, quiescer *TaskLedgerQuiescer) {
	t.Helper()
	if err := quiescer.writeAtomic(quiescer.capabilityPath(), []byte("{\"schema\":1,\"capability\":\"task-ledger-quiesce-v1\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestTaskLedgerQuiescerAcknowledgedTransactionBindsTypedStateReceipt(t *testing.T) {
	quiescer, tx := taskLedgerQuiescerFixture(t)
	writeTaskLedgerCapability(t, quiescer)
	if err := quiescer.Begin(tx); err != nil {
		t.Fatal(err)
	}
	request, found, err := quiescer.readExact(quiescer.requestPath())
	if err != nil || !found {
		t.Fatalf("request = %q/%v/%v", request, found, err)
	}
	if err := quiescer.writeAtomic(quiescer.ackPath(), request, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Complete(tx); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Complete(tx); err != nil {
		t.Fatalf("completed handshake was not idempotent: %v", err)
	}
	digest, err := quiescer.BindStateCapture(tx, quiesceTestDigest)
	if err != nil || !validDigest(digest) {
		t.Fatalf("receipt digest = %q/%v", digest, err)
	}
	if _, found, err := quiescer.readExact(quiescer.requestPath()); err != nil || found {
		t.Fatalf("request transient survived: found=%v err=%v", found, err)
	}
	if _, found, err := quiescer.readExact(quiescer.ackPath()); err != nil || found {
		t.Fatalf("ack transient survived: found=%v err=%v", found, err)
	}
	receipt, found, err := quiescer.readExact(quiescer.receiptPath(tx))
	if err != nil || !found || !strings.Contains(string(receipt), "\"mode\":\"acknowledged\"") || !strings.Contains(string(receipt), quiesceTestDigest) {
		t.Fatalf("receipt is incomplete: %q found=%v err=%v", receipt, found, err)
	}
}

func TestTaskLedgerQuiescerRejectsMissingInvalidAndStaleAcknowledgements(t *testing.T) {
	for _, name := range []string{"missing", "invalid", "stale"} {
		t.Run(name, func(t *testing.T) {
			quiescer, tx := taskLedgerQuiescerFixture(t)
			writeTaskLedgerCapability(t, quiescer)
			if err := quiescer.Begin(tx); err != nil {
				t.Fatal(err)
			}
			if name == "invalid" {
				if err := quiescer.writeAtomic(quiescer.ackPath(), []byte("not-json\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if name == "stale" {
				stale := canonicalQuiesceEnvelope(taskLedgerQuiesceEnvelope{Schema: taskLedgerQuiesceSchema, TransactionID: "other", Nonce: strings.Repeat("a", 64)})
				if err := quiescer.writeAtomic(quiescer.ackPath(), stale, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := quiescer.Complete(tx); err == nil {
				t.Fatal("invalid acknowledgement was accepted")
			}
		})
	}
}

func TestTaskLedgerQuiescerRejectsLostCapableRequestWithoutLegacyFallback(t *testing.T) {
	quiescer, tx := taskLedgerQuiescerFixture(t)
	writeTaskLedgerCapability(t, quiescer)
	if err := quiescer.Begin(tx); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(quiescer.requestPath()); err != nil {
		t.Fatal(err)
	}
	if err := syncDirectory(filepath.Dir(quiescer.requestPath())); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Complete(tx); err == nil {
		t.Fatal("lost capable request was downgraded to legacy bridge")
	}
	if receipt, found, err := quiescer.readExact(quiescer.receiptPath(tx)); err != nil || found {
		t.Fatalf("lost capable request created receipt: %q found=%v err=%v", receipt, found, err)
	}
}

func TestTargetAdapterDiscardClearsMissingAcknowledgementForRetry(t *testing.T) {
	adapter, tx, _ := targetAdapter(t)
	tx.Phase = model.PhasePrepared
	quiescer := NewTaskLedgerQuiescer(adapter.Config)
	quiescer.rootPrefix = t.TempDir()
	if err := os.MkdirAll(quiescer.tasksRoot(), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTaskLedgerCapability(t, quiescer)
	adapter.TaskLedger = quiescer
	if err := quiescer.Begin(tx); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Complete(tx); err == nil {
		t.Fatal("missing acknowledgement was accepted")
	}
	if err := adapter.Discard(context.Background(), tx); err != nil {
		t.Fatalf("discard did not clean failed handshake: %v", err)
	}
	if _, found, err := quiescer.readExact(quiescer.requestPath()); err != nil || found {
		t.Fatalf("discard left a request: found=%v err=%v", found, err)
	}
	retry := tx
	retry.ID = "transaction-2"
	if err := quiescer.Begin(retry); err != nil {
		t.Fatalf("next transaction remained blocked after discard: %v", err)
	}
}

func TestTaskLedgerQuiescerPreservesMismatchedAcknowledgementOnAbort(t *testing.T) {
	quiescer, tx := taskLedgerQuiescerFixture(t)
	writeTaskLedgerCapability(t, quiescer)
	if err := quiescer.Begin(tx); err != nil {
		t.Fatal(err)
	}
	stale := canonicalQuiesceEnvelope(taskLedgerQuiesceEnvelope{Schema: taskLedgerQuiesceSchema, TransactionID: "other", Nonce: strings.Repeat("a", 64)})
	if err := quiescer.writeAtomic(quiescer.ackPath(), stale, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Abort(tx); err == nil {
		t.Fatal("mismatched acknowledgement was removed")
	}
	if _, found, err := quiescer.readExact(quiescer.requestPath()); err != nil || !found {
		t.Fatalf("request was not preserved for investigation: found=%v err=%v", found, err)
	}
	if got, found, err := quiescer.readExact(quiescer.ackPath()); err != nil || !found || string(got) != string(stale) {
		t.Fatalf("mismatched acknowledgement was not preserved: %q found=%v err=%v", got, found, err)
	}
}

func TestTaskLedgerQuiescerNoReplaceRequestPublication(t *testing.T) {
	quiescer, _ := taskLedgerQuiescerFixture(t)
	existing := []byte("existing\n")
	if err := quiescer.writeAtomicNew(quiescer.requestPath(), existing, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.writeAtomicNew(quiescer.requestPath(), []byte("replacement\n"), 0o600); err == nil {
		t.Fatal("request publication replaced an existing file")
	}
	got, found, err := quiescer.readExact(quiescer.requestPath())
	if err != nil || !found || string(got) != string(existing) {
		t.Fatalf("existing request changed: %q found=%v err=%v", got, found, err)
	}
}

func TestTaskLedgerQuiescerUsesLegacyBridgeWithoutCapabilityMarker(t *testing.T) {
	quiescer, tx := taskLedgerQuiescerFixture(t)
	if err := quiescer.Begin(tx); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Complete(tx); err != nil {
		t.Fatal(err)
	}
	digest, err := quiescer.BindStateCapture(tx, quiesceTestDigest)
	if err != nil || !validDigest(digest) {
		t.Fatalf("legacy bridge digest = %q/%v", digest, err)
	}
	receipt, _, err := quiescer.readExact(quiescer.receiptPath(tx))
	if err != nil || !strings.Contains(string(receipt), "legacy-typed-state-bridge") {
		t.Fatalf("legacy bridge receipt missing: %q/%v", receipt, err)
	}
}

func TestTargetAdapterBindsTaskLedgerEvidenceIntoStateReceipt(t *testing.T) {
	quiescer, tx := taskLedgerQuiescerFixture(t)
	tx.Phase = model.PhasePrepared
	tx.Previous = &model.Generation{ID: "previous"}
	writeTaskLedgerCapability(t, quiescer)
	if err := quiescer.Begin(tx); err != nil {
		t.Fatal(err)
	}
	request, _, err := quiescer.readExact(quiescer.requestPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := quiescer.writeAtomic(quiescer.ackPath(), request, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Complete(tx); err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	adapter := &TargetAdapter{TypedState: fakeTypedState{calls: &calls}, TaskLedger: quiescer}
	receipt, _, err := adapter.PrepareState(context.Background(), tx)
	if err != nil || !validDigest(receipt.EvidenceDigest) {
		t.Fatalf("state receipt does not bind durable quiesce evidence: %+v err=%v", receipt, err)
	}
	if receipt.MemberDigests.ApplicationState != quiesceTestDigest {
		t.Fatalf("application-state capture was not retained: %+v", receipt)
	}
}

func TestTargetAdapterQuiesceRequestsBeforeGatewayStopAndRequiresAcknowledgement(t *testing.T) {
	adapter, tx, calls := targetAdapter(t)
	tx.Phase = model.PhasePrepared
	quiescer := NewTaskLedgerQuiescer(adapter.Config)
	quiescer.rootPrefix = t.TempDir()
	if err := os.MkdirAll(quiescer.tasksRoot(), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTaskLedgerCapability(t, quiescer)
	adapter.TaskLedger = quiescer
	adapter.Systemd = acknowledgingTaskLedgerSystemd{
		fakeSystemd: fakeSystemd{calls: calls},
		quiescer:    quiescer,
		gateway:     adapter.Identity.Services["gateway"],
	}

	if err := adapter.Quiesce(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if got, want := *calls, []string{
		"systemd.stop:" + adapter.Identity.Services["gateway"],
		"task-ledger.ack",
		"systemd.stop:" + adapter.Identity.Services["signer"],
	}; !slices.Equal(got, want) {
		t.Fatalf("quiesce ordering = %v, want %v", got, want)
	}
	if _, found, err := quiescer.readExact(quiescer.requestPath()); err != nil || found {
		t.Fatalf("quiesce request survived completed shutdown: found=%v err=%v", found, err)
	}
}

func TestTargetAdapterDoesNotRequestTaskLedgerAcknowledgementForFreshOrRollbackStop(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		phase model.Phase
		fresh bool
	}{
		{name: "fresh-install", phase: model.PhasePrepared, fresh: true},
		{name: "rollback-stop", phase: model.PhaseRolledBack, fresh: false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			adapter, tx, _ := targetAdapter(t)
			tx.Phase = scenario.phase
			if scenario.fresh {
				tx.Previous = nil
			}
			quiescer := NewTaskLedgerQuiescer(adapter.Config)
			quiescer.rootPrefix = t.TempDir()
			if err := os.MkdirAll(quiescer.tasksRoot(), 0o700); err != nil {
				t.Fatal(err)
			}
			writeTaskLedgerCapability(t, quiescer)
			adapter.TaskLedger = quiescer

			if err := adapter.Quiesce(context.Background(), tx); err != nil {
				t.Fatal(err)
			}
			if _, found, err := quiescer.readExact(quiescer.requestPath()); err != nil || found {
				t.Fatalf("non-capture stop wrote a quiesce request: found=%v err=%v", found, err)
			}
			if _, found, err := quiescer.readExact(quiescer.receiptPath(tx)); err != nil || found {
				t.Fatalf("non-capture stop wrote a quiesce receipt: found=%v err=%v", found, err)
			}
		})
	}
}

func TestTaskLedgerQuiescerRejectsUnsafeCapabilityMarker(t *testing.T) {
	quiescer, tx := taskLedgerQuiescerFixture(t)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, quiescer.capabilityPath()); err != nil {
		t.Fatal(err)
	}
	if err := quiescer.Begin(tx); err == nil {
		t.Fatal("unsafe capability marker was accepted")
	}
}
