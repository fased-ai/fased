// Package protocol defines the fixed external surface of the lifecycle daemon.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

	"fased-lifecycled/model"
)

const CurrentSchemaVersion uint32 = 1

type Operation string

const (
	OperationInspect            Operation = "INSPECT"
	OperationConverge           Operation = "CONVERGE"
	OperationRollback           Operation = "ROLLBACK"
	OperationRepairCurrent      Operation = "REPAIR_CURRENT"
	OperationRecover            Operation = "RECOVER"
	OperationCompleteOnboarding Operation = "COMPLETE_ONBOARDING"
)

type Request struct {
	SchemaVersion            uint32                       `json:"schemaVersion"`
	RequestID                string                       `json:"requestId"`
	Operation                Operation                    `json:"operation"`
	TargetGenerationID       string                       `json:"targetGenerationId,omitempty"`
	SourceTopology           string                       `json:"sourceTopology,omitempty"`
	PublicPredecessorVersion string                       `json:"publicPredecessorVersion,omitempty"`
	ExpectedManifestDigest   string                       `json:"expectedManifestDigest,omitempty"`
	TransactionID            string                       `json:"transactionId,omitempty"`
	RollbackAuthorization    *model.RollbackAuthorization `json:"rollbackAuthorization,omitempty"`
}

type Response struct {
	SchemaVersion            uint32 `json:"schemaVersion"`
	RequestID                string `json:"requestId"`
	Outcome                  string `json:"outcome"`
	Detail                   string `json:"detail,omitempty"`
	TransactionID            string `json:"transactionId,omitempty"`
	ActiveGenerationID       string `json:"activeGenerationId,omitempty"`
	ConvergenceReceiptDigest string `json:"convergenceReceiptDigest,omitempty"`
}

var (
	uuidPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

func DecodeRequest(reader io.Reader) (Request, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		return Request{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Request{}, errors.New("unexpected trailing request JSON")
		}
		return Request{}, err
	}
	if err := request.Validate(); err != nil {
		return Request{}, err
	}
	return request, nil
}

func (request Request) Validate() error {
	if request.SchemaVersion > CurrentSchemaVersion {
		return errors.New("request schema is newer than supported")
	}
	if request.SchemaVersion != CurrentSchemaVersion {
		return errors.New("unsupported request schema")
	}
	if !uuidPattern.MatchString(request.RequestID) {
		return errors.New("request id must be a lowercase UUID")
	}
	switch request.Operation {
	case OperationInspect, OperationCompleteOnboarding:
		if request.TargetGenerationID != "" || request.SourceTopology != "" || request.PublicPredecessorVersion != "" || request.ExpectedManifestDigest != "" || request.TransactionID != "" || request.RollbackAuthorization != nil {
			return fmt.Errorf("%s does not accept mutation selectors", request.Operation)
		}
	case OperationConverge:
		if request.RollbackAuthorization != nil {
			return errors.New("converge does not accept rollback authorization")
		}
		if !digestPattern.MatchString(request.TargetGenerationID) {
			return errors.New("converge requires a target generation digest")
		}
		if request.ExpectedManifestDigest != "absent" && !digestPattern.MatchString(request.ExpectedManifestDigest) {
			return errors.New("converge requires an expected manifest digest or absent")
		}
		if request.SourceTopology != "" {
			if request.ExpectedManifestDigest != "absent" {
				return errors.New("public-stable bridge requires an absent canonical manifest")
			}
			if len(request.SourceTopology) > 64 || !regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`).MatchString(request.SourceTopology) {
				return errors.New("converge source topology is invalid")
			}
			if model.ValidateVersion(request.PublicPredecessorVersion) != nil {
				return errors.New("public-stable bridge requires a valid predecessor version")
			}
		} else if request.PublicPredecessorVersion != "" {
			return errors.New("non-bridge converge contains public predecessor evidence")
		}
		if request.TransactionID != "" {
			return errors.New("converge allocates its own transaction identity")
		}
	case OperationRollback:
		if !digestPattern.MatchString(request.TargetGenerationID) || !digestPattern.MatchString(request.ExpectedManifestDigest) {
			return errors.New("rollback requires exact target and manifest digests")
		}
		if request.SourceTopology != "" || request.PublicPredecessorVersion != "" || request.TransactionID != "" || request.RollbackAuthorization == nil {
			return errors.New("rollback accepts only signed installed identity selectors")
		}
		if request.RollbackAuthorization.TargetGenerationID != request.TargetGenerationID {
			return errors.New("rollback target differs from its authorization")
		}
		if err := request.RollbackAuthorization.ValidateAt(time.Now().UTC()); err != nil {
			return fmt.Errorf("rollback authorization: %w", err)
		}
	case OperationRepairCurrent:
		if !digestPattern.MatchString(request.TargetGenerationID) || !digestPattern.MatchString(request.ExpectedManifestDigest) {
			return errors.New("repair-current requires exact target and manifest digests")
		}
		if request.SourceTopology != "" || request.PublicPredecessorVersion != "" || request.TransactionID != "" || request.RollbackAuthorization != nil {
			return errors.New("repair-current accepts only installed identity selectors")
		}
	case OperationRecover:
		if !uuidPattern.MatchString(request.TransactionID) {
			return errors.New("recover requires a transaction id")
		}
		if request.TargetGenerationID != "" || request.SourceTopology != "" || request.PublicPredecessorVersion != "" || request.ExpectedManifestDigest != "" || request.RollbackAuthorization != nil {
			return errors.New("recover uses journal-bound generation identity")
		}
	default:
		return fmt.Errorf("unsupported lifecycle operation %q", request.Operation)
	}
	return nil
}
