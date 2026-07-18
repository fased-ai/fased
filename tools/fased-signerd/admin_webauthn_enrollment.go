package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	signerEnrollmentDefaultTimeout = 5 * time.Minute
	signerEnrollmentMinTimeout     = 30 * time.Second
	signerEnrollmentMaxTimeout     = 10 * time.Minute
	signerEnrollmentMaxBeginBody   = 1 << 10
	signerEnrollmentMaxFinishBody  = signerWebAuthnMaxResponse + (8 << 10)
	signerEnrollmentMaxHeaderBytes = 8 << 10
)

var signerEnrollmentPathPattern = regexp.MustCompile(`^/[A-Za-z0-9_/-]*$`)

const signerEnrollmentStyle = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
main { border: 1px solid #8886; border-radius: 12px; padding: 1.5rem; }
button { font: inherit; padding: .7rem 1rem; cursor: pointer; }
#status { white-space: pre-wrap; }
`

const signerEnrollmentScript = `
"use strict";
const statusNode = document.getElementById("status");
const button = document.getElementById("enroll");
const token = location.hash.length > 1 ? location.hash.slice(1) : "";
let registration = null;
history.replaceState(null, "", location.pathname);
const setStatus = (value) => { statusNode.textContent = value; };
const fromBase64Url = (value) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};
const toBase64Url = (value) => {
  const bytes = new Uint8Array(value);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const api = async (name, body) => {
  const response = await fetch(new URL(name, location.href), {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "Invalid server response." }));
  if (!response.ok || !payload.ok) throw new Error(payload.error || "Enrollment failed.");
  return payload.result;
};
const serializeCredential = (credential) => {
  const response = credential.response;
  const rawId = toBase64Url(credential.rawId);
  return {
    id: credential.id || rawId,
    rawId,
    type: "public-key",
    response: {
      attestationObject: toBase64Url(response.attestationObject),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      transports: typeof response.getTransports === "function" ? response.getTransports() : []
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {})
  };
};
if (!token) {
  button.disabled = true;
  setStatus("This enrollment link is missing its one-time secret. Return to the terminal and launch enrollment again.");
} else if (!window.isSecureContext || !navigator.credentials || !window.PublicKeyCredential) {
  button.disabled = true;
  setStatus("This browser cannot perform WebAuthn in the current secure context.");
} else {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      setStatus("Waiting for your authenticator…");
      if (!registration) {
        const begin = await api("begin", {});
        const publicKey = begin.options.publicKey;
        publicKey.challenge = fromBase64Url(publicKey.challenge);
        publicKey.user.id = fromBase64Url(publicKey.user.id);
        publicKey.excludeCredentials = (publicKey.excludeCredentials || []).map((item) => ({ ...item, id: fromBase64Url(item.id) }));
        registration = { begin, publicKey };
      }
      const credential = await navigator.credentials.create({ publicKey: registration.publicKey });
      if (!credential) throw new Error("Authenticator enrollment was canceled.");
      const finish = await api("finish", { challengeId: registration.begin.challengeId, credential: serializeCredential(credential) });
      setStatus("Enrollment complete for " + finish.credential.label + ". You may close this page.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Enrollment failed.");
      button.disabled = false;
    }
  });
}
`

type signerEnrollmentState uint8

const (
	signerEnrollmentReady signerEnrollmentState = iota
	signerEnrollmentBeginning
	signerEnrollmentBegun
	signerEnrollmentFinishing
	signerEnrollmentComplete
	signerEnrollmentExpired
)

type signerEnrollmentServerConfig struct {
	ControlSocket  string
	ListenAddress  string
	Origin         string
	BasePath       string
	Label          string
	UpdateGatePath string
	LockPath       string
	Timeout        time.Duration
	Stdout         io.Writer
	Now            func() time.Time
	Token          string
	Listener       net.Listener
}

type signerEnrollmentServer struct {
	config       signerEnrollmentServerConfig
	origin       string
	expectedHost string
	basePath     string
	expiresAt    time.Time
	token        []byte

	mu          sync.Mutex
	state       signerEnrollmentState
	challengeID string
	beginResult json.RawMessage
	done        chan struct{}
	doneOnce    sync.Once
}

type signerEnrollmentHTTPResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type signerEnrollmentEmptyRequest struct{}

func localSignerEnrollmentConfig(args []string, home, controlSocket string, stdout io.Writer) (signerEnrollmentServerConfig, error) {
	if len(args) > 1 {
		return signerEnrollmentServerConfig{}, errors.New("usage: fased-signer-enroll [authenticator label]")
	}
	home = strings.TrimSpace(home)
	if home == "" || !filepath.IsAbs(home) || filepath.Clean(home) != home {
		return signerEnrollmentServerConfig{}, errors.New("cannot resolve an absolute user home directory")
	}
	controlSocket = strings.TrimSpace(controlSocket)
	if controlSocket == "" {
		controlSocket = filepath.Join(home, ".fased", "wallet", "local-signer-control.sock")
	}
	label := "Wallet Operator"
	if len(args) == 1 {
		label = args[0]
	}
	return signerEnrollmentServerConfig{
		ControlSocket: controlSocket,
		ListenAddress: "127.0.0.1:18791",
		Origin:        "http://localhost:18791",
		BasePath:      "/",
		Label:         label,
		LockPath:      filepath.Join(home, ".fased", "wallet", "webauthn-enrollment.lock"),
		Timeout:       signerEnrollmentDefaultTimeout,
		Stdout:        stdout,
	}, nil
}

func runLocalSignerEnrollmentLauncher(args []string, home, controlSocket string, stdout io.Writer) error {
	config, err := localSignerEnrollmentConfig(args, home, controlSocket, stdout)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runSignerEnrollmentServer(ctx, config)
}

func runSignerAdminWebAuthnEnrollmentServe(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("webauthn enrollment serve")
	var listenAddress, origin, basePath, label, updateGatePath, lockPath string
	var timeout time.Duration
	fs.StringVar(&listenAddress, "listen", "", "explicit loopback IP and port")
	fs.StringVar(&origin, "origin", "", "exact configured browser origin")
	fs.StringVar(&basePath, "base-path", "/", "browser-visible enrollment path")
	fs.StringVar(&label, "label", "Wallet Operator", "human-readable authenticator label")
	fs.StringVar(&updateGatePath, "update-gate", "", "root-owned signer update gate")
	fs.StringVar(&lockPath, "lock-file", "", "exclusive signer-owned enrollment lock")
	fs.DurationVar(&timeout, "timeout", signerEnrollmentDefaultTimeout, "hard enrollment timeout")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if timeout < signerEnrollmentMinTimeout || timeout > signerEnrollmentMaxTimeout {
		return fmt.Errorf("--timeout must be between %s and %s", signerEnrollmentMinTimeout, signerEnrollmentMaxTimeout)
	}
	config := signerEnrollmentServerConfig{
		ControlSocket:  common.controlSocket,
		ListenAddress:  listenAddress,
		Origin:         origin,
		BasePath:       basePath,
		Label:          label,
		UpdateGatePath: updateGatePath,
		LockPath:       lockPath,
		Timeout:        timeout,
		Stdout:         stdout,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runSignerEnrollmentServer(ctx, config)
}

func validateSignerEnrollmentListenAddress(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	host, portRaw, err := net.SplitHostPort(value)
	if err != nil || host == "" || portRaw == "" {
		return "", errors.New("--listen must be an explicit loopback IP and nonzero port")
	}
	ip := net.ParseIP(host)
	port, portErr := strconv.Atoi(portRaw)
	if ip == nil || !ip.IsLoopback() || portErr != nil || port < 1 || port > 65535 {
		return "", errors.New("--listen must be an explicit loopback IP and nonzero port")
	}
	return net.JoinHostPort(ip.String(), strconv.Itoa(port)), nil
}

func validateSignerEnrollmentOrigin(raw string) (string, string, error) {
	value := strings.TrimSpace(raw)
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", "", errors.New("--origin must be one exact WebAuthn origin")
	}
	if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", errors.New("--origin must not contain credentials, a path, query, or fragment")
	}
	scheme := strings.ToLower(parsed.Scheme)
	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if scheme != "https" && !(scheme == "http" && isLoopbackWebAuthnHostV2(hostname)) {
		return "", "", errors.New("--origin must use HTTPS except for an exact loopback origin")
	}
	if parsed.Port() != "" {
		port, portErr := strconv.Atoi(parsed.Port())
		if portErr != nil || port < 1 || port > 65535 {
			return "", "", errors.New("--origin contains an invalid port")
		}
	}
	host := strings.ToLower(parsed.Host)
	return scheme + "://" + host, host, nil
}

func normalizeSignerEnrollmentBasePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = "/"
	}
	if !signerEnrollmentPathPattern.MatchString(value) || strings.Contains(value, "//") {
		return "", errors.New("--base-path must be a clean absolute URL path")
	}
	clean := filepath.ToSlash(filepath.Clean(value))
	if clean != value && clean+"/" != value {
		return "", errors.New("--base-path must be a clean absolute URL path")
	}
	if clean != "/" {
		clean += "/"
	}
	return clean, nil
}

func generateSignerEnrollmentToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("generate enrollment one-time secret")
	}
	defer zeroBytes(raw)
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func validateSignerEnrollmentUpdateGate(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("--update-gate must be an absolute clean path")
	}
	active, err := trustedUpdateGateActive(path, 0)
	if err != nil {
		return fmt.Errorf("signer update gate is invalid; refusing enrollment: %w", err)
	}
	if active {
		return errors.New("signer update is active; WebAuthn enrollment is temporarily disabled")
	}
	return nil
}

func acquireSignerEnrollmentLock(path string) (*os.File, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("--lock-file must be an absolute clean path")
	}
	parent := filepath.Dir(path)
	parentInfo, err := os.Lstat(parent)
	if err != nil || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 || parentInfo.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("enrollment lock directory must be a trusted non-writable directory")
	}
	if stat, ok := parentInfo.Sys().(*syscall.Stat_t); !ok || (int(stat.Uid) != os.Geteuid() && int(stat.Uid) != 0) {
		return nil, errors.New("enrollment lock directory must be owned by the signer admin user or root")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, errors.New("open signer enrollment lock")
	}
	closeWithError := func(message string) (*os.File, error) {
		_ = file.Close()
		return nil, errors.New(message)
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return closeWithError("signer enrollment lock must be a private regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || int(stat.Uid) != os.Geteuid() {
		return closeWithError("signer enrollment lock must have one link and be owned by the signer admin user")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return closeWithError("another signer enrollment session is already active")
	}
	return file, nil
}

func validateSignerEnrollmentHealth(controlSocket, expectedOrigin string) error {
	raw, err := callSignerAdmin(controlSocket, "health", "", nil)
	if err != nil {
		return fmt.Errorf("query signer WebAuthn configuration: %w", err)
	}
	var health signerHealthResultV2
	if err := decodeSignerAdminStrictJSON(raw, &health); err != nil {
		return errors.New("signer returned an invalid health result")
	}
	if !health.WebAuthn.Configured || strings.TrimSpace(health.WebAuthn.RPID) == "" {
		return errors.New("signer WebAuthn is not configured by the host administrator")
	}
	for _, allowed := range health.WebAuthn.Origins {
		if subtle.ConstantTimeCompare([]byte(allowed), []byte(expectedOrigin)) == 1 {
			return nil
		}
	}
	return errors.New("enrollment origin is not in the signer-owned exact WebAuthn origin allowlist")
}

func newSignerEnrollmentServer(config signerEnrollmentServerConfig) (*signerEnrollmentServer, error) {
	if _, err := requireSignerAdminControlSocket(config.ControlSocket); err != nil {
		return nil, err
	}
	listenAddress, err := validateSignerEnrollmentListenAddress(config.ListenAddress)
	if err != nil {
		return nil, err
	}
	origin, expectedHost, err := validateSignerEnrollmentOrigin(config.Origin)
	if err != nil {
		return nil, err
	}
	basePath, err := normalizeSignerEnrollmentBasePath(config.BasePath)
	if err != nil {
		return nil, err
	}
	if _, err := normalizeSignerWebAuthnLabelV2(config.Label); err != nil {
		return nil, err
	}
	if err := validateSignerEnrollmentUpdateGate(config.UpdateGatePath); err != nil {
		return nil, err
	}
	if err := validateSignerEnrollmentHealth(config.ControlSocket, origin); err != nil {
		return nil, err
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	config.Now = now
	config.ListenAddress = listenAddress
	config.Origin = origin
	config.BasePath = basePath
	if config.Stdout == nil {
		config.Stdout = io.Discard
	}
	token := strings.TrimSpace(config.Token)
	if token == "" {
		token, err = generateSignerEnrollmentToken()
		if err != nil {
			return nil, err
		}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) < 32 {
		zeroBytes(decoded)
		return nil, errors.New("enrollment one-time secret must contain at least 256 random bits")
	}
	zeroBytes(decoded)
	tokenBytes := []byte(token)
	token = ""
	config.Token = ""
	return &signerEnrollmentServer{
		config:       config,
		origin:       origin,
		expectedHost: expectedHost,
		basePath:     basePath,
		expiresAt:    now().UTC().Add(config.Timeout),
		token:        tokenBytes,
		state:        signerEnrollmentReady,
		done:         make(chan struct{}),
	}, nil
}

func (s *signerEnrollmentServer) routePath(path string) (string, bool) {
	if path == "" {
		path = "/"
	}
	if s.basePath != "/" && strings.HasPrefix(path, strings.TrimSuffix(s.basePath, "/")) {
		path = strings.TrimPrefix(path, strings.TrimSuffix(s.basePath, "/"))
		if path == "" {
			path = "/"
		}
	}
	switch path {
	case "/", "/begin", "/finish":
		return path, true
	default:
		return "", false
	}
}

func signerEnrollmentCSP() string {
	hash := func(value string) string {
		digest := sha256.Sum256([]byte(value))
		return base64.StdEncoding.EncodeToString(digest[:])
	}
	return "default-src 'none'; script-src 'sha256-" + hash(signerEnrollmentScript) + "'; style-src 'sha256-" + hash(signerEnrollmentStyle) + "'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; manifest-src 'none'"
}

func setSignerEnrollmentSecurityHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store, max-age=0")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Content-Security-Policy", signerEnrollmentCSP())
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("Permissions-Policy", "publickey-credentials-create=(self)")
	response.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	response.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("X-Frame-Options", "DENY")
}

func (s *signerEnrollmentServer) tokenAuthorized(request *http.Request) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.config.Now().UTC().Before(s.expiresAt) {
		s.state = signerEnrollmentExpired
		zeroBytes(s.token)
		s.token = nil
		zeroBytes(s.beginResult)
		s.beginResult = nil
		s.challengeID = ""
		return false
	}
	if s.state == signerEnrollmentComplete || s.state == signerEnrollmentExpired || len(s.token) == 0 {
		return false
	}
	expected := append([]byte("Bearer "), s.token...)
	defer zeroBytes(expected)
	authorization := request.Header.Get("Authorization")
	request.Header.Del("Authorization")
	actual := []byte(authorization)
	authorization = ""
	defer zeroBytes(actual)
	if len(actual) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func (s *signerEnrollmentServer) requestAllowed(response http.ResponseWriter, request *http.Request, api bool) bool {
	if request.URL.RawQuery != "" || request.URL.RawPath != "" || !strings.EqualFold(request.Host, s.expectedHost) {
		http.Error(response, "not found", http.StatusNotFound)
		return false
	}
	if !api {
		return true
	}
	if request.Header.Get("Origin") != s.origin {
		http.Error(response, "forbidden", http.StatusForbidden)
		return false
	}
	if fetchSite := request.Header.Get("Sec-Fetch-Site"); fetchSite != "" && fetchSite != "same-origin" {
		http.Error(response, "forbidden", http.StatusForbidden)
		return false
	}
	if request.Header.Get("Content-Type") != "application/json" {
		http.Error(response, "content type must be application/json", http.StatusUnsupportedMediaType)
		return false
	}
	if !s.tokenAuthorized(request) {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func decodeSignerEnrollmentHTTPJSON(response http.ResponseWriter, request *http.Request, limit int64, out any) error {
	request.Body = http.MaxBytesReader(response, request.Body, limit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errors.New("invalid request body")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("invalid request body")
	}
	return nil
}

func writeSignerEnrollmentJSON(response http.ResponseWriter, status int, result json.RawMessage, message string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	payload := signerEnrollmentHTTPResponse{OK: status >= 200 && status < 300, Result: result, Error: message}
	_ = json.NewEncoder(response).Encode(payload)
}

func (s *signerEnrollmentServer) handlePage(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(response, "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fased signer enrollment</title><style>"+signerEnrollmentStyle+"</style></head><body><main><h1>Enroll wallet approval passkey</h1><p>This one-time ceremony talks directly to the native signer. The Gateway cannot enroll credentials.</p><button id=\"enroll\" type=\"button\">Enroll passkey</button><p id=\"status\" role=\"status\">Ready. Continue only if you launched enrollment from your own terminal.</p></main><script>"+signerEnrollmentScript+"</script></body></html>")
}

func (s *signerEnrollmentServer) handleBegin(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeSignerEnrollmentJSON(response, http.StatusMethodNotAllowed, nil, "method not allowed")
		return
	}
	var body signerEnrollmentEmptyRequest
	if err := decodeSignerEnrollmentHTTPJSON(response, request, signerEnrollmentMaxBeginBody, &body); err != nil {
		writeSignerEnrollmentJSON(response, http.StatusBadRequest, nil, err.Error())
		return
	}
	s.mu.Lock()
	if s.state == signerEnrollmentBegun && len(s.beginResult) > 0 {
		cached := bytes.Clone(s.beginResult)
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusOK, cached, "")
		return
	}
	if s.state != signerEnrollmentReady {
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusConflict, nil, "enrollment ceremony has already started")
		return
	}
	s.state = signerEnrollmentBeginning
	s.mu.Unlock()
	if err := validateSignerEnrollmentUpdateGate(s.config.UpdateGatePath); err != nil {
		s.mu.Lock()
		s.state = signerEnrollmentReady
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusServiceUnavailable, nil, err.Error())
		return
	}
	result, err := callSignerAdmin(s.config.ControlSocket, "v2.webauthn.registration.begin", "", signerWebAuthnRegistrationBeginRequestV2{Label: s.config.Label})
	if err != nil {
		s.mu.Lock()
		s.state = signerEnrollmentReady
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusBadGateway, nil, "signer rejected enrollment begin")
		return
	}
	var begin signerWebAuthnRegistrationBeginResultV2
	if err := decodeSignerAdminStrictJSON(result, &begin); err != nil || strings.TrimSpace(begin.ChallengeID) == "" || begin.Options == nil {
		s.mu.Lock()
		s.state = signerEnrollmentReady
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusBadGateway, nil, "signer returned an invalid registration challenge")
		return
	}
	s.mu.Lock()
	s.challengeID = begin.ChallengeID
	s.beginResult = bytes.Clone(result)
	s.state = signerEnrollmentBegun
	s.mu.Unlock()
	writeSignerEnrollmentJSON(response, http.StatusOK, result, "")
}

func (s *signerEnrollmentServer) handleFinish(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeSignerEnrollmentJSON(response, http.StatusMethodNotAllowed, nil, "method not allowed")
		return
	}
	var body signerWebAuthnRegistrationFinishRequestV2
	if err := decodeSignerEnrollmentHTTPJSON(response, request, signerEnrollmentMaxFinishBody, &body); err != nil {
		writeSignerEnrollmentJSON(response, http.StatusBadRequest, nil, err.Error())
		return
	}
	if err := validateSignerWebAuthnResponseSizeV2(body.Credential); err != nil {
		writeSignerEnrollmentJSON(response, http.StatusBadRequest, nil, "invalid WebAuthn credential response")
		return
	}
	s.mu.Lock()
	if s.state != signerEnrollmentBegun || body.ChallengeID == "" || subtle.ConstantTimeCompare([]byte(body.ChallengeID), []byte(s.challengeID)) != 1 {
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusConflict, nil, "registration challenge does not match this enrollment session")
		return
	}
	s.state = signerEnrollmentFinishing
	s.mu.Unlock()
	if err := validateSignerEnrollmentUpdateGate(s.config.UpdateGatePath); err != nil {
		s.mu.Lock()
		s.state = signerEnrollmentBegun
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusServiceUnavailable, nil, err.Error())
		return
	}
	result, err := callSignerAdmin(s.config.ControlSocket, "v2.webauthn.registration.finish", "", body)
	if err != nil {
		s.mu.Lock()
		s.state = signerEnrollmentBegun
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusBadGateway, nil, "signer rejected enrollment finish")
		return
	}
	var finish signerWebAuthnRegistrationFinishResultV2
	if err := decodeSignerAdminStrictJSON(result, &finish); err != nil || finish.Credential.ID == "" {
		s.mu.Lock()
		s.state = signerEnrollmentBegun
		s.mu.Unlock()
		writeSignerEnrollmentJSON(response, http.StatusBadGateway, nil, "signer returned an invalid enrollment result")
		return
	}
	writeSignerEnrollmentJSON(response, http.StatusOK, result, "")
	s.mu.Lock()
	s.state = signerEnrollmentComplete
	zeroBytes(s.beginResult)
	s.beginResult = nil
	zeroBytes(s.token)
	s.token = nil
	s.mu.Unlock()
	s.doneOnce.Do(func() { close(s.done) })
}

func (s *signerEnrollmentServer) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	setSignerEnrollmentSecurityHeaders(response)
	route, ok := s.routePath(request.URL.Path)
	if !ok {
		http.Error(response, "not found", http.StatusNotFound)
		return
	}
	api := route != "/"
	if !s.requestAllowed(response, request, api) {
		return
	}
	switch route {
	case "/":
		s.handlePage(response, request)
	case "/begin":
		s.handleBegin(response, request)
	case "/finish":
		s.handleFinish(response, request)
	}
}

func (s *signerEnrollmentServer) writePublicURL(writer io.Writer) error {
	if _, err := io.WriteString(writer, s.origin+s.basePath+"#"); err != nil {
		return err
	}
	if err := writeSignerAdminAll(writer, s.token); err != nil {
		return err
	}
	_, err := io.WriteString(writer, "\n")
	return err
}

func (s *signerEnrollmentServer) destroySecrets() {
	s.mu.Lock()
	defer s.mu.Unlock()
	zeroBytes(s.token)
	s.token = nil
	zeroBytes(s.beginResult)
	s.beginResult = nil
	s.challengeID = ""
}

func runSignerEnrollmentServer(ctx context.Context, config signerEnrollmentServerConfig) error {
	lock, err := acquireSignerEnrollmentLock(config.LockPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
	}()
	serverState, err := newSignerEnrollmentServer(config)
	if err != nil {
		return err
	}
	defer serverState.destroySecrets()
	listener := config.Listener
	if listener == nil {
		listener, err = net.Listen("tcp", serverState.config.ListenAddress)
		if err != nil {
			return errors.New("bind signer enrollment loopback listener")
		}
	}
	defer listener.Close()
	bound, err := validateSignerEnrollmentListenAddress(listener.Addr().String())
	if err != nil || bound != serverState.config.ListenAddress {
		return errors.New("signer enrollment listener did not bind the exact requested loopback address")
	}
	httpServer := &http.Server{
		Handler:           serverState,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       15 * time.Second,
		MaxHeaderBytes:    signerEnrollmentMaxHeaderBytes,
	}
	httpServer.SetKeepAlivesEnabled(false)
	serveResult := make(chan error, 1)
	go func() {
		err := httpServer.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveResult <- err
	}()
	if err := serverState.writePublicURL(serverState.config.Stdout); err != nil {
		_ = httpServer.Close()
		return errors.New("print signer enrollment URL")
	}
	timer := time.NewTimer(serverState.config.Timeout)
	defer timer.Stop()
	var resultErr error
	select {
	case <-serverState.done:
	case <-timer.C:
		serverState.mu.Lock()
		serverState.state = signerEnrollmentExpired
		zeroBytes(serverState.token)
		serverState.token = nil
		zeroBytes(serverState.beginResult)
		serverState.beginResult = nil
		serverState.challengeID = ""
		serverState.mu.Unlock()
		resultErr = errors.New("signer WebAuthn enrollment timed out")
	case <-ctx.Done():
		resultErr = errors.New("signer WebAuthn enrollment canceled")
	case err := <-serveResult:
		if err != nil {
			resultErr = errors.New("signer enrollment HTTP server stopped unexpectedly")
		} else {
			resultErr = errors.New("signer enrollment HTTP server stopped before completion")
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	return resultErr
}
