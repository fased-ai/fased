package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func writeOwnerOnlyRecoveryTestFileV1(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSignerRecoveryPackageRoundTripAndAuthenticationV1(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, _ := createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	directory := t.TempDir()
	password := []byte("correct horse battery staple")
	passwordPath := filepath.Join(directory, "password")
	writeOwnerOnlyRecoveryTestFileV1(t, passwordPath, password)

	exported, err := keys.ExportRecoveryV1("agent", signerWalletRecoveryExportRequestV2{
		ExpectedPublicKey: wallet.PublicKey,
		PasswordPath:      passwordPath,
	})
	if err != nil {
		t.Fatalf("export recovery package: %v", err)
	}
	if _, err := os.Lstat(passwordPath); !os.IsNotExist(err) {
		t.Fatalf("successful export did not consume staged password: %v", err)
	}
	if exported.Package.WalletID != "agent" || exported.Package.Role != "agent" || exported.Package.PublicKey != wallet.PublicKey {
		t.Fatalf("unexpected recovery metadata: %#v", exported.Package)
	}
	if strings.Contains(exported.Package.Encryption.Ciphertext, wallet.PublicKey) {
		t.Fatal("recovery ciphertext unexpectedly contains public metadata")
	}
	wrongPassword := []byte("this password is definitely wrong")
	if secret, err := decryptSignerRecoveryPackageV1(exported.Package, wrongPassword); err == nil {
		zeroBytes(secret)
		t.Fatal("wrong recovery password was accepted")
	}

	packageRaw, err := json.Marshal(exported.Package)
	if err != nil {
		t.Fatal(err)
	}
	recoveryPath := filepath.Join(directory, "recovery.json")
	passwordPath = filepath.Join(directory, "password-import")
	writeOwnerOnlyRecoveryTestFileV1(t, recoveryPath, packageRaw)
	writeOwnerOnlyRecoveryTestFileV1(t, passwordPath, password)
	imported, policy, err := keys.ImportRecoveryV1(signerWalletRecoveryImportRequestV2{
		WalletID:        "agent_recovered",
		ExpectedVersion: 0,
		Policy: signerPolicyV2{
			WalletID: "agent_recovered", Role: "agent", Operations: []string{}, Programs: []string{}, Assets: []signerPolicyAssetV2{},
		},
		RecoveryPath: recoveryPath,
		PasswordPath: passwordPath,
	})
	if err != nil {
		t.Fatalf("import recovery package: %v", err)
	}
	if imported.PublicKey != wallet.PublicKey || policy.Role != "agent" || len(policy.Operations) != 0 {
		t.Fatalf("unexpected recovered wallet: wallet=%#v policy=%#v", imported, policy)
	}
	for _, consumed := range []string{recoveryPath, passwordPath} {
		if _, err := os.Lstat(consumed); !os.IsNotExist(err) {
			t.Fatalf("successful recovery did not consume %s: %v", consumed, err)
		}
	}
}

func TestSignerRecoveryRoundTripReexportAndRawExportForEverySolanaRoleV1(t *testing.T) {
	roles := []string{"agent", "vault", "mining", "profile", "strategy"}
	for _, role := range roles {
		t.Run(role, func(t *testing.T) {
			_, keys := openTestSignerV2(t)
			walletID := role + "_source"
			policy, err := lockedSignerAdminPolicy(walletID, role)
			if err != nil {
				t.Fatalf("create %s policy: %v", role, err)
			}
			wallet, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
				WalletID: walletID, ExpectedVersion: 0, Policy: policy,
			})
			if err != nil {
				t.Fatalf("create %s wallet: %v", role, err)
			}

			directory := t.TempDir()
			password := []byte("correct horse battery staple")
			exportPasswordPath := filepath.Join(directory, "password-export")
			writeOwnerOnlyRecoveryTestFileV1(t, exportPasswordPath, password)
			exported, err := keys.ExportRecoveryV1(walletID, signerWalletRecoveryExportRequestV2{
				ExpectedPublicKey: wallet.PublicKey,
				PasswordPath:      exportPasswordPath,
			})
			if err != nil {
				t.Fatalf("export %s recovery package: %v", role, err)
			}
			packageRaw, err := json.Marshal(exported.Package)
			if err != nil {
				t.Fatal(err)
			}
			recoveryPath := filepath.Join(directory, "recovery.json")
			importPasswordPath := filepath.Join(directory, "password-import")
			writeOwnerOnlyRecoveryTestFileV1(t, recoveryPath, packageRaw)
			writeOwnerOnlyRecoveryTestFileV1(t, importPasswordPath, password)

			restoredWalletID := role + "_restored"
			restoredPolicy, err := lockedSignerAdminPolicy(restoredWalletID, role)
			if err != nil {
				t.Fatal(err)
			}
			restored, policy, err := keys.ImportRecoveryV1(signerWalletRecoveryImportRequestV2{
				WalletID:        restoredWalletID,
				ExpectedVersion: 0,
				Policy:          restoredPolicy,
				RecoveryPath:    recoveryPath,
				PasswordPath:    importPasswordPath,
			})
			if err != nil {
				t.Fatalf("restore %s recovery package: %v", role, err)
			}
			if restored.PublicKey != wallet.PublicKey || policy.Role != role {
				t.Fatalf("%s recovery changed identity: source=%s restored=%s policy=%#v", role, wallet.PublicKey, restored.PublicKey, policy)
			}

			reexportPasswordPath := filepath.Join(directory, "password-reexport")
			writeOwnerOnlyRecoveryTestFileV1(t, reexportPasswordPath, password)
			reexported, err := keys.ExportRecoveryV1(restoredWalletID, signerWalletRecoveryExportRequestV2{
				ExpectedPublicKey: restored.PublicKey,
				PasswordPath:      reexportPasswordPath,
			})
			if err != nil {
				t.Fatalf("re-export restored %s wallet: %v", role, err)
			}
			if reexported.PublicKey != wallet.PublicKey || reexported.Role != role {
				t.Fatalf("%s re-export changed identity: %#v", role, reexported)
			}

			rawDirectory := filepath.Join(directory, ".admin-export")
			if err := os.Mkdir(rawDirectory, 0o700); err != nil {
				t.Fatal(err)
			}
			rawPath := filepath.Join(rawDirectory, "key.json")
			writeOwnerOnlyRecoveryTestFileV1(t, rawPath, nil)
			result, err := keys.ExportRawV2(restoredWalletID, signerWalletRawExportRequestV2{
				ExpectedPublicKey: restored.PublicKey,
				Path:              rawPath,
			})
			if err != nil || !result.Written {
				t.Fatalf("raw export restored %s wallet: result=%#v err=%v", role, result, err)
			}
			raw, err := os.ReadFile(rawPath)
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := readSignerAdminSolanaKeypair(bytes.NewReader(raw))
			if err != nil {
				t.Fatalf("%s raw export is not canonical Solana CLI JSON: %v", role, err)
			}
			var values []int
			if err := json.Unmarshal(canonical, &values); err != nil || len(values) != 64 {
				t.Fatalf("%s canonical raw export could not be decoded", role)
			}
			secret := make([]byte, len(values))
			for index, value := range values {
				secret[index] = byte(value)
				values[index] = 0
			}
			if solana.PrivateKey(secret).PublicKey().String() != wallet.PublicKey {
				t.Fatalf("%s raw export public key mismatch", role)
			}
			zeroBytes(secret)
			zeroBytes(canonical)
		})
	}
}

func TestSignerRecoveryRejectsTamperingAndRoleChangeV1(t *testing.T) {
	_, keys := openTestSignerV2(t)
	policy, err := lockedSignerAdminPolicy("mining", "mining")
	if err != nil {
		t.Fatal(err)
	}
	wallet, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{WalletID: "mining", ExpectedVersion: 0, Policy: policy})
	if err != nil {
		t.Fatal(err)
	}
	passwordPath := filepath.Join(t.TempDir(), "password")
	writeOwnerOnlyRecoveryTestFileV1(t, passwordPath, []byte("a sufficiently strong password"))
	exported, err := keys.ExportRecoveryV1("mining", signerWalletRecoveryExportRequestV2{ExpectedPublicKey: wallet.PublicKey, PasswordPath: passwordPath})
	if err != nil {
		t.Fatal(err)
	}
	tampered := exported.Package
	tampered.Role = "vault"
	if secret, err := decryptSignerRecoveryPackageV1(tampered, []byte("a sufficiently strong password")); err == nil {
		zeroBytes(secret)
		t.Fatal("authenticated recovery metadata could be changed")
	}
	if exported.Package.Encryption.Ciphertext == "" || bytes.Contains([]byte(exported.Package.Encryption.Ciphertext), []byte(wallet.PublicKey)) {
		t.Fatal("invalid recovery ciphertext")
	}
}

func TestSignerRawExportRequiresExactPublicKeyAndSignerOwnedStageV2(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, _ := createTestSignerWalletV2(t, store, keys, "vault", solana.NewWallet().PublicKey().String(), 100, 1000)
	directory := filepath.Join(t.TempDir(), ".admin-export")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "key.json")
	writeOwnerOnlyRecoveryTestFileV1(t, path, nil)
	if _, err := keys.ExportRawV2("vault", signerWalletRawExportRequestV2{ExpectedPublicKey: solana.NewWallet().PublicKey().String(), Path: path}); err == nil {
		t.Fatal("raw export accepted the wrong public key")
	}
	result, err := keys.ExportRawV2("vault", signerWalletRawExportRequestV2{ExpectedPublicKey: wallet.PublicKey, Path: path})
	if err != nil || !result.Written {
		t.Fatalf("raw export failed: result=%#v err=%v", result, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := readSignerAdminSolanaKeypair(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("raw export is not canonical Solana CLI JSON: %v", err)
	}
	zeroBytes(canonical)
}
