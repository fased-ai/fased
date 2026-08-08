package platform

import (
	"net/http"
	"testing"

	"fased-lifecycled/model"
)

func TestGatewayReadinessBindsExactPackagedGeneration(t *testing.T) {
	target := model.Generation{
		Version: "0.1.76",
		Commit:  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
	body := []byte(`{"ok":true,"ready":true,"status":"ready","version":"0.1.76","runtimeSource":"managed-package","generation":{"schemaVersion":1,"version":"0.1.76","releaseCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`)
	if err := verifyGatewayReadiness(http.StatusOK, body, target); err != nil {
		t.Fatalf("expected exact generation identity to pass: %v", err)
	}

	wrongCommit := []byte(`{"ok":true,"ready":true,"status":"ready","version":"0.1.76","runtimeSource":"managed-package","generation":{"schemaVersion":1,"version":"0.1.76","releaseCommit":"cccccccccccccccccccccccccccccccccccccccc"}}`)
	if err := verifyGatewayReadiness(http.StatusOK, wrongCommit, target); err == nil {
		t.Fatal("expected a mismatched release commit to fail closed")
	}

	unverifiedRuntime := []byte(`{"ok":true,"ready":true,"status":"ready","version":"0.1.76","runtimeSource":"source-checkout","generation":{"schemaVersion":1,"version":"0.1.76","releaseCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`)
	if err := verifyGatewayReadiness(http.StatusOK, unverifiedRuntime, target); err == nil {
		t.Fatal("expected an unverified runtime source to fail closed")
	}
}
