package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"fased-lifecycled/protocol"
)

// Call performs one bounded newline-framed request. It never retries a
// mutating operation; recovery and idempotency are explicit protocol actions.
func Call(parent context.Context, socketPath string, request protocol.Request, timeout time.Duration) (protocol.Response, error) {
	if err := request.Validate(); err != nil {
		return protocol.Response{}, err
	}
	if timeout <= 0 {
		return protocol.Response{}, errors.New("lifecycle request timeout must be positive")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return protocol.Response{}, err
	}
	defer connection.Close()
	return callConnection(ctx, connection, request)
}

func callConnection(ctx context.Context, connection net.Conn, request protocol.Request) (protocol.Response, error) {
	deadline, ok := ctx.Deadline()
	if ok {
		if err := connection.SetDeadline(deadline); err != nil {
			return protocol.Response{}, err
		}
	}
	data, err := json.Marshal(request)
	if err != nil {
		return protocol.Response{}, err
	}
	if len(data)+1 > maxRequestBytes {
		return protocol.Response{}, errors.New("lifecycle request exceeds size limit")
	}
	if _, err := connection.Write(append(data, '\n')); err != nil {
		return protocol.Response{}, err
	}
	reader := bufio.NewReaderSize(connection, maxRequestBytes+1)
	frame, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(frame) > maxRequestBytes {
		return protocol.Response{}, errors.New("lifecycle response exceeds size limit")
	}
	if err != nil {
		return protocol.Response{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(frame))
	decoder.DisallowUnknownFields()
	var response protocol.Response
	if err := decoder.Decode(&response); err != nil {
		return protocol.Response{}, err
	}
	if response.SchemaVersion != protocol.CurrentSchemaVersion || response.RequestID != request.RequestID {
		return protocol.Response{}, errors.New("lifecycle response is not bound to the request")
	}
	if response.Outcome == "ERROR" {
		return response, errors.New(response.Detail)
	}
	return response, nil
}
