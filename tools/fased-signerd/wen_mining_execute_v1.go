package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Internal configuration supplied by the execution owner, never an RPC request.
// Public mining dispatch must remain closed until deployment/runtime acceptance.
type wenMiningExecutionConfigV1 struct {
	reviewSHA           string
	RequireLaunchBudget bool
	Root                string
	Pins                wenMiningPinsV1
	MaxSlotLag          uint64
}
type wenMiningExecutionRPCV1 interface {
	wenMiningPrepareRPCV1
	wenMiningRecoveryRPCV1
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

func (s *signerStoreV2) miningExecutionStateV1(request, digest, policyHash, state string) error {
	return s.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		retired, e := signerWalletIsRetiredInTxV2(tx, r.WalletID)
		if e != nil {
			return e
		}
		var p signerPolicyV2
		if retired || r.State != state || r.PolicyHash != policyHash || r.UsageDay != currentDayBucket(s.now()) || json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(r.WalletID)), &p) != nil || p.Hash != policyHash || p.WalletID != r.WalletID {
			return errors.New("mining execution state changed")
		}
		return nil
	})
}

// Returns the durable reservation identity even on a later error. A caller must
// recover that identity, never generate a replacement signature after fencing.
func (s *signerServiceV2) executeWENMiningWithRPCV1(ctx context.Context, c wenMiningExecutionRPCV1, config wenMiningExecutionConfigV1, request, walletID, policyHash string, v signerWENMiningIntentV1, wallet solana.PublicKey) (digest, outcome string, err error) {
	return s.executeGuardedWENMiningWithRPCV1(ctx, c, config, request, walletID, policyHash, v, wallet, nil)
}
func (s *signerServiceV2) executeGuardedWENMiningWithRPCV1(ctx context.Context, c wenMiningExecutionRPCV1, config wenMiningExecutionConfigV1, request, walletID, policyHash string, v signerWENMiningIntentV1, wallet solana.PublicKey, guard func() error) (digest, outcome string, err error) {
	if s == nil || s.store == nil || s.keys == nil {
		return "", "", errors.New("mining execution unavailable")
	}
	if config.Pins.UpgradeAuthority != nil {
		authority := *config.Pins.UpgradeAuthority
		config.Pins.UpgradeAuthority = &authority
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	checkReview := func() error {
		if guard != nil {
			if e := guard(); e != nil {
				return e
			}
		}
		if config.reviewSHA == "" {
			return errors.New("mining execution requires protected review")
		}
		latest, reviewWallet, e := loadWENMiningReviewV1(s.store.db.Path(), walletID, v)
		if e != nil {
			return e
		}
		if latest.RequireLaunchBudget != config.RequireLaunchBudget || latest.reviewSHA != config.reviewSHA || latest.Root != config.Root || latest.MaxSlotLag != config.MaxSlotLag || !reflect.DeepEqual(latest.Pins, config.Pins) || reviewWallet != wallet {
			return errors.New("mining review changed during execution")
		}
		return nil
	}
	if err = checkReview(); err != nil {
		return
	}
	// Reservation checks policy and rejects fenced/replayed actions before RPC.
	digest, _, err = s.store.reserveWENMiningBudgetModeV1(request, walletID, policyHash, v, wallet, config.RequireLaunchBudget)
	if err != nil {
		return
	}
	outcome = "reserved"
	p, err := prepareWENMiningFromRPCV1(ctx, c, config.Root, config.Pins, v, wallet, config.MaxSlotLag)
	if err != nil {
		return digest, outcome, err
	}
	if err = checkReview(); err != nil {
		return
	}
	if err = s.store.miningExecutionStateV1(request, digest, policyHash, "reserved"); err != nil {
		return
	}
	if err = s.store.beginWENSigningAccountsV1(request, digest, wenHashV1(p.message), p.accountKeys, p.slot); err != nil {
		return
	}
	outcome = "signing"
	if err = s.store.changeWENReservationV1(request, digest, func(_ *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "signing" || r.MiningIntent == nil || *r.MiningIntent != v || r.MessageSHA256 != wenHashV1(p.message) {
			return errors.New("mining proof binding changed")
		}
		entry := p.entry
		entry.Data = append([]byte(nil), entry.Data...)
		r.MiningEntry = &entry
		pins := config.Pins
		r.MiningPins = &pins
		return nil
	}); err != nil {
		return
	}
	recheck := func(state string) error {
		fresh, e := prepareWENMiningPinnedV1(ctx, c, config.Root, config.Pins, v, wallet, config.MaxSlotLag, p)
		if e != nil {
			return e
		}
		if !bytes.Equal(fresh.message, p.message) {
			return errors.New("mining message changed")
		}
		p = fresh
		if e = checkReview(); e != nil {
			return e
		}
		return s.store.miningExecutionStateV1(request, digest, policyHash, state)
	}
	if err = recheck("signing"); err != nil {
		return
	}
	key, record, err := s.keys.privateKey(walletID)
	if err != nil {
		return digest, outcome, err
	}
	if record.PublicKey != wallet.String() {
		zeroBytes(key)
		return digest, outcome, errors.New("mining key changed")
	}
	if err = ctx.Err(); err != nil {
		zeroBytes(key)
		return
	}
	signature, err := key.Sign(p.message)
	zeroBytes(key)
	if err != nil {
		return digest, outcome, err
	}
	if err = s.store.recordWENSignatureV1(request, digest, p.message, signature.String()); err != nil {
		return
	}
	outcome = "signed"
	if err = recheck("signed"); err != nil {
		return
	}
	var wire []byte
	err = s.store.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		var policy signerPolicyV2
		retired, e := signerWalletIsRetiredInTxV2(tx, walletID)
		if e != nil {
			return e
		}
		if retired || r.State != "signed" || r.UsageDay != currentDayBucket(s.store.now()) || json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID)), &policy) != nil || policy.Hash != policyHash {
			return errors.New("mining submission unavailable")
		}
		wire, e = wenSignedWireV1(*r, p.message)
		if e != nil {
			return e
		}
		r.State = "submission-uncertain"
		if p.slot > r.MinExecutionSlot {
			r.MinExecutionSlot = p.slot
		}
		return nil
	})
	if err != nil {
		return
	}
	outcome = "submission-uncertain"
	retries := uint(0)
	minimum := p.slot
	returned, sendErr := c.SendRawTransactionWithOpts(ctx, wire, rpc.TransactionOpts{Encoding: solana.EncodingBase64, SkipPreflight: false, PreflightCommitment: rpc.CommitmentFinalized, MaxRetries: &retries, MinContextSlot: &minimum})
	recovered, recoveryErr := s.store.recoverWENMiningExecutionV1(ctx, c, request, digest)
	if recovered != "" {
		outcome = recovered
	}
	err = recoveryErr
	if err != nil {
		return
	}
	if outcome == "finalized-success" || outcome == "finalized-failed" {
		return
	}
	if sendErr != nil {
		return digest, outcome, sendErr
	}
	if returned != signature {
		return digest, outcome, errors.New("mining send identity mismatch; recover journaled signature")
	}
	return
}

func (s *signerStoreV2) recoverWENMiningExecutionV1(ctx context.Context, c wenMiningRecoveryRPCV1, request, digest string) (string, error) {
	outcome, err := s.reconcileWENTransactionV1(ctx, c, request, digest)
	if err != nil {
		return outcome, err
	}
	if outcome == "finalized-failed" {
		return outcome, s.settleWENFailedBudgetV1(request, digest)
	}
	// Successful mining requires its own proof; BTC funding settlement is invalid.
	if outcome == "finalized-success" {
		if err = s.settleWENMiningSuccessV1(request, digest); err != nil {
			return outcome, err
		}
		return outcome, s.observeWENMiningEntryV1(ctx, c, request, digest)
	}
	return outcome, nil
}
