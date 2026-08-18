// Package recovery owns the encrypted signer wallet recovery-package format.
package recovery

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"fased-signerd/internal/custody"
	signerpolicy "fased-signerd/internal/policy"
	solana "github.com/gagliardetto/solana-go"
	"golang.org/x/crypto/argon2"
)

const (
	KindV1        = "fased-signer-wallet-recovery"
	VersionV1     = uint8(1)
	MemoryKiBV1   = uint32(64 * 1024)
	IterationsV1  = uint32(3)
	ParallelismV1 = uint8(1)

	SaltBytesV1       = 16
	KeyBytesV1        = 32
	NonceBytesV1      = 12
	PlaintextBytesV1  = ed25519.PrivateKeySize
	AuthenticationTag = 16

	MaxPackageBytes  = 16 << 10
	MaxPasswordBytes = 1024
)

// PackageV1 is the stable JSON recovery-package schema.
type PackageV1 struct {
	Kind       string       `json:"kind"`
	Version    uint8        `json:"version"`
	WalletID   string       `json:"walletId"`
	Role       string       `json:"role"`
	PublicKey  string       `json:"publicKey"`
	CreatedAt  string       `json:"createdAt"`
	KDF        KDFV1        `json:"kdf"`
	Encryption EncryptionV1 `json:"encryption"`
}

type KDFV1 struct {
	Name        string `json:"name"`
	MemoryKiB   uint32 `json:"memoryKiB"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
}

type EncryptionV1 struct {
	Name       string `json:"name"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// Encrypt produces a package only when its metadata and private-key binding
// are valid. Its serialized schema remains stable at V1.
func Encrypt(walletID, role, publicKey, createdAt string, secret, password []byte) (PackageV1, error) {
	if !validPrivateKey(secret) {
		return PackageV1{}, errors.New("signer wallet key is invalid")
	}
	if solana.PrivateKey(secret).PublicKey().String() != publicKey {
		return PackageV1{}, errors.New("signer wallet public key does not match its private key")
	}

	salt := make([]byte, SaltBytesV1)
	if _, err := rand.Read(salt); err != nil {
		return PackageV1{}, errors.New("generate recovery salt")
	}
	defer custody.ZeroBytes(salt)
	nonce := make([]byte, NonceBytesV1)
	if _, err := rand.Read(nonce); err != nil {
		return PackageV1{}, errors.New("generate recovery nonce")
	}
	defer custody.ZeroBytes(nonce)

	pkg := PackageV1{
		Kind:      KindV1,
		Version:   VersionV1,
		WalletID:  walletID,
		Role:      role,
		PublicKey: publicKey,
		CreatedAt: createdAt,
		KDF: KDFV1{
			Name:        "argon2id",
			MemoryKiB:   MemoryKiBV1,
			Iterations:  IterationsV1,
			Parallelism: ParallelismV1,
			Salt:        base64.RawURLEncoding.EncodeToString(salt),
		},
		Encryption: EncryptionV1{Name: "aes-256-gcm", Nonce: base64.RawURLEncoding.EncodeToString(nonce)},
	}
	key := argon2.IDKey(password, salt, IterationsV1, MemoryKiBV1, ParallelismV1, KeyBytesV1)
	defer custody.ZeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return PackageV1{}, errors.New("initialize recovery encryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return PackageV1{}, errors.New("initialize recovery authenticated encryption")
	}
	ciphertext := aead.Seal(nil, nonce, secret, aad(pkg))
	defer custody.ZeroBytes(ciphertext)
	pkg.Encryption.Ciphertext = base64.RawURLEncoding.EncodeToString(ciphertext)
	if err := Validate(pkg); err != nil {
		return PackageV1{}, err
	}
	return pkg, nil
}

// Validate performs strict semantic validation before any decryption work.
func Validate(pkg PackageV1) error {
	if pkg.Kind != KindV1 || pkg.Version != VersionV1 {
		return errors.New("unsupported recovery package kind or version")
	}
	if pkg.WalletID == "" || signerpolicy.NormalizeWalletID(pkg.WalletID) != pkg.WalletID {
		return errors.New("recovery package walletId is invalid")
	}
	switch pkg.Role {
	case "agent", "mining", "vault":
	default:
		return errors.New("recovery package role is invalid")
	}
	if !canonicalPublicKey(pkg.PublicKey) {
		return errors.New("recovery package publicKey is invalid")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, pkg.CreatedAt)
	if err != nil || createdAt.UTC().Format(time.RFC3339Nano) != pkg.CreatedAt {
		return errors.New("recovery package createdAt is invalid")
	}
	if pkg.KDF.Name != "argon2id" || pkg.KDF.MemoryKiB != MemoryKiBV1 || pkg.KDF.Iterations != IterationsV1 || pkg.KDF.Parallelism != ParallelismV1 {
		return errors.New("recovery package KDF parameters are unsupported")
	}
	if pkg.Encryption.Name != "aes-256-gcm" {
		return errors.New("recovery package encryption is unsupported")
	}
	if !validRawBase64URL(pkg.KDF.Salt, SaltBytesV1) {
		return errors.New("recovery package salt is invalid")
	}
	if !validRawBase64URL(pkg.Encryption.Nonce, NonceBytesV1) {
		return errors.New("recovery package nonce is invalid")
	}
	if !validRawBase64URL(pkg.Encryption.Ciphertext, PlaintextBytesV1+AuthenticationTag) {
		return errors.New("recovery package ciphertext is invalid")
	}
	return nil
}

// Decrypt authenticates and returns the validated Solana CLI private key.
// Callers own and must wipe the returned plaintext.
func Decrypt(pkg PackageV1, password []byte) ([]byte, error) {
	if err := Validate(pkg); err != nil {
		return nil, err
	}
	salt, _ := base64.RawURLEncoding.DecodeString(pkg.KDF.Salt)
	defer custody.ZeroBytes(salt)
	nonce, _ := base64.RawURLEncoding.DecodeString(pkg.Encryption.Nonce)
	defer custody.ZeroBytes(nonce)
	ciphertext, _ := base64.RawURLEncoding.DecodeString(pkg.Encryption.Ciphertext)
	defer custody.ZeroBytes(ciphertext)
	key := argon2.IDKey(password, salt, pkg.KDF.Iterations, pkg.KDF.MemoryKiB, pkg.KDF.Parallelism, KeyBytesV1)
	defer custody.ZeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("initialize recovery decryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("initialize recovery authenticated decryption")
	}
	secret, err := aead.Open(nil, nonce, ciphertext, aad(pkg))
	if err != nil {
		custody.ZeroBytes(secret)
		return nil, errors.New("recovery password is incorrect or the package was modified")
	}
	if !validPrivateKey(secret) {
		custody.ZeroBytes(secret)
		return nil, errors.New("recovery package contains an invalid wallet key")
	}
	if solana.PrivateKey(secret).PublicKey().String() != pkg.PublicKey {
		custody.ZeroBytes(secret)
		return nil, errors.New("recovery package public key does not match its private key")
	}
	return secret, nil
}

func aad(pkg PackageV1) []byte {
	return []byte(fmt.Sprintf("fased-signerd:wallet-recovery:v1:%s:%s:%s:%s", pkg.WalletID, pkg.Role, pkg.PublicKey, pkg.CreatedAt))
}

func validRawBase64URL(value string, size int) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != size || base64.RawURLEncoding.EncodeToString(decoded) != value {
		custody.ZeroBytes(decoded)
		return false
	}
	custody.ZeroBytes(decoded)
	return true
}

func canonicalPublicKey(value string) bool {
	if value == "" || strings.TrimSpace(value) != value {
		return false
	}
	key, err := solana.PublicKeyFromBase58(value)
	return err == nil && key.String() == value
}

func validPrivateKey(secret []byte) bool {
	if len(secret) != ed25519.PrivateKeySize {
		return false
	}
	derived := ed25519.NewKeyFromSeed(secret[:ed25519.SeedSize])
	defer custody.ZeroBytes(derived)
	return subtle.ConstantTimeCompare(derived[ed25519.SeedSize:], secret[ed25519.SeedSize:]) == 1
}
