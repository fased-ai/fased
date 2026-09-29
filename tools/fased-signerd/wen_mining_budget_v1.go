package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"maps"
	"math/big"
	"strconv"
	"strings"
)

func wenMiningNativeScopeV1(walletID, genesis string) string {
	return "wallet:" + wenHashV1([]byte(walletID)) + ":" + genesis + ":sol"
}

// Optional launch ceiling complements, never replaces, the owner SOL ceiling.
func wenMiningLaunchScopeV1(walletID string, v signerWENMiningIntentV1) string {
	return wenMiningNativeScopeV1(walletID, v.Genesis) + ":launch:" + wenHashV1([]byte(v.ProgramID+":"+v.Economy))
}

// Internal reservation only: caller must still perform protected readback,
// preimage loading and simulation. No signature or broadcast is authorized here.
func (s *signerStoreV2) reserveWENMiningBudgetV1(requestID, walletID, policyHash string, v signerWENMiningIntentV1, wallet solana.PublicKey) (string, bool, error) {
	return s.reserveWENMiningBudgetModeV1(requestID, walletID, policyHash, v, wallet, false)
}

func (s *signerStoreV2) reserveWENMiningBudgetModeV1(requestID, walletID, policyHash string, v signerWENMiningIntentV1, wallet solana.PublicKey, requireLaunch bool) (string, bool, error) {
	bad := errors.New("WEN mining policy or fee reservation rejected")
	if s == nil || s.db == nil || walletID == "" || normalizeWalletID(walletID) != walletID || wallet.IsZero() || (!strings.HasPrefix(policyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(policyHash, "sha256:"))) {
		return "", false, bad
	}
	if _, e := validateRequestIDV2(requestID); e != nil {
		return "", false, e
	}
	if e := validateWENMiningIntentV1(v); e != nil {
		return "", false, e
	}
	fee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	scope := wenMiningNativeScopeV1(walletID, v.Genesis)
	scopes := map[string]uint64{scope: fee}
	claims := map[string]uint64{"solana:native": fee}
	binding, _ := json.Marshal(struct {
		Kind, WalletID, Wallet, PolicyHash string
		Intent                             signerWENMiningIntentV1
	}{intentWENMiningV1, walletID, wallet.String(), policyHash, v})
	digest := wenHashV1(binding)
	actionKey := []byte("mining-action:" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Entry+":"+v.Operation)))
	existing := false
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		launchScope := wenMiningLaunchScopeV1(walletID, v)
		if requireLaunch && b.Get([]byte("limit:"+launchScope)) == nil {
			return bad
		}
		if b.Get([]byte("limit:"+launchScope)) != nil {
			scopes[launchScope] = fee
		}
		retired, e := signerWalletIsRetiredInTxV2(tx, walletID)
		if e != nil {
			return e
		}
		if retired {
			return bad
		}
		var record signerWalletRecordV2
		var policy signerPolicyV2
		if json.Unmarshal(tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)), &record) != nil || record.PublicKey != wallet.String() {
			return bad
		}
		if json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID)), &policy) != nil || policy.WalletID != walletID || policy.Hash != policyHash || !containsStringV2(policy.Operations, intentWENMiningV1+"."+v.Operation) || !containsStringV2(policy.Programs, v.ProgramID) {
			return bad
		}
		asset, e := policyAssetByNameV2(policy, "solana:native")
		if e != nil {
			return e
		}
		cap, ok := new(big.Int).SetString(asset.MaxPerTx, 10)
		if !ok || cap.Sign() <= 0 || new(big.Int).SetUint64(fee).Cmp(cap) > 0 || !containsStringV2(asset.Destinations, v.Economy) {
			return bad
		}
		day := currentDayBucket(s.now())
		key := []byte("request:" + requestID)
		if raw := b.Get(key); raw != nil {
			var r wenBudgetReservationV1
			if json.Unmarshal(raw, &r) != nil || r.MiningIntent == nil || *r.MiningIntent != v || r.Version != 1 || r.Digest != digest || r.State != "reserved" || r.MessageSHA256 != "" || r.Signature != "" || r.WalletID != walletID || r.WalletPublicKey != wallet.String() || r.PolicyHash != policyHash || r.UsageDay != day || r.Genesis != v.Genesis || r.MinFinalizedSlot != v.MinFinalizedSlot || !maps.Equal(r.Scopes, scopes) || !maps.Equal(r.WalletClaims, claims) || string(b.Get(actionKey)) != requestID {
				return bad
			}
			existing = true
			return nil
		}
		if b.Get(actionKey) != nil {
			return bad
		}
		if e := reserveWENPolicyUsageV1(tx, walletID, claims, day); e != nil {
			return e
		}
		for reservationScope, amount := range scopes {
			var balance wenBudgetBalanceV1
			if json.Unmarshal(b.Get([]byte("limit:"+reservationScope)), &balance) != nil || balance.Limit == 0 || balance.Reserved > balance.Limit || amount > balance.Limit-balance.Reserved {
				return bad
			}
			balance.Reserved += amount
			raw, err := json.Marshal(balance)
			if err != nil {
				return err
			}
			if err = b.Put([]byte("limit:"+reservationScope), raw); err != nil {
				return err
			}
		}
		raw, e := json.Marshal(wenBudgetReservationV1{MiningIntent: &v, Genesis: v.Genesis, MinFinalizedSlot: v.MinFinalizedSlot, WalletPublicKey: wallet.String(), State: "reserved", Version: 1, Digest: digest, Scopes: scopes, WalletID: walletID, PolicyHash: policyHash, UsageDay: day, WalletClaims: claims})
		if e != nil {
			return e
		}
		if e = b.Put(key, raw); e != nil {
			return e
		}
		return b.Put(actionKey, []byte(requestID))
	})
	if err != nil {
		return "", false, err
	}
	return digest, existing, nil
}
