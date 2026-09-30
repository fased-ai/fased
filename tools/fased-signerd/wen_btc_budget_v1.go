package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

var wenBudgetBucketV1 = []byte("wen-budget-v1")

type wenBudgetBalanceV1 struct{ Limit, Reserved uint64 }
type wenBudgetReservationV1 struct {
	ClaimAuthorization                                                           *wenMiningClaimAuthorizationV1     `json:",omitempty"`
	MiningClaimEffectsSHA256                                                     string                             `json:",omitempty"`
	MiningClaimIntent                                                            *signerWENMiningClaimIntentV1      `json:",omitempty"`
	MiningClaimPrepared                                                          *wenMiningClaimMessageBindingV1    `json:",omitempty"`
	MiningFundingEffectsSHA256                                                   string                             `json:",omitempty"`
	MiningFundingIntent                                                          *signerWENMiningFundingIntentV1    `json:",omitempty"`
	MiningFundingPrepared                                                        *wenMiningFundingMessageBindingV1  `json:",omitempty"`
	NativeClaimEffectsSHA256                                                     string                             `json:",omitempty"`
	NativeClaimIntent                                                            *signerWENNativeClaimIntentV1      `json:",omitempty"`
	NativeClaimPrepared                                                          *wenNativeClaimMessageBindingV1    `json:",omitempty"`
	BTCClaimEffectsSHA256                                                        string                             `json:",omitempty"`
	BTCClaimIntent                                                               *signerWENBTCClaimIntentV1         `json:",omitempty"`
	BTCClaimPrepared                                                             *wenBTCClaimMessageBindingV1       `json:",omitempty"`
	WithdrawalObservation                                                        *wenWithdrawalDurableObservationV1 `json:",omitempty"`
	WithdrawalEffectsSHA256                                                      string                             `json:",omitempty"`
	WithdrawalPrepared                                                           *wenWithdrawalMessageBindingV1     `json:",omitempty"`
	WithdrawalIntent                                                             *signerWENWithdrawalIntentV1       `json:",omitempty"`
	StakingObservation                                                           *wenStakingDurableObservationV1    `json:",omitempty"`
	StakingPrepared                                                              *wenStakingMessageBindingV1        `json:",omitempty"`
	MiningPins                                                                   *wenMiningPinsV1                   `json:",omitempty"`
	MiningObservedSlot                                                           uint64                             `json:",omitempty"`
	MiningObservedSHA256                                                         string                             `json:",omitempty"`
	StakingIntent                                                                *signerWENStakingIntentV1          `json:",omitempty"`
	MiningIntent                                                                 *signerWENMiningIntentV1           `json:",omitempty"`
	MiningEntry                                                                  *wenMiningEntrySnapshotV1          `json:",omitempty"`
	MiningEffectsSHA256                                                          string                             `json:",omitempty"`
	StakingEffectsSHA256                                                         string                             `json:",omitempty"`
	Genesis, MinFinalizedSlot                                                    string
	MinExecutionSlot                                                             uint64
	OutcomeSlot, OutcomeFee                                                      uint64
	OutcomeError                                                                 string
	FailedEffectsSHA256                                                          string
	FailedBudgetSettled                                                          bool
	AccountKeys                                                                  []string
	SuccessNativeDebit                                                           uint64
	SuccessEffectsSHA256, SuccessFundingEffectsSHA256, SuccessTokenEffectsSHA256 string
	SuccessBudgetSettled                                                         bool
	SuccessTokenEffects                                                          []wenTokenEffectV1
	State, MessageSHA256, WalletPublicKey, Signature                             string
	SignedMessage                                                                []byte
	Version                                                                      int
	Digest                                                                       string
	Scopes                                                                       map[string]uint64
	WalletID, PolicyHash, UsageDay                                               string
	WalletClaims                                                                 map[string]uint64
}

// Internal immutable limit configuration. No reset is inferred from time.
func (s *signerStoreV2) configureWENBudgetV1(scope string, limit uint64) error {
	if scope == "" || limit == 0 {
		return errors.New("invalid WEN budget")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b, e := tx.CreateBucketIfNotExists(wenBudgetBucketV1)
		if e != nil {
			return e
		}
		key := []byte("limit:" + scope)
		if old := b.Get(key); old != nil {
			var v wenBudgetBalanceV1
			if json.Unmarshal(old, &v) != nil || v.Limit != limit {
				return errors.New("WEN budget already configured differently")
			}
			return nil
		}
		raw, _ := json.Marshal(wenBudgetBalanceV1{Limit: limit})
		return b.Put(key, raw)
	})
}
func wenBudgetScopesV1(walletID string, intent signerWENBTCIntentV1, e signerWENBTCExposureV1) map[string]uint64 {
	wallet := "wallet:" + wenHashV1([]byte(walletID)) + ":" + intent.Genesis + ":"
	scopes := map[string]uint64{wallet + "sol": e.NativeLamports}
	if e.WalletCashRaw > 0 {
		scopes[wallet+e.CashMint.String()] = e.WalletCashRaw
	}
	if e.CustodyCashRaw > 0 {
		scopes["custody:"+intent.Genesis+":"+e.CustodyAccount.String()+":"+e.CashMint.String()] = e.CustodyCashRaw
	}
	return scopes
}

// Isolated ledger-test entry. Execution must use the policy-bound entry.
func (s *signerStoreV2) reserveWENBudgetV1(requestID, walletID string, a signerWENBTCArtifactsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey) (bool, error) {
	return s.reserveWENBudgetPolicyInternalV1(requestID, walletID, "", a, intent, wallet)
}
func (s *signerStoreV2) reserveWENBudgetPolicyInternalV1(requestID, walletID, policyHash string, a signerWENBTCArtifactsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey) (bool, error) {
	if s == nil || s.db == nil {
		return false, errors.New("WEN budget store unavailable")
	}
	if _, err := validateRequestIDV2(requestID); err != nil {
		return false, err
	}
	if walletID == "" || normalizeWalletID(walletID) != walletID {
		return false, errors.New("invalid WEN budget wallet")
	}
	exposure, err := wenBTCExposureV1(a, intent, wallet)
	if err != nil {
		return false, err
	}
	scopes := wenBudgetScopesV1(walletID, intent, exposure)
	digest := wenBudgetDigestV1(policyHash, walletID, wallet, intent, scopes)
	offerKey := []byte("offer:" + wenHashV1([]byte(intent.Genesis+":"+intent.ProgramID+":"+intent.OfferSHA256+":"+intent.Operation)))
	existing := false
	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("explicit WEN budgets required")
		}
		var walletClaims map[string]uint64
		if policyHash != "" {
			var e error
			walletClaims, e = validateWENPolicyBudgetV1(tx, walletID, policyHash, a, intent, exposure, wallet)
			if e != nil {
				return e
			}
		}
		key := []byte("request:" + requestID)
		if raw := b.Get(key); raw != nil {
			var r wenBudgetReservationV1
			if json.Unmarshal(raw, &r) != nil || r.Digest != digest {
				return errors.New("WEN request already bound differently")
			}
			if policyHash != "" {
				day, dayErr := time.Parse("2006-01-02", r.UsageDay)
				if r.State != "reserved" && r.State != "signing" {
					return errors.New("WEN reservation is not reusable")
				}
				if r.Version != 1 || r.Genesis != intent.Genesis || r.MinFinalizedSlot != intent.MinFinalizedSlot || r.WalletID != walletID || r.WalletPublicKey != wallet.String() || r.PolicyHash != policyHash || dayErr != nil || currentDayBucket(day) != r.UsageDay || !maps.Equal(r.WalletClaims, walletClaims) || !maps.Equal(r.Scopes, scopes) {
					return errors.New("WEN reservation metadata requires reconciliation")
				}
			}
			existing = true
			return nil
		}
		if b.Get(offerKey) != nil {
			return errors.New("WEN offer already reserved")
		}
		usageDay := ""
		if policyHash != "" {
			usageDay = currentDayBucket(s.now())
			if err := reserveWENPolicyUsageV1(tx, walletID, walletClaims, usageDay); err != nil {
				return err
			}
		}
		for scope, amount := range scopes {
			var v wenBudgetBalanceV1
			raw := b.Get([]byte("limit:" + scope))
			if raw == nil || json.Unmarshal(raw, &v) != nil || v.Limit == 0 || v.Reserved > v.Limit || amount == 0 || amount > v.Limit-v.Reserved {
				return errors.New("WEN budget capacity unavailable")
			}
			v.Reserved += amount
			next, _ := json.Marshal(v)
			if err := b.Put([]byte("limit:"+scope), next); err != nil {
				return err
			}
		}
		raw, _ := json.Marshal(wenBudgetReservationV1{Genesis: intent.Genesis, MinFinalizedSlot: intent.MinFinalizedSlot, WalletPublicKey: wallet.String(), State: "reserved", Version: 1, Digest: digest, Scopes: scopes, WalletID: walletID, PolicyHash: policyHash, UsageDay: usageDay, WalletClaims: walletClaims})
		if err := b.Put(key, raw); err != nil {
			return err
		}
		return b.Put(offerKey, []byte(requestID))
	})
	return existing, err
}
func (s *signerStoreV2) wenBudgetReservedV1(scope string) (uint64, error) {
	var value uint64
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("WEN budget missing")
		}
		raw := b.Get([]byte("limit:" + scope))
		var v wenBudgetBalanceV1
		if raw == nil || json.Unmarshal(raw, &v) != nil {
			return errors.New("WEN budget missing or invalid")
		}
		value = v.Reserved
		return nil
	})
	return value, err
}

// Pin original daily usage until cancellation or proved settlement. Unknown
// records conservatively suppress pruning until explicit reconciliation.
func wenReservedUsageKeysV1(tx *bolt.Tx) (map[string]bool, bool) {
	pinned := make(map[string]bool)
	b := tx.Bucket(wenBudgetBucketV1)
	if b == nil {
		return pinned, false
	}
	cursor := b.Cursor()
	prefix := []byte("request:")
	for key, raw := cursor.Seek(prefix); key != nil && bytes.HasPrefix(key, prefix); key, raw = cursor.Next() {
		var r wenBudgetReservationV1
		if json.Unmarshal(raw, &r) != nil || r.Version != 1 || r.WalletID == "" || normalizeWalletID(r.WalletID) != r.WalletID {
			return pinned, true
		}
		day, err := time.Parse("2006-01-02", r.UsageDay)
		if r.PolicyHash == "" || err != nil || currentDayBucket(day) != r.UsageDay || len(r.WalletClaims) == 0 {
			return pinned, true
		}
		if r.State == "cancelled" || r.State == "finalized-failed" && r.FailedBudgetSettled || r.State == "finalized-success" && r.SuccessBudgetSettled {
			continue
		}
		for asset, amount := range r.WalletClaims {
			if asset == "" || amount == 0 {
				return pinned, true
			}
			pinned[string(dailyUsageKeyV2(r.WalletID, asset, r.UsageDay))] = true
		}
	}
	// Typed families own their counters under Artifact.WalletID, rather than
	// the historical top-level WalletClaims record. Preserve every asset for
	// that wallet/day while settlement is unresolved, including retained recovery.
	for _, name := range []string{"campaign-request:", "campaign-stake-request:", "market-request:", "bond-purchase-request:", "bond-claim-request:"} {
		prefix := []byte(name)
		for key, raw := cursor.Seek(prefix); key != nil && bytes.HasPrefix(key, prefix); key, raw = cursor.Next() {
			var r struct {
				Version                        int
				State, UsageDay, OutcomeDigest string
				RetainedRecovery               uint64
				Artifact                       struct{ WalletID string }
			}
			version := 1
			if name == "bond-purchase-request:" || name == "bond-claim-request:" {
				version = 2
			}
			if json.Unmarshal(raw, &r) != nil || r.Version != version || r.Artifact.WalletID == "" || normalizeWalletID(r.Artifact.WalletID) != r.Artifact.WalletID {
				return pinned, true
			}
			day, err := time.Parse("2006-01-02", r.UsageDay)
			if err != nil || currentDayBucket(day) != r.UsageDay {
				return pinned, true
			}
			// These families atomically write outcome and settle budgets. A
			// terminal label alone is insufficient proof of settlement.
			if r.RetainedRecovery == 0 && (r.State == "cancelled" || r.State == "expired" || (r.State == "finalized-success" || r.State == "finalized-failed") && r.OutcomeDigest != "") {
				continue
			}
			u := tx.Bucket(bucketSignerUsageV2)
			if u == nil {
				return pinned, true
			}
			uc := u.Cursor()
			walletPrefix := append([]byte(r.Artifact.WalletID), 0)
			for k, _ := uc.Seek(walletPrefix); k != nil && bytes.HasPrefix(k, walletPrefix); k, _ = uc.Next() {
				parts := bytes.Split(k, []byte{0})
				if len(parts) != 3 {
					return pinned, true
				}
				if string(parts[2]) == r.UsageDay {
					pinned[string(k)] = true
				}
			}
		}
	}
	return pinned, false
}
func wenBudgetDigestV1(policyHash, walletID string, wallet solana.PublicKey, intent signerWENBTCIntentV1, scopes map[string]uint64) string {
	binding, _ := json.Marshal(struct {
		PolicyHash string
		WalletID   string
		Wallet     string
		Intent     signerWENBTCIntentV1
		Scopes     map[string]uint64
	}{policyHash, walletID, wallet.String(), intent, scopes})
	return wenHashV1(binding)
}
