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
		defer func() {
			if receivedLease != nil {
				_ = receivedLease.Close()
			}
		}()
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
		if receivedLease != nil {
			if closeErr := receivedLease.Close(); closeErr != nil {
				return errors.Join(closeErr, release())
			}
			receivedLease = nil
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
	frame := make([]byte, 0, maxRequestBytes+1)
	oob := make([]byte, unix.CmsgSpace(4*4))
	var lease *os.File
	for {
		chunk := make([]byte, maxRequestBytes+1-len(frame))
		n, oobn, flags, _, err := unixConnection.ReadMsgUnix(chunk, oob)
		if err != nil {
			closeReceivedDescriptors(oob[:oobn])
			if lease != nil {
				_ = lease.Close()
			}
			return nil, nil, fmt.Errorf("read lifecycle request frame: %w", err)
		}
		if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || n <= 0 || n > len(chunk) {
			closeReceivedDescriptors(oob[:oobn])
			if lease != nil {
				_ = lease.Close()
			}
			return nil, nil, errors.New("lifecycle request exceeds size limit")
		}
		incoming, rightsErr := receivedLeaseFile(oob[:oobn])
		if rightsErr != nil {
			if lease != nil {
				_ = lease.Close()
			}
			return nil, nil, rightsErr
		}
		if incoming != nil {
			if lease != nil {
				_ = incoming.Close()
				_ = lease.Close()
				return nil, nil, errors.New("lifecycle lease handoff is invalid")
			}
			lease = incoming
		}
		chunk = chunk[:n]
		if newline := bytes.IndexByte(chunk, '\n'); newline >= 0 {
			if newline != len(chunk)-1 {
				if lease != nil {
					_ = lease.Close()
				}
				return nil, nil, errors.New("lifecycle request contains trailing frame data")
			}
			frame = append(frame, chunk...)
			if len(frame) > maxRequestBytes {
				if lease != nil {
					_ = lease.Close()
				}
				return nil, nil, errors.New("lifecycle request exceeds size limit")
			}
			return frame, lease, nil
		}
		frame = append(frame, chunk...)
		if len(frame) >= maxRequestBytes {
			if lease != nil {
				_ = lease.Close()
			}
			return nil, nil, errors.New("lifecycle request exceeds size limit")
		}
	}
}

// closeReceivedDescriptors closes every descriptor that can be recovered from
// an ancillary buffer, including the prefix retained by the kernel when it
// reports MSG_CTRUNC. It is intentionally best-effort because the caller is
// already rejecting the frame; no parsed descriptor may survive that error.
func closeReceivedDescriptors(oob []byte) {
	messages, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return
	}
	for _, message := range messages {
		descriptors, rightsErr := unix.ParseUnixRights(&message)
		if rightsErr != nil {
			continue
		}
		for _, descriptor := range descriptors {
			_ = unix.Close(descriptor)
		}
	}
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
	rightsMessages := 0
	for _, message := range messages {
		rights, rightsErr := unix.ParseUnixRights(&message)
		if rightsErr != nil {
			for _, descriptor := range descriptors {
				_ = unix.Close(descriptor)
			}
			return nil, errors.New("lifecycle lease handoff is invalid")
		}
		rightsMessages++
		descriptors = append(descriptors, rights...)
	}
	if rightsMessages != 1 || len(descriptors) != 1 {
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
