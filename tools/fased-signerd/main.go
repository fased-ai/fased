package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/scrypt"
)

const (
	maxSignerRequestBytes = 1 << 20
	socketReadTimeout     = 30 * time.Second
)

var errRequestTooLarge = errors.New("signer request exceeds maximum size")

type request struct {
	Op       string          `json:"op"`
	Chain    string          `json:"chain,omitempty"`
	WalletID string          `json:"walletId,omitempty"`
	Request  json.RawMessage `json:"request,omitempty"`
}

type signerConfig struct {
	socketPath        string
	controlSocketPath string
	socketMode        uint32
	socketGroup       string
	pidFile           string
	auditLog          string
	stateDBPath       string
	masterKeyPath     string
	webauthnRPID      string
	webauthnOrigins   string
	jupiterAPIKeyPath string
	jupiterLive       bool
	updateGatePath    string
	readOnly          bool
	rateWindow        time.Duration
	rateLimit         map[string]int
	auditMax          int64
	dropUID           int
	dropGID           int
	chains            []string
}

type opBucket struct {
	mu    sync.Mutex
	times []time.Time
}

type rateLimiter struct {
	window  time.Duration
	limits  map[string]int
	buckets map[string]*opBucket
}

func newRateLimiter(window time.Duration, limits map[string]int) *rateLimiter {
	buckets := map[string]*opBucket{}
	for op := range limits {
		buckets[op] = &opBucket{}
	}
	return &rateLimiter{window: window, limits: limits, buckets: buckets}
}

func (r *rateLimiter) allow(op string) bool {
	b, ok := r.buckets[op]
	if !ok {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-r.window)
	dst := b.times[:0]
	for _, seen := range b.times {
		if seen.After(cutoff) {
			dst = append(dst, seen)
		}
	}
	b.times = dst
	if len(b.times) >= r.limits[op] {
		return false
	}
	b.times = append(b.times, now)
	return true
}

type auditWriter struct {
	path     string
	maxBytes int64
	mu       sync.Mutex
	failed   bool
	lastErr  string
}

type signerAuditHealthV2 struct {
	Configured bool   `json:"configured"`
	Healthy    bool   `json:"healthy"`
	LastError  string `json:"lastError,omitempty"`
}

func (a *auditWriter) health() signerAuditHealthV2 {
	if a == nil {
		return signerAuditHealthV2{Healthy: true}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return signerAuditHealthV2{
		Configured: a.path != "",
		Healthy:    !a.failed,
		LastError:  a.lastErr,
	}
}

func (a *auditWriter) recordFailure(err error) {
	a.failed = true
	a.lastErr = safeOperationErrorV2(err)
	log.Printf("fased-signerd audit failure: %s", a.lastErr)
}

func (a *auditWriter) write(entry map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.path == "" {
		return
	}
	data, err := json.Marshal(entry)
	if err != nil {
		a.recordFailure(err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(a.path), 0o700); err != nil {
		a.recordFailure(err)
		return
	}
	if stat, err := os.Stat(a.path); err == nil && stat.Size() >= a.maxBytes && a.maxBytes > 0 {
		rotated := a.path + ".1"
		if err := os.Remove(rotated); err != nil && !errors.Is(err, os.ErrNotExist) {
			a.recordFailure(err)
			return
		}
		if err := os.Rename(a.path, rotated); err != nil {
			a.recordFailure(err)
			return
		}
	}
	file, err := os.OpenFile(a.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		a.recordFailure(err)
		return
	}
	if _, err := file.Write(append(data, '\n')); err != nil {
		_ = file.Close()
		a.recordFailure(err)
		return
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		a.recordFailure(err)
		return
	}
	if err := file.Close(); err != nil {
		a.recordFailure(err)
		return
	}
	a.failed = false
	a.lastErr = ""
}

func getenvInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func getenvInt64(name string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func zeroBytes(buf []byte) {
	for index := range buf {
		buf[index] = 0
	}
}

func currentDayBucket(now time.Time) string {
	return now.UTC().Format("2006-01-02")
}

func normalizeWalletID(walletID string) string {
	value := strings.TrimSpace(strings.ToLower(walletID))
	if value == "" {
		return "default"
	}
	var normalized strings.Builder
	lastUnderscore := false
	for _, character := range value {
		alphaNumeric := (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
		if alphaNumeric {
			normalized.WriteRune(character)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			normalized.WriteRune('_')
			lastUnderscore = true
		}
	}
	result := strings.Trim(normalized.String(), "_")
	if result == "" {
		return "default"
	}
	return result
}

func mustValidate(req request, cfg signerConfig) error {
	switch req.Op {
	case "health", "v2.capabilities", "v2.webauthn.credentials.list":
		if len(req.Request) > 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
	case "v2.webauthn.registration.begin", "v2.webauthn.registration.finish", "v2.webauthn.credentials.revoke":
		if len(req.Request) == 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
	case "v2.review.authorization.begin", "v2.review.authorization.finish":
		if len(req.Request) == 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
	case "v2.network.get", "v2.policy.get", "v2.wallet.get", "v2.wallet.reencrypt", "v2.wallet.rotation.status", "v2.jupiter.trigger.history":
		if len(req.Request) > 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
	case "v2.network.put", "v2.policy.put", "v2.policy.tighten", "v2.wallet.create", "v2.wallet.import", "v2.wallet.importLegacy", "v2.wallet.rotation.create", "v2.wallet.rotation.commit", "v2.execute", "v2.review.get", "v2.review.prepare", "v2.review.execute", "v2.operation.get", "v2.operation.reconcile":
		if len(req.Request) == 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
	case "getAddresses":
		if len(req.Request) > 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
	case "getBalance":
		if len(req.Request) > 0 || req.Chain != "solana" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
		if err := cfg.ensureChainAllowed(req.Chain); err != nil {
			return err
		}
	default:
		return errors.New("unsupported op")
	}
	return nil
}

func fingerprint(raw map[string]any) map[string]any {
	result := map[string]any{"op": raw["op"]}
	if chain, ok := raw["chain"]; ok {
		result["chain"] = chain
	}
	if walletID, ok := raw["walletId"]; ok {
		result["walletId"] = walletID
	}
	if body, ok := raw["request"].(map[string]any); ok {
		for _, key := range []string{"requestId", "policyHash"} {
			if _, present := body[key]; present {
				result["has"+strings.ToUpper(key[:1])+key[1:]] = true
			}
		}
	}
	return result
}

func applyProcessHardening(cfg signerConfig) error {
	applyProcessDumpHardening()
	if cfg.dropGID > 0 {
		if err := syscall.Setgid(cfg.dropGID); err != nil {
			return fmt.Errorf("drop gid %d: %w", cfg.dropGID, err)
		}
	}
	if cfg.dropUID > 0 {
		if err := syscall.Setuid(cfg.dropUID); err != nil {
			return fmt.Errorf("drop uid %d: %w", cfg.dropUID, err)
		}
	}
	return nil
}

func acquirePidLock(pidPath string) error {
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o700); err != nil {
		return err
	}
	if data, err := os.ReadFile(pidPath); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 1 {
			if err := syscall.Kill(pid, 0); err == nil {
				return fmt.Errorf("signer already running (pid=%d); pid file: %s", pid, pidPath)
			}
		}
		_ = os.Remove(pidPath)
	}
	return os.WriteFile(pidPath, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600)
}

func bytesTrimNewline(buf []byte) []byte {
	return []byte(strings.TrimRight(string(buf), "\r\n"))
}

func parseArgs() signerConfig {
	stateRoot := filepath.Join(userHomeDir(), ".fased", "wallet")
	socketModeRaw := firstNonEmpty(strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_SOCKET_MODE")), "0600")
	cfg := signerConfig{
		socketPath:        filepath.Join(stateRoot, "local-signer.sock"),
		controlSocketPath: filepath.Join(stateRoot, "local-signer-control.sock"),
		socketMode:        0o600,
		socketGroup:       strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_SOCKET_GROUP")),
		stateDBPath: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_STATE_DB")),
			filepath.Join(stateRoot, "signerd-v2.db"),
		),
		masterKeyPath: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_MASTER_KEY")),
			filepath.Join(stateRoot, "signerd-v2.master.key"),
		),
		webauthnRPID:      strings.TrimSpace(os.Getenv("FASED_WALLET_WEBAUTHN_RP_ID")),
		webauthnOrigins:   strings.TrimSpace(os.Getenv("FASED_WALLET_WEBAUTHN_ORIGINS")),
		jupiterAPIKeyPath: strings.TrimSpace(os.Getenv("FASED_WALLET_JUPITER_API_KEY_FILE")),
		jupiterLive:       os.Getenv("FASED_WALLET_JUPITER_LIVE_ENABLED") == "1",
		updateGatePath:    strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_UPDATE_GATE")),
		readOnly:          os.Getenv("FASED_WALLET_LOCAL_SIGNER_READ_ONLY") == "1",
		rateWindow:        time.Duration(getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WINDOW_MS", 10_000)) * time.Millisecond,
		auditMax:          getenvInt64("FASED_WALLET_LOCAL_SIGNER_AUDIT_MAX_BYTES", 1_048_576),
		dropUID:           getenvInt("FASED_WALLET_LOCAL_SIGNER_DROP_UID", 0),
		dropGID:           getenvInt("FASED_WALLET_LOCAL_SIGNER_DROP_GID", 0),
	}
	flags := flag.NewFlagSet(os.Args[0], flag.ExitOnError)
	flags.StringVar(&cfg.socketPath, "socket", cfg.socketPath, "unix socket path")
	flags.StringVar(&cfg.controlSocketPath, "control-socket", cfg.controlSocketPath, "administrative unix socket path")
	flags.StringVar(&cfg.stateDBPath, "state-db", cfg.stateDBPath, "signer-owned bbolt state database path")
	flags.StringVar(&cfg.masterKeyPath, "master-key", cfg.masterKeyPath, "signer-owned 0600 master key file path")
	flags.StringVar(&cfg.webauthnRPID, "webauthn-rp-id", cfg.webauthnRPID, "root-configured WebAuthn relying party ID")
	flags.StringVar(&cfg.webauthnOrigins, "webauthn-origins", cfg.webauthnOrigins, "comma-separated exact WebAuthn origin allowlist")
	flags.StringVar(&cfg.jupiterAPIKeyPath, "jupiter-api-key-file", cfg.jupiterAPIKeyPath, "signer-owned private Jupiter API key file")
	flags.StringVar(&cfg.updateGatePath, "update-gate", cfg.updateGatePath, "root-owned gate that blocks application-socket mutations during paired updates")
	flags.StringVar(&socketModeRaw, "socket-mode", socketModeRaw, "application socket mode (octal, default 0600)")
	flags.StringVar(&cfg.socketGroup, "socket-group", cfg.socketGroup, "private group allowed to use the application socket")
	flags.StringVar(&cfg.pidFile, "pid-file", "", "pid file path (default <socket>.pid)")
	flags.StringVar(&cfg.auditLog, "audit-log", "", "audit log path (default <socket>.audit.jsonl)")
	flags.BoolVar(&cfg.readOnly, "read-only", cfg.readOnly, "read-only mode (health/getAddresses/getBalance only)")
	_ = flags.Parse(os.Args[1:])
	cfg.jupiterAPIKeyPath = resolveSignerJupiterAPIKeyPathV2(cfg.jupiterAPIKeyPath, cfg.stateDBPath)

	mode, err := parseModeV2(socketModeRaw)
	if err != nil {
		flags.Usage()
		log.Fatal(err)
	}
	cfg.socketMode = mode
	if cfg.pidFile == "" {
		cfg.pidFile = cfg.socketPath + ".pid"
	}
	if cfg.auditLog == "" {
		cfg.auditLog = cfg.socketPath + ".audit.jsonl"
	}
	cfg.rateLimit = map[string]int{
		"health":                          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_HEALTH", 300),
		"v2.capabilities":                 getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_HEALTH", 300),
		"v2.network.get":                  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_NETWORK", 120),
		"v2.network.put":                  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_NETWORK", 30),
		"v2.policy.get":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_POLICY", 120),
		"v2.policy.put":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_POLICY", 120),
		"v2.policy.tighten":               getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_POLICY", 120),
		"v2.wallet.get":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 120),
		"v2.wallet.create":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.import":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.importLegacy":          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.reencrypt":             getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.rotation.create":       getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_ROTATION_ADMIN", 10),
		"v2.wallet.rotation.status":       getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_ROTATION_ADMIN", 60),
		"v2.wallet.rotation.commit":       getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_ROTATION_ADMIN", 10),
		"v2.execute":                      getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_EXECUTE", 60),
		"v2.operation.get":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_OPERATION", 300),
		"v2.operation.reconcile":          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_OPERATION", 120),
		"v2.review.get":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_REVIEW", 300),
		"v2.webauthn.registration.begin":  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 20),
		"v2.webauthn.registration.finish": getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 20),
		"v2.webauthn.credentials.list":    getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 60),
		"v2.webauthn.credentials.revoke":  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 20),
		"v2.jupiter.trigger.history":      getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_OPERATION", 120),
		"v2.review.authorization.begin":   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_REVIEW_AUTH", 60),
		"v2.review.authorization.finish":  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_REVIEW_AUTH", 60),
		"v2.review.prepare":               getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_REVIEW", 60),
		"v2.review.execute":               getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_EXECUTE", 60),
		"getAddresses":                    getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_GETADDRESSES", 120),
		"getBalance":                      getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_GETBALANCE", 240),
	}
	cfg.chains = parseChainsEnv(os.Getenv("FASED_WALLET_CHAINS"))
	return cfg
}

func parseChainsEnv(raw string) []string {
	parts := strings.Split(strings.TrimSpace(raw), ",")
	var result []string
	seen := map[string]bool{}
	for _, part := range parts {
		chain := strings.ToLower(strings.TrimSpace(part))
		if chain != "solana" || seen[chain] {
			continue
		}
		result = append(result, chain)
		seen[chain] = true
	}
	if len(result) == 0 {
		return []string{"solana"}
	}
	return result
}

func (cfg signerConfig) chainAllowed(chain string) bool {
	normalized := strings.TrimSpace(strings.ToLower(chain))
	for _, allowed := range cfg.chains {
		if allowed == normalized {
			return true
		}
	}
	return false
}

func (cfg signerConfig) ensureChainAllowed(chain string) error {
	normalized := strings.TrimSpace(strings.ToLower(chain))
	if normalized == "" {
		return errors.New("missing chain")
	}
	if !cfg.chainAllowed(normalized) {
		return fmt.Errorf("chain %s not allowed", normalized)
	}
	return nil
}

func firstNonEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func userHomeDir() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return home
	}
	return "/tmp"
}

func main() {
	identity, identityErr := signerReleaseIdentity()
	if identityErr != nil {
		_, _ = fmt.Fprintf(os.Stderr, "fased-signerd: invalid build identity: %s\n", identityErr)
		os.Exit(1)
	}
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-version") {
		_, _ = fmt.Fprintln(os.Stdout, formatSignerVersionV2(identity))
		return
	}
	if filepath.Base(os.Args[0]) == "fased-signer-enroll" {
		applyProcessDumpHardening()
		home, err := os.UserHomeDir()
		controlSocket := strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET"))
		os.Clearenv()
		if err == nil {
			err = runLocalSignerEnrollmentLauncher(os.Args[1:], home, controlSocket, os.Stdout)
		}
		if err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "fased-signer-enroll: %s\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		applyProcessDumpHardening()
		if err := runSignerAdminCLI(os.Args[2:], os.Stdin, os.Stdout, os.Environ()); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "fased-signerd admin: %s\n", err)
			os.Exit(1)
		}
		return
	}
	cfg := parseArgs()
	if err := applyProcessHardening(cfg); err != nil {
		log.Fatal(err)
	}
	if err := run(cfg); err != nil {
		log.Fatal(err)
	}
}

func run(cfg signerConfig) error {
	if _, err := signerReleaseIdentity(); err != nil {
		return fmt.Errorf("invalid signer build identity: %w", err)
	}
	if err := acquirePidLock(cfg.pidFile); err != nil {
		return err
	}
	defer os.Remove(cfg.pidFile)

	store, err := openSignerStoreV2(cfg.stateDBPath)
	if err != nil {
		return err
	}
	defer store.Close()
	keys, err := openSignerKeyManagerV2(store, cfg.masterKeyPath)
	if err != nil {
		return err
	}
	defer keys.Close()
	webauthn, err := newSignerWebAuthnServiceV2(store, cfg.webauthnRPID, cfg.webauthnOrigins)
	if err != nil {
		return err
	}
	var trigger *signerJupiterTriggerClientV2
	if _, statErr := os.Lstat(cfg.jupiterAPIKeyPath); statErr == nil {
		apiKey, keyErr := readSignerJupiterAPIKeyFileV2(cfg.jupiterAPIKeyPath)
		if keyErr != nil {
			return keyErr
		}
		trigger, keyErr = newSignerJupiterTriggerClientV2(apiKey)
		zeroBytes(apiKey)
		if keyErr != nil {
			return keyErr
		}
		defer trigger.close()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return errors.New("inspect signer-owned Jupiter API key file")
	}
	audit := &auditWriter{path: cfg.auditLog, maxBytes: cfg.auditMax}
	service := &signerServiceV2{store: store, keys: keys, webauthn: webauthn, trigger: trigger, audit: audit}

	applicationListener, err := listenUnixSocketV2(cfg.socketPath, cfg.socketMode, cfg.socketGroup)
	if err != nil {
		return err
	}
	defer applicationListener.Close()
	defer os.Remove(cfg.socketPath)
	if filepath.Clean(cfg.controlSocketPath) == filepath.Clean(cfg.socketPath) {
		return errors.New("control socket must be separate from the application socket")
	}
	controlListener, err := listenUnixSocketV2(cfg.controlSocketPath, 0o600, "")
	if err != nil {
		return err
	}
	defer controlListener.Close()
	defer os.Remove(cfg.controlSocketPath)

	limiter := newRateLimiter(cfg.rateWindow, cfg.rateLimit)
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		_ = applicationListener.Close()
		_ = controlListener.Close()
		_ = os.Remove(cfg.socketPath)
		_ = os.Remove(cfg.controlSocketPath)
	}()

	log.Printf("fased-signerd listening on %s", cfg.socketPath)
	log.Printf("fased-signerd control socket listening on %s", cfg.controlSocketPath)
	log.Printf("mode: %s", map[bool]string{true: "read-only", false: "read-write"}[cfg.readOnly])

	errCh := make(chan error, 2)
	serve := func(listener net.Listener, control bool) {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				if errors.Is(acceptErr, net.ErrClosed) {
					errCh <- nil
					return
				}
				continue
			}
			go handleConn(connection, cfg, limiter, audit, service, control)
		}
	}
	go serve(applicationListener, false)
	go serve(controlListener, true)
	return <-errCh
}

func handleConn(conn net.Conn, cfg signerConfig, limiter *rateLimiter, audit *auditWriter, service *signerServiceV2, control bool) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(socketReadTimeout))
		line, err := readRequestLine(reader, maxSignerRequestBytes)
		if err != nil {
			switch {
			case errors.Is(err, errRequestTooLarge):
				_, _ = conn.Write([]byte(`{"ok":false,"error":"signer request too large"}` + "\n"))
				audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "ok": false, "error": "request_too_large"})
			case isTimeout(err):
				_, _ = conn.Write([]byte(`{"ok":false,"error":"read timeout"}` + "\n"))
				audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "ok": false, "error": "read_timeout"})
			case !errors.Is(err, io.EOF):
				_, _ = conn.Write([]byte(`{"ok":false,"error":"read error"}` + "\n"))
			}
			return
		}
		_ = conn.SetReadDeadline(time.Time{})
		line = bytesTrimNewline(line)
		req, raw, err := decodeSignerEnvelopeV2(line)
		if err != nil {
			_, _ = conn.Write([]byte(`{"ok":false,"error":"invalid signer request"}` + "\n"))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "ok": false, "error": "invalid_json"})
			continue
		}
		if err := mustValidate(req, cfg); err != nil {
			_, _ = conn.Write([]byte(fmt.Sprintf(`{"ok":false,"error":%q}`+"\n", err.Error())))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": err.Error(), "fp": fingerprint(raw)})
			continue
		}
		if err := enforceApplicationUpdateGate(cfg.updateGatePath, req.Op, control, 0); err != nil {
			_, _ = conn.Write([]byte(fmt.Sprintf(`{"ok":false,"error":%q}`+"\n", err.Error())))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": "update_gate", "fp": fingerprint(raw)})
			continue
		}
		if !limiter.allow(req.Op) {
			_, _ = conn.Write([]byte(`{"ok":false,"error":"rate limit exceeded"}` + "\n"))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": "rate_limit", "fp": fingerprint(raw)})
			continue
		}
		response, err := service.handle(req, cfg, control)
		if err != nil {
			_, _ = conn.Write([]byte(fmt.Sprintf(`{"ok":false,"error":%q}`+"\n", err.Error())))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": "signer", "fp": fingerprint(raw)})
			continue
		}
		_, _ = conn.Write(append(response, '\n'))
		unknown := bytes.Contains(response, []byte(`"state":"unknown"`))
		if unknown {
			log.Printf("fased-signerd operation requires reconciliation: op=%s fp=%s", req.Op, fingerprint(raw))
		}
		audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": true, "fp": fingerprint(raw), "mode": "signer-v2", "unknown": unknown})
	}
}

func isTimeout(err error) bool {
	networkError, ok := err.(net.Error)
	return ok && networkError.Timeout()
}

func readRequestLine(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	var result []byte
	for {
		fragment, prefix, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(result)+len(fragment) > maxBytes {
			return nil, errRequestTooLarge
		}
		result = append(result, fragment...)
		if !prefix {
			return result, nil
		}
	}
}

type solanaEnvelopeV1 struct {
	Kind       string `json:"kind"`
	Version    int    `json:"version"`
	KDF        string `json:"kdf"`
	Cipher     string `json:"cipher"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	AuthTag    string `json:"authTag"`
	Ciphertext string `json:"ciphertext"`
	PublicKey  string `json:"publicKey"`
}

func parseSolanaEnvelope(data []byte) (*solanaEnvelopeV1, error) {
	var envelope solanaEnvelopeV1
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	if envelope.Kind != "fased-solana-keypair" || envelope.Version != 1 || envelope.KDF != "scrypt" || envelope.Cipher != "aes-256-gcm" {
		return nil, errors.New("not a fased solana keystore envelope")
	}
	if envelope.Salt == "" || envelope.IV == "" || envelope.AuthTag == "" || envelope.Ciphertext == "" || envelope.PublicKey == "" {
		return nil, errors.New("invalid solana envelope")
	}
	return &envelope, nil
}

func decodeB64URL(value string) ([]byte, error) {
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	return base64.URLEncoding.DecodeString(value)
}

func decryptSolanaEnvelope(envelope *solanaEnvelopeV1, passphrase string) ([]byte, error) {
	if strings.TrimSpace(passphrase) == "" {
		return nil, errors.New("missing passphrase")
	}
	salt, err := decodeB64URL(envelope.Salt)
	if err != nil {
		return nil, err
	}
	iv, err := decodeB64URL(envelope.IV)
	if err != nil {
		return nil, err
	}
	tag, err := decodeB64URL(envelope.AuthTag)
	if err != nil {
		return nil, err
	}
	ciphertext, err := decodeB64URL(envelope.Ciphertext)
	if err != nil {
		return nil, err
	}
	key, err := scrypt.Key([]byte(passphrase), salt, 16384, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, iv, append(ciphertext, tag...), nil)
	if err != nil {
		return nil, err
	}
	if len(plaintext) != 64 {
		zeroBytes(plaintext)
		return nil, fmt.Errorf("invalid Solana keystore secret length: %d", len(plaintext))
	}
	return plaintext, nil
}

type solanaWriteRPCEndpointState struct {
	ConsecutiveFailures int
	BackoffUntil        time.Time
	QuotaLikely         bool
}

var solanaWriteRPCCircuits = struct {
	sync.Mutex
	Endpoints map[string]solanaWriteRPCEndpointState
}{Endpoints: map[string]solanaWriteRPCEndpointState{}}

func solanaWriteRPCRequestTimeout() time.Duration {
	return time.Duration(getenvInt("FASED_WALLET_SOLANA_WRITE_RPC_TIMEOUT_MS", 12_000)) * time.Millisecond
}

func solanaWriteRPCConfirmTimeout() time.Duration {
	return time.Duration(getenvInt("FASED_WALLET_SOLANA_CONFIRM_TIMEOUT_MS", 45_000)) * time.Millisecond
}

func looksLikeSolanaRPCQuotaFailure(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "429") ||
		strings.Contains(message, "rate limit") ||
		strings.Contains(message, "too many requests") ||
		strings.Contains(message, "quota") ||
		strings.Contains(message, "credit") ||
		strings.Contains(message, "resource exhausted")
}

func markSolanaWriteRPCSuccess(rpcURL string) {
	solanaWriteRPCCircuits.Lock()
	defer solanaWriteRPCCircuits.Unlock()
	delete(solanaWriteRPCCircuits.Endpoints, strings.TrimSpace(rpcURL))
}

func markSolanaWriteRPCFailure(rpcURL string, err error) {
	key := strings.TrimSpace(rpcURL)
	if key == "" {
		return
	}
	solanaWriteRPCCircuits.Lock()
	defer solanaWriteRPCCircuits.Unlock()
	state := solanaWriteRPCCircuits.Endpoints[key]
	state.ConsecutiveFailures++
	state.QuotaLikely = looksLikeSolanaRPCQuotaFailure(err)
	if state.QuotaLikely {
		state.BackoffUntil = time.Now().Add(30 * time.Second)
	} else if state.ConsecutiveFailures >= 2 {
		backoff := 5 * time.Second * time.Duration(1<<(state.ConsecutiveFailures-2))
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
		state.BackoffUntil = time.Now().Add(backoff)
	}
	solanaWriteRPCCircuits.Endpoints[key] = state
}

func activeSolanaWriteRPCURLs(rpcURLs []string) ([]string, error) {
	now := time.Now()
	solanaWriteRPCCircuits.Lock()
	defer solanaWriteRPCCircuits.Unlock()
	active := make([]string, 0, len(rpcURLs))
	shortestBackoff := time.Duration(0)
	configured := 0
	for _, rpcURL := range rpcURLs {
		trimmed := strings.TrimSpace(rpcURL)
		if trimmed == "" {
			continue
		}
		configured++
		state := solanaWriteRPCCircuits.Endpoints[trimmed]
		if state.BackoffUntil.After(now) {
			remaining := state.BackoffUntil.Sub(now)
			if shortestBackoff == 0 || remaining < shortestBackoff {
				shortestBackoff = remaining
			}
			continue
		}
		active = append(active, trimmed)
	}
	if len(active) > 0 {
		return active, nil
	}
	if configured == 0 {
		return nil, errors.New("missing Solana write RPC URL")
	}
	return nil, fmt.Errorf("all Solana write RPC endpoints are in circuit cooldown; retry in %s", shortestBackoff.Round(time.Second))
}
