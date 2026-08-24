package publicupdate

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func testReceipt() Receipt {
	digest := "sha256:" + strings.Repeat("a", 64)
	return Receipt{
		SchemaVersion: SchemaVersion, Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.0-rc.1",
		OperatorUser: "app", GatewayPort: 18789, PlatformIdentity: "linux/x64", ReleaseSequence: 1, SecurityEpoch: 1,
		ActiveGenerationID: digest, ConvergenceReceiptDigest: digest,
	}
}

func TestHostingAuthorityReceiptRoundTripUsesFixedStrictSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authority", "hosting-authority-v1.json")
	receipt := testReceipt()
	if err := writeHostingReceiptAt(path, receipt, uint32(os.Getuid()), uint32(os.Getgid())); err != nil {
		t.Fatal(err)
	}
	actual, err := readHostingReceiptAt(path, uint32(os.Getuid()), uint32(os.Getgid()))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(receipt)
	got, _ := json.Marshal(actual)
	if !bytes.Equal(got, want) {
		t.Fatalf("receipt mismatch: got %s want %s", got, want)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readHostingReceiptAt(path, uint32(os.Getuid()), uint32(os.Getgid())); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("unsafe receipt accepted: %v", err)
	}
}

func TestPublicHostingEnvelopeRejectsEvolvingCallerFields(t *testing.T) {
	receipt := testReceipt()
	request := Request{
		SchemaVersion: SchemaVersion, Operation: "update", Profile: model.ProfileHosting, Channel: receipt.Channel,
		Version: receipt.Version, OperatorUser: receipt.OperatorUser, GatewayPort: receipt.GatewayPort,
		PlatformIdentity: receipt.PlatformIdentity, TimeoutSeconds: 300, TrustRootSHA256: strings.Repeat("b", 64),
		HostDigest: strings.Repeat("c", 64), ApplicationPath: "/tmp/application", DependencyPath: "/tmp/dependency",
		ReleaseSequence: 2, SecurityEpoch: 1, ManifestProtocolMin: 1, ManifestProtocolMax: 2,
		ReleaseIndexDigest: "sha256:" + strings.Repeat("d", 64), ReleaseAuthorityDigest: "sha256:" + strings.Repeat("e", 64),
		PluginLockDigest: "sha256:" + strings.Repeat("f", 64), ExpectedPreviousSequence: 1, ExpectedPreviousEpoch: 1,
	}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	data = append(data[:len(data)-1], []byte(`,"platformConfig":{"schemaVersion":99}}`)...)
	if _, err := DecodeRequest(bytes.NewReader(data)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("evolving internal state crossed Stage-0 envelope: %v", err)
	}
}

func TestPublicHostingTransitionRequiresExactPreviousAuthority(t *testing.T) {
	previous := testReceipt()
	request := Request{
		SchemaVersion: SchemaVersion, Operation: "update", Profile: model.ProfileHosting, Channel: "beta", Version: "0.1.0-rc.2",
		OperatorUser: previous.OperatorUser, GatewayPort: previous.GatewayPort, PlatformIdentity: previous.PlatformIdentity,
		TimeoutSeconds: 300, TrustRootSHA256: strings.Repeat("b", 64), HostDigest: strings.Repeat("c", 64),
		ApplicationPath: "/tmp/application", ReleaseSequence: 2, SecurityEpoch: 1, ManifestProtocolMin: 1, ManifestProtocolMax: 2,
		ReleaseIndexDigest: "sha256:" + strings.Repeat("d", 64), ReleaseAuthorityDigest: "sha256:" + strings.Repeat("e", 64),
		PluginLockDigest: "sha256:" + strings.Repeat("f", 64), ExpectedPreviousSequence: 1, ExpectedPreviousEpoch: 1,
	}
	if err := ValidatePreviousReceipt(previous, request); err != nil {
		t.Fatal(err)
	}
	previous.ReleaseSequence = 2
	if err := ValidatePreviousReceipt(previous, request); err == nil || !strings.Contains(err.Error(), "installed authority") {
		t.Fatalf("mismatched predecessor accepted: %v", err)
	}
}
