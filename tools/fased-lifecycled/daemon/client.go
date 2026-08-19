package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"time"

	"fased-lifecycled/protocol"
	"golang.org/x/sys/unix"
)

// Call performs one bounded newline-framed request. It never retries a
// mutating operation; recovery and idempotency are explicit protocol actions.
func Call(parent context.Context, socketPath string, request protocol.Request, timeout time.Duration) (protocol.Response, error) {
	return call(parent, socketPath, request, timeout, nil)
}

// CallWithLease transfers a duplicate of the lifecycle mutation lease to the
// persistent supervisor. The supervisor retains that capability while it runs
// the request, so the bootstrap client may exit without opening an
// unlock/relock window around a generation mutation.
func CallWithLease(parent context.Context, socketPath string, request protocol.Request, timeout time.Duration, lease *os.File) (protocol.Response, error) {
	if lease == nil {
		return protocol.Response{}, errors.New("lifecycle mutation lease is unavailable")
	}
	return call(parent, socketPath, request, timeout, lease)
}

func call(parent context.Context, socketPath string, request protocol.Request, timeout time.Duration, lease *os.File) (protocol.Response, error) {
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
	if lease != nil {
		unixConnection, ok := connection.(*net.UnixConn)
		if !ok {
			return protocol.Response{}, errors.New("lifecycle lease handoff requires a Unix socket")
		}
		return callUnixConnectionWithLease(ctx, unixConnection, request, lease)
	}
	return callConnection(ctx, connection, request)
}

func callUnixConnectionWithLease(ctx context.Context, connection *net.UnixConn, request protocol.Request, lease *os.File) (protocol.Response, error) {
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
	data = append(data, '\n')
	if len(data) > maxRequestBytes {
		return protocol.Response{}, errors.New("lifecycle request exceeds size limit")
	}
	if err := writeLeaseRequest(connection, data, int(lease.Fd())); err != nil {
		return protocol.Response{}, err
	}
	return readResponse(connection, request)
}

type leaseMessageWriter interface {
	WriteMsgUnix([]byte, []byte, *net.UnixAddr) (int, int, error)
	Write([]byte) (int, error)
}

// writeLeaseRequest sends the SCM_RIGHTS capability exactly once. Stream
// sockets may short-write the data portion, so the remaining frame is written
// normally without a second control message.
func writeLeaseRequest(connection leaseMessageWriter, data []byte, descriptor int) error {
	n, _, err := connection.WriteMsgUnix(data, unix.UnixRights(descriptor), nil)
	if err != nil {
		return err
	}
	if n <= 0 || n > len(data) {
		return errors.New("lifecycle lease handoff wrote an incomplete request")
	}
	for n < len(data) {
		written, writeErr := connection.Write(data[n:])
		if writeErr != nil {
			return writeErr
		}
		if written <= 0 || written > len(data)-n {
			return errors.New("lifecycle lease handoff wrote an incomplete request")
		}
		n += written
	}
	return nil
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
	return readResponse(connection, request)
}

func readResponse(connection net.Conn, request protocol.Request) (protocol.Response, error) {
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
