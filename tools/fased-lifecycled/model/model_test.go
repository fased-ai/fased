package model

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	testDigestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testDigestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testCommitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testCommitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func testGeneration(id, version, commit, tree, artifacts string) Generation {
	return Generation{
		ID:                id,
		Version:           version,
		Commit:            commit,
		Tree:              tree,
		ArtifactSetDigest: artifacts,
	}
}

func testCapabilities() CapabilityRanges {
	return CapabilityRanges{
		Supervisor: CapabilityRange{Min: 1, Max: 2},
		Controller: CapabilityRange{Min: 2, Max: 4},
		Migrator:   CapabilityRange{Min: 1, Max: 1},
		Signer:     CapabilityRange{Min: 2, Max: 3},
	}
}

func testPlatform(profile Profile) PlatformIdentity {
	platform, _ := NewPlatformIdentity(profile, "test-instance", testDigestA)
	return platform
}

func testTransaction(phase Phase) Transaction {
	previous := testGeneration(testDigestA, "0.1.75", testCommitA, testCommitA, testDigestA)
	platform := testPlatform(ProfileProtectedLocal)
	platformDigest, _ := platform.Digest(ProfileProtectedLocal)
	return Transaction{
		SchemaVersion:             CurrentTransactionSchemaVersion,
		ID:                        "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		Profile:                   ProfileProtectedLocal,
		PlanAction:                "UPDATE",
		ReleaseSequence:           12,
		SecurityEpoch:             3,
		ReleaseIndexDigest:        testDigestA,
		ReleaseAuthorityDigest:    testDigestB,
		TargetManifestProtocolMin: 1,
		TargetManifestProtocolMax: 2,
		PredecessorManifestSchema: CurrentManifestSchemaVersion,
		PredecessorPlatform:       &platform,
		Phase:                     phase,
		Revision:                  1,
		Target:                    testGeneration(testDigestB, "0.1.76", testCommitB, testCommitB, testDigestB),
		TargetStateSchemas:        map[string]uint32{"signer": 2},
		TargetCapabilities:        testCapabilities(),
		Previous:                  &previous,
		ManifestDigest:            testDigestA,
		StateInventoryDigest:      testDigestB,
		MigrationPlanDigest:       testDigestA,
		SignerPlanDigest:          testDigestB,
		PlatformDigest:            platformDigest,
	}
}

func TestReleaseAuthorityIsRequiredAndEnvelopeBound(t *testing.T) {
	tx := testTransaction(PhaseIdle)
	tx.ReleaseSequence = 0
	if err := tx.Validate(); err == nil {
		t.Fatal("transaction without release sequence was accepted")
	}
	tx.ReleaseSequence = 12
	tx.SecurityEpoch = 0
	if err := tx.Validate(); err == nil {
		t.Fatal("transaction without security epoch was accepted")
	}
	tx.SecurityEpoch = 3
	envelope, err := tx.Envelope()
	if err != nil {
		t.Fatal(err)
	}
	if envelope.ReleaseSequence != 12 || envelope.SecurityEpoch != 3 || envelope.ReleaseIndexDigest != testDigestA || envelope.ReleaseAuthorityDigest != testDigestB || envelope.PredecessorManifestSchema != CurrentManifestSchemaVersion || envelope.PredecessorPlatform == nil {
		t.Fatalf("envelope lost monotonic authority: %+v", envelope)
	}
}

func TestInstalledManifestStrictlyDecodesSchemaOneWithoutInventingAuthority(t *testing.T) {
	active := testGeneration(testDigestA, "0.1.76-rc.72", testCommitA, testCommitA, testDigestA)
	legacyPlatform, err := LegacyControllerPlatformIdentity(ProfileProtectedLocal, "test-instance", testDigestA)
	if err != nil {
		t.Fatal(err)
	}
	legacy := manifestSchemaOne{SchemaVersion: 1, Profile: ProfileProtectedLocal, Platform: legacyPlatform, ActiveGeneration: &active,
		StateSchemas: CurrentStateSchemas(), Capabilities: testCapabilities()}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := DecodeInstalledManifest(strings.NewReader(string(data)))
	if err != nil || manifest.SchemaVersion != 1 || manifest.ReleaseSequence != 0 || manifest.SecurityEpoch != 0 || manifest.ActiveGeneration == nil || manifest.ActiveGeneration.ID != active.ID {
		t.Fatalf("schema-one manifest was not decoded exactly: %+v err=%v", manifest, err)
	}
	if _, err := DecodeManifest(strings.NewReader(string(data))); err == nil {
		t.Fatal("schema-one predecessor was accepted as a current canonical manifest")
	}
	var rebound map[string]any
	if err := json.Unmarshal(data, &rebound); err != nil {
		t.Fatal(err)
	}
	rebound["releaseSequence"] = 72
	reboundData, _ := json.Marshal(rebound)
	if _, err := DecodeInstalledManifest(strings.NewReader(string(reboundData))); err == nil {
		t.Fatal("schema-one manifest accepted invented release authority")
	}
}

func TestRollbackAuthorizationIsShortLivedAndExactlyBound(t *testing.T) {
	now := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	authorization := RollbackAuthorization{
		SchemaVersion: 1, CurrentGenerationID: testDigestB, TargetGenerationID: testDigestA,
		CurrentReleaseSequence: 12, TargetReleaseSequence: 11, SecurityEpoch: 3,
		Operator: "founder", Reason: "restore known-good generation",
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(4 * time.Minute).Format(time.RFC3339),
		EnvelopeDigest: testDigestA,
	}
	if err := authorization.ValidateAt(now); err != nil {
		t.Fatalf("valid rollback authorization rejected: %v", err)
	}
	changed := authorization
	changed.TargetGenerationID = testDigestB
	if err := changed.ValidateAt(now); err == nil {
		t.Fatal("rebound rollback authorization was accepted")
	}
	expired := authorization
	expired.ExpiresAt = now.Add(-time.Second).Format(time.RFC3339)
	if err := expired.ValidateAt(now); err == nil {
		t.Fatal("expired rollback authorization was accepted")
	}
}

func TestAdvanceUsesOneFixedStateMachine(t *testing.T) {
	phases := []Phase{PhaseIdle, PhaseStaged, PhasePrepared, PhaseSwitched, PhaseVerified, PhaseCommitted, PhaseRolledBack}
	allowed := map[Phase]map[Phase]bool{
		PhaseIdle:     {PhaseStaged: true, PhaseRolledBack: true},
		PhaseStaged:   {PhasePrepared: true, PhaseRolledBack: true},
		PhasePrepared: {PhaseSwitched: true, PhaseRolledBack: true},
		PhaseSwitched: {PhaseVerified: true, PhaseRolledBack: true},
		PhaseVerified: {PhaseCommitted: true},
	}

	for _, from := range phases {
		for _, to := range phases {
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				tx := testTransaction(from)
				got, err := Advance(tx, to)
				if from == to {
					if err != nil || !reflect.DeepEqual(got, tx) {
						t.Fatalf("idempotent transition changed transaction: got=%+v err=%v", got, err)
					}
					return
				}
				if allowed[from][to] {
					if err != nil {
						t.Fatalf("allowed transition failed: %v", err)
					}
					if got.Phase != to || got.Revision != tx.Revision+1 {
						t.Fatalf("unexpected transition result: %+v", got)
					}
					if got.ID != tx.ID || got.Target != tx.Target || got.Previous != tx.Previous {
						t.Fatalf("transition changed immutable identity: before=%+v after=%+v", tx, got)
					}
					return
				}
				if err == nil {
					t.Fatalf("illegal transition unexpectedly succeeded: %+v", got)
				}
			})
		}
	}
}

func TestPublicBridgeVersionIsRequiredAndEnvelopeBound(t *testing.T) {
	tx := testTransaction(PhaseIdle)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	tx.Previous = nil
	tx.PredecessorManifestSchema = 0
	tx.PredecessorPlatform = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	if err := tx.Validate(); err == nil {
		t.Fatal("bridge without public predecessor version was accepted")
	}
	tx.PublicPredecessorVersion = "0.1.75"
	envelope, err := tx.Envelope()
	if err != nil {
		t.Fatal(err)
	}
	if envelope.PublicPredecessorVersion != tx.PublicPredecessorVersion {
		t.Fatalf("envelope lost public predecessor version: %+v", envelope)
	}
	envelope.PublicPredecessorVersion = "0.1.74"
	if err := envelope.Validate(); err != nil {
		t.Fatalf("valid semantic evidence should remain structurally valid: %v", err)
	}
}

func TestRecoveryDecisionIsDeterministicForEveryPhase(t *testing.T) {
	tests := map[Phase]RecoveryDecision{
		PhaseIdle:       {Action: RecoveryDiscardStaged, Result: PhaseRolledBack},
		PhaseStaged:     {Action: RecoveryDiscardStaged, Result: PhaseRolledBack},
		PhasePrepared:   {Action: RecoveryAbortPrepared, Result: PhaseRolledBack},
		PhaseSwitched:   {Action: RecoveryRestorePrevious, Result: PhaseRolledBack},
		PhaseVerified:   {Action: RecoveryCompleteCommit, Result: PhaseCommitted},
		PhaseCommitted:  {Action: RecoveryAlreadyCurrent, Result: PhaseCommitted},
		PhaseRolledBack: {Action: RecoveryRetryAllowed, Result: PhaseRolledBack},
	}
	for phase, want := range tests {
		t.Run(string(phase), func(t *testing.T) {
			got, err := Recover(testTransaction(phase))
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("got %+v, want %+v", got, want)
			}
		})
	}
}

func TestManifestRejectsUnknownNewerAndAmbiguousState(t *testing.T) {
	active := testGeneration(testDigestB, "0.1.76", testCommitB, testCommitB, testDigestB)
	previous := testGeneration(testDigestA, "0.1.75", testCommitA, testCommitA, testDigestA)
	valid := Manifest{
		SchemaVersion:      CurrentManifestSchemaVersion,
		Profile:            ProfileProtectedLocal,
		Platform:           testPlatform(ProfileProtectedLocal),
		ActiveGeneration:   &active,
		PreviousGeneration: &previous,
		StateSchemas:       map[string]uint32{"walletRegistry": 1, "signer": 2},
		Capabilities:       testCapabilities(),
		ReleaseSequence:    12,
		SecurityEpoch:      3,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}

	newer := valid
	newer.SchemaVersion++
	if err := newer.Validate(); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("newer schema did not fail closed: %v", err)
	}

	ambiguous := valid
	ambiguous.ActiveGeneration = nil
	if err := ambiguous.Validate(); err == nil {
		t.Fatal("previous generation without active generation was accepted")
	}

	same := valid
	same.PreviousGeneration = &active
	if err := same.Validate(); err == nil {
		t.Fatal("identical active and previous generations were accepted")
	}
}

func TestPlatformIdentityUsesThreeServicesAndReadsLegacyControllerTopology(t *testing.T) {
	current, err := NewPlatformIdentity(ProfileProtectedLocal, "test-instance", testDigestA)
	if err != nil {
		t.Fatal(err)
	}
	if current.Adapter != "linux-systemd-local-v2" || len(current.Services) != 3 || current.Services["controller"] != "" {
		t.Fatalf("new platform still exposes a controller worker: %+v", current)
	}
	legacy, err := LegacyControllerPlatformIdentity(ProfileProtectedLocal, "test-instance", testDigestA)
	if err != nil || !legacy.IsLegacyControllerWorker(ProfileProtectedLocal) || legacy.Services["controller"] == "" {
		t.Fatalf("legacy controller topology is not readable for bridge discovery: %+v err=%v", legacy, err)
	}
}

func TestStrictJSONRejectsProcessIdentityAndTrailingData(t *testing.T) {
	manifest := `{
		"schemaVersion":1,
		"profile":"protected-local",
		"platform":{"adapter":"linux-systemd-local-v1","instanceId":"test-instance","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","services":{"controller":"fased-local-controller-worker-test-instance.service","gateway":"fased-gateway-test-instance.service","signer":"fased-signerd-test-instance.service","supervisor":"fased-local-controller-test-instance.service"}},
		"stateSchemas":{"signer":1},
		"capabilities":{
			"supervisor":{"min":1,"max":1},
			"controller":{"min":1,"max":1},
			"migrator":{"min":1,"max":1},
			"signer":{"min":1,"max":1}
		},
		"pid":123
	}`
	if _, err := DecodeManifest(strings.NewReader(manifest)); err == nil {
		t.Fatal("durable process identity was accepted")
	}

	valid := `{
		"schemaVersion":1,
		"profile":"protected-local",
		"platform":{"adapter":"linux-systemd-local-v1","instanceId":"test-instance","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","services":{"controller":"fased-local-controller-worker-test-instance.service","gateway":"fased-gateway-test-instance.service","signer":"fased-signerd-test-instance.service","supervisor":"fased-local-controller-test-instance.service"}},
		"stateSchemas":{"signer":1},
		"capabilities":{
			"supervisor":{"min":1,"max":1},
			"controller":{"min":1,"max":1},
			"migrator":{"min":1,"max":1},
			"signer":{"min":1,"max":1}
		}
	}`
	if _, err := DecodeManifest(strings.NewReader(valid + `{}`)); err == nil {
		t.Fatal("trailing JSON was accepted")
	}
}

func TestCanonicalManifestJSONIsIndependentOfMapInsertionOrder(t *testing.T) {
	first := Manifest{
		SchemaVersion:   CurrentManifestSchemaVersion,
		Profile:         ProfileProtectedLocal,
		Platform:        testPlatform(ProfileProtectedLocal),
		StateSchemas:    map[string]uint32{"walletRegistry": 1, "signer": 2},
		Capabilities:    testCapabilities(),
		ReleaseSequence: 12,
		SecurityEpoch:   3,
	}
	second := first
	second.StateSchemas = map[string]uint32{"signer": 2, "walletRegistry": 1}
	firstJSON, err := CanonicalManifestJSON(first)
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := CanonicalManifestJSON(second)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("canonical manifests differ:\n%s\n%s", firstJSON, secondJSON)
	}
}

func TestValidationRejectsMalformedIdentityAndCapabilities(t *testing.T) {
	manifest := Manifest{
		SchemaVersion: CurrentManifestSchemaVersion,
		Profile:       ProfileHosting,
		Platform:      testPlatform(ProfileHosting),
		StateSchemas:  map[string]uint32{"signer": 1},
		Capabilities:  testCapabilities(),
	}
	badGeneration := testGeneration("not-a-digest", "0.1.76", testCommitB, testCommitB, testDigestB)
	manifest.ActiveGeneration = &badGeneration
	if err := manifest.Validate(); err == nil {
		t.Fatal("malformed generation digest was accepted")
	}

	manifest.ActiveGeneration = nil
	manifest.Capabilities.Controller = CapabilityRange{Min: 3, Max: 2}
	if err := manifest.Validate(); err == nil {
		t.Fatal("inverted capability range was accepted")
	}
}

func TestTransactionRejectsUnknownSchemaAndInvalidBinding(t *testing.T) {
	tx := testTransaction(PhasePrepared)
	if err := tx.Validate(); err != nil {
		t.Fatalf("valid transaction rejected: %v", err)
	}

	tx.SchemaVersion++
	if err := tx.Validate(); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("newer transaction schema did not fail closed: %v", err)
	}

	tx = testTransaction(PhasePrepared)
	tx.ManifestDigest = "bad"
	if err := tx.Validate(); err == nil {
		t.Fatal("invalid manifest binding was accepted")
	}
}
