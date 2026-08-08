package platform

import (
	"context"
	"errors"

	"fased-lifecycled/model"
)

const absentManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

type ManifestStore interface {
	CommitManifest(model.Manifest, string) (string, error)
}

type ManifestCommitter struct {
	Store    ManifestStore
	Identity model.PlatformIdentity
}

func (committer *ManifestCommitter) Commit(ctx context.Context, tx model.Transaction) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if committer == nil || committer.Store == nil {
		return errors.New("installation manifest store is unavailable")
	}
	digest, err := committer.Identity.Digest(tx.Profile)
	if err != nil {
		return err
	}
	if digest != tx.PlatformDigest {
		return errors.New("installation platform identity does not match transaction")
	}
	manifest := model.Manifest{
		SchemaVersion: model.CurrentManifestSchemaVersion, Profile: tx.Profile, Platform: committer.Identity,
		ActiveGeneration: &tx.Target, PreviousGeneration: tx.Previous,
		StateSchemas: copySchemas(tx.TargetStateSchemas), Capabilities: tx.TargetCapabilities,
	}
	expected := tx.ManifestDigest
	if expected == absentManifestDigest {
		expected = ""
	}
	_, err = committer.Store.CommitManifest(manifest, expected)
	return err
}

func copySchemas(source map[string]uint32) map[string]uint32 {
	result := make(map[string]uint32, len(source))
	for name, version := range source {
		result[name] = version
	}
	return result
}
