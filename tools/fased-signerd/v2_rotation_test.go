package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func configureTestSignerMiningRuntimeV1(t *testing.T) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(map[string]any{
		"schema": "sat-mainnet-addresses.v1", "network": "mainnet-beta", "status": "live",
		"sat": map[string]string{
			"programId":     solana.NewWallet().PublicKey().String(),
			"bondProgramId": solana.NewWallet().PublicKey().String(),
			"mint":          solana.NewWallet().PublicKey().String(),
			"mintProgramId": solana.TokenProgramID.String(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		SAT struct {
			ProgramID, BondProgramID, Mint, MintProgramID string
		} `json:"sat"`
	}
	if err := json.Unmarshal(manifest, &decoded); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifest)
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "sat-runtime.json")
	signaturePath := filepath.Join(dir, "sat-runtime.sig")
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest))), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FASED_SAT_PROGRAM_ID", decoded.SAT.ProgramID)
	t.Setenv("FASED_SAT_BOND_PROGRAM_ID", decoded.SAT.BondProgramID)
	t.Setenv("FASED_SAT_MINT_ADDRESS", decoded.SAT.Mint)
	t.Setenv("FASED_SAT_MINT_PROGRAM_ID", decoded.SAT.MintProgramID)
	t.Setenv("FASED_SAT_RUNTIME_MANIFEST_PATH", manifestPath)
	t.Setenv("FASED_SAT_RUNTIME_MANIFEST_SHA256", hex.EncodeToString(digest[:]))
	t.Setenv("FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH", signaturePath)
	t.Setenv("FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY", base64.RawURLEncoding.EncodeToString(publicKey))
}

func rotationCommitRequestForTestV2(rotation signerWalletRotationV2, sourcePolicyVersion uint64) signerWalletRotationCommitRequestV2 {
	return signerWalletRotationCommitRequestV2{
		RotationID:                     rotation.RotationID,
		SuccessorWalletID:              rotation.SuccessorWalletID,
		ExpectedSourcePublicKey:        rotation.SourcePublicKey,
		ExpectedSuccessorPublicKey:     rotation.SuccessorPublicKey,
		ExpectedSourceWalletVersion:    rotation.PrepareExpectedSourceWalletVersion,
		ExpectedSourcePolicyVersion:    sourcePolicyVersion,
		ExpectedSuccessorWalletVersion: 1,
		ExpectedSuccessorPolicyVersion: 1,
		ExpectedRotationVersion:        rotation.Version,
	}
}

func TestSignerSuccessorRotationIsDistinctAtomicIdempotentAndPermanentlyRetiresSource(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	source, sourcePolicy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1_000)

	create := signerWalletRotationCreateRequestV2{
		SuccessorWalletID:           "agent_successor_2026",
		ExpectedSourcePublicKey:     source.PublicKey,
		ExpectedSourceWalletVersion: source.Version,
		ExpectedSourcePolicyVersion: sourcePolicy.Version,
	}
	rotation, err := keys.CreateSuccessorRotation(source.WalletID, create)
	if err != nil {
		t.Fatalf("prepare signer-owned successor rotation: %v", err)
	}
	if rotation.State != signerWalletRotationPreparedV2 || rotation.Version != 1 ||
		rotation.SourcePublicKey != source.PublicKey || rotation.SuccessorPublicKey == source.PublicKey ||
		!strings.HasPrefix(rotation.RotationID, "sha256:") || rotation.Role != sourcePolicy.Role {
		t.Fatalf("unexpected prepared rotation: %#v", rotation)
	}
	encodedRotation, err := json.Marshal(rotation)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encodedRotation, []byte(`"secret"`)) || bytes.Contains(encodedRotation, []byte(`"nonce"`)) {
		t.Fatalf("public rotation metadata exposed encrypted key fields: %s", encodedRotation)
	}
	successorPolicy, err := store.getPolicy(rotation.SuccessorWalletID)
	if err != nil || successorPolicy.Role != sourcePolicy.Role || successorPolicy.Version != 1 || !signerPolicyIsDenyAllV2(successorPolicy) {
		t.Fatalf("successor did not start with the immutable role and deny-all policy: %#v err=%v", successorPolicy, err)
	}
	if sourceKey, _, err := keys.privateKey(source.WalletID); err != nil {
		t.Fatalf("prepared rotation retired source before owner commit: %v", err)
	} else {
		zeroBytes(sourceKey)
	}

	retry, err := keys.CreateSuccessorRotation(source.WalletID, create)
	if err != nil || retry != rotation {
		t.Fatalf("exact prepare retry was not idempotent: retry=%#v err=%v", retry, err)
	}
	different := create
	different.SuccessorWalletID = "different_successor"
	if _, err := keys.CreateSuccessorRotation(source.WalletID, different); err == nil || !strings.Contains(err.Error(), "different immutable") {
		t.Fatalf("source accepted a second successor binding: %v", err)
	}

	historical := signerOperationV2{
		RequestID:    "source-history-before-rotation",
		WalletID:     source.WalletID,
		IntentType:   intentSolanaNativeTransfer,
		IntentDigest: "sha256:" + strings.Repeat("1", 64),
		PolicyHash:   sourcePolicy.Hash,
		Asset:        "solana:native",
		Amount:       "1",
		State:        operationConfirmed,
		ReservedAt:   timestampV2(store.now()),
		UpdatedAt:    timestampV2(store.now()),
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		encoded, encodeErr := json.Marshal(historical)
		if encodeErr != nil {
			return encodeErr
		}
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(historical.RequestID), encoded)
	}); err != nil {
		t.Fatalf("store historical source operation: %v", err)
	}

	commitReq := rotationCommitRequestForTestV2(rotation, sourcePolicy.Version)
	stalePrivateKey, staleOriginal, err := keys.privateKey(source.WalletID)
	if err != nil {
		t.Fatalf("stage concurrent re-encryption fixture: %v", err)
	}
	staleReencrypted := staleOriginal
	staleReencrypted.Version++
	staleReencrypted.RotatedAt = timestampV2(store.now())
	if err := keys.encryptRecord(&staleReencrypted, stalePrivateKey); err != nil {
		zeroBytes(stalePrivateKey)
		t.Fatal(err)
	}
	zeroBytes(stalePrivateKey)
	wrongFence := commitReq
	wrongFence.ExpectedSuccessorWalletVersion++
	if _, err := keys.CommitSuccessorRotation(source.WalletID, wrongFence); err == nil || !strings.Contains(err.Error(), "successor wallet public key or version conflict") {
		t.Fatalf("rotation accepted a stale successor version fence: %v", err)
	}
	committed, err := keys.CommitSuccessorRotation(source.WalletID, commitReq)
	if err != nil {
		t.Fatalf("commit exact successor rotation: %v", err)
	}
	if err := keys.putReencryptedRecordV2(staleOriginal, staleReencrypted); err == nil || !strings.Contains(err.Error(), "permanently retired") {
		t.Fatalf("stale concurrent re-encryption overwrote committed retirement: %v", err)
	}
	if committed.State != signerWalletRotationCommittedV2 || committed.Version != 2 ||
		committed.SourceRetiredPolicyVersion != sourcePolicy.Version+1 || committed.SourceRetiredPolicyHash == "" ||
		committed.CommitFence == nil || committed.CommittedAt == "" {
		t.Fatalf("unexpected committed rotation: %#v", committed)
	}
	commitRetry, err := keys.CommitSuccessorRotation(source.WalletID, commitReq)
	if err != nil || commitRetry.State != signerWalletRotationCommittedV2 || commitRetry.Version != committed.Version {
		t.Fatalf("exact commit retry was not idempotent: %#v err=%v", commitRetry, err)
	}

	retiredSource, err := keys.PublicRecord(source.WalletID)
	if err != nil || retiredSource.RetiredAt == "" || retiredSource.SuccessorWalletID != rotation.SuccessorWalletID || retiredSource.RotationID != rotation.RotationID {
		t.Fatalf("source public retirement metadata is incomplete: %#v err=%v", retiredSource, err)
	}
	if _, _, err := keys.privateKey(source.WalletID); err == nil || !strings.Contains(err.Error(), "permanently retired") {
		t.Fatalf("retired source remained usable for signing: %v", err)
	}
	retiredPolicy, err := store.getPolicy(source.WalletID)
	if err != nil || !signerPolicyIsDenyAllV2(retiredPolicy) || retiredPolicy.Hash != committed.SourceRetiredPolicyHash {
		t.Fatalf("source was not atomically moved to deny-all: %#v err=%v", retiredPolicy, err)
	}
	if _, err := store.putPolicy(testSignerPolicyV2(source.WalletID, destination, 100, 1_000), retiredPolicy.Version); err == nil || !strings.Contains(err.Error(), "permanently deny-all") {
		t.Fatalf("owner policy put re-expanded a retired source: %v", err)
	}
	if _, err := store.tightenPolicy(retiredPolicy, retiredPolicy.Version); err == nil || !strings.Contains(err.Error(), "permanently deny-all") {
		t.Fatalf("application policy change mutated a retired source: %v", err)
	}
	if sourceHistory, err := store.getOperation(historical.RequestID); err != nil || sourceHistory.State != operationConfirmed || sourceHistory.WalletID != source.WalletID {
		t.Fatalf("historical source operation was not preserved for reconciliation: %#v err=%v", sourceHistory, err)
	}
	if successorKey, _, err := keys.privateKey(rotation.SuccessorWalletID); err != nil {
		t.Fatalf("successor key is not signer-owned and usable after atomic baseline activation: %v", err)
	} else {
		zeroBytes(successorKey)
	}
	activeSuccessor, err := store.getPolicy(rotation.SuccessorWalletID)
	if err != nil || activeSuccessor.Role != sourcePolicy.Role || activeSuccessor.BaselineVersion != signerRoleBaselineVersionV1 ||
		activeSuccessor.Version != successorPolicy.Version+1 || activeSuccessor.Hash != committed.SuccessorActivatedPolicyHash {
		t.Fatalf("successor role baseline was not activated atomically: %#v err=%v", activeSuccessor, err)
	}
	expandedSuccessor := testSignerPolicyV2(rotation.SuccessorWalletID, destination, 100, 1_000)
	if _, err := store.putPolicy(expandedSuccessor, successorPolicy.Version); err == nil || !strings.Contains(err.Error(), "version conflict") {
		t.Fatalf("stale successor policy expansion was accepted after commit: %v", err)
	}

	if err := store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerWalletsV2).Get([]byte(source.WalletID))
		var stored signerWalletRecordV2
		if err := json.Unmarshal(raw, &stored); err != nil {
			return err
		}
		if stored.Secret == "" || stored.Nonce == "" {
			return errors.New("retirement deleted the encrypted source key")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSignerSuccessorRotationCommitFailureIsAtomic(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	source, sourcePolicy := createTestSignerWalletV2(t, store, keys, "agent_atomic", destination, 100, 1_000)
	rotation, err := keys.CreateSuccessorRotation(source.WalletID, signerWalletRotationCreateRequestV2{
		SuccessorWalletID:           "agent_atomic_successor",
		ExpectedSourcePublicKey:     source.PublicKey,
		ExpectedSourceWalletVersion: source.Version,
		ExpectedSourcePolicyVersion: sourcePolicy.Version,
	})
	if err != nil {
		t.Fatal(err)
	}
	successorExpanded := testSignerPolicyV2(rotation.SuccessorWalletID, destination, 100, 1_000)
	if _, err := store.putPolicy(successorExpanded, 1); err != nil {
		t.Fatalf("prepare early successor policy expansion fixture: %v", err)
	}
	commit := rotationCommitRequestForTestV2(rotation, sourcePolicy.Version)
	commit.ExpectedSuccessorPolicyVersion = 2
	if _, err := keys.CommitSuccessorRotation(source.WalletID, commit); err == nil || !strings.Contains(err.Error(), "deny-all") {
		t.Fatalf("rotation committed an already-expanded successor: %v", err)
	}
	status, err := keys.SuccessorRotationStatus(source.WalletID)
	if err != nil || status.State != signerWalletRotationPreparedV2 || status.Version != 1 {
		t.Fatalf("failed commit mutated rotation state: %#v err=%v", status, err)
	}
	currentSource, err := keys.PublicRecord(source.WalletID)
	if err != nil || currentSource.RetiredAt != "" {
		t.Fatalf("failed commit retired source: %#v err=%v", currentSource, err)
	}
	currentSourcePolicy, err := store.getPolicy(source.WalletID)
	if err != nil || currentSourcePolicy.Hash != sourcePolicy.Hash || currentSourcePolicy.Version != sourcePolicy.Version {
		t.Fatalf("failed commit changed source policy: %#v err=%v", currentSourcePolicy, err)
	}
}

func TestSignerSuccessorRotationConcurrentExactRequestsConverge(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	source, policy := createTestSignerWalletV2(t, store, keys, "rotation_race", destination, 100, 1_000)
	create := signerWalletRotationCreateRequestV2{
		SuccessorWalletID:           "rotation_race_next",
		ExpectedSourcePublicKey:     source.PublicKey,
		ExpectedSourceWalletVersion: source.Version,
		ExpectedSourcePolicyVersion: policy.Version,
	}
	const workers = 8
	prepared := make(chan signerWalletRotationV2, workers)
	errorsSeen := make(chan error, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			rotation, err := keys.CreateSuccessorRotation(source.WalletID, create)
			if err != nil {
				errorsSeen <- err
				return
			}
			prepared <- rotation
		}()
	}
	wait.Wait()
	close(prepared)
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("concurrent exact prepare failed: %v", err)
	}
	var canonical signerWalletRotationV2
	count := 0
	for rotation := range prepared {
		if count == 0 {
			canonical = rotation
		} else if rotation.RotationID != canonical.RotationID || rotation.SuccessorPublicKey != canonical.SuccessorPublicKey {
			t.Fatalf("concurrent prepares created divergent successors: %#v / %#v", canonical, rotation)
		}
		count++
	}
	if count != workers {
		t.Fatalf("concurrent prepare results = %d, want %d", count, workers)
	}

	commit := rotationCommitRequestForTestV2(canonical, policy.Version)
	committed := make(chan signerWalletRotationV2, workers)
	commitErrors := make(chan error, workers)
	wait = sync.WaitGroup{}
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			rotation, err := keys.CommitSuccessorRotation(source.WalletID, commit)
			if err != nil {
				commitErrors <- err
				return
			}
			committed <- rotation
		}()
	}
	wait.Wait()
	close(committed)
	close(commitErrors)
	for err := range commitErrors {
		t.Fatalf("concurrent exact commit failed: %v", err)
	}
	count = 0
	for rotation := range committed {
		if rotation.State != signerWalletRotationCommittedV2 || rotation.Version != 2 || rotation.RotationID != canonical.RotationID {
			t.Fatalf("concurrent commit returned divergent state: %#v", rotation)
		}
		count++
	}
	if count != workers {
		t.Fatalf("concurrent commit results = %d, want %d", count, workers)
	}
}

func TestMiningRetirementRequiresEvidenceRecoveryNetworkAndReconciliation(t *testing.T) {
	configureTestSignerMiningRuntimeV1(t)
	store, keys := openTestSignerV2(t)
	source, sourcePolicy, err := keys.CreateWithRoleBaseline(
		"mining",
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "mining"},
		signerRoleBaselineRuntimeFromEnvV1(),
	)
	if err != nil {
		t.Fatalf("create role-ready Mining source: %v", err)
	}
	rotation, err := keys.CreateSuccessorRotation(source.WalletID, signerWalletRotationCreateRequestV2{
		SuccessorWalletID:           "mining_successor",
		ExpectedSourcePublicKey:     source.PublicKey,
		ExpectedSourceWalletVersion: source.Version,
		ExpectedSourcePolicyVersion: sourcePolicy.Version,
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedNetworkVersion := uint64(0)
	network, err := keys.PutNetworkV2(rotation.SuccessorWalletID, signerNetworkPutRequestV2{
		ExpectedVersion: &expectedNetworkVersion,
		PrimaryRPCURL:   "https://api.devnet.solana.com",
	})
	if err != nil {
		t.Fatalf("configure Mining successor network: %v", err)
	}
	evidence := signerMiningRetirementEvidenceV1{
		Version: 1, WalletID: source.WalletID, PublicKey: source.PublicKey,
		ObservedAt:     timestampV2(store.now()),
		NewJobsStopped: true, WorkersDrained: true, ClearingDrained: true, SubmissionsReconciled: true,
		SOLBalanceLamports: "42", SATBalanceRaw: "99",
		RuntimeStateHash:     "sha256:" + strings.Repeat("a", 64),
		SubmissionLedgerHash: "sha256:" + strings.Repeat("b", 64),
	}
	commit := rotationCommitRequestForTestV2(rotation, sourcePolicy.Version)
	if _, err := keys.CommitSuccessorRotation(source.WalletID, commit); err == nil || !strings.Contains(err.Error(), "requires recovery") {
		t.Fatalf("Mining retirement accepted missing recovery and safety evidence: %v", err)
	}
	commit.ExpectedSuccessorNetworkVersion = network.Version
	commit.ExpectedSuccessorNetworkHash = network.Hash
	commit.RecoveryPackageHash = "sha256:" + strings.Repeat("c", 64)
	commit.SafetyEvidence = &evidence
	staleEvidence := evidence
	staleEvidence.ObservedAt = timestampV2(store.now().Add(-6 * time.Minute))
	staleCommit := commit
	staleCommit.SafetyEvidence = &staleEvidence
	if _, err := keys.CommitSuccessorRotation(source.WalletID, staleCommit); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("Mining retirement accepted stale safety evidence: %v", err)
	}
	pending := signerOperationV2{
		RequestID: "mining-pending-before-retirement", WalletID: source.WalletID,
		IntentType: intentSolanaNativeTransfer, IntentDigest: "sha256:" + strings.Repeat("d", 64),
		PolicyHash: sourcePolicy.Hash, Asset: "solana:native", Amount: "1", State: operationUnknown,
		ReservedAt: timestampV2(store.now()), UpdatedAt: timestampV2(store.now()),
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		raw, encodeErr := json.Marshal(pending)
		if encodeErr != nil {
			return encodeErr
		}
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(pending.RequestID), raw)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.CommitSuccessorRotation(source.WalletID, commit); err == nil || !strings.Contains(err.Error(), "must be reconciled") {
		t.Fatalf("Mining retirement accepted an unknown signer operation: %v", err)
	}
	pending.State = operationFailed
	if err := store.db.Update(func(tx *bolt.Tx) error {
		raw, encodeErr := json.Marshal(pending)
		if encodeErr != nil {
			return encodeErr
		}
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(pending.RequestID), raw)
	}); err != nil {
		t.Fatal(err)
	}
	commitBody, err := json.Marshal(commit)
	if err != nil {
		t.Fatal(err)
	}
	encodedCommitted, err := (&signerServiceV2{store: store, keys: keys}).handle(request{
		Op: "v2.wallet.rotation.commit", WalletID: source.WalletID, Request: commitBody,
	}, signerConfig{}, true)
	if err != nil {
		t.Fatalf("commit safe Mining retirement through signer-owner authority: %v", err)
	}
	var envelope signerAdminResponse
	if err := json.Unmarshal(encodedCommitted, &envelope); err != nil || !envelope.OK {
		t.Fatalf("decode Mining retirement response envelope: %s err=%v", encodedCommitted, err)
	}
	var committed signerWalletRotationV2
	if err := json.Unmarshal(envelope.Result, &committed); err != nil {
		t.Fatal(err)
	}
	if committed.State != signerWalletRotationCommittedV2 || committed.SafetyEvidenceHash == "" ||
		committed.RecoveryPackageHash != commit.RecoveryPackageHash || committed.SafetyEvidence == nil {
		t.Fatalf("Mining retirement receipt evidence is incomplete: %#v", committed)
	}
	readiness, err := (&signerServiceV2{store: store, keys: keys}).walletReadinessV2(rotation.SuccessorWalletID)
	if err != nil || !readiness.Ready || readiness.Role != "mining" || readiness.OperationLane != "mining-typed-sat" {
		t.Fatalf("Mining successor is not ready after atomic retirement: %#v err=%v", readiness, err)
	}
}

func TestSignerSuccessorRotationOpsAreStrictAndControlOnly(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	source, policy := createTestSignerWalletV2(t, store, keys, "rotation_control", destination, 100, 1_000)
	service := &signerServiceV2{store: store, keys: keys}
	body, _ := json.Marshal(signerWalletRotationCreateRequestV2{
		SuccessorWalletID:           "rotation_control_next",
		ExpectedSourcePublicKey:     source.PublicKey,
		ExpectedSourceWalletVersion: source.Version,
		ExpectedSourcePolicyVersion: policy.Version,
	})
	createEnvelope := request{Op: "v2.wallet.rotation.create", WalletID: source.WalletID, Request: body}
	if _, err := service.handle(createEnvelope, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket reached successor creation: %v", err)
	}
	unknown := append([]byte{}, body[:len(body)-1]...)
	unknown = append(unknown, []byte(`,"unexpected":true}`)...)
	if _, err := service.handle(requestWithBodyV2(createEnvelope, unknown), signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "invalid signer-v2 request") {
		t.Fatalf("rotation create accepted an unknown request field: %v", err)
	}
	if _, err := service.handle(createEnvelope, signerConfig{}, true); err != nil {
		t.Fatalf("control socket could not prepare successor rotation: %v", err)
	}
	if _, err := service.handle(request{Op: "v2.wallet.rotation.status", WalletID: source.WalletID}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket reached rotation status: %v", err)
	}
}

func requestWithBodyV2(req request, body json.RawMessage) request {
	req.Request = body
	return req
}
