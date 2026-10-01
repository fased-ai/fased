package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	signerpolicy "fased-signerd/internal/policy"
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
	return signerpolicy.RequireTightening(current, candidate)
}

func requireAutonomousRoleV2(policy signerPolicyV2, intent normalizedIntentV2) error {
	if policy.ApprovalMode != "" {
		return errors.New("wallet policy requires explicit owner approval; no automatic delegation is installed")
	}

	if policy.Role != "agent" {
 return errors.New("signer policy has an invalid ordinary wallet discriminator")
 }
	return nil
}
