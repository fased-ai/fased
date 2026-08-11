package participant

import (
	"path/filepath"
	"testing"
)

func TestCanonicalStateSpecsSeparateSignerWalletPluginDataAndApplication(t *testing.T) {
	specs := CanonicalStateSpecs("/home/app/.fased", "/var/lib/fased-signerd")
	want := map[Kind]bool{ApplicationState: false, Configuration: false, Wallet: false, Mining: false, Federation: false, PluginData: false, Signer: false}
	for _, spec := range specs {
		want[spec.Kind] = true
		if spec.Kind == PluginData && spec.Path != filepath.Join("/home/app/.fased", "plugin-data") {
			t.Fatalf("plugin data was rebound to executable extensions: %+v", spec)
		}
		if spec.Kind == Signer && (!spec.SignerOwned || !spec.RootOnly) {
			t.Fatalf("signer state lost its isolated policy: %+v", spec)
		}
	}
	for kind, found := range want {
		if !found {
			t.Fatalf("typed state participant %s is missing", kind)
		}
	}
}
