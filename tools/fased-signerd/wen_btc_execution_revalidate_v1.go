package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

// Recheck the original admitted message, never compile a replacement. This is
// internal validation only, not a signature or permission to reuse an admission.
func (s *signerStoreV2) revalidateWENExecutionV1(ctx context.Context, client signerWENBTCPrepareRPCV1, a *signerWENBTCExecutionAdmissionV1, nowHint uint64) ([]byte, error) {
	return s.revalidateWENExecutionStateV1(ctx, client, a, nowHint, "signing")
}

func (s *signerStoreV2) revalidateWENExecutionStateV1(ctx context.Context, client signerWENBTCPrepareRPCV1, a *signerWENBTCExecutionAdmissionV1, nowHint uint64, expectedState string) ([]byte, error) {
	bad := errors.New("WEN execution revalidation rejected")
	if a == nil || a.prepared == nil || s == nil || s.db == nil {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	p := a.prepared
	checkOwner := func() (string, signerWENBTCReviewV1, *signerWENBTCRouteV1, error) {
		root, review, route, err := loadWENBTCReviewV1(s.db.Path(), a.walletID, a.semanticIntent)
		if err != nil {
			return "", review, nil, err
		}
		if wenReviewDigestV1(review) != a.reviewDigest || review.WalletPublicKey != p.intent.payer.String() {
			return "", review, nil, bad
		}
		err = s.db.View(func(tx *bolt.Tx) error {
			b := tx.Bucket(wenBudgetBucketV1)
			if b == nil {
				return bad
			}
			var r wenBudgetReservationV1
			if json.Unmarshal(b.Get([]byte("request:"+a.requestID)), &r) != nil || r.State != expectedState || r.Digest != a.reservationDigest || r.WalletID != a.walletID || r.MessageSHA256 != wenHashV1(p.message) || r.UsageDay != currentDayBucket(s.now()) {
				return bad
			}
			if expectedState == "signed" {
				if _, err := wenSignedWireV1(r, p.message); err != nil {
					return err
				}
			}
			var policy signerPolicyV2
			if json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(a.walletID)), &policy) != nil || policy.Hash != r.PolicyHash || policy.WalletID != a.walletID {
				return bad
			}
			return nil
		})
		return root, review, route, err
	}
	root, review, route, err := checkOwner()
	if err != nil {
		return nil, err
	}
	fresh, err := readWENBTCSubscriptionRPCV1(ctx, client, root, review.Pins, a.semanticIntent, p.intent.payer, nowHint, review.MaxSlotLag, route)
	if err != nil {
		return nil, err
	}
	if fresh.Slot < a.simulation.slot || fresh.ReferenceSlot >= p.expiresSlot || !bytes.Equal(fresh.Data, p.intent.data) || !reflect.DeepEqual(fresh.Accounts, p.intent.accounts) || !reflect.DeepEqual(fresh.rentLengths, p.rentLengths) {
		return nil, bad
	}
	keys := make([]solana.PublicKey, len(p.pins))
	for i, pin := range p.pins {
		keys[i] = pin.key
	}
	minimum := fresh.ReferenceSlot
	batch, err := client.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &minimum})
	if err != nil {
		return nil, err
	}
	if batch == nil || len(batch.Value) != len(keys) || batch.Context.Slot < minimum || batch.Context.Slot >= p.expiresSlot {
		return nil, bad
	}
	snapshots := make([]*signerWENBTCAccountV1, len(keys))
	for i, v := range batch.Value {
		if v == nil || v.Data == nil {
			return nil, bad
		}
		snapshots[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: v.Owner, Executable: v.Executable, Slot: batch.Context.Slot, Data: append([]byte(nil), v.Data.GetBinary()...)}
	}
	height, err := client.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if height < a.simulation.height {
		return nil, bad
	}
	message, err := p.revalidate(snapshots, height)
	if err != nil {
		return nil, err
	}
	slot, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if slot < batch.Context.Slot || slot >= p.expiresSlot || slot < p.life.minimumSlot || slot-p.life.minimumSlot > p.life.maximumSlotLag {
		return nil, bad
	}
	chain, err := client.GetGenesisHash(ctx)
	if err != nil {
		return nil, err
	}
	if chain.String() != review.Pins.Genesis {
		return nil, bad
	}
	if _, _, _, err := checkOwner(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return message, nil
}
