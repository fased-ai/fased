// Package controller defines the private supervisor-to-target-controller protocol.
package controller

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"time"

	"fased-lifecycled/daemon"
	"fased-lifecycled/engine"
	"fased-lifecycled/model"
	"fased-lifecycled/store"
)

const schemaVersion uint32 = 1
const maxFrameBytes = 1 << 20
const controllerReadyTimeout = 30 * time.Second

type Operation string

const (
	operationRun                Operation = "RUN"
	operationCommit             Operation = "COMMIT"
	operationAbort              Operation = "ABORT"
	operationRecover            Operation = "RECOVER"
	operationCompleteOnboarding Operation = "COMPLETE_ONBOARDING"
)

type request struct {
	SchemaVersion uint32             `json:"schemaVersion"`
	Operation     Operation          `json:"operation"`
	Transaction   *model.Transaction `json:"transaction,omitempty"`
	TransactionID string             `json:"transactionId,omitempty"`
}

type response struct {
	SchemaVersion uint32        `json:"schemaVersion"`
	Result        engine.Result `json:"result"`
	Error         string        `json:"error,omitempty"`
}

type OnboardingCompleter interface {
	CompleteOnboarding(context.Context) error
}

type Service struct {
	Engine     *engine.TargetEngine
	Onboarding OnboardingCompleter
}

func (service *Service) Handle(ctx context.Context, input request) (engine.Result, error) {
	if service == nil || service.Engine == nil {
		return engine.Result{}, errors.New("target controller service is unavailable")
	}
	if input.SchemaVersion != schemaVersion {
		return engine.Result{}, errors.New("unsupported target controller protocol")
	}
	switch input.Operation {
	case operationRun:
		if input.Transaction == nil || input.TransactionID != "" {
			return engine.Result{}, errors.New("RUN requires one bound transaction")
		}
		return service.Engine.Run(ctx, *input.Transaction)
	case operationCommit:
		if input.Transaction != nil {
			return engine.Result{}, errors.New("COMMIT accepts only a transaction id")
		}
		return service.Engine.Commit(ctx, input.TransactionID)
	case operationAbort:
		if input.Transaction != nil {
			return engine.Result{}, errors.New("ABORT accepts only a transaction id")
		}
		return service.Engine.Abort(ctx, input.TransactionID)
	case operationRecover:
		if input.Transaction != nil {
			return engine.Result{}, errors.New("RECOVER accepts only a transaction id")
		}
		tx, err := service.Engine.Journal.ReadJournal(store.AuthorityTargetController, input.TransactionID)
		if err != nil {
			return engine.Result{}, err
		}
		return service.Engine.Recover(ctx, tx)
	case operationCompleteOnboarding:
		if input.Transaction != nil || input.TransactionID != "" || service.Onboarding == nil {
			return engine.Result{}, errors.New("COMPLETE_ONBOARDING accepts no selectors and requires the platform adapter")
		}
		if err := service.Onboarding.CompleteOnboarding(ctx); err != nil {
			return engine.Result{}, err
		}
		return engine.Result{Outcome: engine.OutcomeUpdated, Phase: model.PhaseCommitted}, nil
	default:
		return engine.Result{}, errors.New("unsupported target controller operation")
	}
}

type Server struct {
	Service          *Service
	OperationTimeout time.Duration
}

func (server *Server) Serve(ctx context.Context, listener *net.UnixListener) error {
	if server == nil || server.Service == nil || server.OperationTimeout <= 0 {
		return errors.New("target controller server is incomplete")
	}
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			defer connection.Close()
			peer, err := daemon.UnixPeer(connection)
			if err != nil || peer.UID != 0 {
				return
			}
			_ = connection.SetDeadline(time.Now().Add(server.OperationTimeout))
			frame, err := readFrame(connection)
			if err != nil {
				return
			}
			var input request
			if err := strictJSON(frame, &input); err != nil {
				return
			}
			operationCtx, cancel := context.WithTimeout(ctx, server.OperationTimeout)
			result, operationErr := server.Service.Handle(operationCtx, input)
			cancel()
			output := response{SchemaVersion: schemaVersion, Result: result}
			if operationErr != nil {
				output.Error = operationErr.Error()
			}
			_ = json.NewEncoder(connection).Encode(output)
		}()
	}
}

type Client struct {
	SocketPath string
	Timeout    time.Duration
}

func (client Client) Run(ctx context.Context, tx model.Transaction) (engine.Result, error) {
	return client.call(ctx, request{SchemaVersion: schemaVersion, Operation: operationRun, Transaction: &tx})
}
func (client Client) Commit(ctx context.Context, id string) (engine.Result, error) {
	return client.callID(ctx, operationCommit, id)
}
func (client Client) Abort(ctx context.Context, id string) (engine.Result, error) {
	return client.callID(ctx, operationAbort, id)
}
func (client Client) Recover(ctx context.Context, id string) (engine.Result, error) {
	return client.callID(ctx, operationRecover, id)
}
func (client Client) CompleteOnboarding(ctx context.Context) (engine.Result, error) {
	return client.call(ctx, request{SchemaVersion: schemaVersion, Operation: operationCompleteOnboarding})
}
func (client Client) callID(ctx context.Context, operation Operation, id string) (engine.Result, error) {
	return client.call(ctx, request{SchemaVersion: schemaVersion, Operation: operation, TransactionID: id})
}

func (client Client) call(ctx context.Context, input request) (engine.Result, error) {
	if client.Timeout <= 0 || client.SocketPath == "" {
		return engine.Result{}, errors.New("target controller client is incomplete")
	}
	connection, err := client.dialReady(ctx)
	if err != nil {
		return engine.Result{}, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(client.Timeout))
	if err := json.NewEncoder(connection).Encode(input); err != nil {
		return engine.Result{}, err
	}
	frame, err := readFrame(connection)
	if err != nil {
		return engine.Result{}, err
	}
	var output response
	if err := strictJSON(frame, &output); err != nil {
		return engine.Result{}, err
	}
	if output.SchemaVersion != schemaVersion {
		return engine.Result{}, errors.New("target controller response schema mismatch")
	}
	if output.Error != "" {
		return output.Result, errors.New(output.Error)
	}
	return output.Result, nil
}

// dialReady waits only for the systemd-started controller to create and bind
// its private socket. It never retries after a connection has been made, so a
// mutating request cannot be replayed after an ambiguous transport failure.
func (client Client) dialReady(ctx context.Context) (net.Conn, error) {
	readyTimeout := controllerReadyTimeout
	if client.Timeout < readyTimeout {
		readyTimeout = client.Timeout
	}
	readyCtx, cancel := context.WithTimeout(ctx, readyTimeout)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		connection, err := (&net.Dialer{}).DialContext(readyCtx, "unix", client.SocketPath)
		if err == nil {
			return connection, nil
		}
		if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ECONNREFUSED) {
			return nil, err
		}
		select {
		case <-readyCtx.Done():
			return nil, errors.New("target controller socket did not become ready")
		case <-ticker.C:
		}
	}
}

func readFrame(connection net.Conn) ([]byte, error) {
	reader := bufio.NewReaderSize(connection, maxFrameBytes+1)
	frame, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(frame) > maxFrameBytes {
		return nil, errors.New("target controller frame exceeds size limit")
	}
	if err != nil {
		return nil, err
	}
	return bytes.TrimSpace(frame), nil
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("unexpected trailing target controller JSON")
		}
		return err
	}
	return nil
}
