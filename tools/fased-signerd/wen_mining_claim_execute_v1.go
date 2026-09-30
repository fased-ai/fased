package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenMiningClaimExecutionRPCV1 interface {
	wenMiningPrepareRPCV1
	signerWENBTCReconcileRPCV1
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

// Internal only; public dispatch requires separate deployment/client acceptance.
// Return the durable identity on every post-reservation error; never replace it.
func (s *signerServiceV2) executeWENMiningClaimWithRPCV1(ctx context.Context, c wenMiningClaimExecutionRPCV1, request, walletID, policyHash string, v signerWENMiningClaimIntentV1) (digest, outcome string, err error) {
	return s.executeGuardedWENMiningClaimV1(ctx, c, request, walletID, policyHash, v, nil)
}
func (s *signerServiceV2) executeGuardedWENMiningClaimV1(ctx context.Context, c wenMiningClaimExecutionRPCV1, request, walletID, policyHash string, v signerWENMiningClaimIntentV1, guard func() error) (digest, outcome string, err error) {
	return s.executeReviewedMiningClaimV1(ctx, c, request, walletID, policyHash, v, guard, nil, "")
}

// Candidate-only adapter. expectedDigest is supplied by the future trusted
// approval layer, never accepted from an application request as authorization.
func (s *signerServiceV2) executeReviewedMiningClaimV1(ctx context.Context, c wenMiningClaimExecutionRPCV1, request, walletID, policyHash string, v signerWENMiningClaimIntentV1, guard func() error, artifact *wenMiningClaimReviewArtifactV1, expectedDigest string) (digest, outcome string, err error) {
	return s.executeMiningClaimAuthorizationBoundaryV1(ctx, c, request, walletID, policyHash, v, guard, artifact, expectedDigest, nil)
}
func (s *signerServiceV2) executeMiningClaimAuthorizationBoundaryV1(ctx context.Context, c wenMiningClaimExecutionRPCV1, request, walletID, policyHash string, v signerWENMiningClaimIntentV1, guard func() error, artifact *wenMiningClaimReviewArtifactV1, expectedDigest string, authorize func(string) error) (digest, outcome string, err error) {
	if s == nil || s.store == nil || s.keys == nil {
		return "", "", errors.New("mining claim execution unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var pinned *wenMiningClaimMessageBindingV1
	if artifact != nil {
		a := *artifact
		hash, checkErr := a.digest()
		if checkErr != nil || hash != expectedDigest || a.RequestID != request || a.WalletID != walletID || a.PolicyHash != policyHash || !equalWENMiningClaimIntentV1(a.Intent, v) {
			return "", "", errors.New("mining claim approval artifact mismatch")
		}
		b := a.Binding
		b.Message = append([]byte(nil), b.Message...)
		pinned = &b
	} else if expectedDigest != "" {
		return "", "", errors.New("missing mining claim approval artifact")
	}
	p, err := preparePinnedWENMiningClaimV1(ctx, c, s.store.db.Path(), walletID, v, pinned)
	if err != nil {
		return
	}
	if artifact != nil && artifact.WalletPublicKey != p.wallet.String() {
		return "", "", errors.New("mining claim approval wallet mismatch")
	}
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	digest, _, err = s.store.reservePreparedWENMiningClaimV1(request, walletID, policyHash, v, p)
	if err != nil {
		return
	}
	outcome = "reserved"
	ix, err := buildWENMiningClaimInstructionV1(v, p.wallet)
	if err != nil {
		return
	}
	instructions, err := wenMiningClaimInstructionsV1(ix, p.computeLimit)
	if err != nil {
		return
	}
	tx, err := solana.NewTransaction(instructions, p.blockhash, solana.TransactionPayer(p.wallet))
	if err != nil {
		return
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	all, err := tx.Message.GetAllKeys()
	if err != nil {
		return
	}
	keys := make([]string, len(all))
	for i, k := range all {
		keys[i] = k.String()
	}
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	if authorize != nil {
		if err = authorize(digest); err != nil {
			return
		}
	}
	if err = s.store.beginWENSigningAccountsV1(request, digest, wenHashV1(p.message), keys, p.slot); err != nil {
		return
	}
	outcome = "signing"
	binding := wenMiningClaimMessageBindingV1{ComputeUnitLimit: p.computeLimit, Message: p.message, Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, StateHash: p.state.StateHash, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}
	if _, err = preparePinnedWENMiningClaimV1(ctx, c, s.store.db.Path(), walletID, v, &binding); err != nil {
		return
	}
	if err = s.store.miningExecutionStateV1(request, digest, policyHash, "signing"); err != nil {
		return
	}
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	if authorize != nil {
		if err = authorize(digest); err != nil {
			return
		}
	}
	key, record, err := s.keys.privateKey(walletID)
	if err != nil {
		return
	}
	if record.PublicKey != p.wallet.String() {
		zeroBytes(key)
		return digest, outcome, errors.New("mining claim key identity changed")
	}
	if err = ctx.Err(); err != nil {
		zeroBytes(key)
		return
	}
	signature, err := key.Sign(p.message)
	zeroBytes(key)
	if err != nil {
		return
	}
	if err = s.store.recordWENSignatureV1(request, digest, p.message, signature.String()); err != nil {
		return
	}
	outcome = "signed"
	wire, err := s.store.prepareWENMiningClaimSubmissionV1(ctx, c, request, digest)
	if err != nil {
		return
	}
	outcome = "submission-uncertain"
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	retries := uint(0)
	minimum := p.slot
	returned, sendErr := c.SendRawTransactionWithOpts(ctx, wire, rpc.TransactionOpts{Encoding: solana.EncodingBase64, SkipPreflight: false, PreflightCommitment: rpc.CommitmentFinalized, MaxRetries: &retries, MinContextSlot: &minimum})
	recovered, recoveryErr := s.store.recoverWENMiningClaimExecutionV1(ctx, c, request, digest)
	if recovered != "" {
		outcome = recovered
	}
	if recoveryErr != nil {
		return digest, outcome, recoveryErr
	}
	if outcome == "finalized-success" || outcome == "finalized-failed" {
		return
	}
	if sendErr != nil {
		return digest, outcome, sendErr
	}
	if returned != signature {
		return digest, outcome, errors.New("mining claim send identity mismatch; recover journaled signature")
	}
	return
}
