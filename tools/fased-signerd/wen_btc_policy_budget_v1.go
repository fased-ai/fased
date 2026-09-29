package main

import (
	"encoding/json"
	"errors"
	"math/big"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func (s *signerStoreV2) reserveWENPolicyBudgetV1(requestID, walletID, policyHash string, a signerWENBTCArtifactsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey) (bool, error) {
	if policyHash == "" {
		return false, errors.New("explicit WEN policy hash required")
	}
	return s.reserveWENBudgetPolicyInternalV1(requestID, walletID, policyHash, a, intent, wallet)
}
func validateWENPolicyBudgetV1(tx *bolt.Tx, walletID, hash string, a signerWENBTCArtifactsV1, intent signerWENBTCIntentV1, e signerWENBTCExposureV1, wallet solana.PublicKey) (map[string]uint64, error) {
	bad := errors.New("WEN owner policy does not authorize reservation")
	var record signerWalletRecordV2
	if json.Unmarshal(tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)), &record) != nil || record.PublicKey != wallet.String() {
		return nil, bad
	}
	raw := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
	var p signerPolicyV2
	if raw == nil || json.Unmarshal(raw, &p) != nil || p.Hash != hash || p.WalletID != walletID || !containsStringV2(p.Operations, intentWENBTCSubscriptionV1+"."+intent.Operation) {
		return nil, bad
	}
	programs := []string{a.program.String(), solana.TokenProgramID.String()}
	if intent.Operation == "acquisition" {
		programs = append(programs, a.keys[5].String())
	}
	for _, program := range programs {
		if !containsStringV2(p.Programs, program) {
			return nil, bad
		}
	}
	claims := map[string]uint64{"solana:native": e.NativeLamports}
	if e.WalletCashRaw > 0 {
		claims["solana:spl:"+e.CashMint.String()] = e.WalletCashRaw
	}
	for asset, amount := range claims {
		limit, err := policyAssetByNameV2(p, asset)
		if err != nil {
			return nil, err
		}
		// Explicit WEN sale is the semantic target; the immutable offer and program
		// enforce its actual custody routes. Broad reviewed-destination flags do not suffice.
		if !containsStringV2(limit.Destinations, a.keys[0].String()) {
			return nil, bad
		}
		cap, ok := new(big.Int).SetString(limit.MaxPerTx, 10)
		if !ok || cap.Sign() <= 0 || new(big.Int).SetUint64(amount).Cmp(cap) > 0 {
			return nil, bad
		}
	}
	return claims, nil
}
func reserveWENPolicyUsageV1(tx *bolt.Tx, walletID string, claims map[string]uint64, day string) error {
	var p signerPolicyV2
	if err := json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID)), &p); err != nil {
		return err
	}
	usage := tx.Bucket(bucketSignerUsageV2)
	for asset, amount := range claims {
		limit, err := policyAssetByNameV2(p, asset)
		if err != nil {
			return err
		}
		cap, ok := new(big.Int).SetString(limit.MaxDaily, 10)
		if !ok || cap.Sign() <= 0 {
			return errors.New("invalid WEN policy daily cap")
		}
		key := dailyUsageKeyV2(walletID, asset, day)
		used := new(big.Int)
		if raw := usage.Get(key); raw != nil {
			if _, ok = used.SetString(string(raw), 10); !ok || used.Sign() < 0 {
				return errors.New("invalid shared usage")
			}
		}
		used.Add(used, new(big.Int).SetUint64(amount))
		if used.Cmp(cap) > 0 {
			return errors.New("WEN shared daily budget exhausted")
		}
		if err = usage.Put(key, []byte(used.String())); err != nil {
			return err
		}
	}
	return nil
}
