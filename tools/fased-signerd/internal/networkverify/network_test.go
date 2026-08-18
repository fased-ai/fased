package networkverify

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNormalizeRPCURLAndOriginFailClosed(t *testing.T) {
	for _, raw := range []string{
		"https://api.mainnet-beta.solana.com",
		"http://localhost:8899",
		"http://[0:0:0:0:0:0:0:1]:08899/rpc",
	} {
		if _, err := NormalizeRPCURL(raw, "primaryRpcUrl"); err != nil {
			t.Fatalf("NormalizeRPCURL(%q): %v", raw, err)
		}
	}
	for _, raw := range []string{
		"http://rpc.example.com",
		"https://169.254.169.254/latest/meta-data",
		"https://metadata.google.internal/computeMetadata/v1",
		"https://2130706433/rpc",
		"https://rpc_example.com",
	} {
		if _, err := NormalizeRPCURL(raw, "primaryRpcUrl"); err == nil {
			t.Fatalf("unsafe URL accepted: %q", raw)
		}
	}
	left, err := CanonicalOrigin("https://api.mainnet-beta.solana.com")
	if err != nil {
		t.Fatal(err)
	}
	right, err := CanonicalOrigin("https://api.mainnet-beta.solana.com:0443")
	if err != nil || left != right || !SameOrigin("https://api.mainnet-beta.solana.com", "https://api.mainnet-beta.solana.com:0443") {
		t.Fatalf("canonical origins differ: left=%q right=%q err=%v", left, right, err)
	}
}

func TestDialRPCRejectsUnsafeTargets(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, address := range []string{"169.254.169.254:443", "224.0.0.1:443", "[fd00:ec2::254]:443"} {
		connection, err := DialRPC(ctx, "tcp", address, time.Second)
		if err == nil || connection != nil || !strings.Contains(err.Error(), "unsafe") {
			t.Fatalf("unsafe target accepted %s: %#v %v", address, connection, err)
		}
	}
}

func TestHTTPClientRefusesRedirectAndBoundsJSON(t *testing.T) {
	client := NewHTTPClient(time.Second)
	if err := client.CheckRedirect(&http.Request{}, nil); err != http.ErrUseLastResponse {
		t.Fatalf("redirect policy changed: %v", err)
	}
	transport, ok := client.Transport.(responseBudgetRoundTripper)
	base, baseOK := transport.base.(*http.Transport)
	if !ok || !baseOK || base.Proxy != nil || base.ResponseHeaderTimeout != 10*time.Second ||
		base.MaxResponseHeaderBytes != MaxRPCResponseHeader || !base.DisableCompression ||
		base.TLSClientConfig == nil || base.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		t.Fatalf("transport boundary changed: %#v", client.Transport)
	}
	deep := []byte(strings.Repeat("[", MaxRPCJSONDepth+1) + "0" + strings.Repeat("]", MaxRPCJSONDepth+1))
	if err := ValidateJSONDepth(deep); err == nil || !strings.Contains(err.Error(), "nesting depth") {
		t.Fatalf("deep JSON accepted: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, "https://rpc.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	responseFor := func(payload []byte, contentLength int64) responseBudgetRoundTripper {
		return responseBudgetRoundTripper{base: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(payload)), ContentLength: contentLength}, nil
		})}
	}
	oversized := bytes.Repeat([]byte("x"), MaxRPCResponseBytes+1)
	if _, err := responseFor(oversized, -1).RoundTrip(request); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("streamed oversized RPC response was accepted: %v", err)
	}
	if _, err := responseFor([]byte(`{}`), MaxRPCResponseBytes+1).RoundTrip(request); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("declared oversized RPC response was accepted: %v", err)
	}
	valid := []byte(`{"jsonrpc":"2.0","id":1,"result":{"value":1}}`)
	response, err := responseFor(valid, int64(len(valid))).RoundTrip(request)
	if err != nil {
		t.Fatalf("bounded RPC response was rejected: %v", err)
	}
	readBack, err := io.ReadAll(response.Body)
	if err != nil || !bytes.Equal(readBack, valid) {
		t.Fatalf("bounded RPC response changed: %q err=%v", readBack, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestGenesisClusterBinding(t *testing.T) {
	if _, err := NormalizeGenesisHash(MainnetGenesisHash); err != nil {
		t.Fatal(err)
	}
	if err := ValidateClusterGenesis("mainnet-beta", MainnetGenesisHash, "https://rpc.example.com"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateClusterGenesis("devnet", MainnetGenesisHash, "https://rpc.example.com"); err == nil || !strings.Contains(err.Error(), "not Solana devnet") {
		t.Fatalf("mismatched genesis accepted: %v", err)
	}
	if err := ValidateClusterGenesis("local", MainnetGenesisHash, "http://127.0.0.1:8899"); err == nil || !strings.Contains(err.Error(), "invalid cluster genesis") {
		t.Fatalf("public local genesis accepted: %v", err)
	}
}

func TestRPCURLsForClusterFiltersLiveEndpointsInOrder(t *testing.T) {
	first := startGenesisRPC(t, MainnetGenesisHash)
	second := startGenesisRPC(t, MainnetGenesisHash)
	urls, err := RPCURLsForCluster([]string{second.URL, "http://127.0.0.1:1", first.URL}, "mainnet-beta", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(urls) != 2 || urls[0] != second.URL || urls[1] != first.URL {
		t.Fatalf("live cluster endpoints were not retained in input order: %#v", urls)
	}
}

func TestRPCURLsForClusterFailsClosed(t *testing.T) {
	mismatch := startGenesisRPC(t, DevnetGenesisHash)
	if _, err := RPCURLsForCluster([]string{mismatch.URL}, "mainnet-beta", time.Second); err == nil || !strings.Contains(err.Error(), "typed Vault bond cluster verification failed: signer-owned RPC is not Solana mainnet-beta") {
		t.Fatalf("mismatched genesis was accepted: %v", err)
	}
	if _, err := RPCURLsForCluster([]string{"http://127.0.0.1:1"}, "mainnet-beta", time.Second); err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Fatalf("all-unreachable endpoints did not fail closed: %v", err)
	}
}

func startGenesisRPC(t *testing.T, genesis string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"jsonrpc":"2.0","id":1,"result":"`+genesis+`"}`)
	}))
	t.Cleanup(server.Close)
	return server
}
