package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

const signerRoleBaselineVersionV1 = uint64(1)

const signerSATMainnetManifestPublicKeyV1 = "F-Kv6SBcZHvs1LQ0LNHwYQ6VuKidpkv1nkgRqggn1kk"

const (
	roleBaselineNativeMaxPerTxV1     = "1000000000"
	roleBaselineNativeMaxDailyV1     = "5000000000"
	roleBaselineMiningActionsPerTxV1 = "64"
	roleBaselineMiningActionsDailyV1 = "4096"
	roleBaselineSATMaxPerTxV1        = "1000000000000"
	roleBaselineSATMaxDailyV1        = "5000000000000"
)

type signerRoleBaselineRequestV1 struct {
	Version uint64 `json:"version"`
	Role    string `json:"role"`
}

type signerRoleBaselineActivationRequestV1 struct {
	ExpectedVersion uint64                      `json:"expectedPolicyVersion"`
	Baseline        signerRoleBaselineRequestV1 `json:"baseline"`
}

type signerRoleBaselineRuntimeV1 struct {
	SATProgramID     string
	SATBondProgramID string
	SATMintAddress   string
	SATMintProgramID string
	Verified         bool
	VerificationErr  string
}

type signerSATRuntimeManifestV1 struct {
	Schema  string `json:"schema"`
	Network string `json:"network"`
	Status  string `json:"status"`
	SAT     struct {
		Mint          string `json:"mint"`
		ProgramID     string `json:"programId"`
		MintProgramID string `json:"mintProgramId"`
		BondProgramID string `json:"bondProgramId"`
	} `json:"sat"`
}

func readSignerSATRuntimeArtifactV1(path string, maxBytes int64) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("artifact path is missing")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maxBytes {
		return nil, errors.New("artifact must be a bounded regular file")
	}
	return os.ReadFile(path)
}

func trustedSignerSATManifestKeysV1() []ed25519.PublicKey {
	encoded := []string{signerSATMainnetManifestPublicKeyV1}
	if value := strings.TrimSpace(os.Getenv("FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY")); value != "" {
		encoded = append(encoded, value)
	}
	for _, value := range strings.Split(os.Getenv("FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEYS"), ",") {
		if value = strings.TrimSpace(value); value != "" {
			encoded = append(encoded, value)
		}
	}
	keys := make([]ed25519.PublicKey, 0, len(encoded))
	for _, value := range encoded {
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
		if err == nil && len(decoded) == ed25519.PublicKeySize {
			keys = append(keys, ed25519.PublicKey(decoded))
		}
	}
	return keys
}

func verifySignerRoleBaselineRuntimeV1(runtime signerRoleBaselineRuntimeV1) error {
	manifestRaw, err := readSignerSATRuntimeArtifactV1(os.Getenv("FASED_SAT_RUNTIME_MANIFEST_PATH"), 128*1024)
	if err != nil {
		return fmt.Errorf("read signed SAT runtime manifest: %w", err)
	}
	expectedHash := strings.ToLower(strings.TrimSpace(os.Getenv("FASED_SAT_RUNTIME_MANIFEST_SHA256")))
	if len(expectedHash) != sha256.Size*2 {
		return errors.New("signed SAT runtime manifest SHA-256 is missing or invalid")
	}
	if _, err := hex.DecodeString(expectedHash); err != nil {
		return errors.New("signed SAT runtime manifest SHA-256 is invalid")
	}
	digest := sha256.Sum256(manifestRaw)
	if hex.EncodeToString(digest[:]) != expectedHash {
		return errors.New("signed SAT runtime manifest SHA-256 mismatch")
	}
	signatureRaw, err := readSignerSATRuntimeArtifactV1(os.Getenv("FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH"), 4096)
	if err != nil {
		return fmt.Errorf("read signed SAT runtime manifest signature: %w", err)
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureRaw)))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("signed SAT runtime manifest signature is invalid")
	}
	verified := false
	for _, key := range trustedSignerSATManifestKeysV1() {
		if ed25519.Verify(key, manifestRaw, signature) {
			verified = true
			break
		}
	}
	if !verified {
		return errors.New("signed SAT runtime manifest signature is not trusted")
	}
	var manifest signerSATRuntimeManifestV1
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return errors.New("signed SAT runtime manifest JSON is invalid")
	}
	if manifest.Schema != "sat-mainnet-addresses.v1" || manifest.Network != "mainnet-beta" || manifest.Status != "live" {
		return errors.New("signed SAT runtime manifest is not a live mainnet manifest")
	}
	if strings.TrimSpace(manifest.SAT.ProgramID) != runtime.SATProgramID ||
		strings.TrimSpace(manifest.SAT.BondProgramID) != runtime.SATBondProgramID ||
		strings.TrimSpace(manifest.SAT.Mint) != runtime.SATMintAddress ||
		strings.TrimSpace(manifest.SAT.MintProgramID) != runtime.SATMintProgramID {
		return errors.New("signed SAT runtime manifest does not match the configured runtime IDs")
	}
	return nil
}

type signerWalletReadinessV2 struct {
	WalletID        string `json:"walletId"`
	PublicKey       string `json:"publicKey"`
	WalletVersion   uint64 `json:"walletVersion"`
	Role            string `json:"role"`
	BaselineVersion uint64 `json:"baselineVersion"`
	PolicyVersion   uint64 `json:"policyVersion"`
	PolicyHash      string `json:"policyHash"`
	NetworkVersion  uint64 `json:"networkVersion"`
	NetworkHash     string `json:"networkHash,omitempty"`
	KeyReady        bool   `json:"keyReady"`
	PolicyReady     bool   `json:"policyReady"`
	NetworkReady    bool   `json:"networkReady"`
	OperationLane   string `json:"operationLane"`
	Ready           bool   `json:"ready"`
}

func signerRoleBaselineRuntimeFromEnvV1() signerRoleBaselineRuntimeV1 {
	runtime := signerRoleBaselineRuntimeV1{
		SATProgramID:     strings.TrimSpace(os.Getenv("FASED_SAT_PROGRAM_ID")),
		SATBondProgramID: strings.TrimSpace(os.Getenv("FASED_SAT_BOND_PROGRAM_ID")),
		SATMintAddress:   strings.TrimSpace(os.Getenv("FASED_SAT_MINT_ADDRESS")),
		SATMintProgramID: strings.TrimSpace(os.Getenv("FASED_SAT_MINT_PROGRAM_ID")),
	}
	if runtime.SATProgramID == "" && runtime.SATBondProgramID == "" && runtime.SATMintAddress == "" && runtime.SATMintProgramID == "" {
		return runtime
	}
	if err := verifySignerRoleBaselineRuntimeV1(runtime); err != nil {
		runtime.VerificationErr = err.Error()
		return runtime
	}
	runtime.Verified = true
	return runtime
}

func normalizeRoleBaselineRequestV1(input signerRoleBaselineRequestV1) (signerRoleBaselineRequestV1, error) {
	input.Role = strings.ToLower(strings.TrimSpace(input.Role))
	if input.Version != signerRoleBaselineVersionV1 {
		return signerRoleBaselineRequestV1{}, fmt.Errorf(
			"unsupported signer role baseline version %d; supported version is %d",
			input.Version,
			signerRoleBaselineVersionV1,
		)
	}
	switch input.Role {
	case "agent", "mining", "vault":
		return input, nil
	default:
		return signerRoleBaselineRequestV1{}, errors.New("role baseline must be agent, mining, or vault")
	}
}

func baseTransferProgramsV1() []string {
	return []string{
		solana.SystemProgramID.String(),
		solana.TokenProgramID.String(),
		solana.Token2022ProgramID.String(),
		solana.SPLAssociatedTokenAccountProgramID.String(),
		memoProgramV2V2.String(),
	}
}

func compileSignerRoleBaselineV1(
	walletID string,
	walletPublicKey string,
	request signerRoleBaselineRequestV1,
	runtime signerRoleBaselineRuntimeV1,
) (signerPolicyV2, error) {
	request, err := normalizeRoleBaselineRequestV1(request)
	if err != nil {
		return signerPolicyV2{}, err
	}
	walletPublicKey, err = normalizePublicKeyV2(walletPublicKey, "signer wallet public key")
	if err != nil {
		return signerPolicyV2{}, err
	}
	policy := signerPolicyV2{
		WalletID:        walletID,
		Role:            request.Role,
		BaselineVersion: request.Version,
		Operations: []string{
			intentSolanaNativeTransfer,
			intentSolanaSPLTransferChecked,
		},
		Programs: baseTransferProgramsV1(),
		Assets: []signerPolicyAssetV2{
			{
				Asset:                "solana:native",
				Destinations:         []string{walletPublicKey},
				MaxPerTx:             roleBaselineNativeMaxPerTxV1,
				MaxDaily:             roleBaselineNativeMaxDailyV1,
				ReviewedDestinations: true,
			},
		},
	}

	if request.Role == "mining" {
		if !runtime.Verified {
			detail := strings.TrimSpace(runtime.VerificationErr)
			if detail == "" {
				detail = "signed manifest proof is missing"
			}
			return signerPolicyV2{}, fmt.Errorf("Mining role baseline requires a verified release-bound SAT runtime manifest: %s", detail)
		}
		programID, programErr := normalizePublicKeyV2(runtime.SATProgramID, "signed SAT runtime program ID")
		mint, mintErr := normalizePublicKeyV2(runtime.SATMintAddress, "signed SAT runtime mint")
		mintProgramID, mintProgramErr := normalizePublicKeyV2(runtime.SATMintProgramID, "signed SAT runtime mint program ID")
		if programErr != nil || mintErr != nil || mintProgramErr != nil || strings.TrimSpace(runtime.SATBondProgramID) == "" {
			return signerPolicyV2{}, errors.New(
				"Mining role baseline requires the complete release-bound SAT runtime manifest (program, bond program, mint, and mint program)",
			)
		}
		bondProgramID, bondProgramErr := normalizePublicKeyV2(runtime.SATBondProgramID, "signed SAT runtime bond program ID")
		if bondProgramErr != nil {
			return signerPolicyV2{}, errors.New("Mining role baseline contains an invalid release-bound SAT runtime manifest")
		}
		policy.TypedSATPrograms = true
		policy.Programs = append(
			policy.Programs,
			programID,
			bondProgramID,
			mintProgramID,
			satAddressLookupTableProgramIDV2.String(),
		)
		for _, action := range sortedSATActionsV2() {
			codec := signerSATCodecsV2[action]
			if codec.Family == satFamilyMain {
				policy.Operations = append(policy.Operations, "sat."+action+"@"+programID)
			}
		}
		for _, action := range []string{"create", "extend", "deactivate", "close"} {
			policy.Operations = append(
				policy.Operations,
				"satLookup."+action+"@"+satAddressLookupTableProgramIDV2.String(),
			)
		}
		policy.Assets[0].TypedSATDestinations = true
		policy.Assets = append(policy.Assets,
			signerPolicyAssetV2{
				Asset: "sat:action", Destinations: []string{walletPublicKey, programID, satAddressLookupTableProgramIDV2.String()},
				MaxPerTx: roleBaselineMiningActionsPerTxV1, MaxDaily: roleBaselineMiningActionsDailyV1,
				TypedSATDestinations: true,
			},
			signerPolicyAssetV2{
				Asset: "sat:capital:lamports", Destinations: []string{programID},
				MaxPerTx: roleBaselineNativeMaxPerTxV1, MaxDaily: roleBaselineNativeMaxDailyV1,
				TypedSATDestinations: true,
			},
			signerPolicyAssetV2{
				Asset: "sat:mint:" + mint, Destinations: []string{walletPublicKey, programID},
				MaxPerTx: roleBaselineMiningActionsPerTxV1, MaxDaily: roleBaselineMiningActionsDailyV1,
				TypedSATDestinations: true,
			},
			signerPolicyAssetV2{
				Asset: "solana:spl:" + mint, Destinations: []string{walletPublicKey},
				MaxPerTx: roleBaselineSATMaxPerTxV1, MaxDaily: roleBaselineSATMaxDailyV1,
				ReviewedDestinations: true, TypedSATDestinations: true,
			},
		)
	}

	return normalizeSignerPolicyV2(policy)
}

func (m *signerKeyManagerV2) CreateWithRoleBaseline(
	walletID string,
	expectedVersion uint64,
	request signerRoleBaselineRequestV1,
	runtime signerRoleBaselineRuntimeV1,
) (signerWalletRecordV2, signerPolicyV2, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, fmt.Errorf("generate wallet key: %w", err)
	}
	defer zeroBytes(privateKey)
	solanaPrivateKey := solana.PrivateKey(privateKey)
	policy, err := compileSignerRoleBaselineV1(walletID, solanaPrivateKey.PublicKey().String(), request, runtime)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	return m.storeNewKeyWithPolicy(walletID, solanaPrivateKey, policy, expectedVersion)
}

func (m *signerKeyManagerV2) ImportFromFileWithRoleBaseline(
	req signerWalletImportRequestV2,
	runtime signerRoleBaselineRuntimeV1,
) (signerWalletRecordV2, signerPolicyV2, error) {
	secret, err := readSignerImportFileV2(req.Path)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	privateKey := solana.PrivateKey(secret)
	policy, err := compileSignerRoleBaselineV1(
		req.WalletID,
		privateKey.PublicKey().String(),
		*req.Baseline,
		runtime,
	)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	record, stored, err := m.storeNewKeyWithPolicy(req.WalletID, privateKey, policy, req.ExpectedVersion)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	_ = removeSignerImportFileV2(req.Path)
	return record, stored, nil
}

func (m *signerKeyManagerV2) ImportLegacyWithRoleBaseline(
	req signerWalletLegacyImportRequestV2,
	runtime signerRoleBaselineRuntimeV1,
) (signerWalletRecordV2, signerPolicyV2, error) {
	secret, expectedPublicKey, err := readLegacySignerImportV2(req.Path, req.PassphrasePath)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	defer zeroBytes(secret)
	privateKey := solana.PrivateKey(secret)
	if privateKey.PublicKey().String() != expectedPublicKey {
		return signerWalletRecordV2{}, signerPolicyV2{}, errors.New("legacy signer wallet public key mismatch")
	}
	policy, err := compileSignerRoleBaselineV1(
		req.WalletID,
		privateKey.PublicKey().String(),
		*req.Baseline,
		runtime,
	)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	record, stored, err := m.storeNewKeyWithPolicy(req.WalletID, privateKey, policy, req.ExpectedVersion)
	if err != nil {
		return signerWalletRecordV2{}, signerPolicyV2{}, err
	}
	_ = removeSignerImportFileV2(req.Path)
	_ = removeSignerImportFileV2(req.PassphrasePath)
	return record, stored, nil
}

func (s *signerStoreV2) activateRoleBaselineV1(
	walletID string,
	expectedVersion uint64,
	request signerRoleBaselineRequestV1,
	walletPublicKey string,
	runtime signerRoleBaselineRuntimeV1,
) (signerPolicyV2, error) {
	current, err := s.getPolicy(walletID)
	if err != nil {
		return signerPolicyV2{}, err
	}
	if current.Version != expectedVersion {
		return signerPolicyV2{}, fmt.Errorf(
			"signer policy version conflict: expected %d, current %d",
			expectedVersion,
			current.Version,
		)
	}
	if current.BaselineVersion != 0 || len(current.Operations) != 0 || len(current.Programs) != 0 || len(current.Assets) != 0 {
		return signerPolicyV2{}, errors.New("role baseline activation is permitted only for an existing explicit deny-all wallet")
	}
	if request.Role != "" && strings.ToLower(strings.TrimSpace(request.Role)) != current.Role {
		return signerPolicyV2{}, errors.New("role baseline activation cannot change the immutable wallet role")
	}
	request.Role = current.Role
	candidate, err := compileSignerRoleBaselineV1(walletID, walletPublicKey, request, runtime)
	if err != nil {
		return signerPolicyV2{}, err
	}
	return s.putPolicy(candidate, expectedVersion)
}

func (s *signerServiceV2) walletReadinessV2(walletID string) (signerWalletReadinessV2, error) {
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerWalletReadinessV2{}, err
	}
	policy, err := s.store.getPolicy(walletID)
	if err != nil {
		return signerWalletReadinessV2{}, err
	}
	network, err := s.keys.NetworkSummaryV2(walletID)
	if err != nil {
		return signerWalletReadinessV2{}, err
	}
	keyReady := false
	if privateKey, _, keyErr := s.keys.privateKey(walletID); keyErr == nil {
		keyReady = len(privateKey) > 0
		zeroBytes(privateKey)
	}
	policyReady := policy.BaselineVersion == signerRoleBaselineVersionV1 &&
		len(policy.Operations) > 0 && len(policy.Programs) > 0 && len(policy.Assets) > 0
	operationLane := "blocked"
	if policyReady {
		switch policy.Role {
		case "agent":
			operationLane = "agent-reviewed-and-autonomous"
		case "mining":
			operationLane = "mining-typed-sat"
		case "vault":
			operationLane = "vault-reviewed-only"
		}
	}
	result := signerWalletReadinessV2{
		WalletID:        wallet.WalletID,
		PublicKey:       wallet.PublicKey,
		WalletVersion:   wallet.Version,
		Role:            policy.Role,
		BaselineVersion: policy.BaselineVersion,
		PolicyVersion:   policy.Version,
		PolicyHash:      policy.Hash,
		NetworkVersion:  network.Version,
		NetworkHash:     network.Hash,
		KeyReady:        keyReady,
		PolicyReady:     policyReady,
		NetworkReady:    network.Ready,
		OperationLane:   operationLane,
	}
	result.Ready = result.KeyReady && result.PolicyReady && result.NetworkReady
	return result, nil
}
