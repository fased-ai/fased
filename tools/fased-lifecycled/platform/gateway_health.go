package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"fased-lifecycled/model"
)

type LoopbackGatewayHealth struct{}

type gatewayReadiness struct {
	OK            bool   `json:"ok"`
	Ready         bool   `json:"ready"`
	Status        string `json:"status"`
	Version       string `json:"version"`
	RuntimeSource string `json:"runtimeSource"`
	Generation    *struct {
		SchemaVersion uint32 `json:"schemaVersion"`
		Version       string `json:"version"`
		ReleaseCommit string `json:"releaseCommit"`
	} `json:"generation"`
}

func verifyGatewayReadiness(statusCode int, body []byte, target model.Generation) error {
	var payload gatewayReadiness
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("decode Gateway readiness: %w", err)
	}
	if statusCode != http.StatusOK || !payload.OK || !payload.Ready || payload.Status != "ready" {
		return errors.New("Gateway did not report ready")
	}
	if payload.RuntimeSource != "managed-package" && payload.RuntimeSource != "packaged-runtime" {
		return fmt.Errorf("Gateway runtime source %q is not a verified package", payload.RuntimeSource)
	}
	if payload.Version != target.Version || payload.Generation == nil || payload.Generation.SchemaVersion != 1 || payload.Generation.Version != target.Version || payload.Generation.ReleaseCommit != target.Commit {
		return fmt.Errorf("Gateway readiness identity does not match generation %s at %s", target.Version, target.Commit)
	}
	return nil
}

func (LoopbackGatewayHealth) Verify(ctx context.Context, port uint16, target model.Generation) error {
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
				if readErr == nil && len(body) < 64<<10 && verifyGatewayReadiness(response.StatusCode, body, target) == nil {
					return nil
				}
				if readErr != nil {
					last = readErr
				} else if len(body) >= 64<<10 {
					last = errors.New("Gateway readiness response is too large")
				} else {
					last = verifyGatewayReadiness(response.StatusCode, body, target)
				}
			} else {
				last = requestErr
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("Gateway did not become ready as v%s at commit %s: %w", target.Version, target.Commit, last)
}
