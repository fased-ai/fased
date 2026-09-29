package main

import (
	"bytes"
	"crypto/ed25519"
	"errors"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

// Persist a signature already obtained by the execution owner, before any
// broadcast. This does not invoke a key or authorize signing. Recording remains
// possible after policy revocation: losing a real signature would hide exposure.
func (s *signerStoreV2) recordWENSignatureV1(requestID, digest string, message []byte, signature string) error {
	if len(message) == 0 || len(message)+65 > 1232 {
		return errors.New("invalid WEN signed message length")
	}
	owned := append([]byte(nil), message...)
	sig, err := solana.SignatureFromBase58(signature)
	if err != nil || sig.IsZero() || sig.String() != signature {
		return errors.New("invalid WEN signature")
	}
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.MiningClaimIntent != nil || r.MiningClaimPrepared != nil {
			if e := validateWENMiningClaimFenceV1(*r, wenHashV1(owned), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
				return e
			}
		}
		if r.MiningFundingIntent != nil || r.MiningFundingPrepared != nil {
			if e := validateWENMiningFundingFenceV1(*r, wenHashV1(owned), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
				return e
			}
		}
		if r.NativeClaimIntent != nil || r.NativeClaimPrepared != nil {
			if e := validateWENNativeClaimFenceV1(*r, wenHashV1(owned), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
				return e
			}
		}
		if r.BTCClaimIntent != nil || r.BTCClaimPrepared != nil {
			if e := validateWENBTCClaimFenceV1(*r, wenHashV1(owned), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
				return e
			}
		}
		if r.WithdrawalIntent != nil {
			if e := validateWENWithdrawalFenceV1(*r, wenHashV1(owned), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
				return e
			}
		}
		if r.StakingIntent != nil {
			if e := validateWENStakingFenceV1(*r, wenHashV1(owned), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
				return e
			}
		}
		pub, err := solana.PublicKeyFromBase58(r.WalletPublicKey)
		if err != nil || pub.IsZero() || pub.String() != r.WalletPublicKey || wenHashV1(owned) != r.MessageSHA256 || !ed25519.Verify(ed25519.PublicKey(pub[:]), owned, sig[:]) {
			return errors.New("WEN signature does not bind reserved wallet and message")
		}
		if r.State == "signed" || r.State == "submission-uncertain" || r.State == "finalized-success" || r.State == "finalized-failed" {
			if r.Signature != signature || !bytes.Equal(r.SignedMessage, owned) {
				return errors.New("WEN signature journal conflict")
			}
			return nil
		}
		if r.State != "signing" || r.Signature != "" || len(r.SignedMessage) != 0 {
			return errors.New("WEN signature journal transition unavailable")
		}
		r.State = "signed"
		r.Signature = signature
		r.SignedMessage = owned
		return nil
	})
}
