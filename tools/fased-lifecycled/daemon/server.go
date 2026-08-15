package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"fased-lifecycled/protocol"
)

const maxRequestBytes = 64 << 10

type Peer struct {
	UID uint32
	GID uint32
}

type RequestHandler interface {
	Handle(context.Context, protocol.Request) (protocol.Response, error)
}

type Server struct {
	Handler          RequestHandler
	AllowedUIDs      map[uint32]struct{}
	ReadTimeout      time.Duration
	WriteTimeout     time.Duration
	OperationTimeout time.Duration
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
	reader := bufio.NewReaderSize(connection, maxRequestBytes+1)
	frame, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(frame) > maxRequestBytes {
		return errors.New("lifecycle request exceeds size limit")
	}
	if err != nil {
		return fmt.Errorf("read lifecycle request frame: %w", err)
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

func (server *Server) validate() error {
	if server == nil || server.Handler == nil || len(server.AllowedUIDs) == 0 {
		return errors.New("lifecycle server requires a handler and explicit peer allowlist")
	}
	if server.ReadTimeout <= 0 || server.WriteTimeout <= 0 || server.OperationTimeout <= 0 {
		return errors.New("lifecycle server requires bounded positive timeouts")
	}
	return nil
}
