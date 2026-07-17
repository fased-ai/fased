package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type signerEnrollmentFakeControl struct {
	path     string
	requests chan request
	listener net.Listener
	respond  func(request) (json.RawMessage, error)
	done     chan struct{}
}

func startSignerEnrollmentFakeControl(
	t *testing.T,
	origin string,
	respond func(request) (json.RawMessage, error),
) *signerEnrollmentFakeControl {
	t.Helper()
	directory := signerAdminShortTempDir(t)
	path := filepath.Join(directory, "enrollment-control.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen on enrollment control socket: %v", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	server := &signerEnrollmentFakeControl{
		path: path, requests: make(chan request, 32), listener: listener, respond: respond, done: make(chan struct{}),
	}
	go func() {
		defer close(server.done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				line, err := bufio.NewReader(connection).ReadBytes('\n')
				if err != nil {
					return
				}
				var req request
				if err := decodeSignerAdminStrictJSON(bytes.TrimSpace(line), &req); err != nil {
					return
				}
				server.requests <- req
				var result json.RawMessage
				if req.Op == "health" {
					health := signerHealthResultV2{WebAuthn: signerWebAuthnHealthV2{
						Configured: true, RPID: strings.ToLower(strings.Split(strings.TrimPrefix(origin, "http://"), ":")[0]), Origins: []string{origin}, Ready: true,
					}}
					result, err = json.Marshal(health)
				} else if server.respond != nil {
					result, err = server.respond(req)
				} else {
					err = errors.New("unexpected request")
				}
				response := signerAdminResponse{OK: err == nil, Result: result}
				if err != nil {
					response.Error = err.Error()
				}
				encoded, _ := json.Marshal(response)
				_, _ = connection.Write(append(encoded, '\n'))
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		<-server.done
	})
	return server
}

func signerEnrollmentTestToken() string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 32))
}

func signerEnrollmentTestConfig(t *testing.T, control *signerEnrollmentFakeControl) signerEnrollmentServerConfig {
	t.Helper()
	return signerEnrollmentServerConfig{
		ControlSocket: control.path,
		ListenAddress: "127.0.0.1:18791",
		Origin:        "http://localhost:18791",
		BasePath:      "/_fased/signer-enrollment/",
		Label:         "Test security key",
		LockPath:      filepath.Join(t.TempDir(), "enrollment.lock"),
		Timeout:       time.Minute,
		Stdout:        ioDiscardForEnrollmentTest{},
		Token:         signerEnrollmentTestToken(),
	}
}

type ioDiscardForEnrollmentTest struct{}

func (ioDiscardForEnrollmentTest) Write(value []byte) (int, error) { return len(value), nil }

func signerEnrollmentRequest(
	t *testing.T,
	server *signerEnrollmentServer,
	method, route, token, origin, contentType, body string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://localhost:18791"+route, strings.NewReader(body))
	request.Host = "localhost:18791"
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func TestSignerEnrollmentPageIsSelfContainedAndHardened(t *testing.T) {
	control := startSignerEnrollmentFakeControl(t, "http://localhost:18791", nil)
	server, err := newSignerEnrollmentServer(signerEnrollmentTestConfig(t, control))
	if err != nil {
		t.Fatal(err)
	}
	<-control.requests // health
	response := signerEnrollmentRequest(t, server, http.MethodGet, "/_fased/signer-enrollment/", "", "", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("page status = %d: %s", response.Code, response.Body.String())
	}
	for header, expected := range map[string]string{
		"Cache-Control":                "no-store",
		"Referrer-Policy":              "no-referrer",
		"X-Frame-Options":              "DENY",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options":       "nosniff",
	} {
		if !strings.Contains(response.Header().Get(header), expected) {
			t.Fatalf("%s = %q, want %q", header, response.Header().Get(header), expected)
		}
	}
	csp := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-ancestors 'none'") || strings.Contains(csp, "'unsafe-inline'") || strings.Contains(csp, "*") {
		t.Fatalf("unsafe CSP: %q", csp)
	}
	body := response.Body.String()
	if !strings.Contains(body, "navigator.credentials.create") || strings.Contains(body, "https://") || strings.Contains(body, signerEnrollmentTestToken()) {
		t.Fatalf("page is not self-contained or leaked token: %s", body)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("enrollment server emitted a CORS allow-origin header")
	}
}

func TestSignerEnrollmentRejectsTokenOriginHostMethodAndBodyAttacks(t *testing.T) {
	control := startSignerEnrollmentFakeControl(t, "http://localhost:18791", func(request) (json.RawMessage, error) {
		return nil, errors.New("should not reach signer")
	})
	server, err := newSignerEnrollmentServer(signerEnrollmentTestConfig(t, control))
	if err != nil {
		t.Fatal(err)
	}
	<-control.requests // health
	token := signerEnrollmentTestToken()
	tests := []struct {
		name, method, route, token, origin, contentType, body string
		status                                                int
		mutate                                                func(*http.Request)
	}{
		{name: "missing token", method: http.MethodPost, route: "/begin", origin: "http://localhost:18791", contentType: "application/json", body: `{}`, status: http.StatusUnauthorized},
		{name: "wrong token", method: http.MethodPost, route: "/begin", token: token + "x", origin: "http://localhost:18791", contentType: "application/json", body: `{}`, status: http.StatusUnauthorized},
		{name: "cross origin", method: http.MethodPost, route: "/begin", token: token, origin: "https://attacker.example", contentType: "application/json", body: `{}`, status: http.StatusForbidden},
		{name: "form content", method: http.MethodPost, route: "/begin", token: token, origin: "http://localhost:18791", contentType: "application/x-www-form-urlencoded", body: `{}`, status: http.StatusUnsupportedMediaType},
		{name: "unknown json", method: http.MethodPost, route: "/begin", token: token, origin: "http://localhost:18791", contentType: "application/json", body: `{"extra":true}`, status: http.StatusBadRequest},
		{name: "oversized json", method: http.MethodPost, route: "/begin", token: token, origin: "http://localhost:18791", contentType: "application/json", body: `{"padding":"` + strings.Repeat("x", signerEnrollmentMaxBeginBody) + `"}`, status: http.StatusBadRequest},
		{name: "query token", method: http.MethodPost, route: "/begin?token=" + token, token: token, origin: "http://localhost:18791", contentType: "application/json", body: `{}`, status: http.StatusNotFound},
		{name: "wrong method", method: http.MethodPut, route: "/begin", token: token, origin: "http://localhost:18791", contentType: "application/json", body: `{}`, status: http.StatusMethodNotAllowed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := signerEnrollmentRequest(t, server, test.method, test.route, test.token, test.origin, test.contentType, test.body)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body.String())
			}
		})
	}
	request := httptest.NewRequest(http.MethodPost, "http://localhost:18791/begin", strings.NewReader(`{}`))
	request.Host = "attacker.example"
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Origin", "http://localhost:18791")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("wrong Host status = %d", response.Code)
	}
	select {
	case req := <-control.requests:
		t.Fatalf("adversarial request reached signer: %#v", req)
	default:
	}
}

func TestSignerEnrollmentPassesOneRegistrationThroughControlSocketAndInvalidatesToken(t *testing.T) {
	finishStarted := make(chan struct{})
	releaseFinish := make(chan struct{})
	var finishOnce sync.Once
	control := startSignerEnrollmentFakeControl(t, "http://localhost:18791", func(req request) (json.RawMessage, error) {
		switch req.Op {
		case "v2.webauthn.registration.begin":
			return json.RawMessage(`{"challengeId":"challenge-1","expiresAt":"2030-01-01T00:00:00Z","options":{"publicKey":{"challenge":"Wlo","rp":{"id":"localhost","name":"Fased"},"user":{"id":"Wlo","name":"owner","displayName":"Owner"},"pubKeyCredParams":[{"type":"public-key","alg":-7}]}}}`), nil
		case "v2.webauthn.registration.finish":
			finishOnce.Do(func() { close(finishStarted) })
			<-releaseFinish
			return json.RawMessage(`{"credential":{"id":"credential-1","label":"Test security key","createdAt":"2030-01-01T00:00:00Z"}}`), nil
		default:
			return nil, errors.New("unexpected op")
		}
	})
	server, err := newSignerEnrollmentServer(signerEnrollmentTestConfig(t, control))
	if err != nil {
		t.Fatal(err)
	}
	<-control.requests // health
	token := signerEnrollmentTestToken()
	begin := signerEnrollmentRequest(t, server, http.MethodPost, "/_fased/signer-enrollment/begin", token, "http://localhost:18791", "application/json", `{}`)
	if begin.Code != http.StatusOK || !strings.Contains(begin.Body.String(), `"challengeId":"challenge-1"`) {
		t.Fatalf("begin failed: %d %s", begin.Code, begin.Body.String())
	}
	beginReq := <-control.requests
	if beginReq.Op != "v2.webauthn.registration.begin" {
		t.Fatalf("unexpected begin passthrough: %#v", beginReq)
	}
	var beginBody signerWebAuthnRegistrationBeginRequestV2
	if err := decodeSignerAdminStrictJSON(beginReq.Request, &beginBody); err != nil || beginBody.Label != "Test security key" {
		t.Fatalf("unexpected begin body: %#v, %v", beginBody, err)
	}
	duplicate := signerEnrollmentRequest(t, server, http.MethodPost, "/begin", token, "http://localhost:18791", "application/json", `{}`)
	if duplicate.Code != http.StatusOK || !strings.Contains(duplicate.Body.String(), `"challengeId":"challenge-1"`) {
		t.Fatalf("duplicate begin status = %d", duplicate.Code)
	}
	finishBody := `{"challengeId":"challenge-1","credential":{"id":"credential-1","rawId":"Y3JlZGVudGlhbC0x","type":"public-key","response":{"attestationObject":"YQ","clientDataJSON":"Yg"},"clientExtensionResults":{}}}`
	responses := make(chan int, 2)
	go func() {
		responses <- signerEnrollmentRequest(t, server, http.MethodPost, "/finish", token, "http://localhost:18791", "application/json", finishBody).Code
	}()
	<-finishStarted
	go func() {
		responses <- signerEnrollmentRequest(t, server, http.MethodPost, "/finish", token, "http://localhost:18791", "application/json", finishBody).Code
	}()
	time.Sleep(10 * time.Millisecond)
	close(releaseFinish)
	first, second := <-responses, <-responses
	if !((first == http.StatusOK && second == http.StatusConflict) || (second == http.StatusOK && first == http.StatusConflict)) {
		t.Fatalf("concurrent finish statuses = %d, %d", first, second)
	}
	finishReq := <-control.requests
	if finishReq.Op != "v2.webauthn.registration.finish" {
		t.Fatalf("unexpected finish passthrough: %#v", finishReq)
	}
	var forwarded signerWebAuthnRegistrationFinishRequestV2
	if err := decodeSignerAdminStrictJSON(finishReq.Request, &forwarded); err != nil || forwarded.ChallengeID != "challenge-1" || !bytes.Contains(forwarded.Credential, []byte("attestationObject")) {
		t.Fatalf("unexpected finish request: %#v, %v", forwarded, err)
	}
	after := signerEnrollmentRequest(t, server, http.MethodPost, "/begin", token, "http://localhost:18791", "application/json", `{}`)
	if after.Code != http.StatusUnauthorized {
		t.Fatalf("completed session accepted token: %d", after.Code)
	}
}

func TestSignerEnrollmentExpiresAndUpdateGateFailsClosed(t *testing.T) {
	control := startSignerEnrollmentFakeControl(t, "http://localhost:18791", func(req request) (json.RawMessage, error) {
		return json.RawMessage(`{"challengeId":"challenge-1","expiresAt":"2030-01-01T00:00:00Z","options":{"publicKey":{}}}`), nil
	})
	now := time.Date(2029, 1, 1, 0, 0, 0, 0, time.UTC)
	config := signerEnrollmentTestConfig(t, control)
	config.Now = func() time.Time { return now }
	server, err := newSignerEnrollmentServer(config)
	if err != nil {
		t.Fatal(err)
	}
	<-control.requests // health
	now = now.Add(2 * time.Minute)
	response := signerEnrollmentRequest(t, server, http.MethodPost, "/begin", signerEnrollmentTestToken(), "http://localhost:18791", "application/json", `{}`)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expired token status = %d", response.Code)
	}

	if os.Geteuid() != 0 {
		t.Skip("root-owned update gate test requires root")
	}
	gateDirectory := t.TempDir()
	gatePath := filepath.Join(gateDirectory, "active")
	if err := os.WriteFile(gatePath, []byte("update\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config = signerEnrollmentTestConfig(t, control)
	config.UpdateGatePath = gatePath
	if _, err := newSignerEnrollmentServer(config); err == nil || !strings.Contains(err.Error(), "update is active") {
		t.Fatalf("active update gate did not stop enrollment: %v", err)
	}
}

func TestSignerEnrollmentUpdateGateBlocksFinishAfterBegin(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-owned update gate test requires root")
	}
	control := startSignerEnrollmentFakeControl(t, "http://localhost:18791", func(req request) (json.RawMessage, error) {
		if req.Op != "v2.webauthn.registration.begin" {
			return nil, errors.New("finish must not reach signer while update gate is active")
		}
		return json.RawMessage(`{"challengeId":"challenge-1","expiresAt":"2030-01-01T00:00:00Z","options":{"publicKey":{}}}`), nil
	})
	gatePath := filepath.Join(t.TempDir(), "active")
	config := signerEnrollmentTestConfig(t, control)
	config.UpdateGatePath = gatePath
	server, err := newSignerEnrollmentServer(config)
	if err != nil {
		t.Fatal(err)
	}
	<-control.requests // health
	token := signerEnrollmentTestToken()
	begin := signerEnrollmentRequest(t, server, http.MethodPost, "/begin", token, "http://localhost:18791", "application/json", `{}`)
	if begin.Code != http.StatusOK {
		t.Fatalf("begin status = %d: %s", begin.Code, begin.Body.String())
	}
	if req := <-control.requests; req.Op != "v2.webauthn.registration.begin" {
		t.Fatalf("unexpected signer request: %#v", req)
	}
	if err := os.WriteFile(gatePath, []byte("update\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	finish := signerEnrollmentRequest(t, server, http.MethodPost, "/finish", token, "http://localhost:18791", "application/json", `{"challengeId":"challenge-1","credential":{"id":"credential-1"}}`)
	if finish.Code != http.StatusServiceUnavailable || !strings.Contains(finish.Body.String(), "update is active") {
		t.Fatalf("active update gate finish status = %d: %s", finish.Code, finish.Body.String())
	}
	select {
	case req := <-control.requests:
		t.Fatalf("finish reached signer through active gate: %#v", req)
	default:
	}
}

func TestSignerEnrollmentValidationAndExclusiveLock(t *testing.T) {
	for _, value := range []string{"localhost:18791", "0.0.0.0:18791", "127.0.0.1:0", "127.0.0.1"} {
		if _, err := validateSignerEnrollmentListenAddress(value); err == nil {
			t.Fatalf("accepted unsafe listen address %q", value)
		}
	}
	for _, value := range []string{"http://example.com", "https://example.com/path", "https://user@example.com", "https://example.com?token=x"} {
		if _, _, err := validateSignerEnrollmentOrigin(value); err == nil {
			t.Fatalf("accepted unsafe origin %q", value)
		}
	}
	if _, err := normalizeSignerEnrollmentBasePath("/safe/../escape"); err == nil {
		t.Fatal("accepted non-clean base path")
	}
	lockPath := filepath.Join(t.TempDir(), "enrollment.lock")
	first, err := acquireSignerEnrollmentLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := acquireSignerEnrollmentLock(lockPath); err == nil || !strings.Contains(err.Error(), "already active") {
		t.Fatalf("second enrollment acquired lock: %v", err)
	}
}

func TestLocalSignerEnrollmentLauncherUsesSignedBinaryDefaults(t *testing.T) {
	home := t.TempDir()
	config, err := localSignerEnrollmentConfig([]string{"Laptop security key"}, home, "", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if config.ControlSocket != filepath.Join(home, ".fased", "wallet", "local-signer-control.sock") ||
		config.LockPath != filepath.Join(home, ".fased", "wallet", "webauthn-enrollment.lock") ||
		config.ListenAddress != "127.0.0.1:18791" || config.Origin != "http://localhost:18791" ||
		config.Label != "Laptop security key" || config.Timeout != 5*time.Minute {
		t.Fatalf("unexpected local enrollment launcher config: %#v", config)
	}
	explicit := filepath.Join(home, "custom-control.sock")
	config, err = localSignerEnrollmentConfig(nil, home, explicit, io.Discard)
	if err != nil || config.ControlSocket != explicit || config.Label != "Wallet Operator" {
		t.Fatalf("explicit control socket was not preserved: %#v, %v", config, err)
	}
	if _, err := localSignerEnrollmentConfig([]string{"one", "two"}, home, "", io.Discard); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("accepted extra launcher arguments: %v", err)
	}
	if _, err := localSignerEnrollmentConfig(nil, "relative", "", io.Discard); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("accepted relative launcher home: %v", err)
	}
}

func TestRunSignerEnrollmentServerPrintsFragmentOnlyAndExitsAfterSuccess(t *testing.T) {
	control := startSignerEnrollmentFakeControl(t, "http://localhost:18791", func(req request) (json.RawMessage, error) {
		if req.Op == "v2.webauthn.registration.begin" {
			return json.RawMessage(`{"challengeId":"challenge-1","expiresAt":"2030-01-01T00:00:00Z","options":{"publicKey":{"challenge":"Wlo","rp":{"id":"localhost"},"user":{"id":"Wlo"}}}}`), nil
		}
		return json.RawMessage(`{"credential":{"id":"credential-1","label":"Test security key","createdAt":"2030-01-01T00:00:00Z"}}`), nil
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_, port, _ := net.SplitHostPort(address)
	origin := "http://localhost:" + port
	// The fake signer health must acknowledge the exact dynamically selected origin.
	control.listener.Close()
	<-control.done
	control = startSignerEnrollmentFakeControl(t, origin, control.respond)
	config := signerEnrollmentTestConfig(t, control)
	config.ListenAddress = address
	config.Origin = origin
	config.BasePath = "/"
	config.Listener = listener
	config.Timeout = 5 * time.Second
	outputReader, outputWriter := io.Pipe()
	defer outputReader.Close()
	defer outputWriter.Close()
	config.Stdout = outputWriter
	result := make(chan error, 1)
	go func() { result <- runSignerEnrollmentServer(context.Background(), config) }()
	printedLine := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(outputReader).ReadString('\n')
		printedLine <- line
	}()
	var printed string
	select {
	case line := <-printedLine:
		printed = strings.TrimSpace(line)
	case <-time.After(2 * time.Second):
		t.Fatal("server did not print an enrollment URL")
	}
	if !strings.HasPrefix(printed, origin+"/#") || strings.Contains(strings.SplitN(printed, "#", 2)[0], "?") {
		t.Fatalf("secret was not printed only as a URL fragment: %q", printed)
	}
	token := strings.SplitN(printed, "#", 2)[1]
	client := &http.Client{Timeout: 2 * time.Second}
	post := func(route, body string) *http.Response {
		req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+port+route, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = "localhost:" + port
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	begin := post("/begin", `{}`)
	_ = begin.Body.Close()
	if begin.StatusCode != http.StatusOK {
		t.Fatalf("integration begin status = %d", begin.StatusCode)
	}
	finish := post("/finish", `{"challengeId":"challenge-1","credential":{"id":"credential-1"}}`)
	_ = finish.Body.Close()
	if finish.StatusCode != http.StatusOK {
		t.Fatalf("integration finish status = %d", finish.StatusCode)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("server did not exit successfully: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not exit after successful enrollment")
	}
}
