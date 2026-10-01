package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

const signerRoleBaselineVersionV1 = uint64(1)

const (
	roleBaselineNativeMaxPerTxV1 = "1000000000"
	roleBaselineNativeMaxDailyV1 = "5000000000"
)

type signerRoleBaselineRequestV1 struct {
	ApprovalMode string `json:"approvalMode,omitempty"`
	Version      uint64 `json:"version"`
	Role         string `json:"role"`
}

type signerRoleBaselineRuntimeV1 struct{}

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
	return signerRoleBaselineRuntimeV1{}
}

func normalizeRoleBaselineRequestV1(input signerRoleBaselineRequestV1) (signerRoleBaselineRequestV1, error) {
	input.Role = strings.ToLower(strings.TrimSpace(input.Role))
	if input.ApprovalMode != "" && input.ApprovalMode != "read-only" {
		return signerRoleBaselineRequestV1{}, errors.New("new wallet baseline permits only read-only approval mode")
	}
	if input.Version != signerRoleBaselineVersionV1 {
		return signerRoleBaselineRequestV1{}, fmt.Errorf(
			"unsupported signer role baseline version %d; supported version is %d",
			input.Version,
			signerRoleBaselineVersionV1,
		)
	}
	switch input.Role {
	case "agent":
		return input, nil
	default:
		return signerRoleBaselineRequestV1{}, errors.New("wallet baseline must use the ordinary discriminator agent")
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
	if request.ApprovalMode == "read-only" {
		return normalizeSignerPolicyV2(signerPolicyV2{WalletID: walletID, Role: request.Role, BaselineVersion: request.Version, ApprovalMode: "read-only"})
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
		((len(policy.Operations) > 0 && len(policy.Programs) > 0 && len(policy.Assets) > 0) ||
			((policy.ApprovalMode == "read-only") && len(policy.Operations) == 0 && len(policy.Programs) == 0 && len(policy.Assets) == 0))
	operationLane := "blocked"
	if policyReady {
		operationLane = "reviewed-and-autonomous"
	}
	if policy.ApprovalMode == "read-only" && policyReady {
		operationLane = "read-only"
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
