package recovery

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	"fased-signerd/internal/custody"
	solana "github.com/gagliardetto/solana-go"
)

func testPrivateKeyV1() []byte {
	seed := bytes.Repeat([]byte{0x42}, ed25519.SeedSize)
	defer custody.ZeroBytes(seed)
	return ed25519.NewKeyFromSeed(seed)
}

func testPackageV1(t *testing.T) (PackageV1, []byte, []byte) {
	t.Helper()
	secret := testPrivateKeyV1()
	password := []byte("correct horse battery staple")
	pkg, err := Encrypt(
		"agent_1",
		"agent",
		solana.PrivateKey(secret).PublicKey().String(),
		"2026-08-18T12:34:56.123456789Z",
		secret,
		password,
	)
	if err != nil {
		custody.ZeroBytes(secret)
		t.Fatal(err)
	}
	return pkg, secret, password
}

func TestRoundTripAndAuthenticationV1(t *testing.T) {
	pkg, secret, password := testPackageV1(t)
	defer custody.ZeroBytes(secret)
	defer custody.ZeroBytes(password)
	if err := Validate(pkg); err != nil {
		t.Fatalf("validate encrypted package: %v", err)
	}
	decrypted, err := Decrypt(pkg, password)
	if err != nil {
		t.Fatalf("decrypt package: %v", err)
	}
	defer custody.ZeroBytes(decrypted)
	if !bytes.Equal(decrypted, secret) {
		t.Fatal("decrypted key does not match source key")
	}
	if plaintext, err := Decrypt(pkg, []byte("definitely-not-the-right-password")); err == nil {
		custody.ZeroBytes(plaintext)
		t.Fatal("wrong password was accepted")
	}
	tampered := pkg
	tampered.Role = "vault"
	if plaintext, err := Decrypt(tampered, password); err == nil {
		custody.ZeroBytes(plaintext)
		t.Fatal("AAD role tampering was accepted")
	}
}

func TestRejectsMalformedMetadataAndEncodingV1(t *testing.T) {
	pkg, secret, password := testPackageV1(t)
	defer custody.ZeroBytes(secret)
	defer custody.ZeroBytes(password)
	tests := []struct {
		name string
		edit func(*PackageV1)
		want string
	}{
		{"kdf", func(value *PackageV1) { value.KDF.MemoryKiB++ }, "recovery package KDF parameters are unsupported"},
		{"padded salt", func(value *PackageV1) { value.KDF.Salt += "=" }, "recovery package salt is invalid"},
		{"padded ciphertext", func(value *PackageV1) { value.Encryption.Ciphertext += "=" }, "recovery package ciphertext is invalid"},
		{"non-canonical public key", func(value *PackageV1) { value.PublicKey = " " + value.PublicKey }, "recovery package publicKey is invalid"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := pkg
			test.edit(&value)
			if err := Validate(value); err == nil || err.Error() != test.want {
				t.Fatalf("Validate() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestEncryptRejectsInvalidKeyStructureAndBindingV1(t *testing.T) {
	secret := testPrivateKeyV1()
	defer custody.ZeroBytes(secret)
	password := []byte("correct horse battery staple")
	defer custody.ZeroBytes(password)
	publicKey := solana.PrivateKey(secret).PublicKey().String()
	invalid := append([]byte(nil), secret...)
	invalid[len(invalid)-1] ^= 0x01
	defer custody.ZeroBytes(invalid)
	if _, err := Encrypt("agent_1", "agent", publicKey, "2026-08-18T12:34:56Z", invalid, password); err == nil || err.Error() != "signer wallet key is invalid" {
		t.Fatalf("invalid private-key structure error = %v", err)
	}
	other := testPrivateKeyV1()
	other[0] ^= 0x01
	derived := ed25519.NewKeyFromSeed(other[:ed25519.SeedSize])
	custody.ZeroBytes(other)
	other = derived
	defer custody.ZeroBytes(other)
	if _, err := Encrypt("agent_1", "agent", solana.PrivateKey(other).PublicKey().String(), "2026-08-18T12:34:56Z", secret, password); err == nil || err.Error() != "signer wallet public key does not match its private key" {
		t.Fatalf("public/private binding error = %v", err)
	}
}
