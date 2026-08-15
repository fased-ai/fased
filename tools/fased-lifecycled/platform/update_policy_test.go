package platform

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
)

func updatePolicyConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		Profile: model.ProfileProtectedLocal, InstanceID: "0123456789abcdef",
		LifecycleRoot: filepath.Join(t.TempDir(), "lifecycle"),
	}
}

func TestUpdatePolicyIsRootOwnedVersionedAndIdempotent(t *testing.T) {
	config := updatePolicyConfig(t)
	owner := uint32(os.Geteuid())
	if _, err := readUpdatePolicyAt(config.UpdatePolicyPath(), owner, config.Profile, config.InstanceID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing update policy did not remain distinguishable: %v", err)
	}
	replacement, changed, err := installUpdatePolicyTransactionalAt(config.UpdatePolicyPath(), owner, config.Profile, config.InstanceID, "beta")
	if err != nil || !changed {
		t.Fatalf("initial update policy installation failed: changed=%v err=%v", changed, err)
	}
	replacement.Commit()
	policy, err := readUpdatePolicyAt(config.UpdatePolicyPath(), owner, config.Profile, config.InstanceID)
	if err != nil || policy.Channel != "beta" || policy.Profile != config.Profile || policy.InstanceID != config.InstanceID {
		t.Fatalf("installed update policy is not bound to its platform: policy=%+v err=%v", policy, err)
	}
	infoBefore, err := os.Stat(config.UpdatePolicyPath())
	if err != nil {
		t.Fatal(err)
	}
	replacement, changed, err = installUpdatePolicyTransactionalAt(config.UpdatePolicyPath(), owner, config.Profile, config.InstanceID, "beta")
	if err != nil || changed {
		t.Fatalf("identical update policy was treated as a mutation: changed=%v err=%v", changed, err)
	}
	replacement.Commit()
	infoAfter, err := os.Stat(config.UpdatePolicyPath())
	if err != nil || !os.SameFile(infoBefore, infoAfter) || !infoAfter.ModTime().Equal(infoBefore.ModTime()) {
		t.Fatalf("identical policy changed file identity or timestamp: before=%v after=%v err=%v", infoBefore, infoAfter, err)
	}
}

func TestUpdatePolicyRejectsUnknownChannelWithoutMutation(t *testing.T) {
	config := updatePolicyConfig(t)
	if _, _, err := installUpdatePolicyTransactionalAt(config.UpdatePolicyPath(), uint32(os.Geteuid()), config.Profile, config.InstanceID, "nightly"); err == nil {
		t.Fatal("unknown update channel was accepted")
	}
	if _, err := os.Lstat(config.UpdatePolicyPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid policy input mutated the lifecycle root: %v", err)
	}
}
