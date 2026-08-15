package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"

	"fased-lifecycled/model"
)

type NetworkPolicy interface {
	Verify(context.Context, Config, model.Transaction) error
}

type NoNetworkPolicy struct{}

func (NoNetworkPolicy) Verify(context.Context, Config, model.Transaction) error { return nil }

type CommandHostingNetworkPolicy struct{ TailscaleBinary, SocketBinary, SignerWebAuthnPath string }

func (policy CommandHostingNetworkPolicy) Verify(ctx context.Context, config Config, tx model.Transaction) error {
	if config.Profile != model.ProfileHosting || tx.Profile != model.ProfileHosting {
		return errors.New("Hosting network policy received another profile")
	}
	if policy.TailscaleBinary != "/usr/bin/tailscale" && policy.TailscaleBinary != "/bin/tailscale" {
		return errors.New("Tailscale binary must use a fixed system path")
	}
	if policy.SocketBinary != "/usr/bin/ss" && policy.SocketBinary != "/bin/ss" {
		return errors.New("socket inventory binary must use a fixed system path")
	}
	if policy.SignerWebAuthnPath != "/etc/fased/signerd-webauthn.env" {
		return errors.New("signer WebAuthn identity must use the fixed root path")
	}
	status, err := exec.CommandContext(ctx, policy.TailscaleBinary, "status", "--json").Output()
	if err != nil {
		return fmt.Errorf("Tailscale is not ready: %w", err)
	}
	var parsed struct {
		BackendState string `json:"BackendState"`
		Self         struct {
			DNSName      string   `json:"DNSName"`
			TailscaleIPs []string `json:"TailscaleIPs"`
		} `json:"Self"`
	}
	if json.Unmarshal(status, &parsed) != nil {
		return errors.New("Tailscale status is not an authenticated running node")
	}
	dns := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(parsed.Self.DNSName)), ".")
	if parsed.BackendState != "Running" || len(parsed.Self.TailscaleIPs) == 0 || !hostingDNSPattern.MatchString(dns) {
		return errors.New("Tailscale status is not an authenticated running node")
	}
	serve, err := exec.CommandContext(ctx, policy.TailscaleBinary, "serve", "status", "--json").Output()
	if err != nil || !privateServeTargetsLoopback(serve, config.GatewayPort) {
		return errors.Join(err, errors.New("Tailscale private Serve route is not bound to the loopback Gateway"))
	}
	if err := verifySignerWebAuthnFile(policy.SignerWebAuthnPath, dns, 0); err != nil {
		return err
	}
	listeners, err := exec.CommandContext(ctx, policy.SocketBinary, "-H", "-ltn").Output()
	if err != nil {
		return fmt.Errorf("socket inventory failed: %w", err)
	}
	return RejectPublicGatewayListener(string(listeners), config.GatewayPort)
}

var hostingDNSPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)

func privateServeTargetsLoopback(data []byte, port uint16) bool {
	var value any
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	var public bool
	var visit func(any)
	visit = func(item any) {
		switch typed := item.(type) {
		case map[string]any:
			for key, child := range typed {
				if strings.EqualFold(key, "AllowFunnel") && child == true {
					public = true
				}
				visit(child)
			}
		case []any:
			for _, child := range typed {
				visit(child)
			}
		}
	}
	visit(value)
	return !public && bytes.Contains(data, []byte(fmt.Sprintf("http://127.0.0.1:%d", port)))
}

func verifySignerWebAuthnFile(path, dns string, expectedUID uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("root-owned signer WebAuthn identity is unavailable")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o644 || stat.Uid != expectedUID || stat.Nlink != 1 || info.Size() <= 0 || info.Size() > 4096 {
		return errors.New("root-owned signer WebAuthn identity is unsafe")
	}
	data, err := os.ReadFile(path)
	want := []byte("FASED_WALLET_WEBAUTHN_RP_ID=" + dns + "\nFASED_WALLET_WEBAUTHN_ORIGINS=https://" + dns + "\n")
	if err != nil || !bytes.Equal(data, want) {
		return errors.New("root-owned signer WebAuthn identity differs from Tailscale")
	}
	return nil
}

func RejectPublicGatewayListener(listeners string, port uint16) error {
	needle := fmt.Sprintf(":%d", port)
	for _, line := range strings.Split(listeners, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		address := fields[len(fields)-2]
		if !strings.HasSuffix(address, needle) {
			continue
		}
		if strings.HasPrefix(address, "0.0.0.0:") || strings.HasPrefix(address, "[::]:") || strings.HasPrefix(address, "*:") {
			return errors.New("Hosting Gateway port is publicly exposed")
		}
	}
	return nil
}
