package signer

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"fased-lifecycled/platform"
)

const socketTimeout = 20 * time.Second
const maxSignerResponse = 1 << 20

type CommandCaller struct {
	ClientBinary string
	Config       platform.Config
	SystemdRun   string
}

func (caller CommandCaller) Call(ctx context.Context, operation string, request UpgradeRequest) (UpgradeReceipt, error) {
	if err := requireExecutable(caller.ClientBinary); err != nil {
		return UpgradeReceipt{}, err
	}
	if !allowedOperation(operation) {
		return UpgradeReceipt{}, errors.New("unsupported signer lifecycle operation")
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return UpgradeReceipt{}, err
	}
	command, err := signerCommand(ctx, caller.SystemdRun, caller.ClientBinary, caller.Config.Signer, "",
		"signer-call", "--socket", caller.Config.ControlSocket(), "--operation", operation)
	if err != nil {
		return UpgradeReceipt{}, err
	}
	command.Stdin = bytes.NewReader(encoded)
	output, err := command.Output()
	if err != nil {
		return UpgradeReceipt{}, fmt.Errorf("signer lifecycle call failed: %w", err)
	}
	var receipt UpgradeReceipt
	if err := strictDecode(output, &receipt); err != nil {
		return UpgradeReceipt{}, errors.New("signer lifecycle helper returned an invalid receipt")
	}
	return receipt, nil
}

func RunSocketHelper(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("signer-call", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var socket, operation string
	flags.StringVar(&socket, "socket", "", "")
	flags.StringVar(&operation, "operation", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !allowedOperation(operation) {
		return errors.New("invalid signer-call invocation")
	}
	if err := validateOwnedControlSocket(socket); err != nil {
		return err
	}
	var request UpgradeRequest
	limited, err := io.ReadAll(io.LimitReader(stdin, 64<<10))
	if err != nil || len(limited) == 64<<10 {
		return errors.New("invalid signer-call request size")
	}
	if err := strictDecode(limited, &request); err != nil {
		return errors.New("invalid signer-call request")
	}
	envelope, err := json.Marshal(struct {
		Op      string         `json:"op"`
		Request UpgradeRequest `json:"request"`
	}{Op: operation, Request: request})
	if err != nil {
		return err
	}
	dialer := net.Dialer{Timeout: socketTimeout}
	connection, err := dialer.Dial("unix", socket)
	if err != nil {
		return errors.New("connect signer control socket")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(socketTimeout))
	if _, err := connection.Write(append(envelope, '\n')); err != nil {
		return errors.New("write signer lifecycle request")
	}
	line, err := bufio.NewReaderSize(connection, maxSignerResponse+1).ReadSlice('\n')
	if err != nil || len(line) > maxSignerResponse {
		return errors.New("read signer lifecycle response")
	}
	var response struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  string          `json:"error,omitempty"`
	}
	if err := strictDecode(bytes.TrimSpace(line), &response); err != nil {
		return errors.New("invalid signer lifecycle response")
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "signer rejected lifecycle request"
		}
		return errors.New(response.Error)
	}
	var receipt UpgradeReceipt
	if err := strictDecode(response.Result, &receipt); err != nil {
		return errors.New("invalid signer lifecycle result")
	}
	return json.NewEncoder(stdout).Encode(receipt)
}

func validateOwnedControlSocket(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("signer control socket path must be absolute and clean")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
		return errors.New("signer control socket directory is unsafe")
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
		return errors.New("signer control socket is unavailable or unsafe")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return errors.New("signer control socket is not owned by the helper identity")
	}
	return nil
}

func allowedOperation(operation string) bool {
	switch operation {
	case "v2.lifecycle.upgrade.prepare", "v2.lifecycle.upgrade.verify", "v2.lifecycle.upgrade.commit", "v2.lifecycle.upgrade.abort":
		return true
	default:
		return false
	}
}

func strictDecode(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON")
		}
		return err
	}
	return nil
}
