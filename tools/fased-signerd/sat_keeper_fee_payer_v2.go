package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

var keeperFeePayerActionsV2 = map[string]struct{}{
	"openCycleV2":                      {},
	"closeCommitPhase":                 {},
	"closeCommitPhaseV2":               {},
	"sealCycleEntropy":                 {},
	"snapshotKeeperCapabilitiesV2":     {},
	"sealCycleEntropyV2":               {},
	"releaseUnrevealedCommit":          {},
	"releaseUnrevealedCommitV2":        {},
	"abortEmptyCycle":                  {},
	"abortEmptyCycleV2":                {},
	"settleCyclePage":                  {},
	"finalizeCycleSettlement":          {},
	"scoreCyclePage":                   {},
	"distributeCyclePage":              {},
	"settleCyclePageV2":                {},
	"finalizeCycleSettlementV2":        {},
	"scoreCyclePageV2":                 {},
	"distributeCyclePageV2":            {},
	"recordAgentCycleReceiptV2":        {},
	"closeResolvedMinerCycleStateV2":   {},
	"closeResolvedCycleRegistryPageV2": {},
	"closeResolvedCycleArtifactsV2":    {},
}

func normalizeKeeperFeePayerIntentV2(
	input signerIntentV2,
	feePayer solana.PublicKey,
	authorityWalletID string,
	authority solana.PublicKey,
) (normalizedIntentV2, error) {
	vnextKeeper := strings.HasSuffix(strings.TrimSpace(input.Action), "V2")
	standaloneKeeper := vnextKeeper && normalizeWalletID(input.AuthorityWalletID) == normalizeWalletID(authorityWalletID) && feePayer.Equals(authority)
	if feePayer.IsZero() || authority.IsZero() || (!standaloneKeeper && feePayer.Equals(authority)) {
		return normalizedIntentV2{}, errors.New("keeper fee payer must be distinct from operational authority")
	}
	if strings.TrimSpace(input.Type) != intentSolanaSATKeeperAction {
		return normalizedIntentV2{}, errors.New("typed SAT keeper intent has the wrong type")
	}
	if err := requireKeeperFeePayerActionV2(input.Action); err != nil {
		return normalizedIntentV2{}, err
	}
	if normalizeWalletID(input.AuthorityWalletID) != normalizeWalletID(authorityWalletID) {
		return normalizedIntentV2{}, errors.New("typed SAT keeper authority wallet binding mismatch")
	}
	authorityInput := input
	authorityInput.Type = intentSolanaSATAction
	authorityInput.AuthorityWalletID = ""
	normalizationWallet := authority
	if vnextKeeper {
		normalizationWallet = feePayer
	}
	authorityIntent, err := normalizeSATIntentV2(authorityInput, normalizationWallet)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	canonical := authorityIntent.Intent
	canonical.Type = intentSolanaSATKeeperAction
	canonical.AuthorityWalletID = normalizeWalletID(authorityWalletID)
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(encoded)
	authorityIntent.RequiredRole = "mining"
	var parentIntent *normalizedIntentV2
	if !vnextKeeper {
		parentIntent = &authorityIntent
	}
	return normalizedIntentV2{
		Intent:               canonical,
		Digest:               "sha256:" + hex.EncodeToString(digest[:]),
		Asset:                "solana:native",
		Amount:               new(big.Int).SetUint64(1),
		RequiredPrograms:     authorityIntent.RequiredPrograms,
		Destination:          feePayer.String(),
		Instructions:         authorityIntent.Instructions,
		AddressLookupTables:  authorityIntent.AddressLookupTables,
		NativeFeeReservation: new(big.Int).SetUint64(500_000),
		PolicyOperation:      "satKeeperFee." + strings.TrimSpace(input.Action) + "@" + authorityIntent.Instructions[0].ProgramID().String(),
		RequiredRole:         "keeper",
		ParentIntent:         parentIntent,
	}, nil
}

type signerKeeperFeePayerCapabilityV2 struct {
	MiningWalletID    string `json:"miningWalletId"`
	FeePayerWalletID  string `json:"feePayerWalletId"`
	FeePayerPublicKey string `json:"feePayerPublicKey"`
	PolicyHash        string `json:"policyHash"`
	MaxPerTransaction string `json:"maxPerTransactionLamports"`
	MaxDaily          string `json:"maxDailyLamports"`
	State             string `json:"state"`
}

type signerKeeperFeePayerEnsureRequestV2 struct {
	Standalone bool `json:"standalone,omitempty"`
}

func sortedKeeperFeePayerActionsV2() []string {
	actions := make([]string, 0, len(keeperFeePayerActionsV2))
	for action := range keeperFeePayerActionsV2 {
		actions = append(actions, action)
	}
	sort.Strings(actions)
	return actions
}

func keeperFeePayerWalletIDV2(miningWalletID string) string {
	digest := sha256.Sum256([]byte(normalizeWalletID(miningWalletID)))
	return "sat_kfp_" + hex.EncodeToString(digest[:])[:56]
}

func keeperRuntimeFromMiningPolicyV2(policy signerPolicyV2) (signerRoleBaselineRuntimeV1, error) {
	if policy.Role != "mining" || !policy.TypedSATPrograms {
		return signerRoleBaselineRuntimeV1{}, errors.New("Mining parent lacks a release-bound typed SAT policy")
	}
	programID := ""
	for _, action := range sortedKeeperFeePayerActionsV2() {
		if strings.HasSuffix(action, "V2") {
			continue
		}
		prefix := "sat." + action + "@"
		matched := ""
		for _, operation := range policy.Operations {
			if strings.HasPrefix(operation, prefix) {
				if matched != "" {
					return signerRoleBaselineRuntimeV1{}, errors.New("Mining parent contains ambiguous keeper program bindings")
				}
				matched = strings.TrimPrefix(operation, prefix)
			}
		}
		if matched == "" || (programID != "" && matched != programID) {
			return signerRoleBaselineRuntimeV1{}, errors.New("Mining parent lacks one complete keeper action program binding")
		}
		programID = matched
	}
	if _, err := normalizePublicKeyV2(programID, "Mining parent SAT program ID"); err != nil {
		return signerRoleBaselineRuntimeV1{}, err
	}
	return signerRoleBaselineRuntimeV1{SATProgramID: programID, Verified: true}, nil
}

func keeperRuntimeFromKeeperPolicyV2(policy signerPolicyV2) (signerRoleBaselineRuntimeV1, error) {
	if policy.Role != "keeper" || !policy.TypedSATPrograms {
		return signerRoleBaselineRuntimeV1{}, errors.New("Keeper wallet lacks a release-bound typed SAT policy")
	}
	programID := ""
	for _, action := range sortedKeeperFeePayerActionsV2() {
		matched := ""
		prefix := "satKeeperFee." + action + "@"
		for _, operation := range policy.Operations {
			if strings.HasPrefix(operation, prefix) {
				if matched != "" {
					return signerRoleBaselineRuntimeV1{}, errors.New("Keeper wallet contains ambiguous program bindings")
				}
				matched = strings.TrimPrefix(operation, prefix)
			}
		}
		if matched == "" || (programID != "" && matched != programID) {
			return signerRoleBaselineRuntimeV1{}, errors.New("Keeper wallet lacks one complete action program binding")
		}
		programID = matched
	}
	if _, err := normalizePublicKeyV2(programID, "Keeper wallet SAT program ID"); err != nil {
		return signerRoleBaselineRuntimeV1{}, err
	}
	return signerRoleBaselineRuntimeV1{SATProgramID: programID, Verified: true}, nil
}

func (s *signerServiceV2) keeperFeePayerCapabilityV2(miningWalletID string) (signerKeeperFeePayerCapabilityV2, error) {
	miningWalletID = normalizeWalletID(miningWalletID)
	miningPolicy, err := s.store.getPolicy(miningWalletID)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	miningWallet, err := s.keys.PublicRecord(miningWalletID)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	feePayerWalletID := keeperFeePayerWalletIDV2(miningWalletID)
	keeperRuntime, err := keeperRuntimeFromMiningPolicyV2(miningPolicy)
	if miningPolicy.Role == "keeper" {
		feePayerWalletID = miningWalletID
		keeperRuntime, err = keeperRuntimeFromKeeperPolicyV2(miningPolicy)
	}
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	wallet, err := s.keys.PublicRecord(feePayerWalletID)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	policy, err := s.store.getPolicy(feePayerWalletID)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	if policy.Role != "keeper" || policy.BaselineVersion != signerRoleBaselineVersionV1 ||
		wallet.PublicKey == "" || (miningPolicy.Role == "mining" && wallet.PublicKey == miningWallet.PublicKey) {
		return signerKeeperFeePayerCapabilityV2{}, errors.New("stored keeper fee-payer capability is invalid or not authority-separated")
	}
	asset, err := policyAssetByNameV2(policy, "solana:native")
	if err != nil || asset.MaxPerTx != roleBaselineKeeperMaxPerTxV1 || asset.MaxDaily != roleBaselineKeeperMaxDailyV1 {
		return signerKeeperFeePayerCapabilityV2{}, errors.New("stored keeper fee-payer limits do not match the signer-owned baseline")
	}
	for _, action := range sortedKeeperFeePayerActionsV2() {
		if !containsStringV2(policy.Operations, "satKeeperFee."+action+"@"+keeperRuntime.SATProgramID) {
			return signerKeeperFeePayerCapabilityV2{}, errors.New("stored keeper fee-payer program binding is incomplete")
		}
	}
	return signerKeeperFeePayerCapabilityV2{
		MiningWalletID: miningWalletID, FeePayerWalletID: feePayerWalletID,
		FeePayerPublicKey: wallet.PublicKey, PolicyHash: policy.Hash,
		MaxPerTransaction: asset.MaxPerTx, MaxDaily: asset.MaxDaily, State: "ready",
	}, nil
}

func (s *signerServiceV2) ensureKeeperFeePayerCapabilityV2(miningWalletID string) (signerKeeperFeePayerCapabilityV2, error) {
	miningWalletID = normalizeWalletID(miningWalletID)
	miningWallet, err := s.keys.PublicRecord(miningWalletID)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	miningPolicy, err := s.store.getPolicy(miningWalletID)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	if miningPolicy.Role != "mining" {
		return signerKeeperFeePayerCapabilityV2{}, errors.New("keeper fee payer requires a Mining-role parent wallet")
	}
	keeperRuntime, err := keeperRuntimeFromMiningPolicyV2(miningPolicy)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, err
	}
	feePayerWalletID := keeperFeePayerWalletIDV2(miningWalletID)
	if existing, existingErr := s.keeperFeePayerCapabilityV2(miningWalletID); existingErr == nil {
		return existing, nil
	}
	wallet, _, err := s.keys.CreateWithRoleBaseline(
		feePayerWalletID,
		0,
		signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: "keeper"},
		keeperRuntime,
	)
	if err != nil {
		return signerKeeperFeePayerCapabilityV2{}, fmt.Errorf("create signer-owned keeper fee payer: %w", err)
	}
	if wallet.PublicKey == miningWallet.PublicKey {
		return signerKeeperFeePayerCapabilityV2{}, errors.New("generated keeper fee payer reused the Mining authority")
	}
	return s.keeperFeePayerCapabilityV2(miningWalletID)
}

func (s *signerServiceV2) ensureStandaloneKeeperCapabilityV2(walletID string) (signerKeeperFeePayerCapabilityV2, error) {
	walletID = normalizeWalletID(walletID)
	if existing, err := s.keeperFeePayerCapabilityV2(walletID); err == nil && existing.FeePayerWalletID == walletID {
		return existing, nil
	}
	if signerSATReleaseAcknowledgementGeneration2.ComponentGenerations.Protocol != "SAT-PROTO-GEN-002" ||
		signerSATReleaseAcknowledgementGeneration2.ComponentGenerations.Keeper != "SAT-KEEPER-GEN-002" {
		return signerKeeperFeePayerCapabilityV2{}, errors.New("standalone Keeper provisioning requires the frozen generation-2 contract")
	}
	runtime := signerRoleBaselineRuntimeFromEnvV1()
	if !runtime.Verified {
		return signerKeeperFeePayerCapabilityV2{}, errors.New("standalone Keeper provisioning requires the verified release-bound SAT runtime")
	}
	if _, _, err := s.keys.CreateWithRoleBaseline(
		walletID,
		0,
		signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: "keeper"},
		runtime,
	); err != nil {
		return signerKeeperFeePayerCapabilityV2{}, fmt.Errorf("create standalone signer-owned Keeper: %w", err)
	}
	return s.keeperFeePayerCapabilityV2(walletID)
}

func requireKeeperFeePayerActionV2(action string) error {
	action = strings.TrimSpace(action)
	if _, ok := keeperFeePayerActionsV2[action]; !ok {
		return errors.New("SAT action is not an allowlisted keeper action")
	}
	return nil
}
