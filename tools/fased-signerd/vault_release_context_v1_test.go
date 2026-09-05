package main

import (
	"strings"
	"testing"
)

func TestVaultReleaseContextV1Disabled(t *testing.T) {
	oldV, oldC, oldD, oldDev := signerBuildVersion, signerBuildCommit, signerBuildInputDigest, signerBuildDevelopment
	t.Cleanup(func() {
		signerBuildVersion, signerBuildCommit, signerBuildInputDigest, signerBuildDevelopment = oldV, oldC, oldD, oldDev
	})
	signerBuildVersion, signerBuildCommit, signerBuildInputDigest, signerBuildDevelopment = "dev", "unknown", "unknown", "true"
	if _, err := signerVaultReleaseContextV1("devnet", "test-genesis"); err == nil || !strings.Contains(err.Error(), "development") {
		t.Fatalf("development accepted: %v", err)
	}
	signerBuildVersion, signerBuildCommit, signerBuildInputDigest, signerBuildDevelopment = "0.1.0", strings.Repeat("a", 40), "sha256:"+strings.Repeat("b", 64), "false"
	// Release stamps alone cannot enable a deployment, nor can environment input.
	t.Setenv("FASED_VAULT_DEPLOYMENT_ENABLED", "true")
	for _, cluster := range []string{"devnet", "mainnet-beta", "testnet", ""} {
		if _, err := signerVaultReleaseContextV1(cluster, "test-genesis"); err == nil {
			t.Fatalf("enabled %s without finalized pins", cluster)
		}
	}
	if err := verifySignerVaultDeploymentV1("devnet", "test-genesis", signerOwnedAccountSnapshotV2{}, signerOwnedAccountSnapshotV2{}, 1); err == nil {
		t.Fatal("verified absent deployment")
	}
}
