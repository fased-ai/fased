package trust

import (
	"errors"
	"time"

	"fased-lifecycled/model"
)

type RollbackGrant struct {
	SchemaVersion          uint32 `json:"schemaVersion"`
	Type                   string `json:"type"`
	CurrentGenerationID    string `json:"currentGenerationId"`
	TargetGenerationID     string `json:"targetGenerationId"`
	CurrentReleaseSequence uint64 `json:"currentReleaseSequence"`
	TargetReleaseSequence  uint64 `json:"targetReleaseSequence"`
	SecurityEpoch          uint64 `json:"securityEpoch"`
	Operator               string `json:"operator"`
	Reason                 string `json:"reason"`
	IssuedAt               string `json:"issuedAt"`
	ExpiresAt              string `json:"expiresAt"`
}

func SignRollbackGrant(grant RollbackGrant, keys []SigningKey) ([]byte, error) {
	authorization := rollbackAuthorization(grant, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
	if grant.Type != "fased-rollback-authorization" {
		return nil, errors.New("rollback grant type is invalid")
	}
	// Validate all semantic fields with a temporary syntactically valid digest.
	issued, err := time.Parse(time.RFC3339, grant.IssuedAt)
	if err != nil {
		return nil, err
	}
	if err := authorization.ValidateAt(issued); err != nil {
		return nil, err
	}
	return signEnvelope(grant, keys)
}

func VerifyRollbackGrant(root VerifiedRoot, data []byte, now time.Time) (model.RollbackAuthorization, error) {
	var envelope rawEnvelope
	if err := decodeStrict(data, &envelope); err != nil {
		return model.RollbackAuthorization{}, err
	}
	var grant RollbackGrant
	if err := decodeStrict(envelope.Signed, &grant); err != nil {
		return model.RollbackAuthorization{}, err
	}
	if grant.Type != "fased-rollback-authorization" {
		return model.RollbackAuthorization{}, errors.New("rollback grant type is invalid")
	}
	_, verified, err := verifyEnvelope(data, root.keys)
	if err != nil {
		return model.RollbackAuthorization{}, err
	}
	if err := requireThreshold(root.metadata.Root, verified); err != nil {
		return model.RollbackAuthorization{}, err
	}
	canonicalDigest, err := digestDocument(data)
	if err != nil {
		return model.RollbackAuthorization{}, err
	}
	authorization := rollbackAuthorization(grant, "sha256:"+canonicalDigest)
	if err := authorization.ValidateAt(now); err != nil {
		return model.RollbackAuthorization{}, err
	}
	return authorization, nil
}

func rollbackAuthorization(grant RollbackGrant, digest string) model.RollbackAuthorization {
	return model.RollbackAuthorization{SchemaVersion: grant.SchemaVersion, CurrentGenerationID: grant.CurrentGenerationID, TargetGenerationID: grant.TargetGenerationID, CurrentReleaseSequence: grant.CurrentReleaseSequence, TargetReleaseSequence: grant.TargetReleaseSequence, SecurityEpoch: grant.SecurityEpoch, Operator: grant.Operator, Reason: grant.Reason, IssuedAt: grant.IssuedAt, ExpiresAt: grant.ExpiresAt, EnvelopeDigest: digest}
}
