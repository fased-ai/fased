package main

import (
	"strings"
	"testing"
)

func TestSignerReleaseIdentityDistinguishesDevelopmentAndReleaseBuilds(t *testing.T) {
	development, err := resolveSignerReleaseIdentityV2("dev", "unknown", "unknown", "true")
	if err != nil || !development.Development {
		t.Fatalf("explicit development identity was rejected: %#v err=%v", development, err)
	}

	commit := strings.Repeat("a", 40)
	digest := "sha256:" + strings.Repeat("b", 64)
	release, err := resolveSignerReleaseIdentityV2("0.1.63", commit, digest, "false")
	if err != nil || release.Development || release.Commit != commit || release.BuildInputDigest != digest {
		t.Fatalf("stamped release identity was rejected: %#v err=%v", release, err)
	}
	formatted := formatSignerVersionV2(release)
	for _, expected := range []string{"fased-signerd 0.1.63", "commit=" + commit, "buildInputDigest=" + digest, "development=false"} {
		if !strings.Contains(formatted, expected) {
			t.Fatalf("version output %q is missing %q", formatted, expected)
		}
	}
}

func TestSignerReleaseIdentityFailsClosedOnPartialOrMalformedReleaseStamps(t *testing.T) {
	commit := strings.Repeat("a", 40)
	digest := "sha256:" + strings.Repeat("b", 64)
	for _, input := range [][4]string{
		{"", commit, digest, "false"},
		{"0.1.63", "unknown", digest, "false"},
		{"0.1.63", commit, "unknown", "false"},
		{"0.1.63", commit, digest, "not-a-bool"},
		{"version-0.1.63", commit, digest, "false"},
		{"0.1.63", strings.Repeat("A", 40), digest, "false"},
	} {
		if _, err := resolveSignerReleaseIdentityV2(input[0], input[1], input[2], input[3]); err == nil {
			t.Fatalf("invalid signer release stamp was accepted: %#v", input)
		}
	}
}
