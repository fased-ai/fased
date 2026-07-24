package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

const signerOperatorRequestTTLV1 = 2 * time.Minute

type signerOperatorContextV1 struct {
	Nonce     string                  `json:"nonce"`
	ExpiresAt string                  `json:"expiresAt"`
	Release   signerReleaseIdentityV2 `json:"release"`
}

type signerOperatorWalletImportRequestV1 struct {
	ExpectedVersion uint64                      `json:"expectedVersion"`
	Baseline        signerRoleBaselineRequestV1 `json:"baseline"`
	KeypairBase64   string                      `json:"keypairBase64"`
}

type signerOperatorWalletCreateRequestV1 struct {
	ExpectedVersion uint64                      `json:"expectedVersion"`
	Baseline        signerRoleBaselineRequestV1 `json:"baseline"`
	AllowExisting   bool                        `json:"allowExisting,omitempty"`
}

type signerOperatorNetworkSetPrimaryRequestV1 struct {
	ExpectedVersion uint64 `json:"expectedVersion"`
	PrimaryRPCURL   string `json:"primaryRpcUrl"`
}

type signerOperatorRecoveryExportRequestV1 struct {
	ExpectedPublicKey string `json:"expectedPublicKey"`
	PasswordBase64    string `json:"passwordBase64"`
}

type signerOperatorRecoveryImportRequestV1 struct {
	ExpectedVersion uint64                        `json:"expectedVersion"`
	Baseline        signerRoleBaselineRequestV1   `json:"baseline"`
	Package         signerWalletRecoveryPackageV1 `json:"package"`
	PasswordBase64  string                        `json:"passwordBase64"`
}

type signerOperatorRawExportRequestV1 struct {
	ExpectedPublicKey           string `json:"expectedPublicKey"`
	AcknowledgeCustodyReduction bool   `json:"acknowledgeCustodyReduction"`
}

type signerOperatorRawExportResultV1 struct {
	WalletID      string `json:"walletId"`
	PublicKey     string `json:"publicKey"`
	KeypairBase64 string `json:"keypairBase64"`
}

var signerOperatorAllowedOperationsV1 = map[string]bool{
	"health":                    true,
	"v2.capabilities":           true,
	"v2.wallet.get":             true,
	"getBalance":                true,
	"v2.wallet.readiness":       true,
	"v2.network.get":            true,
	"v2.network.setPrimary":     true,
	"v2.wallet.create":          true,
	"v2.wallet.import":          true,
	"v2.wallet.rotation.status": true,
}

func newSignerOperatorContextV1(now time.Time) (signerOperatorContextV1, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return signerOperatorContextV1{}, errors.New("generate signer operator nonce")
	}
	defer zeroBytes(nonce)
	release, err := signerReleaseIdentity()
	if err != nil {
		return signerOperatorContextV1{}, err
	}
	return signerOperatorContextV1{
		Nonce:     hex.EncodeToString(nonce),
		ExpiresAt: now.UTC().Add(signerOperatorRequestTTLV1).Format(time.RFC3339Nano),
		Release:   release,
	}, nil
}

func (s *signerStoreV2) consumeOperatorNonceV1(nonce string, expiresAt time.Time) error {
	if s == nil || s.db == nil {
		return errors.New("signer state database is unavailable")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerOperatorNoncesV2)
		if bucket == nil {
			return errors.New("signer operator nonce store is unavailable")
		}
		now := s.now().UTC()
		cursor := bucket.Cursor()
		for key, value := cursor.First(); key != nil; key, value = cursor.Next() {
			seenExpiry, err := time.Parse(time.RFC3339Nano, string(value))
			if err != nil || !seenExpiry.After(now) {
				if err := cursor.Delete(); err != nil {
					return err
				}
			}
		}
		if bucket.Get([]byte(nonce)) != nil {
			return errors.New("signer operator nonce was already used")
		}
		return bucket.Put([]byte(nonce), []byte(expiresAt.UTC().Format(time.RFC3339Nano)))
	})
}

func validateSignerOperatorContextV1(req request, store *signerStoreV2, now time.Time) error {
	if !signerOperatorAllowedOperationsV1[req.Op] {
		return errors.New("operation is not available on the signer operator socket")
	}
	context := req.Operator
	if context == nil || len(context.Nonce) != 64 {
		return errors.New("signer operator request requires a one-time nonce")
	}
	if _, err := hex.DecodeString(context.Nonce); err != nil {
		return errors.New("signer operator nonce is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, context.ExpiresAt)
	if err != nil || expiresAt.UTC().Format(time.RFC3339Nano) != context.ExpiresAt {
		return errors.New("signer operator expiry is invalid")
	}
	now = now.UTC()
	if !expiresAt.After(now) || expiresAt.After(now.Add(signerOperatorRequestTTLV1)) {
		return errors.New("signer operator request is expired or exceeds the allowed lifetime")
	}
	release, err := signerReleaseIdentity()
	if err != nil {
		return err
	}
	if context.Release != release {
		return errors.New("signer operator release identity does not match the running signer")
	}
	return store.consumeOperatorNonceV1(context.Nonce, expiresAt)
}

func decodeOperatorSecretV1(raw string, expectedMax int, field string) ([]byte, error) {
	secret, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil || len(secret) == 0 || len(secret) > expectedMax {
		zeroBytes(secret)
		return nil, fmt.Errorf("operator %s is invalid", field)
	}
	return secret, nil
}

func (m *signerKeyManagerV2) importOperatorKeypairWithRoleBaselineV1(
	walletID string,
	req signerOperatorWalletImportRequestV1,
) (signerWalletRecordV2, signerPolicyV2, error) {
	secret, err := decodeOperatorSecretV1(req.KeypairBase64, 64, "keypair")
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	if len(secret) != 64 || !validateSolanaCLIPrivateKeyV2(secret) {
		return signerWalletRecordV2{}, signerPolicyV2{}, errors.New("operator keypair is not a canonical Solana keypair")
	}
	privateKey := solana.PrivateKey(secret)
	policy, err := compileSignerRoleBaselineV1(
		walletID,
		privateKey.PublicKey().String(),
		req.Baseline,
		signerRoleBaselineRuntimeFromEnvV1(),
	)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	return m.storeNewKeyWithPolicy(walletID, privateKey, policy, req.ExpectedVersion)
}

func (m *signerKeyManagerV2) exportOperatorRecoveryV1(
	walletID string,
	req signerOperatorRecoveryExportRequestV1,
) (signerWalletRecoveryExportResultV2, error) {
	password, err := decodeOperatorSecretV1(req.PasswordBase64, maxSignerRecoveryPasswordBytes, "recovery password")
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	defer zeroBytes(password)
	if _, err := validateSignerAdminRecoveryPasswordV1(append([]byte(nil), password...)); err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	privateKey, wallet, err := m.privateKey(normalizeWalletID(walletID))
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	defer zeroBytes(privateKey)
	if req.ExpectedPublicKey != wallet.PublicKey {
		return signerWalletRecoveryExportResultV2{}, errors.New("expectedPublicKey does not match the signer wallet")
	}
	policy, err := m.store.getPolicy(walletID)
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	pkg, err := encryptSignerRecoveryPackageV1(wallet, policy.Role, privateKey, password)
	if err != nil {
		return signerWalletRecoveryExportResultV2{}, err
	}
	return signerWalletRecoveryExportResultV2{
		WalletID: walletID, Role: policy.Role, PublicKey: wallet.PublicKey, Package: pkg,
	}, nil
}

func (m *signerKeyManagerV2) importOperatorRecoveryV1(
	walletID string,
	req signerOperatorRecoveryImportRequestV1,
) (signerWalletRecordV2, signerPolicyV2, error) {
	baseline, err := normalizeRoleBaselineRequestV1(req.Baseline)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	if err := validateSignerRecoveryPackageV1(req.Package); err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	if req.Package.Role != baseline.Role {
		return signerWalletRecordV2{}, signerPolicyV2{}, errors.New("recovery package role does not match the requested role baseline")
	}
	password, err := decodeOperatorSecretV1(req.PasswordBase64, maxSignerRecoveryPasswordBytes, "recovery password")
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(password)
	secret, err := decryptSignerRecoveryPackageV1(req.Package, password)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	privateKey := solana.PrivateKey(secret)
	policy, err := compileSignerRoleBaselineV1(
		walletID,
		privateKey.PublicKey().String(),
		baseline,
		signerRoleBaselineRuntimeFromEnvV1(),
	)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	return m.storeNewKeyWithPolicy(walletID, privateKey, policy, req.ExpectedVersion)
}

func (m *signerKeyManagerV2) exportOperatorRawV1(
	walletID string,
	req signerOperatorRawExportRequestV1,
) (signerOperatorRawExportResultV1, error) {
	if !req.AcknowledgeCustodyReduction {
		return signerOperatorRawExportResultV1{}, errors.New("raw export requires explicit custody-reduction acknowledgement")
	}
	privateKey, wallet, err := m.privateKey(normalizeWalletID(walletID))
	if err != nil {
		return signerOperatorRawExportResultV1{}, err
	}
	defer zeroBytes(privateKey)
	if req.ExpectedPublicKey != wallet.PublicKey {
		return signerOperatorRawExportResultV1{}, errors.New("expectedPublicKey does not match the signer wallet")
	}
	return signerOperatorRawExportResultV1{
		WalletID: wallet.WalletID, PublicKey: wallet.PublicKey,
		KeypairBase64: base64.RawStdEncoding.EncodeToString(privateKey),
	}, nil
}

func (s *signerServiceV2) handleOperatorLifecycleV1(req request, cfg signerConfig) ([]byte, error) {
	if cfg.readOnly && req.Op != "health" && req.Op != "v2.capabilities" &&
		req.Op != "v2.wallet.get" && req.Op != "v2.wallet.readiness" && req.Op != "v2.network.get" &&
		req.Op != "getBalance" && req.Op != "v2.wallet.rotation.status" {
		return nil, errors.New("read-only signer mode")
	}
	switch req.Op {
	case "health", "v2.capabilities":
		health, err := s.health(cfg)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(health)
	case "v2.wallet.get":
		wallet, err := s.keys.PublicRecord(req.WalletID)
		if err != nil {
			return nil, err
		}
		policy, err := s.store.getPolicy(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWalletPolicyResultV2{Wallet: wallet, Policy: policy})
	case "getBalance":
		wallet, err := s.keys.PublicRecord(req.WalletID)
		if err != nil {
			return nil, err
		}
		address, err := solana.PublicKeyFromBase58(wallet.PublicKey)
		if err != nil {
			return nil, errors.New("signer-owned wallet record has an invalid public key")
		}
		rpcURLs, err := s.keys.SolanaRPCURLsV2(req.WalletID)
		if err != nil {
			return nil, errSignerNetworkPendingV2
		}
		lamports, err := signerOwnedSolanaBalanceV2(rpcURLs, address)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(map[string]any{
			"ok": true, "chain": "solana", "address": wallet.PublicKey,
			"balance": fmt.Sprintf("%d", lamports), "unit": "lamports",
		})
	case "v2.wallet.readiness":
		result, err := s.walletReadinessV2(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.network.get":
		result, err := s.keys.NetworkSummaryV2(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.network.setPrimary":
		var body signerOperatorNetworkSetPrimaryRequestV1
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		expectedVersion := body.ExpectedVersion
		result, err := s.keys.PutNetworkV2(req.WalletID, signerNetworkPutRequestV2{
			ExpectedVersion: &expectedVersion,
			PrimaryRPCURL:   body.PrimaryRPCURL,
		})
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.wallet.create":
		var body signerOperatorWalletCreateRequestV1
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		wallet, policy, err := s.keys.CreateWithRoleBaseline(
			req.WalletID,
			body.ExpectedVersion,
			body.Baseline,
			signerRoleBaselineRuntimeFromEnvV1(),
		)
		if err != nil && body.AllowExisting {
			existingWallet, walletErr := s.keys.PublicRecord(req.WalletID)
			existingPolicy, policyErr := s.store.getPolicy(req.WalletID)
			baseline, baselineErr := normalizeRoleBaselineRequestV1(body.Baseline)
			if walletErr == nil && policyErr == nil && baselineErr == nil &&
				existingPolicy.Role == baseline.Role &&
				existingPolicy.BaselineVersion == signerRoleBaselineVersionV1 {
				wallet, policy, err = existingWallet, existingPolicy, nil
			}
		}
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWalletPolicyResultV2{Wallet: wallet, Policy: policy})
	case "v2.wallet.import":
		var body signerOperatorWalletImportRequestV1
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		wallet, policy, err := s.keys.importOperatorKeypairWithRoleBaselineV1(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWalletPolicyResultV2{Wallet: wallet, Policy: policy})
	case "v2.wallet.rotation.status":
		rotation, err := s.keys.SuccessorRotationStatus(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(rotation)
	default:
		return nil, errors.New("operation is not available on the signer operator socket")
	}
}
