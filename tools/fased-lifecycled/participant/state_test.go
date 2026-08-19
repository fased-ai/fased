package participant

import (
	"path/filepath"
	"testing"
)

func TestCanonicalStateSpecsSeparateSignerWalletPluginDataAndApplication(t *testing.T) {
	specs := CanonicalStateSpecs("/home/app/.fased", "/var/lib/fased-signerd")
	want := map[Kind]bool{ApplicationState: false, Configuration: false, Wallet: false, Mining: false, Federation: false, PluginData: false, Signer: false}
	signerSpecs := 0
	walletSpecs := map[string]bool{
		filepath.Join("/home/app/.fased", "wallet"):                              false,
		filepath.Join("/home/app/.fased", "wallet", "provider-registry.v1.json"): false,
	}
	for _, spec := range specs {
		want[spec.Kind] = true
		if spec.Kind == ApplicationState && spec.Path == filepath.Join("/home/app/.fased", "extensions") {
			t.Fatal("mutable executable extensions remained ordinary preserved application state")
		}
		if spec.Kind == PluginData && spec.Path != filepath.Join("/home/app/.fased", "plugin-data") {
			t.Fatalf("plugin data was rebound to executable extensions: %+v", spec)
		}
		if spec.Kind == Configuration && !spec.ProjectionOwned {
			t.Fatalf("configuration participant has competing rollback ownership: %+v", spec)
		}
		if spec.Kind == Wallet {
			if _, ok := walletSpecs[spec.Path]; !ok || !spec.RootOnly {
				t.Fatalf("wallet participant included secret or signer-owned material: %+v", spec)
			}
			walletSpecs[spec.Path] = true
		}
		if spec.Kind == Signer && (!spec.SignerOwned || !spec.RootOnly) {
			t.Fatalf("signer state lost its isolated policy: %+v", spec)
		}
		if spec.Kind == Signer {
			signerSpecs++
			if spec.Path != "/var/lib/fased-signerd" {
				t.Fatalf("lifecycle enumerated signer-owned contents: %+v", spec)
			}
		}
		if (spec.Kind == Mining || spec.Kind == Federation) && !spec.SQLite {
			t.Fatalf("database participant lost SQLite family handling: %+v", spec)
		}
		if spec.Kind == ApplicationState && spec.Path == filepath.Join("/home/app/.fased", "tasks") {
			wantLedger := filepath.Join("/home/app/.fased", "tasks", "task-ledger.sqlite")
			if len(spec.SQLiteMains) != 1 || spec.SQLiteMains[0] != wantLedger {
				t.Fatalf("task ledger lost its exact SQLite family boundary: %+v", spec)
			}
		}
	}
	for kind, found := range want {
		if !found {
			t.Fatalf("typed state participant %s is missing", kind)
		}
	}
	if signerSpecs != 1 {
		t.Fatalf("signer state must have exactly one opaque root participant, got %d", signerSpecs)
	}
	for path, found := range walletSpecs {
		if !found {
			t.Fatalf("wallet participant boundary is missing %s", path)
		}
	}
}
