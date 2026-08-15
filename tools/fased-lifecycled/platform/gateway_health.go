package platform

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"fased-lifecycled/engine"
	"fased-lifecycled/model"
)

type LoopbackGatewayHealth struct{}

type gatewayReadiness struct {
	OK            bool   `json:"ok"`
	Ready         bool   `json:"ready"`
	Status        string `json:"status"`
	Version       string `json:"version"`
	RuntimeSource string `json:"runtimeSource"`
	PID           uint32 `json:"pid"`
	StartedAt     string `json:"startedAt"`
	Generation    *struct {
		SchemaVersion uint32 `json:"schemaVersion"`
		GenerationID  string `json:"generationId"`
		Version       string `json:"version"`
		ReleaseCommit string `json:"releaseCommit"`
	} `json:"generation"`
}

func verifyGatewayReadiness(statusCode int, body []byte, target model.Generation) (engine.GatewayReceipt, error) {
	var payload gatewayReadiness
	if err := json.Unmarshal(body, &payload); err != nil {
		return engine.GatewayReceipt{}, fmt.Errorf("decode Gateway readiness: %w", err)
	}
	if statusCode != http.StatusOK || !payload.OK || !payload.Ready || payload.Status != "ready" {
		return engine.GatewayReceipt{}, errors.New("Gateway did not report ready")
	}
	if payload.RuntimeSource != "go-lifecycle" {
		return engine.GatewayReceipt{}, fmt.Errorf("Gateway runtime source %q is not the Go lifecycle generation", payload.RuntimeSource)
	}
	if payload.Version != target.Version || payload.Generation == nil || payload.Generation.SchemaVersion != 1 || payload.Generation.GenerationID != target.ID || payload.Generation.Version != target.Version || payload.Generation.ReleaseCommit != target.Commit {
		return engine.GatewayReceipt{}, fmt.Errorf("Gateway readiness identity does not match generation %s at %s", target.Version, target.Commit)
	}
	if payload.PID == 0 {
		return engine.GatewayReceipt{}, errors.New("Gateway readiness lacks a process identity")
	}
	if _, err := time.Parse(time.RFC3339Nano, payload.StartedAt); err != nil {
		return engine.GatewayReceipt{}, errors.New("Gateway readiness process start time is invalid")
	}
	digest := sha256.Sum256(body)
	return engine.GatewayReceipt{GenerationID: target.ID, Version: target.Version, ReleaseCommit: target.Commit, PID: payload.PID, StartedAt: payload.StartedAt, ReadinessDigest: fmt.Sprintf("sha256:%x", digest)}, nil
}

func (LoopbackGatewayHealth) Verify(ctx context.Context, port uint16, target model.Generation) (engine.GatewayReceipt, error) {
	deadline := time.Now().Add(30 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	var last error = errors.New("Gateway readiness endpoint is unavailable")
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/readyz", port), nil)
		if err == nil {
			response, requestErr := client.Do(request)
			if requestErr == nil {
				body, readErr := io.ReadAll(io.LimitReader(response.Body, 64<<10))
				_ = response.Body.Close()
				if readErr == nil && len(body) < 64<<10 {
					receipt, verifyErr := verifyGatewayReadiness(response.StatusCode, body, target)
					if verifyErr == nil {
						return receipt, nil
					}
				}
				if readErr != nil {
					last = readErr
				} else if len(body) >= 64<<10 {
					last = errors.New("Gateway readiness response is too large")
				} else {
					_, last = verifyGatewayReadiness(response.StatusCode, body, target)
				}
			} else {
				last = requestErr
			}
		}
		select {
		case <-ctx.Done():
			return engine.GatewayReceipt{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return engine.GatewayReceipt{}, fmt.Errorf("Gateway did not become ready as v%s at commit %s: %w", target.Version, target.Commit, last)
}
