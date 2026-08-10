package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"fased-lifecycled/model"
)

type NetworkPolicy interface {
	Verify(context.Context, Config, model.Transaction) error
}

type NoNetworkPolicy struct{}

func (NoNetworkPolicy) Verify(context.Context, Config, model.Transaction) error { return nil }

type CommandHostingNetworkPolicy struct{ TailscaleBinary, SocketBinary string }

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
	status, err := exec.CommandContext(ctx, policy.TailscaleBinary, "status", "--json").Output()
	if err != nil {
		return fmt.Errorf("Tailscale is not ready: %w", err)
	}
	var parsed struct {
		BackendState string `json:"BackendState"`
		Self         struct {
			TailscaleIPs []string `json:"TailscaleIPs"`
		} `json:"Self"`
	}
	if json.Unmarshal(status, &parsed) != nil || parsed.BackendState != "Running" || len(parsed.Self.TailscaleIPs) == 0 {
		return errors.New("Tailscale status is not an authenticated running node")
	}
	listeners, err := exec.CommandContext(ctx, policy.SocketBinary, "-H", "-ltn").Output()
	if err != nil {
		return fmt.Errorf("socket inventory failed: %w", err)
	}
	return RejectPublicGatewayListener(string(listeners), config.GatewayPort)
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
