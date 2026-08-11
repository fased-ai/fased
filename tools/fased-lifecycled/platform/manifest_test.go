package platform

import (
	"context"
	"testing"

	"fased-lifecycled/model"
)

const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const commitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const commitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type fakeManifestStore struct {
	manifest model.Manifest
	expected string
	calls    int
}

func (store *fakeManifestStore) CommitManifest(manifest model.Manifest, expected string) (string, error) {
	store.manifest, store.expected = manifest, expected
	store.calls++
	return digestB, nil
}

func manifestTransaction(t *testing.T, fresh bool) (model.Transaction, model.PlatformIdentity) {
	t.Helper()
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	platformDigest, _ := identity.Digest(model.ProfileProtectedLocal)
	var previous *model.Generation
	manifestDigest := absentManifestDigest
	if !fresh {
		value := model.Generation{ID: digestA, Version: "0.1.75", Commit: commitA, Tree: commitA, ArtifactSetDigest: digestA}
		previous, manifestDigest = &value, digestA
	}
	capabilities := model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1}, Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator: model.CapabilityRange{Min: 1, Max: 1}, Signer: model.CapabilityRange{Min: 1, Max: 1},
	}
	action := "UPDATE"
	if fresh {
		action = "INSTALL"
	}
	return model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: "018f47d2-5a6b-7c8d-9e0f-123456789abc", Profile: model.ProfileProtectedLocal, PlanAction: action,
		ReleaseSequence: 12, SecurityEpoch: 3,
		Phase: model.PhaseVerified, Revision: 5,
		Target:             model.Generation{ID: digestB, Version: "0.1.76", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB},
		TargetStateSchemas: map[string]uint32{"signer": 2}, TargetCapabilities: capabilities, Previous: previous,
		ManifestDigest: manifestDigest, StateInventoryDigest: digestA, MigrationPlanDigest: digestB,
		SignerPlanDigest: digestA, PlatformDigest: platformDigest,
	}, identity
}

func TestManifestCommitterCreatesCanonicalFreshAndUpdateRecords(t *testing.T) {
	for _, fresh := range []bool{true, false} {
		t.Run(map[bool]string{true: "fresh", false: "update"}[fresh], func(t *testing.T) {
			tx, identity := manifestTransaction(t, fresh)
			store := &fakeManifestStore{}
			committer := ManifestCommitter{Store: store, Identity: identity}
			if err := committer.Commit(context.Background(), tx); err != nil {
				t.Fatal(err)
			}
			wantExpected := tx.ManifestDigest
			if fresh {
				wantExpected = ""
			}
			if store.calls != 1 || store.expected != wantExpected || store.manifest.ActiveGeneration.ID != digestB || store.manifest.Platform.ConfigurationDigest == "" || store.manifest.ReleaseSequence != tx.ReleaseSequence || store.manifest.SecurityEpoch != tx.SecurityEpoch {
				t.Fatalf("unexpected committed manifest: %+v expected=%q calls=%d", store.manifest, store.expected, store.calls)
			}
		})
	}
}

func TestManifestCommitterRejectsPlatformSubstitution(t *testing.T) {
	tx, identity := manifestTransaction(t, false)
	identity.ConfigurationDigest = digestA
	store := &fakeManifestStore{}
	if err := (&ManifestCommitter{Store: store, Identity: identity}).Commit(context.Background(), tx); err == nil {
		t.Fatal("platform substitution was accepted")
	}
	if store.calls != 0 {
		t.Fatal("platform mismatch reached manifest mutation")
	}
}
