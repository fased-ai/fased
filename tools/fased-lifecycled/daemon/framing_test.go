package daemon

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"fased-lifecycled/protocol"
	"golang.org/x/sys/unix"
)

func unixFramePair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "request.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	accepted := make(chan *net.UnixConn, 1)
	errs := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.AcceptUnix()
		if acceptErr != nil {
			errs <- acceptErr
			return
		}
		accepted <- connection
	}()
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	select {
	case server := <-accepted:
		t.Cleanup(func() { _ = server.Close() })
		return client, server
	case err := <-errs:
		t.Fatal(err)
	}
	return nil, nil
}

func strictFrame(t *testing.T) []byte {
	t.Helper()
	data, err := json.Marshal(protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: requestID, Operation: protocol.OperationInspect})
	if err != nil {
		t.Fatal(err)
	}
	return append(data, '\n')
}

func temporaryLeaseFile(t *testing.T) *os.File {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(t.TempDir(), "lease.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func TestReadRequestFrameAccumulatesFragmentedUnixLeaseFrame(t *testing.T) {
	client, server := unixFramePair(t)
	frame := strictFrame(t)
	lease := temporaryLeaseFile(t)
	first := len(frame) / 2
	if n, _, err := client.WriteMsgUnix(frame[:first], unix.UnixRights(int(lease.Fd())), nil); err != nil || n != first {
		t.Fatalf("first fragmented write = %d, %v", n, err)
	}
	type result struct {
		frame []byte
		lease *os.File
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		got, received, err := readRequestFrame(server)
		resultCh <- result{frame: got, lease: received, err: err}
	}()
	select {
	case result := <-resultCh:
		if result.lease != nil {
			_ = result.lease.Close()
		}
		t.Fatalf("fragmented first write unexpectedly completed: frame=%q err=%v", result.frame, result.err)
	case <-time.After(25 * time.Millisecond):
	}
	if n, err := client.Write(frame[first:]); err != nil || n != len(frame)-first {
		t.Fatalf("second fragmented write = %d, %v", n, err)
	}
	outcome := <-resultCh
	if outcome.err != nil || !bytes.Equal(outcome.frame, frame) || outcome.lease == nil {
		t.Fatalf("fragmented lease frame = %q lease=%v err=%v", outcome.frame, outcome.lease != nil, outcome.err)
	}
	if err := outcome.lease.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestReadRequestFrameRejectsCoalescedTrailingUnixFrame(t *testing.T) {
	client, server := unixFramePair(t)
	frame := strictFrame(t)
	lease := temporaryLeaseFile(t)
	if _, _, err := client.WriteMsgUnix(append(append([]byte{}, frame...), frame...), unix.UnixRights(int(lease.Fd())), nil); err != nil {
		t.Fatal(err)
	}
	if _, received, err := readRequestFrame(server); err == nil || !strings.Contains(err.Error(), "trailing frame data") || received != nil {
		t.Fatalf("coalesced frame accepted: lease=%v err=%v", received != nil, err)
	}
}

func TestReadRequestFrameClosesInvalidReceivedDescriptors(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("descriptor accounting is Linux-specific")
	}
	client, server := unixFramePair(t)
	lease := temporaryLeaseFile(t)
	before, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.WriteMsgUnix(strictFrame(t), unix.UnixRights(int(lease.Fd()), int(lease.Fd())), nil); err != nil {
		t.Fatal(err)
	}
	if _, received, err := readRequestFrame(server); err == nil || received != nil {
		t.Fatalf("multiple received descriptors accepted: lease=%v err=%v", received != nil, err)
	}
	after, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("invalid SCM_RIGHTS path leaked descriptors: before=%d after=%d", len(before), len(after))
	}
}

func TestReadRequestFrameClosesTruncatedReceivedDescriptors(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("descriptor accounting is Linux-specific")
	}
	client, server := unixFramePair(t)
	lease := temporaryLeaseFile(t)
	before, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	descriptors := make([]int, 9)
	for index := range descriptors {
		descriptors[index] = int(lease.Fd())
	}
	if _, _, err := client.WriteMsgUnix(strictFrame(t), unix.UnixRights(descriptors...), nil); err != nil {
		t.Fatal(err)
	}
	if _, received, err := readRequestFrame(server); err == nil || received != nil {
		t.Fatalf("truncated received descriptors accepted: lease=%v err=%v", received != nil, err)
	}
	after, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("truncated SCM_RIGHTS path leaked descriptors: before=%d after=%d", len(before), len(after))
	}
}

type shortLeaseWriter struct {
	firstWrite []byte
	following  []byte
	oob        []byte
}

func (writer *shortLeaseWriter) WriteMsgUnix(data, oob []byte, _ *net.UnixAddr) (int, int, error) {
	n := len(data) / 2
	writer.firstWrite = append(writer.firstWrite, data[:n]...)
	writer.oob = append(writer.oob, oob...)
	return n, len(oob), nil
}

func (writer *shortLeaseWriter) Write(data []byte) (int, error) {
	writer.following = append(writer.following, data...)
	return len(data), nil
}

func TestWriteLeaseRequestCompletesShortDataWithoutResendingRights(t *testing.T) {
	writer := &shortLeaseWriter{}
	frame := []byte("strict framed request\n")
	if err := writeLeaseRequest(writer, frame, 7); err != nil {
		t.Fatal(err)
	}
	if got := append(append([]byte{}, writer.firstWrite...), writer.following...); !bytes.Equal(got, frame) {
		t.Fatalf("short write did not complete frame: %q", got)
	}
	if len(writer.oob) == 0 || len(writer.following) == 0 {
		t.Fatalf("short write did not send rights once then data: oob=%d following=%d", len(writer.oob), len(writer.following))
	}
}
