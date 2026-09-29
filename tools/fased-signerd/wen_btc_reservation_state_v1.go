package main

import (
	"encoding/json"
	"errors"
	"math/big"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

// Internal only. The execution owner must win this durable fence BEFORE asking
// for any signature. A repeat is rejected even for the same message: a restart
// cannot establish whether the former worker obtained or submitted a signature.
func (s *signerStoreV2) beginWENSigningV1(requestID, digest, messageSHA string) error {
	return s.beginWENSigningAccountsV1(requestID, digest, messageSHA, nil)
}
func (s *signerStoreV2) beginWENSigningAccountsV1(requestID, digest, messageSHA string, accountKeys []string, minimumSlot ...uint64) error {
	accountKeys = append([]string(nil), accountKeys...)
	if !wenReservationHashV1(messageSHA) {
		return errors.New("invalid WEN message hash")
	}
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "reserved" || r.MessageSHA256 != "" || r.UsageDay != currentDayBucket(s.now()) {
			return errors.New("WEN signing fence already crossed or unavailable")
		}
		if r.MiningClaimIntent != nil || r.MiningClaimPrepared != nil {
			if e := validateWENMiningClaimFenceV1(*r, messageSHA, accountKeys, minimumSlot); e != nil {
				return e
			}
		}
		if r.MiningFundingIntent != nil || r.MiningFundingPrepared != nil {
			if e := validateWENMiningFundingFenceV1(*r, messageSHA, accountKeys, minimumSlot); e != nil {
				return e
			}
		}
		if r.NativeClaimIntent != nil || r.NativeClaimPrepared != nil {
			if e := validateWENNativeClaimFenceV1(*r, messageSHA, accountKeys, minimumSlot); e != nil {
				return e
			}
		}
		if r.BTCClaimIntent != nil || r.BTCClaimPrepared != nil {
			if e := validateWENBTCClaimFenceV1(*r, messageSHA, accountKeys, minimumSlot); e != nil {
				return e
			}
		}
		if r.WithdrawalIntent != nil {
			if e := validateWENWithdrawalFenceV1(*r, messageSHA, accountKeys, minimumSlot); e != nil {
				return e
			}
		}
		if r.StakingIntent != nil {
			if e := validateWENStakingFenceV1(*r, messageSHA, accountKeys, minimumSlot); e != nil {
				return e
			}
		}
		var p signerPolicyV2
		if json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(r.WalletID)), &p) != nil || p.Hash != r.PolicyHash || p.WalletID != r.WalletID {
			return errors.New("WEN policy changed before signing fence")
		}
		if accountKeys != nil {
			if len(accountKeys) == 0 || len(accountKeys) > 256 || accountKeys[0] != r.WalletPublicKey {
				return errors.New("invalid WEN resolved payer")
			}
			seen := map[string]bool{}
			for _, key := range accountKeys {
				pub, err := solana.PublicKeyFromBase58(key)
				if err != nil || pub.String() != key || seen[key] {
					return errors.New("invalid WEN resolved accounts")
				}
				seen[key] = true
			}
		}
		if len(minimumSlot) > 1 {
			return errors.New("invalid WEN execution slot")
		}
		if len(minimumSlot) == 1 {
			if minimumSlot[0] == 0 {
				return errors.New("invalid WEN execution slot")
			}
			r.MinExecutionSlot = minimumSlot[0]
		}
		r.AccountKeys = accountKeys
		r.State, r.MessageSHA256 = "signing", messageSHA
		return nil
	})
}

// Cancellation is allowed only before the signing fence. Release and the terminal
// tombstone commit together; original-day counters are used even after midnight.
// Offer exclusion is deliberately retained, so cancellation cannot recycle an
// accepted offer into a new entitlement. No signed-outcome refund is inferred.
func (s *signerStoreV2) cancelWENReservationV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State == "cancelled" {
			return nil
		}
		if r.State != "reserved" || r.MessageSHA256 != "" {
			return errors.New("WEN reservation may have been signed; reconciliation required")
		}
		b := tx.Bucket(wenBudgetBucketV1)
		for scope, amount := range r.Scopes {
			var v wenBudgetBalanceV1
			if json.Unmarshal(b.Get([]byte("limit:"+scope)), &v) != nil || amount == 0 || v.Reserved < amount || v.Reserved > v.Limit {
				return errors.New("invalid WEN scope release")
			}
			v.Reserved -= amount
			raw, err := json.Marshal(v)
			if err != nil {
				return err
			}
			if err := b.Put([]byte("limit:"+scope), raw); err != nil {
				return err
			}
		}
		u := tx.Bucket(bucketSignerUsageV2)
		for asset, amount := range r.WalletClaims {
			key := dailyUsageKeyV2(r.WalletID, asset, r.UsageDay)
			used, ok := new(big.Int).SetString(string(u.Get(key)), 10)
			n := new(big.Int).SetUint64(amount)
			if !ok || used.Cmp(n) < 0 {
				return errors.New("WEN original usage counter missing or insufficient")
			}
			used.Sub(used, n)
			if err := u.Put(key, []byte(used.String())); err != nil {
				return err
			}
		}
		r.State = "cancelled"
		return nil
	})
}

func wenReservationHashV1(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (s *signerStoreV2) changeWENReservationV1(requestID, digest string, mutate func(*bolt.Tx, *wenBudgetReservationV1) error) error {
	if s == nil || s.db == nil || !wenReservationHashV1(digest) {
		return errors.New("invalid WEN reservation reference")
	}
	if _, err := validateRequestIDV2(requestID); err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("WEN reservation unavailable")
		}
		key := []byte("request:" + requestID)
		var r wenBudgetReservationV1
		if json.Unmarshal(b.Get(key), &r) != nil || r.Version != 1 || r.Digest != digest || r.WalletID == "" || normalizeWalletID(r.WalletID) != r.WalletID || r.PolicyHash == "" || len(r.WalletClaims) == 0 || len(r.Scopes) == 0 {
			return errors.New("WEN reservation requires reconciliation")
		}
		day, err := time.Parse("2006-01-02", r.UsageDay)
		if err != nil || currentDayBucket(day) != r.UsageDay {
			return errors.New("invalid WEN usage day")
		}
		for asset, amount := range r.WalletClaims {
			if asset == "" || amount == 0 {
				return errors.New("invalid WEN claim")
			}
		}
		if err := mutate(tx, &r); err != nil {
			return err
		}
		raw, err := json.Marshal(r)
		if err != nil {
			return err
		}
		return b.Put(key, raw)
	})
}
