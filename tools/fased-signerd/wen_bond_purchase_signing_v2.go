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
func (s *signerStoreV2) beginWENBondPurchaseSigningV2(walletID, requestID, digest string, p *wenBondPurchaseCostPreparedV2) error {
	return s.transitionWENBondPurchaseSigningV2(walletID, requestID, digest, p, "reserved", "signing", "")
}

func (s *signerStoreV2) transitionWENBondPurchaseSigningV2(walletID, requestID, digest string, p *wenBondPurchaseCostPreparedV2, from, to, signature string) error {
	bad := errors.New("Bond purchase signing guard rejected")
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
		key := []byte("bond-purchase-request:" + requestID)
		var r wenBondPurchaseReservationV2
		if json.Unmarshal(b.Get(key), &r) != nil || r.Version != 2 || r.State != from || r.Digest != digest || r.Artifact.WalletID != walletID || r.Artifact.RequestID != requestID || r.Authorization == nil || r.UsageDay != currentDayBucket(s.now()) {
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
		if !reflect.DeepEqual(p.pins, r.Artifact.Pins) || !reflect.DeepEqual(p.policy, r.Artifact.Policy) || p.limits != r.Artifact.Limits || !bytes.Equal(p.message, old.Message) || p.blockhash != old.Blockhash || p.fee != old.Fee || p.total != old.Total || p.lastValidHeight != old.LastValidHeight || p.currentHeight < old.CurrentHeight || p.currentHeight >= p.lastValidHeight || p.snapshot.StateSHA256 != old.Snapshot.StateSHA256 || p.snapshot.Slot < old.Snapshot.Slot || p.snapshot.ReferenceSlot < old.Snapshot.ReferenceSlot || p.snapshot.ReferenceSlot >= r.Artifact.Policy.ExpiresSlot || p.snapshot.Now < old.Snapshot.Now || p.snapshot.Rent != old.Snapshot.Rent {
			return bad
		}
		life := signerWENBTCMessageLifeV1{p.currentHeight, p.lastValidHeight, p.snapshot.Slot, p.policy.MaxSlotLag}
		if e = verifyWENBondPurchaseMessageV2(p.message, p.snapshot.Pins, p.snapshot.Quote, p.policy.Nonce, p.snapshot.Now, p.policy.Route, p.blockhash, p.limits.ComputeUnits, p.policy.internalLookups(), p.snapshot.Lookups, life); e != nil {
			return e
		}
		scopes := wenBondPurchaseReservationScopesV2(r.Artifact)
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
