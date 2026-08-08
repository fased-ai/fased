package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const lifecycleDigestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const lifecycleDigestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func lifecycleRequest() signerLifecycleUpgradeRequestV1 {
	return signerLifecycleUpgradeRequestV1{
		SchemaVersion:        signerLifecycleUpgradeSchemaV1,
		TransactionID:        "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		TargetGenerationID:   lifecycleDigestA,
		StateInventoryDigest: lifecycleDigestB,
		PlanDigest:           lifecycleDigestA,
		FromSchema:           signerStateSchemaVersionV2,
		ToSchema:             signerStateSchemaVersionV2,
	}
}

func TestSignerLifecycleGateBindsExactTransaction(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gate.json")
	request := lifecycleRequest()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requireSignerLifecycleGateBindingV1(path, request, os.Geteuid()); err != nil {
		t.Fatal(err)
	}
	mismatch := request
	mismatch.PlanDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := requireSignerLifecycleGateBindingV1(path, mismatch, os.Geteuid()); err == nil {
		t.Fatal("mismatched signer lifecycle transaction used an existing gate")
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := requireSignerLifecycleGateBindingV1(path, request, os.Geteuid()); err == nil {
		t.Fatal("accessible signer lifecycle gate was accepted")
	}
}

func openLifecycleStore(t *testing.T) (*signerStoreV2, string) {
	t.Helper()
	statePath := filepath.Join(t.TempDir(), "state.db")
	store, err := openSignerStoreV2(statePath)
	if err != nil {
		t.Fatal(err)
	}
	return store, statePath
}

func TestSignerLifecyclePrepareVerifyCommitIsBoundAndIdempotent(t *testing.T) {
	store, statePath := openLifecycleStore(t)
	defer store.Close()
	request := lifecycleRequest()

	prepared, err := prepareSignerLifecycleUpgradeV1(store, statePath, request)
	if err != nil || prepared.Phase != signerLifecyclePhasePreparedV1 {
		t.Fatalf("prepare failed: %+v err=%v", prepared, err)
	}
	repeated, err := prepareSignerLifecycleUpgradeV1(store, statePath, request)
	if err != nil || repeated != prepared {
		t.Fatalf("repeated prepare changed receipt: %+v err=%v", repeated, err)
	}
	verified, err := verifySignerLifecycleUpgradeV1(store, statePath, request)
	if err != nil || verified.Phase != signerLifecyclePhaseVerifiedV1 {
		t.Fatalf("verify failed: %+v err=%v", verified, err)
	}
	committed, err := commitSignerLifecycleUpgradeV1(store, statePath, request)
	if err != nil || committed.Phase != signerLifecyclePhaseCommittedV1 {
		t.Fatalf("commit failed: %+v err=%v", committed, err)
	}
	repeatedCommit, err := commitSignerLifecycleUpgradeV1(store, statePath, request)
	if err != nil || repeatedCommit.Phase != signerLifecyclePhaseCommittedV1 {
		t.Fatalf("repeated commit failed: %+v err=%v", repeatedCommit, err)
	}
	preparedAfterCommit, err := prepareSignerLifecycleUpgradeV1(store, statePath, request)
	if err != nil || preparedAfterCommit.Phase != signerLifecyclePhaseCommittedV1 {
		t.Fatalf("prepare replay changed committed transaction: %+v err=%v", preparedAfterCommit, err)
	}
	if err := abortSignerLifecycleUpgradeV1(store, statePath, request); err == nil {
		t.Fatal("committed signer transaction was aborted")
	}
}

func TestSignerLifecycleAbortBeforeMigrationRemovesTransaction(t *testing.T) {
	store, statePath := openLifecycleStore(t)
	defer store.Close()
	request := lifecycleRequest()
	if _, err := prepareSignerLifecycleUpgradeV1(store, statePath, request); err != nil {
		t.Fatal(err)
	}
	if err := abortSignerLifecycleUpgradeV1(store, statePath, request); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(signerLifecycleMarkerPathV1(statePath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("abort retained lifecycle marker: %v", err)
	}
}

func TestSignerLifecycleOfflineAbortRestoresExactSnapshot(t *testing.T) {
	store, statePath := openLifecycleStore(t)
	request := lifecycleRequest()
	if _, err := prepareSignerLifecycleUpgradeV1(store, statePath, request); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, []byte("corrupt-target-state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := abortSignerLifecycleUpgradeOfflineV1(statePath, request); err != nil {
		t.Fatal(err)
	}
	version, err := inspectSignerSchemaReadOnlyV2(statePath)
	if err != nil || version != signerStateSchemaVersionV2 {
		t.Fatalf("offline abort did not restore signer snapshot: version=%d err=%v", version, err)
	}
}

func TestSignerLifecycleStrictRequestAndBindingMismatch(t *testing.T) {
	raw, err := json.Marshal(lifecycleRequest())
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	document["path"] = "/tmp/evil"
	malicious, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeSignerLifecycleUpgradeRequestV1(malicious); err == nil {
		t.Fatal("signer lifecycle request accepted caller path")
	}

	store, statePath := openLifecycleStore(t)
	defer store.Close()
	request := lifecycleRequest()
	if _, err := prepareSignerLifecycleUpgradeV1(store, statePath, request); err != nil {
		t.Fatal(err)
	}
	mismatch := request
	mismatch.PlanDigest = lifecycleDigestB
	if _, err := verifySignerLifecycleUpgradeV1(store, statePath, mismatch); err == nil {
		t.Fatal("signer lifecycle request binding mismatch was accepted")
	}
}
