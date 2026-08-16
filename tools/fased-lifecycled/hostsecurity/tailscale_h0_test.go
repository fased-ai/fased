//go:build tailscale_h0

package hostsecurity

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

type tailscaleH0Runner struct {
	socket               string
	loginServer          string
	headscaleAuthKeyFile string
}

func (runner tailscaleH0Runner) Run(ctx context.Context, command string, args []string, stdin io.Reader, stdout, stderr io.Writer, environment []string) error {
	if command == "/usr/bin/tailscale" {
		adapted := []string{"--socket=" + runner.socket}
		if len(args) > 0 && args[0] == "up" {
			adapted = append(adapted, "up", "--login-server="+runner.loginServer, "--accept-dns=false", "--hostname=fased-h0")
			for _, arg := range args[1:] {
				if strings.HasPrefix(arg, "--auth-key=file:") {
					arg = "--auth-key=file:" + runner.headscaleAuthKeyFile
				}
				adapted = append(adapted, arg)
			}
		} else if len(args) >= 4 && args[0] == "serve" && args[1] == "--bg" && args[2] == "--yes" {
			// Headscale does not implement Tailscale's certificate-enablement API.
			// Exercise the real private Serve data plane on port 443 over HTTP;
			// production SaaS HTTPS remains an owner-operated Hosting predicate.
			adapted = append(adapted, "serve", "--http=443", "--bg", "--yes", args[3])
		} else {
			adapted = append(adapted, args...)
		}
		args = adapted
	}
	return (CommandRunner{}).Run(ctx, command, args, stdin, stdout, stderr, environment)
}

func (runner tailscaleH0Runner) Output(ctx context.Context, command string, args ...string) ([]byte, error) {
	var output bytes.Buffer
	err := runner.Run(ctx, command, args, nil, &output, &output, nil)
	if output.Len() > maxCommandOutput {
		return nil, io.ErrShortBuffer
	}
	return output.Bytes(), err
}

func TestRealTailscaleH0(t *testing.T) {
	socket := os.Getenv("FASED_H0_TAILSCALE_SOCKET")
	loginServer := os.Getenv("FASED_H0_LOGIN_SERVER")
	authKeyFile := os.Getenv("FASED_H0_AUTH_KEY_FILE")
	headscaleAuthKeyFile := os.Getenv("FASED_H0_HEADSCALE_AUTH_KEY_FILE")
	wantSuffix := os.Getenv("FASED_H0_EXPECTED_DNS_SUFFIX")
	if socket == "" || loginServer == "" || authKeyFile == "" || headscaleAuthKeyFile == "" || wantSuffix == "" {
		t.Fatal("H0 environment is incomplete")
	}
	runner := tailscaleH0Runner{socket: socket, loginServer: loginServer, headscaleAuthKeyFile: headscaleAuthKeyFile}
	host := LinuxHost{Runner: runner, HTTPClient: &http.Client{Timeout: 5 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	before, err := host.Inspect(ctx, 18789, "fc")
	if err != nil || !before.TailscaleInstalled || before.Authenticated {
		t.Fatalf("unexpected pre-auth inspection: %#v err=%v", before, err)
	}
	if err := host.Authenticate(ctx, authKeyFile, false, io.Discard); err != nil {
		t.Fatalf("authenticate real client: %v", err)
	}
	authenticated, err := host.Inspect(ctx, 18789, "fc")
	if err != nil || !authenticated.TailscaleRunning || !authenticated.Authenticated || authenticated.TailscaleIPv4 == "" || authenticated.TailscaleVersion == "" || !strings.HasSuffix(authenticated.TailscaleDNS, wantSuffix) {
		t.Fatalf("real client identity did not converge: %#v err=%v", authenticated, err)
	}
	previous, err := host.SnapshotPrivateServe(ctx)
	if err != nil || !strings.Contains(previous, `"version"`) {
		t.Fatalf("unexpected initial Serve snapshot: %q err=%v", previous, err)
	}
	if err := host.ConfigurePrivateServe(ctx, 18789); err != nil {
		t.Fatalf("configure real private Serve: %v", err)
	}
	configured, err := host.Inspect(ctx, 18789, "fc")
	if err != nil || !configured.PrivateServeReady {
		t.Fatalf("private Serve did not converge: %#v err=%v", configured, err)
	}
	if err := host.RestorePrivateServe(ctx, previous); err != nil {
		t.Fatalf("restore Serve baseline: %v", err)
	}
	restored, err := host.Inspect(ctx, 18789, "fc")
	if err != nil || restored.PrivateServeReady {
		t.Fatalf("Serve rollback did not converge: %#v err=%v", restored, err)
	}
	if err := host.ConfigurePrivateServe(ctx, 18789); err != nil {
		t.Fatalf("restore final private Serve evidence: %v", err)
	}
}
