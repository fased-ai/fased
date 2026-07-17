package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// tightenPolicy applies an application-requested policy change only when every
// permission and limit is a subset of the currently acknowledged policy. The
// comparison and write share one bbolt transaction so a concurrent root-owned
// policy update cannot turn a stale tightening request into an expansion.
func (s *signerStoreV2) tightenPolicy(input signerPolicyV2, expectedVersion uint64) (signerPolicyV2, error) {
	if s == nil || s.db == nil {
		return signerPolicyV2{}, errors.New("signer state database is unavailable")
	}
	var stored signerPolicyV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		walletID := normalizeWalletID(input.WalletID)
		if strings.TrimSpace(input.WalletID) == "" {
			return errors.New("walletId is required")
		}
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		retired, err := signerWalletIsRetiredInTxV2(tx, walletID)
		if err != nil {
			return err
		}
		if retired {
			return errors.New("retired signer wallet policy is permanently deny-all")
		}
		policies := tx.Bucket(bucketSignerPoliciesV2)
		raw := policies.Get([]byte(walletID))
		if raw == nil {
			return errors.New("explicit signer policy required")
		}
		var current signerPolicyV2
		if err := json.Unmarshal(raw, &current); err != nil {
			return fmt.Errorf("decode current signer policy: %w", err)
		}
		if current.Version != expectedVersion {
			return fmt.Errorf("signer policy version conflict: expected %d, current %d", expectedVersion, current.Version)
		}
		input.WalletID = walletID
		input.Version = current.Version + 1
		candidate, err := normalizeSignerPolicyV2(input)
		if err != nil {
			return err
		}
		if err := requirePolicyTighteningV2(current, candidate); err != nil {
			return err
		}
		encoded, err := json.Marshal(candidate)
		if err != nil {
			return err
		}
		if err := policies.Put([]byte(walletID), encoded); err != nil {
			return err
		}
		stored = candidate
		return nil
	})
	return stored, err
}

func requirePolicyTighteningV2(current, candidate signerPolicyV2) error {
	if current.WalletID != candidate.WalletID || current.Role != candidate.Role {
		return errors.New("application policy change cannot alter wallet identity or role")
	}
	if !stringSetSubsetV2(candidate.Operations, current.Operations) {
		return errors.New("application policy change cannot add operations")
	}
	if !stringSetSubsetV2(candidate.Programs, current.Programs) {
		return errors.New("application policy change cannot add programs")
	}
	currentAssets := make(map[string]signerPolicyAssetV2, len(current.Assets))
	for _, asset := range current.Assets {
		currentAssets[asset.Asset] = asset
	}
	for _, candidateAsset := range candidate.Assets {
		currentAsset, ok := currentAssets[candidateAsset.Asset]
		if !ok {
			return fmt.Errorf("application policy change cannot add asset %s", candidateAsset.Asset)
		}
		if !stringSetSubsetV2(candidateAsset.Destinations, currentAsset.Destinations) {
			return fmt.Errorf("application policy change cannot add destinations for %s", candidateAsset.Asset)
		}
		if !policyAmountAtMostV2(candidateAsset.MaxPerTx, currentAsset.MaxPerTx) {
			return fmt.Errorf("application policy change cannot raise per-transaction cap for %s", candidateAsset.Asset)
		}
		if !policyAmountAtMostV2(candidateAsset.MaxDaily, currentAsset.MaxDaily) {
			return fmt.Errorf("application policy change cannot raise daily cap for %s", candidateAsset.Asset)
		}
	}
	return nil
}

func stringSetSubsetV2(candidate, current []string) bool {
	allowed := make(map[string]bool, len(current))
	for _, value := range current {
		allowed[value] = true
	}
	for _, value := range candidate {
		if !allowed[value] {
			return false
		}
	}
	return true
}

func policyAmountAtMostV2(candidate, current string) bool {
	candidateAmount, candidateOK := new(big.Int).SetString(candidate, 10)
	currentAmount, currentOK := new(big.Int).SetString(current, 10)
	return candidateOK && currentOK && candidateAmount.Sign() > 0 && candidateAmount.Cmp(currentAmount) <= 0
}

func requireAutonomousRoleV2(policy signerPolicyV2, intent normalizedIntentV2) error {
	switch policy.Role {
	case "vault":
		return errors.New("Vault execution requires signer-reviewed authorization")
	case "mining":
		if intent.Intent.Type != intentSolanaSATAction {
			return errors.New("Mining autonomous execution is restricted to typed SAT operations")
		}
	case "agent":
		if intent.Intent.Type == intentSolanaSATAction {
			return errors.New("typed SAT mining operations require a Mining wallet")
		}
	default:
		return errors.New("signer policy has an invalid wallet role")
	}
	return nil
}
