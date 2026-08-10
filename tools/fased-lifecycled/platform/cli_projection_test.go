package platform

import (
	"encoding/json"
	"testing"

	"fased-lifecycled/model"
)

func TestCLIProjectionBindsCanonicalLocalPaths(t *testing.T) {
	config, err := NewConfigWithGatewayPort(model.ProfileProtectedLocal, "0123456789abcdef", "/home/owner/.fased", 18789,
		Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
	if err != nil {
		t.Fatal(err)
	}
	data, err := CanonicalCLIProjectionJSON(config)
	if err != nil {
		t.Fatal(err)
	}
	var projection CLIProjection
	if err := json.Unmarshal(data, &projection); err != nil {
		t.Fatal(err)
	}
	if projection.SchemaVersion != 1 || projection.Profile != model.ProfileProtectedLocal || projection.InstanceID != config.InstanceID {
		t.Fatalf("unexpected projection identity: %+v", projection)
	}
	want := map[string]string{
		"FASED_RUNTIME_SOURCE":             "go-lifecycle",
		"FASED_PROTECTED_LOCAL":            "1",
		"FASED_PROTECTED_LOCAL_INSTANCE":   config.InstanceID,
		"FASED_WALLET_LOCAL_SIGNER_BIN":    "/opt/fased/local/0123456789abcdef/current/payload/bin/fased-signerd", // pragma: allowlist secret
		"FASED_WALLET_LOCAL_SIGNER_SOCKET": "/run/fased-local/0123456789abcdef/application/app.sock",
		"FASED_HOST_UPDATER_SOCKET":        "/run/fased-local-controller/0123456789abcdef/request.sock",
	}
	for key, expected := range want {
		if projection.Environment[key] != expected {
			t.Fatalf("projection %s=%q, want %q", key, projection.Environment[key], expected)
		}
	}
}
