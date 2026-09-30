package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"maps"
	"math/big"
	"reflect"
	"strconv"
	"strings"
)

// Required launch ceiling shares the existing owner SOL budget.
func wenStakingLaunchScopeV1(walletID string, v signerWENStakingIntentV1) string {
	return wenMiningNativeScopeV1(walletID, v.Genesis) + ":launch:" + wenHashV1([]byte(v.ProgramID+":"+v.Sale))
}

// Internal accounting primitive: total must come from reviewed signer preparation.
// Deposit principal is policy-checked; this does not bind a message or enable signing.
func (s *signerStoreV2) reserveWENStakingBudgetV1(requestID, walletID, policyHash string, v signerWENStakingIntentV1, wallet solana.PublicKey, total uint64) (string, bool, error) {
	return s.reserveWENStakingBoundBudgetV1(requestID, walletID, policyHash, v, wallet, total, nil)
}
func (s *signerStoreV2) reserveWENStakingBoundBudgetV1(requestID, walletID, policyHash string, v signerWENStakingIntentV1, wallet solana.PublicKey, total uint64, prepared *wenStakingMessageBindingV1) (string, bool, error) {
	bad := errors.New("WEN staking policy or fee reservation rejected")
	if s == nil || s.db == nil || walletID == "" || normalizeWalletID(walletID) != walletID || wallet.IsZero() || (!strings.HasPrefix(policyHash, "sha256:") || !wenReservationHashV1(strings.TrimPrefix(policyHash, "sha256:"))) {
		return "", false, bad
	}
	if _, e := validateRequestIDV2(requestID); e != nil {
		return "", false, e
	}
	if e := validateWENStakingIntentV1(v); e != nil {
		return "", false, e
	}
	ix, e := buildWENStakingInstructionV1(v, wallet)
	if e != nil {
		return "", false, e
	}
	if prepared != nil {
		if e := validateWENStakingMessageBindingV1(v, wallet, total, *prepared); e != nil {
			return "", false, e
		}
		raw, err := json.Marshal(prepared)
		if err != nil {
			return "", false, err
		}
		var copy wenStakingMessageBindingV1
		if err = json.Unmarshal(raw, &copy); err != nil {
			return "", false, err
		}
		prepared = &copy
	}
	fee := total
	if fee == 0 {
		return "", false, bad
	}
	scope := wenMiningNativeScopeV1(walletID, v.Genesis)
	scopes := map[string]uint64{scope: fee}
	claims := map[string]uint64{"solana:native": fee}
	principal, _ := strconv.ParseUint(v.Amount, 10, 64)
	tokenAsset := "solana:spl:" + v.Mint
	if v.Operation == "deposit" {
		claims[tokenAsset] = principal
	}
	binding, _ := json.Marshal(struct {
		Kind, WalletID, Wallet, PolicyHash string
		Intent                             signerWENStakingIntentV1
		Total                              uint64
		Prepared                           *wenStakingMessageBindingV1
	}{intentWENStakingV1, walletID, wallet.String(), policyHash, v, total, prepared})
	digest := wenHashV1(binding)
	actionKey := []byte("staking-action:" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Sale+":"+wallet.String()+":"+v.TokenAccount+":"+v.Operation+":"+v.Day+":"+v.Last+":"+v.AggregateFrom)))
	existing := false
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		launchScope := wenStakingLaunchScopeV1(walletID, v)
		if b.Get([]byte("limit:"+launchScope)) == nil {
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
		if json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID)), &policy) != nil || policy.WalletID != walletID || policy.Hash != policyHash || !containsStringV2(policy.Operations, intentWENStakingV1+"."+v.Operation) || !containsStringV2(policy.Programs, v.ProgramID) {
			return bad
		}
		asset, e := policyAssetByNameV2(policy, "solana:native")
		if e != nil {
			return e
		}
		cap, ok := new(big.Int).SetString(asset.MaxPerTx, 10)
		if !ok || cap.Sign() <= 0 || new(big.Int).SetUint64(fee).Cmp(cap) > 0 || !containsStringV2(asset.Destinations, v.Sale) {
			return bad
		}
		if v.Operation == "deposit" {
			token, e := policyAssetByNameV2(policy, tokenAsset)
			if e != nil {
				return e
			}
			cap, ok := new(big.Int).SetString(token.MaxPerTx, 10)
			if !ok || cap.Sign() <= 0 || new(big.Int).SetUint64(principal).Cmp(cap) > 0 || !containsStringV2(token.Destinations, ix.Accounts()[7].PublicKey.String()) {
				return bad
			}
		}
		day := currentDayBucket(s.now())
		key := []byte("request:" + requestID)
		if raw := b.Get(key); raw != nil {
			var r wenBudgetReservationV1
			if json.Unmarshal(raw, &r) != nil || !reflect.DeepEqual(r.StakingPrepared, prepared) || r.StakingIntent == nil || *r.StakingIntent != v || r.Version != 1 || r.Digest != digest || r.State != "reserved" || r.MessageSHA256 != "" || r.Signature != "" || r.WalletID != walletID || r.WalletPublicKey != wallet.String() || r.PolicyHash != policyHash || r.UsageDay != day || r.Genesis != v.Genesis || r.MinFinalizedSlot != v.MinFinalizedSlot || !maps.Equal(r.Scopes, scopes) || !maps.Equal(r.WalletClaims, claims) || string(b.Get(actionKey)) != requestID {
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
		raw, e := json.Marshal(wenBudgetReservationV1{StakingPrepared: prepared, StakingIntent: &v, Genesis: v.Genesis, MinFinalizedSlot: v.MinFinalizedSlot, WalletPublicKey: wallet.String(), State: "reserved", Version: 1, Digest: digest, Scopes: scopes, WalletID: walletID, PolicyHash: policyHash, UsageDay: day, WalletClaims: claims})
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
