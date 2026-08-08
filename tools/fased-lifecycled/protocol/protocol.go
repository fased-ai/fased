// Package protocol defines the fixed external surface of the lifecycle daemon.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

const CurrentSchemaVersion uint32 = 1

type Operation string

const (
	OperationInspect  Operation = "INSPECT"
	OperationConverge Operation = "CONVERGE"
	OperationRecover  Operation = "RECOVER"
)

type Request struct {
	SchemaVersion          uint32    `json:"schemaVersion"`
	RequestID              string    `json:"requestId"`
	Operation              Operation `json:"operation"`
	TargetGenerationID     string    `json:"targetGenerationId,omitempty"`
	ExpectedManifestDigest string    `json:"expectedManifestDigest,omitempty"`
	TransactionID          string    `json:"transactionId,omitempty"`
}

type Response struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	RequestID     string `json:"requestId"`
	Outcome       string `json:"outcome"`
	Detail        string `json:"detail,omitempty"`
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
	case OperationInspect:
		if request.TargetGenerationID != "" || request.ExpectedManifestDigest != "" || request.TransactionID != "" {
			return errors.New("inspect does not accept mutation selectors")
		}
	case OperationConverge:
		if !digestPattern.MatchString(request.TargetGenerationID) {
			return errors.New("converge requires a target generation digest")
		}
		if request.ExpectedManifestDigest != "absent" && !digestPattern.MatchString(request.ExpectedManifestDigest) {
			return errors.New("converge requires an expected manifest digest or absent")
		}
		if request.TransactionID != "" {
			return errors.New("converge allocates its own transaction identity")
		}
	case OperationRecover:
		if !uuidPattern.MatchString(request.TransactionID) {
			return errors.New("recover requires a transaction id")
		}
		if request.TargetGenerationID != "" || request.ExpectedManifestDigest != "" {
			return errors.New("recover uses journal-bound generation identity")
		}
	default:
		return fmt.Errorf("unsupported lifecycle operation %q", request.Operation)
	}
	return nil
}
