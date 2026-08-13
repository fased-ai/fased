// Command fased-branch-trust creates deterministic, explicitly non-publishable
// trust metadata for an exact branch artifact. It is an acceptance-fixture
// utility and is never shipped in a release.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/trust"
)

type inventory struct {
	PluginLockDigest string                 `json:"pluginLockDigest"`
	StateSchemas     map[string]uint32      `json:"stateSchemas"`
	Capabilities     model.CapabilityRanges `json:"capabilities"`
}

type fixtureKey struct {
	id      string
	record  trust.Key
	private ed25519.PrivateKey
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "fased-branch-trust:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("fased-branch-trust", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var artifactDir, inventoryPath, version, commit, tree, artifactSetDigest, issuedText string
	var releaseSequence, securityEpoch uint64
	flags.StringVar(&artifactDir, "artifact-dir", "", "")
	flags.StringVar(&inventoryPath, "inventory", "", "")
	flags.StringVar(&version, "version", "", "")
	flags.StringVar(&commit, "commit", "", "")
	flags.StringVar(&tree, "tree", "", "")
	flags.StringVar(&artifactSetDigest, "artifact-set-digest", "", "")
	flags.StringVar(&issuedText, "issued-at", "", "")
	flags.Uint64Var(&releaseSequence, "release-sequence", 1, "")
	flags.Uint64Var(&securityEpoch, "security-epoch", 1, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("invalid arguments")
	}
	if artifactDir == "" || inventoryPath == "" || version == "" || commit == "" || tree == "" || artifactSetDigest == "" || issuedText == "" || releaseSequence == 0 || securityEpoch == 0 {
		return errors.New("all identity arguments are required")
	}
	issued, err := time.Parse(time.RFC3339Nano, issuedText)
	if err != nil {
		return errors.New("issued-at is invalid")
	}
	var inv inventory
	data, err := os.ReadFile(inventoryPath)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &inv); err != nil {
		return err
	}
	rootKeys := []fixtureKey{fixtureKeyFor(commit, "root-1"), fixtureKeyFor(commit, "root-2"), fixtureKeyFor(commit, "root-3")}
	releaseKey := fixtureKeyFor(commit, "release")
	root := trust.RootMetadata{SchemaVersion: 1, Type: "fased-lifecycle-root", Version: 1,
		IssuedAt: issued.Format(time.RFC3339), ExpiresAt: issued.Add(30 * 24 * time.Hour).Format(time.RFC3339),
		Keys: map[string]trust.Key{}, Root: trust.RootRole{Threshold: 2},
		ReleaseAuthority: &trust.ReleaseAuthority{Type: "github-artifact-attestation-v1", Repository: "fased-ai/fased", Workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml", SourceRefPrefix: "refs/tags/v", DenySelfHostedRunners: true},
		Revocations:      trust.Revocations{ReleaseVersions: []string{}, TargetDigests: []string{}, DelegatedKeyIDs: []string{}}}
	for _, key := range rootKeys {
		root.Keys[key.id] = key.record
		root.Root.KeyIDs = append(root.Root.KeyIDs, key.id)
	}
	sortStrings(root.Root.KeyIDs)
	rootJSON, err := trust.SignRoot(root, signingKeys(rootKeys[:2]))
	if err != nil {
		return err
	}
	delegationJSON, err := trust.SignDelegation(trust.Delegation{SchemaVersion: 1, Type: "fased-release-delegation", Version: 1,
		IssuedAt: issued.Format(time.RFC3339), ExpiresAt: issued.Add(24 * time.Hour).Format(time.RFC3339),
		KeyID: releaseKey.id, Key: releaseKey.record, Channels: []string{"beta"}, MinReleaseSequence: releaseSequence, MaxReleaseSequence: releaseSequence, SecurityEpoch: securityEpoch}, signingKeys(rootKeys[:2]))
	if err != nil {
		return err
	}
	application, err := asset(artifactDir, "fased-generation-linux-x64-v"+version+".tar.gz")
	if err != nil {
		return err
	}
	dependencyName, err := exactlyOne(artifactDir, "fased-hosted-deps-linux-x64-", ".tar.gz")
	if err != nil {
		return err
	}
	dependency, err := asset(artifactDir, dependencyName)
	if err != nil {
		return err
	}
	host, err := asset(artifactDir, "fased-lifecycled-linux-amd64")
	if err != nil {
		return err
	}
	host.PrivilegedComponent = "lifecycle-host"
	host.Protocols = &trust.HostProtocols{Manifest: trust.ProtocolRange{Min: 1, Max: 2}, Journal: trust.ProtocolRange{Min: 1, Max: 1}, Participant: trust.ProtocolRange{Min: 1, Max: 1}, Platform: trust.ProtocolRange{Min: 1, Max: 2}}
	signer, err := asset(artifactDir, "fased-signerd-linux-amd64")
	if err != nil {
		return err
	}
	indexJSON, err := trust.SignReleaseIndex(trust.ReleaseIndex{SchemaVersion: 1, Type: "fased-release-index", Channel: "beta", Version: version,
		ReleaseSequence: releaseSequence, SecurityEpoch: securityEpoch, Commit: commit, Tree: tree, ArtifactSetDigest: artifactSetDigest,
		Application: map[string]trust.Asset{"x64": application}, DependencyLayer: map[string]trust.Asset{"x64": dependency},
		LifecycleHost: map[string]trust.Asset{"x64": host}, Signer: map[string]trust.Asset{"x64": signer},
		StateSchemas: inv.StateSchemas, Capabilities: inv.Capabilities, PluginLockDigest: inv.PluginLockDigest,
		IssuedAt: issued.Format(time.RFC3339), ExpiresAt: issued.Add(23 * time.Hour).Format(time.RFC3339)}, trust.SigningKey{KeyID: releaseKey.id, PrivateKey: releaseKey.private})
	if err != nil {
		return err
	}
	for name, body := range map[string][]byte{"fased-branch-root.json": rootJSON, "fased-branch-delegation.json": delegationJSON, "fased-branch-release-index.json": indexJSON} {
		if err := os.WriteFile(filepath.Join(artifactDir, name), body, 0644); err != nil {
			return err
		}
	}
	pin := sha256.Sum256(rootJSON)
	return os.WriteFile(filepath.Join(artifactDir, "fased-branch-root.sha256"), []byte(hex.EncodeToString(pin[:])+"\n"), 0644)
}

func fixtureKeyFor(commit, role string) fixtureKey {
	seed := sha256.Sum256([]byte("FASED NONPUBLISHABLE BRANCH FIXTURE TRUST v1\x00" + commit + "\x00" + role))
	private := ed25519.NewKeyFromSeed(seed[:])
	public := private.Public().(ed25519.PublicKey)
	der, _ := x509.MarshalPKIXPublicKey(public)
	id := sha256.Sum256(der)
	return fixtureKey{id: hex.EncodeToString(id[:]), record: trust.Key{KeyType: "ed25519", Scheme: "ed25519", PublicKey: base64.StdEncoding.EncodeToString(der)}, private: private}
}

func signingKeys(keys []fixtureKey) []trust.SigningKey {
	result := make([]trust.SigningKey, 0, len(keys))
	for _, key := range keys {
		result = append(result, trust.SigningKey{KeyID: key.id, PrivateKey: key.private})
	}
	return result
}

func asset(dir, name string) (trust.Asset, error) {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return trust.Asset{}, err
	}
	sum := sha256.Sum256(data)
	return trust.Asset{Name: name, Size: uint64(len(data)), SHA256: "sha256:" + hex.EncodeToString(sum[:])}, nil
}

func exactlyOne(dir, prefix, suffix string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	match := ""
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && filepath.Ext(name) != "" && len(name) > len(prefix)+len(suffix) && name[:len(prefix)] == prefix && name[len(name)-len(suffix):] == suffix {
			if match != "" {
				return "", errors.New("multiple dependency assets found")
			}
			match = name
		}
	}
	if match == "" {
		return "", errors.New("dependency asset not found")
	}
	return match, nil
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
