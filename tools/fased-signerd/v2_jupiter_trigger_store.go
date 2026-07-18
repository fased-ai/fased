package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	bolt "go.etcd.io/bbolt"
)

const (
	triggerPhaseReservedV2         = "reserved"
	triggerPhaseVaultRegisteringV2 = "vault-registering"
	triggerPhaseVaultReadyV2       = "vault-ready"
	triggerPhaseCraftingV2         = "crafting"
	triggerPhaseCancelInitiatingV2 = "cancel-initiating"
	triggerPhasePreparedV2         = "prepared"
	triggerPhaseSignedV2           = "signed"
	triggerPhaseSubmittingV2       = "submitting"
	triggerPhaseConfirmedV2        = "confirmed"
	triggerPhaseFailedV2           = "failed"
	triggerPhaseUnknownV2          = "unknown"
	triggerProviderJupiterV2       = "jupiter-trigger-v2"
	triggerOrderStateOpenV2        = "open"
	triggerOrderStateCancelledV2   = "cancelled"
)

// signerJupiterTriggerWorkflowV2 is signer-private durable state. It is never
// returned by the application socket. In particular, its crafted transaction
// and external request identifiers stay inside fased-signerd.
type signerJupiterTriggerWorkflowV2 struct {
	RequestID               string          `json:"requestId"`
	WalletID                string          `json:"walletId"`
	IntentDigest            string          `json:"intentDigest"`
	PolicyHash              string          `json:"policyHash"`
	Action                  string          `json:"action"`
	SemanticIntent          json.RawMessage `json:"semanticIntent,omitempty"`
	Phase                   string          `json:"phase"`
	StateDigest             string          `json:"stateDigest"`
	Vault                   string          `json:"vault,omitempty"`
	SourceTokenAccount      string          `json:"sourceTokenAccount,omitempty"`
	DestinationTokenAccount string          `json:"destinationTokenAccount,omitempty"`
	ExternalRequestID       string          `json:"externalRequestId,omitempty"`
	UnsignedTxBase64        string          `json:"unsignedTxBase64,omitempty"`
	TransactionDigest       string          `json:"transactionDigest,omitempty"`
	Signature               string          `json:"signature,omitempty"`
	OrderID                 string          `json:"orderId,omitempty"`
	OrderState              string          `json:"orderState,omitempty"`
	Error                   string          `json:"error,omitempty"`
	CreatedAt               string          `json:"createdAt"`
	UpdatedAt               string          `json:"updatedAt"`
}

func isSignerOwnedTriggerIntentV2(intent normalizedIntentV2) bool {
	return intent.Intent.Type == intentSolanaTriggerCreate || intent.Intent.Type == intentSolanaTriggerCancel
}

func triggerActionForIntentV2(intent normalizedIntentV2) (string, error) {
	if !isSignerOwnedTriggerIntentV2(intent) || intent.Intent.Jupiter == nil || intent.Intent.Jupiter.Trigger == nil {
		return "", errors.New("signer-owned Jupiter Trigger intent is required")
	}
	action := strings.TrimSpace(intent.Intent.Jupiter.Trigger.Operation)
	if (intent.Intent.Type == intentSolanaTriggerCreate && action != "create") ||
		(intent.Intent.Type == intentSolanaTriggerCancel && action != "cancel") {
		return "", errors.New("Jupiter Trigger operation does not match the typed intent")
	}
	return action, nil
}

func (s *signerStoreV2) ensureJupiterTriggerWorkflowV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	stateDigest string,
) (signerJupiterTriggerWorkflowV2, error) {
	if s == nil || s.db == nil {
		return signerJupiterTriggerWorkflowV2{}, errors.New("signer state database is unavailable")
	}
	if err := s.maintainStateV2(); err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	requestID, err := validateRequestIDV2(req.RequestID)
	if err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	action, err := triggerActionForIntentV2(intent)
	if err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	stateDigest, err = normalizeSHA256DigestV2(stateDigest, "Trigger stateDigest")
	if err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	walletID := normalizeWalletID(req.IntentWalletID())
	policyHash := strings.TrimSpace(req.PolicyHash)
	semanticIntent, err := json.Marshal(intent.Intent)
	if err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	var workflow signerJupiterTriggerWorkflowV2
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerJupiterTriggerV2)
		if raw := bucket.Get([]byte(requestID)); raw != nil {
			if err := json.Unmarshal(raw, &workflow); err != nil {
				return errors.New("stored Jupiter Trigger workflow is invalid")
			}
			if workflow.RequestID != requestID || workflow.WalletID != walletID ||
				workflow.IntentDigest != intent.Digest || workflow.PolicyHash != policyHash ||
				workflow.Action != action || workflow.StateDigest != stateDigest ||
				string(workflow.SemanticIntent) != string(semanticIntent) {
				return errors.New("requestId is already bound to a different immutable Jupiter Trigger workflow")
			}
			return nil
		}
		if err := requireBucketCapacityV2(bucket, maxSignerTriggerWorkflowsV2, "Jupiter Trigger workflow store"); err != nil {
			return err
		}
		now := timestampV2(s.now())
		workflow = signerJupiterTriggerWorkflowV2{
			RequestID: requestID, WalletID: walletID, IntentDigest: intent.Digest,
			PolicyHash: policyHash, Action: action, Phase: triggerPhaseReservedV2,
			SemanticIntent: semanticIntent, StateDigest: stateDigest, CreatedAt: now, UpdatedAt: now,
		}
		encoded, err := json.Marshal(workflow)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(requestID), encoded)
	})
	return workflow, err
}

func (s *signerStoreV2) getJupiterTriggerWorkflowV2(requestID string) (signerJupiterTriggerWorkflowV2, error) {
	if s == nil || s.db == nil {
		return signerJupiterTriggerWorkflowV2{}, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(requestID)
	if err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	var workflow signerJupiterTriggerWorkflowV2
	err = s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerJupiterTriggerV2).Get([]byte(requestID))
		if raw == nil {
			return errors.New("Jupiter Trigger workflow not found")
		}
		if err := json.Unmarshal(raw, &workflow); err != nil {
			return errors.New("stored Jupiter Trigger workflow is invalid")
		}
		return nil
	})
	return workflow, err
}

func triggerPhaseAllowedV2(phase string, expected []string) bool {
	for _, candidate := range expected {
		if phase == candidate {
			return true
		}
	}
	return false
}

func (s *signerStoreV2) updateJupiterTriggerWorkflowV2(
	requestID string,
	expected []string,
	mutate func(*signerJupiterTriggerWorkflowV2) error,
) (signerJupiterTriggerWorkflowV2, error) {
	if s == nil || s.db == nil {
		return signerJupiterTriggerWorkflowV2{}, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(requestID)
	if err != nil {
		return signerJupiterTriggerWorkflowV2{}, err
	}
	var workflow signerJupiterTriggerWorkflowV2
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerJupiterTriggerV2)
		raw := bucket.Get([]byte(requestID))
		if raw == nil {
			return errors.New("Jupiter Trigger workflow not found")
		}
		if err := json.Unmarshal(raw, &workflow); err != nil {
			return errors.New("stored Jupiter Trigger workflow is invalid")
		}
		if !triggerPhaseAllowedV2(workflow.Phase, expected) {
			return fmt.Errorf("Jupiter Trigger workflow is %s, expected %s", workflow.Phase, strings.Join(expected, " or "))
		}
		if err := mutate(&workflow); err != nil {
			return err
		}
		workflow.UpdatedAt = timestampV2(s.now())
		encoded, err := json.Marshal(workflow)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(requestID), encoded)
	})
	return workflow, err
}

func (s *signerStoreV2) markJupiterTriggerSignedV2(
	requestID string,
	attempt uint64,
	unsignedTxBase64 string,
	signedRaw []byte,
	signature string,
	externalRequestID string,
) (signerOperationV2, signerJupiterTriggerWorkflowV2, error) {
	if s == nil || s.db == nil {
		return signerOperationV2{}, signerJupiterTriggerWorkflowV2{}, errors.New("signer state database is unavailable")
	}
	if len(signedRaw) == 0 || len(signedRaw) > 1232 || strings.TrimSpace(signature) == "" {
		return signerOperationV2{}, signerJupiterTriggerWorkflowV2{}, errors.New("exact signed Trigger transaction is required")
	}
	signedEncoded := base64.StdEncoding.EncodeToString(signedRaw)
	digest := sha256.Sum256(signedRaw)
	transactionDigest := "sha256:" + hex.EncodeToString(digest[:])
	var operation signerOperationV2
	var workflow signerJupiterTriggerWorkflowV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		rawOperation := operations.Get([]byte(requestID))
		if rawOperation == nil || json.Unmarshal(rawOperation, &operation) != nil {
			return errors.New("stored signer operation is missing or invalid")
		}
		if operation.State != operationReserved || operation.ExecutionAttempt != attempt {
			return errors.New("stale Trigger execution attempt cannot persist signed bytes")
		}
		workflows := tx.Bucket(bucketSignerJupiterTriggerV2)
		rawWorkflow := workflows.Get([]byte(requestID))
		if rawWorkflow == nil || json.Unmarshal(rawWorkflow, &workflow) != nil {
			return errors.New("stored Jupiter Trigger workflow is missing or invalid")
		}
		if workflow.Phase != triggerPhasePreparedV2 || workflow.IntentDigest != operation.IntentDigest ||
			workflow.PolicyHash != operation.PolicyHash || workflow.WalletID != operation.WalletID {
			return errors.New("Jupiter Trigger workflow does not match its reserved signer operation")
		}
		now := timestampV2(s.now())
		operation.State = operationBroadcast
		operation.Signature = strings.TrimSpace(signature)
		operation.TransactionDigest = transactionDigest
		operation.SignedTxBase64 = signedEncoded
		operation.BroadcastAt = now
		operation.UpdatedAt = now
		operation.ExecutionLeaseUntil = ""
		workflow.Phase = triggerPhaseSignedV2
		workflow.UnsignedTxBase64 = strings.TrimSpace(unsignedTxBase64)
		workflow.ExternalRequestID = strings.TrimSpace(externalRequestID)
		workflow.TransactionDigest = transactionDigest
		workflow.Signature = strings.TrimSpace(signature)
		workflow.Error = ""
		workflow.UpdatedAt = now
		encodedOperation, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		encodedWorkflow, err := json.Marshal(workflow)
		if err != nil {
			return err
		}
		if err := operations.Put([]byte(requestID), encodedOperation); err != nil {
			return err
		}
		return workflows.Put([]byte(requestID), encodedWorkflow)
	})
	return operation, workflow, err
}

func (s *signerStoreV2) markJupiterTriggerUnknownV2(requestID string, cause error) (signerOperationV2, error) {
	var operation signerOperationV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		rawOperation := operations.Get([]byte(requestID))
		if rawOperation == nil || json.Unmarshal(rawOperation, &operation) != nil {
			return errors.New("stored signer operation is missing or invalid")
		}
		if operation.State != operationBroadcast && operation.State != operationUnknown {
			return fmt.Errorf("cannot mark Trigger operation unknown in state %s", operation.State)
		}
		workflows := tx.Bucket(bucketSignerJupiterTriggerV2)
		rawWorkflow := workflows.Get([]byte(requestID))
		var workflow signerJupiterTriggerWorkflowV2
		if rawWorkflow == nil || json.Unmarshal(rawWorkflow, &workflow) != nil {
			return errors.New("stored Jupiter Trigger workflow is missing or invalid")
		}
		if workflow.Phase != triggerPhaseSubmittingV2 && workflow.Phase != triggerPhaseUnknownV2 {
			return fmt.Errorf("cannot mark Trigger workflow unknown in phase %s", workflow.Phase)
		}
		now := timestampV2(s.now())
		safe := safeOperationErrorV2(cause)
		operation.State = operationUnknown
		operation.Error = safe
		operation.UpdatedAt = now
		workflow.Phase = triggerPhaseUnknownV2
		workflow.Error = safe
		workflow.UpdatedAt = now
		encodedOperation, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		encodedWorkflow, err := json.Marshal(workflow)
		if err != nil {
			return err
		}
		if err := operations.Put([]byte(requestID), encodedOperation); err != nil {
			return err
		}
		return workflows.Put([]byte(requestID), encodedWorkflow)
	})
	return operation, err
}

func (s *signerStoreV2) markJupiterTriggerPreSignUnknownV2(requestID string, cause error) (signerOperationV2, error) {
	var operation signerOperationV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		rawOperation := operations.Get([]byte(requestID))
		if rawOperation == nil || json.Unmarshal(rawOperation, &operation) != nil {
			return errors.New("stored signer operation is missing or invalid")
		}
		if operation.State != operationReserved {
			return fmt.Errorf("cannot mark pre-sign Trigger operation unknown in state %s", operation.State)
		}
		workflows := tx.Bucket(bucketSignerJupiterTriggerV2)
		rawWorkflow := workflows.Get([]byte(requestID))
		var workflow signerJupiterTriggerWorkflowV2
		if rawWorkflow == nil || json.Unmarshal(rawWorkflow, &workflow) != nil {
			return errors.New("stored Jupiter Trigger workflow is missing or invalid")
		}
		now := timestampV2(s.now())
		safe := safeOperationErrorV2(cause)
		operation.State = operationUnknown
		operation.Error = safe
		operation.ExecutionLeaseUntil = ""
		operation.UpdatedAt = now
		workflow.Phase = triggerPhaseUnknownV2
		workflow.Error = safe
		workflow.UpdatedAt = now
		encodedOperation, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		encodedWorkflow, err := json.Marshal(workflow)
		if err != nil {
			return err
		}
		if err := operations.Put([]byte(requestID), encodedOperation); err != nil {
			return err
		}
		return workflows.Put([]byte(requestID), encodedWorkflow)
	})
	return operation, err
}

func (s *signerStoreV2) markJupiterTriggerConfirmedV2(
	requestID string,
	orderID string,
	orderState string,
) (signerOperationV2, error) {
	var operation signerOperationV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		rawOperation := operations.Get([]byte(requestID))
		if rawOperation == nil || json.Unmarshal(rawOperation, &operation) != nil {
			return errors.New("stored signer operation is missing or invalid")
		}
		if operation.State != operationBroadcast && operation.State != operationUnknown {
			return fmt.Errorf("cannot confirm Trigger operation in state %s", operation.State)
		}
		workflows := tx.Bucket(bucketSignerJupiterTriggerV2)
		rawWorkflow := workflows.Get([]byte(requestID))
		var workflow signerJupiterTriggerWorkflowV2
		if rawWorkflow == nil || json.Unmarshal(rawWorkflow, &workflow) != nil {
			return errors.New("stored Jupiter Trigger workflow is missing or invalid")
		}
		if workflow.Phase != triggerPhaseSubmittingV2 && workflow.Phase != triggerPhaseUnknownV2 {
			return fmt.Errorf("cannot confirm Trigger workflow in phase %s", workflow.Phase)
		}
		orderID, err := normalizeJupiterExternalIDV2(orderID, "Jupiter order id")
		if err != nil || orderID == "" {
			return errors.New("confirmed Trigger order id is invalid")
		}
		orderState = strings.ToLower(strings.TrimSpace(orderState))
		if orderState != triggerOrderStateOpenV2 && orderState != triggerOrderStateCancelledV2 {
			return errors.New("confirmed Trigger order state is invalid")
		}
		now := timestampV2(s.now())
		operation.State = operationConfirmed
		operation.SignedTxBase64 = ""
		operation.AuthorizationProof = ""
		operation.Error = ""
		operation.ConfirmedAt = now
		operation.UpdatedAt = now
		operation.ExternalResult = &signerExternalResultV2{
			Provider: triggerProviderJupiterV2, Action: workflow.Action,
			OrderID: orderID, OrderState: orderState,
		}
		workflow.Phase = triggerPhaseConfirmedV2
		workflow.OrderID = orderID
		workflow.OrderState = orderState
		workflow.Error = ""
		workflow.UnsignedTxBase64 = ""
		workflow.SemanticIntent = nil
		workflow.UpdatedAt = now
		encodedOperation, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		encodedWorkflow, err := json.Marshal(workflow)
		if err != nil {
			return err
		}
		if err := operations.Put([]byte(requestID), encodedOperation); err != nil {
			return err
		}
		return workflows.Put([]byte(requestID), encodedWorkflow)
	})
	return operation, err
}
