package main

import (
	"encoding/json"
	"errors"
)

type signerReviewAuthorizationContextV2 struct {
	WalletID          string
	Role              string
	IntentType        string
	IntentDigest      string
	TransactionDigest string
	PolicyHash        string
	RequestID         string
	Nonce             string
	SemanticIntent    json.RawMessage
	IssuedAt          string
	ExpiresAt         string
}

type signerReviewAuthorizationVerifierV2 func(
	context signerReviewAuthorizationContextV2,
	authorization *signerReviewAuthorizationV2,
) error

// The WebAuthn implementation installs this verifier during signer startup.
// The default is deliberately fail closed. Autonomous execution is handled
// separately and is allowed only for an Agent-role policy.
var signerReviewedAuthorizationVerifierV2 signerReviewAuthorizationVerifierV2 = func(
	context signerReviewAuthorizationContextV2,
	authorization *signerReviewAuthorizationV2,
) error {
	return errors.New("reviewed signer execution requires signer-owned authorization verification")
}

func authorizeJupiterReviewExecutionV2(
	review signerReviewV2,
	policy signerPolicyV2,
	transactionDigest string,
	authorization *signerReviewAuthorizationV2,
) error {
	if review.Mode == jupiterReviewModeAutonomousV2 {
		if policy.Role != "agent" {
			return errors.New("autonomous Jupiter execution is restricted to Agent-role wallets")
		}
		if authorization != nil {
			return errors.New("autonomous execution cannot accept caller-provided review authorization")
		}
		return nil
	}
	if review.Mode != jupiterReviewModeReviewedV2 || authorization == nil {
		return errors.New("reviewed Jupiter execution requires a signer-verified authorization proof")
	}
	return signerReviewedAuthorizationVerifierV2(signerReviewAuthorizationContextV2{
		WalletID:          review.WalletID,
		Role:              policy.Role,
		IntentType:        review.IntentType,
		IntentDigest:      review.IntentDigest,
		TransactionDigest: transactionDigest,
		PolicyHash:        review.PolicyHash,
		RequestID:         review.RequestID,
		Nonce:             review.Nonce,
		SemanticIntent:    review.SemanticIntent,
		IssuedAt:          review.IssuedAt,
		ExpiresAt:         review.ExpiresAt,
	}, authorization)
}
