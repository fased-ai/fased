package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

type wenMiningClaimCandidateV1 struct {
	CommitRequest string                  `json:"commitRequest"`
	Intent        signerWENMiningIntentV1 `json:"miningIntent"`
	ObservedSlot  uint64                  `json:"observedSlot"`
	Source        string                  `json:"source"`
	Status        string                  `json:"status"`
}
type wenMiningClaimDiscoveryV1 struct {
	Candidates     []wenMiningClaimCandidateV1 `json:"candidates"`
	Cursor         string                      `json:"cursor"`
	Complete       bool                        `json:"complete"`
	Scanned        int                         `json:"scanned"`
	SigningEnabled bool                        `json:"signingEnabled"`
}

// Internal host pagination. Cursor is the last scanned request ID, not proof of
// completeness across concurrent updates. Start again at empty cursor after a
// complete pass: pending entries can finalize and earlier keys can be inserted.
// Finalized commitments and persisted accepted-entry snapshots locate candidates
// only, never prove a settled unpaid reward.
func (s *signerStoreV2) discoverWENMiningClaimsV1(ctx context.Context, walletID, owner, cursor string, limit int) (wenMiningClaimDiscoveryV1, error) {
	out := wenMiningClaimDiscoveryV1{Candidates: []wenMiningClaimCandidateV1{}}
	bad := errors.New("mining claim journal discovery rejected")
	if s == nil || s.db == nil || walletID == "" || normalizeWalletID(walletID) != walletID || limit < 1 || limit > 100 {
		return out, bad
	}
	if cursor != "" {
		if _, e := validateRequestIDV2(cursor); e != nil {
			return out, e
		}
	}
	if e := ctx.Err(); e != nil {
		return out, e
	}
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			out.Complete = true
			return nil
		}
		c := b.Cursor()
		prefix := []byte("request:")
		start := append([]byte(nil), prefix...)
		start = append(start, []byte(cursor)...)
		k, raw := c.Seek(start)
		if cursor != "" && bytes.Equal(k, start) {
			k, raw = c.Next()
		}
		for ; k != nil && bytes.HasPrefix(k, prefix) && out.Scanned < limit; k, raw = c.Next() {
			if e := ctx.Err(); e != nil {
				return e
			}
			out.Scanned++
			id := string(k[len(prefix):])
			if _, e := validateRequestIDV2(id); e != nil {
				return bad
			}
			out.Cursor = id
			var saved wenBudgetReservationV1
			if json.Unmarshal(raw, &saved) != nil {
				return bad
			}
			candidate, e := miningClaimJournalCandidateV1(b, saved, walletID, owner, id)
			if e != nil {
				return e
			}
			if candidate != nil {
				out.Candidates = append(out.Candidates, *candidate)
			}
		}
		out.Complete = k == nil || !bytes.HasPrefix(k, prefix)
		return ctx.Err()
	})
	if e != nil {
		return wenMiningClaimDiscoveryV1{}, e
	}
	return out, nil
}

// Host entry point uses the configured wallet identity; no caller-owned owner key.
// No public signing dispatch or background worker is enabled by this read.
func (s *signerServiceV2) discoverConfiguredWENMiningClaimsV1(ctx context.Context, cfg signerConfig, walletID, cursor string, limit int) (wenMiningClaimDiscoveryV1, error) {
	var zero wenMiningClaimDiscoveryV1
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() {
		return zero, errors.New("claim discovery configuration rejected")
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return zero, e
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil {
		return zero, e
	}
	out, e := s.store.discoverWENMiningClaimsV1(ctx, walletID, record.PublicKey, cursor, limit)
	if e != nil {
		return zero, e
	}
	latest, e := s.keys.PublicRecord(walletID)
	if e != nil || latest.PublicKey != record.PublicKey {
		return zero, errors.New("claim discovery wallet changed")
	}
	return out, nil
}

func miningClaimJournalCandidateV1(b *bolt.Bucket, saved wenBudgetReservationV1, walletID, owner, id string) (*wenMiningClaimCandidateV1, error) {
	bad := errors.New("mining claim journal candidate rejected")
	if saved.WalletID != walletID || saved.MiningIntent == nil || saved.MiningIntent.Operation != "commit" {
		return nil, nil
	}
	if saved.WalletPublicKey != owner {
		return nil, bad
	}
	v := *saved.MiningIntent
	index := []byte("mining-action:" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Entry+":commit")))
	if string(b.Get(index)) != id || saved.MiningObservedSlot > ^uint64(0)-32 {
		return nil, bad
	}
	observed := saved.MiningObservedSlot
	source := "finalized-commit"
	if saved.State == "finalized-success" && saved.SuccessBudgetSettled {
		if _, e := proposeWENMiningRevealV1(saved, saved.MiningObservedSlot, saved.MiningObservedSlot+32); e != nil {
			return nil, e
		}
	} else {
		// A persisted accepted entry survives an uncertain/failed commit. It is a
		// locator, not evidence that commitment or payout succeeded.
		if saved.MiningEntry == nil {
			return nil, nil
		}
		if saved.MiningPins == nil || saved.MiningPins.ProgramID != v.ProgramID || saved.MiningPins.Genesis != v.Genesis || !wenReservationHashV1(saved.MiningPins.CodeSHA256) {
			return nil, bad
		}
		wallet, e := solana.PublicKeyFromBase58(owner)
		if e != nil {
			return nil, bad
		}
		if _, e = prepareWENMiningInstructionV1(v, wallet, *saved.MiningEntry, nil); e != nil {
			return nil, e
		}
		observed = saved.MiningEntry.Slot
		source = "accepted-entry-snapshot"
	}
	return &wenMiningClaimCandidateV1{CommitRequest: id, Intent: v, ObservedSlot: observed, Source: source, Status: "requires-settlement-readback"}, nil
}
