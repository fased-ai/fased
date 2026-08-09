package platform

import (
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func TestSignerOwnerWrapperBindsCanonicalGenerationAndIdentity(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	wrapper, err := RenderSignerOwnerWrapper(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"FASED_SIGNER_USER=\"fssg-example\"",
		"FASED_SIGNER_BIN=\"/opt/fased/local/example/current/payload/bin/fased-signerd\"",
		"FASED_SIGNER_OWNER_LOCAL=\"1\"",
		"exec \"/usr/local/libexec/fased-local-signer-owner-example\" \"$@\"",
	} {
		if !strings.Contains(string(wrapper), required) {
			t.Fatalf("signer-owner wrapper is missing %q:\n%s", required, wrapper)
		}
	}
}
