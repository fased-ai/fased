package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Read-only configured host join. Claim descriptor/pins are explicit reviewed
// host inputs, not inferred from the network. A returned proposal grants no review.
func (s *signerServiceV2) proposeJournalWENMiningClaimV1(ctx context.Context, cfg signerConfig, walletID, request, operation string, pins wenStakingPinsV1, descriptor []byte, minimum, expires, maxFee, maxLag uint64, factory func(string) signerWENBTCReadRPCV1) (wenMiningDiscoveredClaimV1, error) {
	var zero wenMiningDiscoveredClaimV1
	bad := errors.New("claim host journal or configuration changed")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return zero, bad
	}
	if _, e := validateRequestIDV2(request); e != nil {
		return zero, e
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return zero, e
	}
	public, e := s.keys.PublicRecord(walletID)
	if e != nil {
		return zero, e
	}
	owner, e := solana.PublicKeyFromBase58(public.PublicKey)
	if e != nil {
		return zero, e
	}
	var original []byte
	var candidate *wenMiningClaimCandidateV1
	e = s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		original = append([]byte(nil), b.Get([]byte("request:"+request))...)
		var saved wenBudgetReservationV1
		if json.Unmarshal(original, &saved) != nil {
			return bad
		}
		if saved.MiningPins == nil || saved.MiningPins.ProgramID != pins.ProgramID || saved.MiningPins.Genesis != pins.Genesis || saved.MiningPins.CodeSHA256 != pins.CodeSHA256 || saved.MiningPins.DeploymentSlot != pins.DeploymentSlot || !reflect.DeepEqual(saved.MiningPins.UpgradeAuthority, pins.UpgradeAuthority) {
			return bad
		}
		var err error
		candidate, err = miningClaimJournalCandidateV1(b, saved, walletID, public.PublicKey, request)
		if err != nil {
			return err
		}
		if candidate == nil {
			return bad
		}
		return nil
	})
	if e != nil {
		return zero, e
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != candidate.Intent.Genesis {
		return zero, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "claim host RPC")
	if e != nil {
		return zero, e
	}
	if e = ctx.Err(); e != nil {
		return zero, e
	}
	client := factory(endpoint)
	if client == nil {
		return zero, bad
	}
	out, e := proposeDiscoveredWENMiningClaimV1(ctx, client, pins, descriptor, *candidate, owner, operation, minimum, expires, maxFee, maxLag)
	if e != nil {
		return zero, e
	}
	latest, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || !reflect.DeepEqual(latest, network) {
		return zero, bad
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != public.PublicKey {
		return zero, bad
	}
	e = s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil || !bytes.Equal(original, b.Get([]byte("request:"+request))) {
			return bad
		}
		var saved wenBudgetReservationV1
		if json.Unmarshal(original, &saved) != nil {
			return bad
		}
		again, e := miningClaimJournalCandidateV1(b, saved, walletID, public.PublicKey, request)
		if e != nil || again == nil || *again != *candidate {
			return bad
		}
		return ctx.Err()
	})
	if e != nil {
		return zero, e
	}
	return out, nil
}
