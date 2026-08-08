package controller

import (
	"context"
	"testing"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

func TestServiceRejectsUnboundOperationsBeforeEngine(t *testing.T) {
	service := Service{Engine: &engine.TargetEngine{}}
	if _, err := service.Handle(context.Background(), request{SchemaVersion: 1, Operation: operationRun}); err == nil {
		t.Fatal("RUN without transaction was accepted")
	}
	if _, err := service.Handle(context.Background(), request{SchemaVersion: 1, Operation: operationCommit, Transaction: &model.Transaction{}}); err == nil {
		t.Fatal("COMMIT with caller transaction was accepted")
	}
	if _, err := service.Handle(context.Background(), request{SchemaVersion: 2, Operation: operationRecover}); err == nil {
		t.Fatal("newer private controller protocol was accepted")
	}
}

func TestStrictControllerJSONRejectsUnknownFields(t *testing.T) {
	var input request
	if err := strictJSON([]byte(`{"schemaVersion":1,"operation":"RECOVER","transactionId":"x","command":"rm"}`), &input); err == nil {
		t.Fatal("unknown controller command field was accepted")
	}
}
