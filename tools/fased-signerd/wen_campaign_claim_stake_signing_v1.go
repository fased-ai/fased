package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// The execution owner supplies a fresh, pinned RPC preparation. This is a
// one-time durable guard, not a key accessor; a crash leaves signing unresolved.
func (s *signerStoreV2) beginWENCampaignClaimStakeSigningV1(walletID, requestID, digest string, p *wenCampaignClaimStakePreparedV1) error {
	return s.transitionWENCampaignClaimStakeSigningV1(walletID, requestID, digest, p, "reserved", "signing", "")
}

func (s *signerStoreV2) transitionWENCampaignClaimStakeSigningV1(walletID, requestID, digest string, p *wenCampaignClaimStakePreparedV1, from, to, signature string) error {
	bad := errors.New("campaign signing guard rejected")
	if !(((from == "reserved" || from == "signing") && to == "signing" && signature == "") || (from == "signing" && to == "signed" && signature != "") || (from == "signed" && to == "submission-uncertain" && signature != "")) {
		return bad
	}
	if s == nil || s.db == nil || p == nil {
		return bad
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		key := []byte("campaign-stake-request:" + requestID)
		var r wenCampaignClaimStakeReservationV1
		if json.Unmarshal(b.Get(key), &r) != nil || r.Version != 1 || r.State != from || r.Digest != digest || r.Artifact.WalletID != walletID || r.Artifact.RequestID != requestID || r.Authorization == nil || r.UsageDay != currentDayBucket(s.now()) {
			return bad
		}
		hash, e := r.Artifact.digest()
		if e != nil || hash != digest {
			return bad
		}
		if e = validateWENCampaignConsumedApprovalV1(tx, walletID, requestID, digest, r.Artifact.WalletPublicKey, r.Authorization, s.now().UTC()); e != nil {
			return e
		}
		old := r.Artifact
		expires := mustStakeUint(old.Intent.ExpiresSlot)
		if !bytes.Equal(p.message, old.Message) || p.blockhash != old.Blockhash || p.fee != old.Fee || p.rent != old.Rent || p.maximumDebit != old.MaximumDebit || p.lastValidHeight != old.LastValidHeight || p.currentHeight < old.CurrentHeight || p.currentHeight >= p.lastValidHeight || p.snapshot.Claim.Slot < old.Snapshot.Claim.Slot || p.snapshot.Claim.ReferenceSlot < old.Snapshot.Claim.ReferenceSlot || p.snapshot.Claim.ReferenceSlot < p.snapshot.Claim.Slot || p.snapshot.Claim.ReferenceSlot >= expires || !sameWENCampaignClaimStakeStateV1(p.snapshot, old.Snapshot) {
			return bad
		}
		debit := old.MaximumDebit
		scopes := map[string]uint64{wenMiningNativeScopeV1(walletID, r.Artifact.Pins.Genesis): debit, wenCampaignClaimStakeLaunchScopeV1(r.Artifact): debit}
		if !reflect.DeepEqual(scopes, r.Scopes) {
			return bad
		}
		for scope, n := range scopes {
			var balance wenBudgetBalanceV1
			if json.Unmarshal(b.Get([]byte("limit:"+scope)), &balance) != nil || balance.Reserved < n || balance.Reserved > balance.Limit {
				return bad
			}
		}
		if from == "reserved" || from == "signing" {
			if r.Signature != "" {
				return bad
			}
		}
		if signature != "" {
			pub, e := solana.PublicKeyFromBase58(r.Artifact.WalletPublicKey)
			if e != nil {
				return bad
			}
			sig, e := solana.SignatureFromBase58(signature)
			if e != nil || sig.String() != signature || !ed25519.Verify(ed25519.PublicKey(pub[:]), p.message, sig[:]) {
				return bad
			}
			if from == "signed" && r.Signature != signature {
				return bad
			}
			r.Signature = signature
		}
		r.State = to
		raw, e := json.Marshal(r)
		if e != nil {
			return e
		}
		return b.Put(key, raw)
	})
}
