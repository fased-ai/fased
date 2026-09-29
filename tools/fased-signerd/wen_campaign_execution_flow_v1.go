package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Both campaign owners use this engine. Typed storage guards retain their own
// artifact contracts; only this engine accesses keys and releases one send.
type wenCampaignExecutionFlowV1 struct {
	publicKey, signature                          string
	reserve, authorize, refresh, admission, guard func() error
	transition                                    func(string, string, string) error
	commit                                        func() ([]byte, error)
	recover                                       func() (string, error)
	message                                       func() []byte
	minimumSlot                                   func() uint64
	send                                          func(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

func (s *signerServiceV2) runWENCampaignExecutionV1(ctx context.Context, wallet string, initialDigest, initialState string, flow wenCampaignExecutionFlowV1) (digest, state string, err error) {
	digest, state = initialDigest, initialState
	if err = flow.refresh(); err != nil {
		return
	}
	var signature solana.Signature
	if state != "signed" {
		if state != "signing" {
			err = flow.reserve()
			if err != nil {
				return
			}
			state = "reserved"
			if err = flow.authorize(); err != nil {
				return
			}
			if err = flow.transition("reserved", "signing", ""); err != nil {
				return
			}
		} else {
			// Existing consumed approval is rechecked inside the durable guard. Signing
			// again can only reproduce the same signature over the same immutable bytes.
			if err = flow.transition("signing", "signing", ""); err != nil {
				return
			}
		}
		state = "signing"
		if err = ctx.Err(); err != nil {
			return
		}
		if err = flow.admission(); err != nil {
			return
		}
		key, record, e := s.keys.privateKey(wallet)
		if e != nil {
			err = e
			return
		}
		if record.PublicKey != flow.publicKey {
			zeroBytes(key)
			err = errors.New("campaign signing wallet changed")
			return
		}
		signature, e = key.Sign(flow.message())
		zeroBytes(key)
		if e != nil {
			err = e
			return
		}
		if err = flow.transition("signing", "signed", signature.String()); err != nil {
			return
		}
		state = "signed"
	} else {
		signature, err = solana.SignatureFromBase58(flow.signature)
		if err != nil {
			return
		}
	}
	if err = flow.refresh(); err != nil {
		return
	}
	if err = flow.admission(); err != nil {
		return
	}
	wire, e := flow.commit()
	if e != nil {
		err = e
		return
	}
	state = "submission-uncertain"
	if err = ctx.Err(); err != nil {
		return
	}
	if flow.guard != nil {
		if err = flow.guard(); err != nil {
			return
		}
	}
	retries := uint(0)
	min := flow.minimumSlot()
	returned, sendErr := flow.send(ctx, wire, rpc.TransactionOpts{Encoding: solana.EncodingBase64, SkipPreflight: false, PreflightCommitment: rpc.CommitmentFinalized, MaxRetries: &retries, MinContextSlot: &min})
	recovered, e := flow.recover()
	if recovered != "" {
		state = recovered
	}
	if e != nil {
		err = e
		return
	}
	if state == "finalized-success" || state == "finalized-failed" {
		return
	}
	if sendErr != nil {
		err = sendErr
		return
	}
	if returned != signature {
		err = errors.New("campaign send identity mismatch; recover journaled signature")
	}
	return
}
