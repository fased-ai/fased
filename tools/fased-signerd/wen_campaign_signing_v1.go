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
func (s *signerStoreV2) beginWENCampaignSigningV1(walletID, requestID, digest string, p *wenCampaignPreparedV1) error {
	return s.transitionWENCampaignSigningV1(walletID, requestID, digest, p, "reserved", "signing", "")
}

func (s *signerStoreV2) transitionWENCampaignSigningV1(walletID, requestID, digest string, p *wenCampaignPreparedV1, from, to, signature string) error {
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
		key := []byte("campaign-request:" + requestID)
		var r wenCampaignReservationV1
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
		old := r.Artifact.Binding
		if !bytes.Equal(p.message, old.Message) || p.blockhash != old.Blockhash || p.fee != old.Fee || p.lastValidHeight != old.LastValidHeight || p.currentHeight < old.CurrentHeight || p.currentHeight >= p.lastValidHeight || p.position.Slot < old.Position.Slot || p.position.ReferenceSlot < old.Position.ReferenceSlot || p.position.ReferenceSlot < p.position.Slot || p.position.ReferenceSlot >= old.ExpiresSlot {
			return bad
		}
		if (p.claim == nil) != (old.Claim == nil) || p.claim != nil && !sameWENCampaignClaimStateV1(*p.claim, *old.Claim) {
			return bad
		}
		if (p.setup == nil) != (old.Setup == nil) || p.setup != nil && !sameWENCampaignSetupStateV1(*p.setup, *old.Setup) {
			return bad
		}
		current, previous := p.position, old.Position
		current.Now = previous.Now
		current.Slot = previous.Slot
		current.ReferenceSlot = previous.ReferenceSlot
		if !reflect.DeepEqual(current, previous) {
			return bad
		}
		debit, e := r.Artifact.debit()
		if e != nil {
			return e
		}
		scopes := map[string]uint64{wenMiningNativeScopeV1(walletID, r.Artifact.Pins.Genesis): debit, wenCampaignLaunchScopeV1(r.Artifact): debit}
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
