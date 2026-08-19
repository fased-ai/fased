package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"fased-lifecycled/protocol"
	"golang.org/x/sys/unix"
)

const maxRequestBytes = 64 << 10

type Peer struct {
	UID uint32
	GID uint32
}

type RequestHandler interface {
	Handle(context.Context, protocol.Request) (protocol.Response, error)
}

// OperationLease serializes a supervisor operation with core and plugin
// mutation routes. A non-nil received lease is a trusted duplicate passed by
// the lifecycle host; nil means the persistent supervisor acquires the same
// lease itself. The returned release is held until Handle returns, independent
// of the client connection lifetime.
type OperationLease func(context.Context, Peer, *os.File) (func() error, error)

type Server struct {
	Handler          RequestHandler
	AllowedUIDs      map[uint32]struct{}
	ReadTimeout      time.Duration
	WriteTimeout     time.Duration
	OperationTimeout time.Duration
	OperationLease   OperationLease
}

func (server *Server) Serve(ctx context.Context, listener *net.UnixListener) error {
	if err := server.validate(); err != nil {
		return err
	}
	var workers sync.WaitGroup
	defer workers.Wait()
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		peer, err := UnixPeer(connection)
		if err != nil {
			_ = connection.Close()
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer connection.Close()
			_ = server.HandlePeer(ctx, connection, peer)
		}()
	}
}

func (server *Server) HandlePeer(ctx context.Context, connection net.Conn, peer Peer) error {
	if err := server.validate(); err != nil {
		return err
	}
	if _, allowed := server.AllowedUIDs[peer.UID]; !allowed {
		return errors.New("lifecycle peer is not authorized")
	}
	if err := connection.SetReadDeadline(time.Now().Add(server.ReadTimeout)); err != nil {
		return err
	}
	frame, receivedLease, err := readRequestFrame(connection)
	if err != nil {
		return err
	}
	if receivedLease != nil {
		defer receivedLease.Close()
	}
	request, err := protocol.DecodeRequest(bytes.NewReader(frame))
	if err != nil {
		return err
	}
	if request.Operation == protocol.OperationRollback && peer.UID != 0 {
		return errors.New("rollback requires the root-authorized lifecycle client")
	}
	operationCtx, cancel := context.WithTimeout(ctx, server.OperationTimeout)
	defer cancel()
	if server.OperationLease != nil {
		release, leaseErr := server.OperationLease(operationCtx, peer, receivedLease)
		if leaseErr != nil {
			return leaseErr
		}
		defer func() { _ = release() }()
	}
	response, operationErr := server.Handler.Handle(operationCtx, request)
	if operationErr != nil {
		if response.Outcome == "ROLLED_BACK" || response.Outcome == "RECOVERY_PENDING" {
			response.SchemaVersion = protocol.CurrentSchemaVersion
			response.RequestID = request.RequestID
			response.Detail = operationErr.Error()
		} else {
			response = protocol.Response{
				SchemaVersion: protocol.CurrentSchemaVersion, RequestID: request.RequestID,
				Outcome: "ERROR", Detail: operationErr.Error(),
			}
		}
	}
	if err := connection.SetWriteDeadline(time.Now().Add(server.WriteTimeout)); err != nil {
		return err
	}
	if err := json.NewEncoder(connection).Encode(response); err != nil {
		return err
	}
	return operationErr
}

func readRequestFrame(connection net.Conn) ([]byte, *os.File, error) {
	unixConnection, isUnix := connection.(*net.UnixConn)
	if !isUnix {
		return readBufferedRequestFrame(connection)
	}
	frame := make([]byte, maxRequestBytes+1)
	oob := make([]byte, unix.CmsgSpace(4*4))
	n, oobn, flags, _, err := unixConnection.ReadMsgUnix(frame, oob)
	if err != nil {
		return nil, nil, fmt.Errorf("read lifecycle request frame: %w", err)
	}
	if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || n > maxRequestBytes {
		return nil, nil, errors.New("lifecycle request exceeds size limit")
	}
	if n == 0 || frame[n-1] != '\n' {
		return nil, nil, errors.New("lifecycle request frame is incomplete")
	}
	lease, err := receivedLeaseFile(oob[:oobn])
	if err != nil {
		return nil, nil, err
	}
	return frame[:n], lease, nil
}

func readBufferedRequestFrame(connection net.Conn) ([]byte, *os.File, error) {
	reader := bufio.NewReaderSize(connection, maxRequestBytes+1)
	frame, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(frame) > maxRequestBytes {
		return nil, nil, errors.New("lifecycle request exceeds size limit")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read lifecycle request frame: %w", err)
	}
	return frame, nil, nil
}

func receivedLeaseFile(oob []byte) (*os.File, error) {
	if len(oob) == 0 {
		return nil, nil
	}
	messages, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil, errors.New("lifecycle lease handoff is invalid")
	}
	var descriptors []int
	for _, message := range messages {
		rights, rightsErr := unix.ParseUnixRights(&message)
		if rightsErr != nil {
			continue
		}
		descriptors = append(descriptors, rights...)
	}
	if len(descriptors) != 1 {
		for _, descriptor := range descriptors {
			_ = unix.Close(descriptor)
		}
		return nil, errors.New("lifecycle lease handoff is invalid")
	}
	return os.NewFile(uintptr(descriptors[0]), "lifecycle-mutation-lease"), nil
}

func (server *Server) validate() error {
	if server == nil || server.Handler == nil || len(server.AllowedUIDs) == 0 {
		return errors.New("lifecycle server requires a handler and explicit peer allowlist")
	}
	if server.ReadTimeout <= 0 || server.WriteTimeout <= 0 || server.OperationTimeout <= 0 {
		return errors.New("lifecycle server requires bounded positive timeouts")
	}
	return nil
}
