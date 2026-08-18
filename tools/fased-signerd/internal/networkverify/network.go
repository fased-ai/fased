// Package networkverify contains the signer-owned Solana RPC verification
// boundary. It accepts only canonical safe endpoints and uses a transport that
// cannot be redirected, proxied, or DNS-rebound into private infrastructure.
package networkverify

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/gagliardetto/solana-go/rpc/jsonrpc"
)

const (
	MaxRPCURLBytes       = 2048
	MaxRPCResponseBytes  = 4 * 1024 * 1024
	MaxRPCResponseHeader = 64 * 1024
	MaxRPCJSONDepth      = 64
	maxRPCResponseBytes  = MaxRPCResponseBytes
	maxRPCResponseHeader = MaxRPCResponseHeader
	maxRPCJSONDepth      = MaxRPCJSONDepth
	MainnetGenesisHash   = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" // pragma: allowlist secret
	DevnetGenesisHash    = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" // pragma: allowlist secret
)

// NormalizeRPCURL validates and canonicalizes a signer-owned RPC URL.
func NormalizeRPCURL(raw, field string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	if raw != strings.TrimSpace(raw) || len(raw) > MaxRPCURLBytes || strings.ContainsAny(raw, "\r\n\t\x00") {
		return "", fmt.Errorf("%s is invalid or exceeds %d bytes", field, MaxRPCURLBytes)
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Opaque != "" || parsed.Host == "" {
		return "", fmt.Errorf("%s must be an absolute HTTPS URL", field)
	}
	if parsed.User != nil {
		return "", fmt.Errorf("%s must not contain URL user information", field)
	}
	if parsed.Fragment != "" || strings.Contains(raw, "#") {
		return "", fmt.Errorf("%s must not contain a fragment", field)
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", fmt.Errorf("%s must use HTTPS", field)
	}
	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if hostname == "" || len(hostname) > 253 || strings.Contains(hostname, "%") {
		return "", fmt.Errorf("%s contains an invalid host", field)
	}
	ip := net.ParseIP(hostname)
	if ip == nil {
		if looksLikeNonCanonicalIPLiteral(hostname) {
			return "", fmt.Errorf("%s contains a non-canonical IP literal", field)
		}
		if err := validateHostname(hostname); err != nil {
			return "", fmt.Errorf("%s contains an unsafe host", field)
		}
	} else if isUnsafeIP(ip) {
		return "", fmt.Errorf("%s targets an unsafe private, metadata, link-local, multicast, or unspecified address", field)
	}
	if scheme == "http" && !isLoopbackHost(hostname, ip) {
		return "", fmt.Errorf("%s must use HTTPS except for loopback local development", field)
	}
	port := parsed.Port()
	if port != "" {
		value, err := strconv.ParseUint(port, 10, 16)
		if err != nil || value == 0 {
			return "", fmt.Errorf("%s contains an invalid port", field)
		}
		port = strconv.FormatUint(value, 10)
	}
	canonicalHost := hostname
	if ip != nil {
		canonicalHost = ip.String()
	}
	if strings.Contains(canonicalHost, ":") {
		canonicalHost = "[" + canonicalHost + "]"
	}
	if port != "" {
		joinHost := hostname
		if ip != nil {
			joinHost = ip.String()
		}
		canonicalHost = net.JoinHostPort(joinHost, port)
	}
	parsed.Scheme = scheme
	parsed.Host = canonicalHost
	return parsed.String(), nil
}

// CanonicalOrigin returns the scheme, canonical host, and explicit default port.
func CanonicalOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Hostname() == "" {
		return "", errors.New("signer-owned Solana RPC URL is invalid")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("signer-owned Solana RPC URL must use http or https")
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	} else {
		value, err := strconv.ParseUint(port, 10, 16)
		if err != nil || value == 0 {
			return "", errors.New("signer-owned Solana RPC URL has an invalid port")
		}
		port = strconv.FormatUint(value, 10)
	}
	return scheme + "://" + net.JoinHostPort(host, port), nil
}

// SameOrigin compares canonical origins in constant time at the caller boundary.
func SameOrigin(left, right string) bool {
	leftOrigin, leftErr := CanonicalOrigin(left)
	rightOrigin, rightErr := CanonicalOrigin(right)
	return leftErr == nil && rightErr == nil && subtle.ConstantTimeCompare([]byte(leftOrigin), []byte(rightOrigin)) == 1
}

// NormalizeGenesisHash rejects malformed signer-owned genesis responses.
func NormalizeGenesisHash(raw string) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) || len(raw) > 128 || strings.ContainsAny(raw, "\r\n\t\x00") {
		return "", errors.New("invalid signer network genesis hash")
	}
	if _, err := solana.PublicKeyFromBase58(raw); err != nil {
		return "", errors.New("invalid signer network genesis hash")
	}
	return raw, nil
}

// NewSolanaRPCClient constructs an RPC client with signer-owned transport rules.
func NewSolanaRPCClient(endpoint string, timeout time.Duration) *rpc.Client {
	client := jsonrpc.NewClientWithOpts(endpoint, &jsonrpc.RPCClientOpts{HTTPClient: NewHTTPClient(timeout)})
	return rpc.NewWithCustomRPCClient(client)
}

// NewHTTPClient constructs a proxy-free, redirect-refusing bounded client.
func NewHTTPClient(timeout time.Duration) *http.Client {
	base := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return DialRPC(ctx, network, address, timeout)
		},
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           16,
		MaxIdleConnsPerHost:    4,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  10 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: maxRPCResponseHeader,
		DisableCompression:     true,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
	}
	return &http.Client{
		Transport: responseBudgetRoundTripper{base: base},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: timeout,
	}
}

type responseBudgetRoundTripper struct{ base http.RoundTripper }

func (t responseBudgetRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.base == nil {
		return nil, errors.New("signer-owned Solana RPC transport is unavailable")
	}
	response, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, errors.New("signer-owned Solana RPC returned an empty response")
	}
	if response.ContentLength > maxRPCResponseBytes {
		_ = response.Body.Close()
		return nil, errors.New("signer-owned Solana RPC response exceeds the allowed size")
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxRPCResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil {
		return nil, errors.New("read signer-owned Solana RPC response")
	}
	if len(payload) > maxRPCResponseBytes {
		return nil, errors.New("signer-owned Solana RPC response exceeds the allowed size")
	}
	if closeErr != nil {
		return nil, errors.New("close signer-owned Solana RPC response")
	}
	if err := ValidateJSONDepth(payload); err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(payload))
	response.ContentLength = int64(len(payload))
	return response, nil
}

// ValidateJSONDepth enforces the signer RPC response nesting limit.
func ValidateJSONDepth(payload []byte) error {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || (trimmed[0] != '{' && trimmed[0] != '[') {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	depth := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if depth != 0 {
				return errors.New("signer-owned Solana RPC returned invalid JSON")
			}
			return nil
		}
		if err != nil {
			return errors.New("signer-owned Solana RPC returned invalid JSON")
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			continue
		}
		switch delimiter {
		case '{', '[':
			depth++
			if depth > maxRPCJSONDepth {
				return errors.New("signer-owned Solana RPC JSON exceeds the allowed nesting depth")
			}
		case '}', ']':
			depth--
			if depth < 0 {
				return errors.New("signer-owned Solana RPC returned invalid JSON")
			}
		}
	}
}

// DialRPC resolves immediately before dialing and rejects all unsafe answers.
func DialRPC(ctx context.Context, network, address string, timeout time.Duration) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || strings.TrimSpace(host) == "" || strings.TrimSpace(port) == "" {
		return nil, errors.New("signer-owned Solana RPC dial address is invalid")
	}
	host = strings.Trim(host, "[]")
	addresses := []net.IPAddr{}
	if ip := net.ParseIP(host); ip != nil {
		addresses = append(addresses, net.IPAddr{IP: ip})
	} else {
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(resolved) == 0 {
			return nil, errors.New("signer-owned Solana RPC host resolution failed")
		}
		addresses = resolved
	}
	for _, candidate := range addresses {
		if isUnsafeIP(candidate.IP) {
			return nil, errors.New("signer-owned Solana RPC resolved to an unsafe address")
		}
	}
	dialer := net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	for _, candidate := range addresses {
		connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
		if err == nil {
			return connection, nil
		}
	}
	return nil, errors.New("signer-owned Solana RPC connection failed")
}

// NormalizeCluster validates a typed Vault bond cluster.
func NormalizeCluster(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value != raw {
		return "", errors.New("typed Vault bond cluster is invalid")
	}
	switch value {
	case "local", "devnet", "mainnet-beta":
		return value, nil
	default:
		return "", errors.New("typed Vault bond cluster must be local, devnet, or mainnet-beta")
	}
}

// ValidateClusterGenesis ensures a live RPC genesis matches its typed cluster.
func ValidateClusterGenesis(cluster, genesisHash, rpcURL string) error {
	cluster, err := NormalizeCluster(cluster)
	if err != nil {
		return err
	}
	switch cluster {
	case "mainnet-beta":
		if genesisHash != MainnetGenesisHash {
			return errors.New("signer-owned RPC is not Solana mainnet-beta")
		}
	case "devnet":
		if genesisHash != DevnetGenesisHash {
			return errors.New("signer-owned RPC is not Solana devnet")
		}
	case "local":
		parsed, parseErr := url.Parse(rpcURL)
		if parseErr != nil {
			return errors.New("signer-owned local RPC URL is invalid")
		}
		host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
		ip := net.ParseIP(host)
		if !isLoopbackHost(host, ip) {
			return errors.New("typed local Vault bond execution requires a loopback signer-owned RPC")
		}
		if genesisHash == MainnetGenesisHash || genesisHash == DevnetGenesisHash || strings.TrimSpace(genesisHash) == "" {
			return errors.New("signer-owned local RPC has an invalid cluster genesis hash")
		}
	}
	return nil
}

// RPCURLsForCluster returns only reachable endpoints whose live genesis agrees
// with the reviewed typed cluster, in input order.
func RPCURLsForCluster(rpcURLs []string, cluster string, timeout time.Duration) ([]string, error) {
	if _, err := NormalizeCluster(cluster); err != nil {
		return nil, err
	}
	validated := make([]string, 0, len(rpcURLs))
	for _, rpcURL := range rpcURLs {
		client := NewSolanaRPCClient(rpcURL, timeout)
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		genesis, err := client.GetGenesisHash(ctx)
		cancel()
		if err != nil {
			continue
		}
		if err := ValidateClusterGenesis(cluster, genesis.String(), rpcURL); err != nil {
			return nil, fmt.Errorf("typed Vault bond cluster verification failed: %w", err)
		}
		validated = append(validated, rpcURL)
	}
	if len(validated) == 0 {
		return nil, errors.New("typed Vault bond cluster could not be verified by any signer-owned RPC")
	}
	return validated, nil
}

func looksLikeNonCanonicalIPLiteral(hostname string) bool {
	if hostname == "" {
		return false
	}
	for _, part := range strings.Split(hostname, ".") {
		if part == "" {
			return false
		}
		candidate, base := part, 10
		if strings.HasPrefix(strings.ToLower(candidate), "0x") {
			candidate, base = candidate[2:], 16
		}
		if candidate == "" {
			return false
		}
		for _, char := range candidate {
			if char >= '0' && char <= '9' {
				continue
			}
			if base == 16 && ((char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
				continue
			}
			return false
		}
	}
	return true
}

func validateHostname(hostname string) error {
	switch hostname {
	case "metadata", "metadata.google.internal", "metadata.aws.internal", "metadata.azure.internal", "instance-data.ec2.internal":
		return errors.New("metadata hostname")
	}
	for _, label := range strings.Split(hostname, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return errors.New("invalid hostname label")
		}
		for _, char := range label {
			if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' {
				continue
			}
			return errors.New("invalid hostname character")
		}
	}
	return nil
}

func isUnsafeIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsUnspecified() || ip.IsPrivate() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsLinkLocalMulticast() || ip.IsLinkLocalUnicast() {
		return true
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		if ipv4.Equal(net.IPv4bcast) {
			return true
		}
		for _, metadata := range []string{"100.100.100.200", "168.63.129.16", "192.0.0.192"} {
			if ipv4.Equal(net.ParseIP(metadata).To4()) {
				return true
			}
		}
	} else {
		for _, metadata := range []string{"fd00:ec2::254", "fd20:ce::254"} {
			if ip.Equal(net.ParseIP(metadata)) {
				return true
			}
		}
	}
	return false
}

func isLoopbackHost(hostname string, ip net.IP) bool {
	if ip != nil {
		return ip.IsLoopback()
	}
	return hostname == "localhost" || strings.HasSuffix(hostname, ".localhost")
}
