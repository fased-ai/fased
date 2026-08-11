package controller

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type fakeOnboardingCompleter struct{ calls int }

func (value *fakeOnboardingCompleter) CompleteOnboarding(context.Context) (engine.Result, error) {
	value.calls++
	return engine.Result{Outcome: engine.OutcomeAlreadyCurrent, Phase: model.PhaseCommitted}, nil
}

func TestClientWaitsForTargetControllerSocketWithoutReplayingRequest(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "controller.sock")
	requestCount := make(chan int, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		listener, err := net.Listen("unix", socketPath)
		if err != nil {
			requestCount <- -1
			return
		}
		defer listener.Close()
		connection, err := listener.Accept()
		if err != nil {
			requestCount <- -1
			return
		}
		defer connection.Close()
		frame, err := bufio.NewReader(connection).ReadBytes('\n')
		if err != nil {
			requestCount <- -1
			return
		}
		var input request
		if err := json.Unmarshal(frame, &input); err != nil || input.Operation != operationRun {
			requestCount <- -1
			return
		}
		requestCount <- 1
		_ = json.NewEncoder(connection).Encode(response{
			SchemaVersion: schemaVersion,
			Result:        engine.Result{Outcome: engine.OutcomePrepared, Phase: model.PhaseVerified},
		})
	}()
	client := Client{SocketPath: socketPath, Timeout: time.Second}
	result, err := client.Run(context.Background(), model.Transaction{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != engine.OutcomePrepared || <-requestCount != 1 {
		t.Fatal("controller readiness wait changed or replayed the request")
	}
}

func TestClientControllerReadinessWaitIsBounded(t *testing.T) {
	client := Client{SocketPath: filepath.Join(t.TempDir(), "missing.sock"), Timeout: 120 * time.Millisecond}
	started := time.Now()
	_, err := client.Run(context.Background(), model.Transaction{})
	if err == nil || err.Error() != "target controller socket did not become ready" {
		t.Fatalf("unexpected readiness result: %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("controller readiness wait exceeded its bound")
	}
}

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

func TestServiceCompletesOnboardingOnlyThroughTypedAdapter(t *testing.T) {
	completion := &fakeOnboardingCompleter{}
	service := Service{Engine: &engine.TargetEngine{}, Onboarding: completion}
	result, err := service.Handle(context.Background(), request{SchemaVersion: 1, Operation: operationCompleteOnboarding})
	if err != nil || completion.calls != 1 || result.Outcome != engine.OutcomeAlreadyCurrent || result.Phase != model.PhaseCommitted {
		t.Fatalf("unexpected onboarding completion: result=%+v calls=%d err=%v", result, completion.calls, err)
	}
	if _, err := service.Handle(context.Background(), request{SchemaVersion: 1, Operation: operationCompleteOnboarding, TransactionID: "caller"}); err == nil {
		t.Fatal("onboarding completion accepted a caller selector")
	}
}

func TestStrictControllerJSONRejectsUnknownFields(t *testing.T) {
	var input request
	if err := strictJSON([]byte(`{"schemaVersion":1,"operation":"RECOVER","transactionId":"x","command":"rm"}`), &input); err == nil {
		t.Fatal("unknown controller command field was accepted")
	}
}
