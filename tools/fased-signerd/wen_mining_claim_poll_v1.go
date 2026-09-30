package main

import (
	"context"
	"errors"
	"reflect"
	"time"
)

type wenMiningClaimReviewItemV1 struct {
	ReviewDraft *wenMiningClaimBootstrapV1  `json:"reviewDraft,omitempty"`
	Entry       string                      `json:"entry"`
	Status      string                      `json:"status"`
	Proposal    *wenMiningDiscoveredClaimV1 `json:"proposal,omitempty"`
}
type wenMiningClaimPollV1 struct {
	Items          []wenMiningClaimReviewItemV1 `json:"items"`
	NextCursor     string                       `json:"nextCursor"`
	ScanComplete   bool                         `json:"scanComplete"`
	Scanned        int                          `json:"scanned"`
	SigningEnabled bool                         `json:"signingEnabled"`
}

// One bounded, read-only polling tick for one reviewed deployment and claim
// operation. The caller schedules subsequent ticks; no goroutine or signing
// dispatch is created. A complete scan resets the cursor so deferred entries
// are retried. Results are ephemeral review inputs, never execution permission.
func (s *signerServiceV2) pollWENMiningAdmissionClaimsV1(ctx context.Context, cfg signerConfig, walletID, cursor string, limit int, operation string, pins wenStakingPinsV1, descriptor []byte, minimum, expires, maxFee, maxLag uint64, factory func(string) signerWENBTCReadRPCV1) (wenMiningClaimPollV1, error) {
	var zero wenMiningClaimPollV1
	bad := errors.New("claim polling configuration rejected")
	if s == nil || s.keys == nil || factory == nil || limit < 1 || limit > 10 || (operation != "sol" && operation != "sat") {
		return zero, bad
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	identity, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return zero, err
	}
	network, err := s.keys.SolanaNetworkV2(walletID)
	if err != nil || network.GenesisHash != pins.Genesis {
		return zero, bad
	}
	page, err := s.discoverConfiguredWENMiningAdmissionsV1(ctx, cfg, walletID, cursor, limit)
	if err != nil {
		return zero, err
	}
	out := wenMiningClaimPollV1{Items: []wenMiningClaimReviewItemV1{}, NextCursor: page.Cursor, ScanComplete: page.Complete, Scanned: page.Scanned}
	if page.Complete {
		out.NextCursor = ""
	}
	for _, candidate := range page.Candidates {
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		// Another deployment is not admitted by this tick's descriptor.
		if candidate.Intent.ProgramID != pins.ProgramID || candidate.Intent.Genesis != pins.Genesis {
			continue
		}
		item := wenMiningClaimReviewItemV1{Entry: candidate.Intent.Entry, Status: "readback-rejected"}
		proposal, err := s.proposeAdmissionWENMiningClaimV1(ctx, cfg, walletID, candidate.Intent, operation, pins, descriptor, minimum, expires, maxFee, maxLag, factory)
		if err == nil {
			draft, draftErr := draftWENMiningClaimReviewV1(walletID, identity.PublicKey, item.Entry, proposal, pins, descriptor, maxFee, maxLag)
			if draftErr != nil {
				return zero, draftErr
			}
			item.Status = "requires-review"
			item.Proposal = &proposal
			item.ReviewDraft = &draft
		}
		// A rejected readback is not evidence of zero reward, insolvency or final
		// failure. Continue the bounded page and retry on a later complete scan.
		out.Items = append(out.Items, item)
	}
	latest, err := s.keys.SolanaNetworkV2(walletID)
	if err != nil || !reflect.DeepEqual(latest, network) {
		return zero, bad
	}
	public, err := s.keys.PublicRecord(walletID)
	if err != nil || public.PublicKey != identity.PublicKey {
		return zero, bad
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	return out, nil
}
