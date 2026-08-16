package hostsecurity

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
)

const maxCommandOutput = 1 << 20

type Runner interface {
	Run(context.Context, string, []string, io.Reader, io.Writer, io.Writer, []string) error
	Output(context.Context, string, ...string) ([]byte, error)
}

type CommandRunner struct{}

func (CommandRunner) Run(ctx context.Context, command string, args []string, stdin io.Reader, stdout, stderr io.Writer, environment []string) error {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	cmd.Env = append([]string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}, environment...)
	return cmd.Run()
}

func (runner CommandRunner) Output(ctx context.Context, command string, args ...string) ([]byte, error) {
	var output bytes.Buffer
	limited := &boundedWriter{Writer: &output, Remaining: maxCommandOutput}
	err := runner.Run(ctx, command, args, nil, limited, limited, nil)
	if limited.Exceeded {
		return nil, errors.New("Hosting security command output exceeded its bound")
	}
	return output.Bytes(), err
}

type boundedWriter struct {
	Writer    io.Writer
	Remaining int
	Exceeded  bool
}

func (writer *boundedWriter) Write(data []byte) (int, error) {
	if len(data) > writer.Remaining {
		writer.Exceeded = true
		return 0, errors.New("bounded writer exceeded")
	}
	written, err := writer.Writer.Write(data)
	writer.Remaining -= written
	return written, err
}

func fixedExecutable(candidates ...string) (string, error) {
	for _, candidate := range candidates {
		info, err := os.Lstat(candidate)
		stat, statOK := infoSyscallStat(info)
		if err == nil && statOK && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 &&
			info.Mode().Perm()&0o111 != 0 && info.Mode().Perm()&0o022 == 0 && stat.Uid == 0 && stat.Nlink >= 1 {
			return candidate, nil
		}
	}
	return "", errors.New("required fixed root-owned system executable is unavailable")
}

func infoSyscallStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}
