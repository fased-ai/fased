package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"fased-lifecycled/protocol"
)

type transportHandler struct {
	calls int
	fail  error
}

func (handler *transportHandler) Handle(_ context.Context, request protocol.Request) (protocol.Response, error) {
	handler.calls++
	return protocol.Response{SchemaVersion: 1, RequestID: request.RequestID, Outcome: "MANAGED"}, handler.fail
}

func transportServer(handler RequestHandler) *Server {
	return &Server{Handler: handler, AllowedUIDs: map[uint32]struct{}{1000: {}},
		ReadTimeout: time.Second, WriteTimeout: time.Second, OperationTimeout: time.Second}
}

func TestServerAuthorizesPeerAndProcessesExactlyOneStrictRequest(t *testing.T) {
	handler := &transportHandler{}
	server := transportServer(handler)
	client, daemon := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- server.HandlePeer(context.Background(), daemon, Peer{UID: 1000, GID: 1000}) }()
	request := protocol.Request{SchemaVersion: 1, RequestID: requestID, Operation: protocol.OperationInspect}
	if err := json.NewEncoder(client).Encode(request); err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := json.NewDecoder(client).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil || handler.calls != 1 || response.Outcome != "MANAGED" {
		t.Fatalf("unexpected transport result: response=%+v calls=%d err=%v", response, handler.calls, err)
	}
}

func TestServerRejectsUnauthorizedPeerBeforeReading(t *testing.T) {
	handler := &transportHandler{}
	server := transportServer(handler)
	client, daemon := net.Pipe()
	defer client.Close()
	defer daemon.Close()
	if err := server.HandlePeer(context.Background(), daemon, Peer{UID: 2000}); err == nil {
		t.Fatal("unauthorized peer was accepted")
	}
	if handler.calls != 0 {
		t.Fatal("unauthorized peer reached request handler")
	}
}

func TestServerReturnsBoundErrorResponse(t *testing.T) {
	handler := &transportHandler{fail: errors.New("first failing predicate")}
	server := transportServer(handler)
	client, daemon := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- server.HandlePeer(context.Background(), daemon, Peer{UID: 1000}) }()
	request := protocol.Request{SchemaVersion: 1, RequestID: requestID, Operation: protocol.OperationInspect}
	_ = json.NewEncoder(client).Encode(request)
	var response protocol.Response
	if err := json.NewDecoder(client).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil || response.Outcome != "ERROR" || response.RequestID != requestID || response.Detail != "first failing predicate" {
		t.Fatalf("unexpected error response: %+v err=%v", response, err)
	}
}

func TestCallUsesBoundNewlineProtocolWithoutImplicitRetry(t *testing.T) {
	handler := &transportHandler{}
	server := transportServer(handler)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, daemon := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- server.HandlePeer(ctx, daemon, Peer{UID: 1000}) }()
	request := protocol.Request{SchemaVersion: 1, RequestID: requestID, Operation: protocol.OperationInspect}
	callCtx, callCancel := context.WithTimeout(ctx, time.Second)
	defer callCancel()
	response, err := callConnection(callCtx, client, request)
	if err != nil || response.Outcome != "MANAGED" || handler.calls != 1 {
		t.Fatalf("unexpected client response: %+v calls=%d err=%v", response, handler.calls, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
