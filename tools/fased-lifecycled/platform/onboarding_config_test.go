package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOnboardingConfigDeclaredOwner(t *testing.T) {
	uid := uint32(os.Getuid())
	for _, tc := range []struct {
		name              string
		operator, gateway uint32
		mode              os.FileMode
		denied            bool
	}{
		{"operator", uid, uid + 1, 0600, false},
		{"gateway atomic write", uid + 1, uid, 0660, false},
		{"unrelated owner", uid + 1, uid + 2, 0600, true},
		{"world access", uid + 1, uid, 0664, true},
		{"executable", uid + 1, uid, 0700, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "fased.json"), []byte("{}"), tc.mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(filepath.Join(root, "fased.json"), tc.mode); err != nil {
				t.Fatal(err)
			}
			config := Config{OwnerStateRoot: root, Operator: Principal{UID: tc.operator}, Gateway: Principal{UID: tc.gateway}}
			err := validateOnboardingConfig(config)
			if (err != nil) != tc.denied {
				t.Fatalf("denied=%v, err=%v", tc.denied, err)
			}
		})
	}
}

func TestOnboardingConfigRejectsLinkedInputs(t *testing.T) {
	for _, hard := range []bool{false, true} {
		root := t.TempDir()
		source := filepath.Join(root, "source.json")
		target := filepath.Join(root, "fased.json")
		if err := os.WriteFile(source, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		var err error
		if hard {
			err = os.Link(source, target)
		} else {
			err = os.Symlink(source, target)
		}
		if err != nil {
			t.Fatal(err)
		}
		uid := uint32(os.Getuid())
		config := Config{OwnerStateRoot: root, Operator: Principal{UID: uid}, Gateway: Principal{UID: uid + 1}}
		if err := validateOnboardingConfig(config); err == nil {
			t.Fatal("linked configuration accepted")
		}
	}
}
