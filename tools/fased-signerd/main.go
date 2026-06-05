package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	system "github.com/gagliardetto/solana-go/programs/system"
	rpc "github.com/gagliardetto/solana-go/rpc"
	"golang.org/x/crypto/scrypt"
)

const (
	maxSignerRequestBytes = 1 << 20
	socketReadTimeout     = 30 * time.Second
)

var errRequestTooLarge = errors.New("signer request exceeds maximum size")

type custodyUnlockScope struct {
	WalletID      string
	Role          string
	Chains        map[string]bool
	AllowPrograms map[string]bool
	SOLMaxPerTx   *big.Int
	SOLMaxDaily   *big.Int
}

type custodyUnlockEntry struct {
	SessionID     string
	Host          string
	WalletID      string
	Role          string
	ExpiresAt     time.Time
	Passphrase    []byte
	Scope         custodyUnlockScope
	SOLSpentDaily *big.Int
	DailyBucket   string
}

type custodyUnlockState struct {
	mu       sync.Mutex
	sessions map[string]*custodyUnlockEntry
}

var activeCustodyUnlock = custodyUnlockState{
	sessions: map[string]*custodyUnlockEntry{},
}

type request struct {
	Op       string          `json:"op"`
	Chain    string          `json:"chain,omitempty"`
	WalletID string          `json:"walletId,omitempty"`
	Request  json.RawMessage `json:"request,omitempty"`
}

type custodyUnlockRequest struct {
	SessionID     string   `json:"sessionId"`
	Host          string   `json:"host"`
	WalletID      string   `json:"walletId"`
	Role          string   `json:"role,omitempty"`
	Chains        []string `json:"chains,omitempty"`
	AllowPrograms []string `json:"allowPrograms,omitempty"`
	ExpiresAt     string   `json:"expiresAt"`
	Passphrase    string   `json:"passphrase"`
	SOLMaxPerTx   string   `json:"solanaMaxPerTx,omitempty"`
	SOLMaxDaily   string   `json:"solanaMaxDaily,omitempty"`
}

type custodyLockRequest struct {
	SessionID string `json:"sessionId,omitempty"`
	Host      string `json:"host,omitempty"`
	WalletID  string `json:"walletId,omitempty"`
}

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type signerConfig struct {
	socketPath          string
	pidFile             string
	auditLog            string
	readOnly            bool
	rateWindow          time.Duration
	rateLimit           map[string]int
	auditMax            int64
	dropUID             int
	dropGID             int
	backendMode         string
	chains              []string
	keystorePath        string
	solanaKeystorePath  string
	solanaKeystorePaths map[string]string
	rpcURL              string
	solanaRPCURL        string
	solanaRPCURLs       map[string]string
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
	for _, t := range b.times {
		if t.After(cutoff) {
			dst = append(dst, t)
		}
	}
	b.times = dst
	limit := r.limits[op]
	if len(b.times) >= limit {
		return false
	}
	b.times = append(b.times, now)
	return true
}

type auditWriter struct {
	path     string
	maxBytes int64
	mu       sync.Mutex
}

func (a *auditWriter) write(entry map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.path == "" {
		return
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(a.path), 0o700)
	if st, err := os.Stat(a.path); err == nil && st.Size() >= a.maxBytes && a.maxBytes > 0 {
		rot := a.path + ".1"
		_ = os.Remove(rot)
		_ = os.Rename(a.path, rot)
	}
	f, err := os.OpenFile(a.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

func getenvInt(name string, def int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func getenvInt64(name string, def int64) int64 {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func envFlagEnabled(name string) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func custodySplitKeyActive() bool {
	return strings.TrimSpace(strings.ToLower(os.Getenv("FASED_WALLET_CUSTODY_MODE"))) == "split-key" &&
		envFlagEnabled("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY") &&
		envFlagEnabled("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION") &&
		envFlagEnabled("FASED_WALLET_CUSTODY_PHASE2_COMPLETE")
}

func custodySplitKeyWallets() map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(os.Getenv("FASED_WALLET_CUSTODY_WALLETS"), ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		wid := normalizeWalletID(part)
		if wid != "" {
			out[wid] = true
		}
	}
	return out
}

func custodySplitKeyActiveForWallet(walletID string) bool {
	if !custodySplitKeyActive() {
		return false
	}
	wallets := custodySplitKeyWallets()
	if len(wallets) == 0 {
		return false
	}
	return wallets[normalizeWalletID(walletID)]
}

func zeroBytes(buf []byte) {
	for i := range buf {
		buf[i] = 0
	}
}

func normalizeCustodyHost(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return ""
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return host + ":" + port
	}
	return host
}

func parseCapBigInt(raw string) *big.Int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	value, ok := new(big.Int).SetString(trimmed, 10)
	if !ok || value.Sign() < 0 {
		return nil
	}
	return value
}

func cloneBigInt(value *big.Int) *big.Int {
	if value == nil {
		return nil
	}
	return new(big.Int).Set(value)
}

func normalizeStringSet(values []string, normalize func(string) string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		normalized := normalize(value)
		if normalized == "" {
			continue
		}
		out[normalized] = true
	}
	return out
}

func normalizeChainName(raw string) string {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value != "solana" {
		return ""
	}
	return value
}

func normalizeProgramID(raw string) string {
	return strings.TrimSpace(strings.ToLower(raw))
}

func currentDayBucket(now time.Time) string {
	return now.UTC().Format("2006-01-02")
}

func cleanupExpiredCustodyUnlocksLocked(now time.Time) {
	for walletID, entry := range activeCustodyUnlock.sessions {
		if entry == nil {
			delete(activeCustodyUnlock.sessions, walletID)
			continue
		}
		if entry.ExpiresAt.IsZero() || !entry.ExpiresAt.After(now) {
			if len(entry.Passphrase) > 0 {
				zeroBytes(entry.Passphrase)
			}
			delete(activeCustodyUnlock.sessions, walletID)
		}
	}
}

func currentCustodyStatus(walletID string) (bool, *custodyUnlockEntry) {
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	entry := activeCustodyUnlock.sessions[normalizeWalletID(walletID)]
	if entry == nil {
		return false, nil
	}
	return true, entry
}

func setCustodyUnlock(req custodyUnlockRequest, expiresAt time.Time) {
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	walletID := normalizeWalletID(req.WalletID)
	if existing := activeCustodyUnlock.sessions[walletID]; existing != nil && len(existing.Passphrase) > 0 {
		zeroBytes(existing.Passphrase)
	}
	activeCustodyUnlock.sessions[walletID] = &custodyUnlockEntry{
		SessionID:  strings.TrimSpace(req.SessionID),
		Host:       normalizeCustodyHost(req.Host),
		WalletID:   walletID,
		Role:       strings.TrimSpace(req.Role),
		ExpiresAt:  expiresAt.UTC(),
		Passphrase: append([]byte(nil), []byte(req.Passphrase)...),
		Scope: custodyUnlockScope{
			WalletID:      walletID,
			Role:          strings.TrimSpace(req.Role),
			Chains:        normalizeStringSet(req.Chains, normalizeChainName),
			AllowPrograms: normalizeStringSet(req.AllowPrograms, normalizeProgramID),
			SOLMaxPerTx:   parseCapBigInt(req.SOLMaxPerTx),
			SOLMaxDaily:   parseCapBigInt(req.SOLMaxDaily),
		},
		SOLSpentDaily: big.NewInt(0),
		DailyBucket:   currentDayBucket(time.Now()),
	}
}

func clearCustodyUnlock(sessionID, host, walletID string) bool {
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	normalizedHost := normalizeCustodyHost(host)
	rawWalletID := strings.TrimSpace(walletID)
	normalizedWalletID := ""
	if rawWalletID != "" {
		normalizedWalletID = normalizeWalletID(rawWalletID)
	}
	for key, entry := range activeCustodyUnlock.sessions {
		if entry == nil {
			delete(activeCustodyUnlock.sessions, key)
			continue
		}
		if normalizedWalletID != "" && key != normalizedWalletID {
			continue
		}
		if sessionID != "" && entry.SessionID != strings.TrimSpace(sessionID) {
			continue
		}
		if normalizedHost != "" && entry.Host != normalizedHost {
			continue
		}
		if len(entry.Passphrase) > 0 {
			zeroBytes(entry.Passphrase)
		}
		delete(activeCustodyUnlock.sessions, key)
		return true
	}
	return false
}

func readActiveCustodyPassphrase(walletID string) (string, error) {
	active, entry := currentCustodyStatus(walletID)
	if !active || entry == nil {
		return "", errors.New("custody unlock required")
	}
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	current := activeCustodyUnlock.sessions[normalizeWalletID(walletID)]
	if current == nil || current.ExpiresAt.IsZero() || !current.ExpiresAt.After(time.Now()) || len(current.Passphrase) == 0 {
		return "", errors.New("custody unlock required")
	}
	return string(append([]byte(nil), current.Passphrase...)), nil
}

func applyDailySpendLocked(entry *custodyUnlockEntry, chain string, amount *big.Int) error {
	if entry == nil || amount == nil || amount.Sign() <= 0 {
		return nil
	}
	bucket := currentDayBucket(time.Now())
	if entry.DailyBucket != bucket {
		entry.DailyBucket = bucket
		entry.SOLSpentDaily = big.NewInt(0)
	}
	switch chain {
	case "solana":
		if entry.Scope.SOLMaxDaily != nil && entry.Scope.SOLMaxDaily.Sign() > 0 {
			next := new(big.Int).Add(entry.SOLSpentDaily, amount)
			if next.Cmp(entry.Scope.SOLMaxDaily) > 0 {
				return errors.New("custody solana daily cap exceeded")
			}
			entry.SOLSpentDaily = next
		}
	}
	return nil
}

func normalizeWalletID(walletID string) string {
	v := strings.TrimSpace(walletID)
	if v == "" {
		return "default"
	}
	v = strings.ToLower(v)
	var b strings.Builder
	lastUnderscore := false
	for _, r := range v {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlphaNum {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteRune('_')
			lastUnderscore = true
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "default"
	}
	return out
}

func normalizeWalletIDForFilename(walletID string) string {
	v := strings.TrimSpace(strings.ToLower(walletID))
	if v == "" {
		return "default"
	}
	var b strings.Builder
	lastHyphen := false
	for _, r := range v {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlphaNum || r == '_' || r == '-' {
			b.WriteRune(r)
			lastHyphen = false
			continue
		}
		if !lastHyphen {
			b.WriteRune('-')
			lastHyphen = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "default"
	}
	return out
}

func parseWalletMapEnv(prefix string) map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		k := kv[:i]
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		v := strings.TrimSpace(kv[i+1:])
		if v == "" {
			continue
		}
		wid := normalizeWalletID(strings.TrimPrefix(k, prefix))
		out[wid] = v
	}
	return out
}

func mustValidate(req request, cfg signerConfig) error {
	switch req.Op {
	case "health":
		if len(req.Request) > 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
	case "custodyStatus":
		if len(req.Request) > 0 || req.Chain != "" {
			return errors.New("invalid signer request")
		}
	case "getAddresses":
		if len(req.Request) > 0 || req.Chain != "" {
			return errors.New("invalid signer request")
		}
	case "getBalance":
		if req.Chain != "solana" {
			return errors.New("invalid signer request")
		}
		if err := cfg.ensureChainAllowed(req.Chain); err != nil {
			return err
		}
	case "prepareTx", "sendTx", "signTx":
		if cfg.readOnly {
			return errors.New("read-only signer mode")
		}
		if len(req.Request) == 0 {
			return errors.New("invalid signer request")
		}
		var body map[string]any
		if err := json.Unmarshal(req.Request, &body); err != nil {
			return errors.New("invalid signer request")
		}
		rv := body
		chain, _ := rv["chain"].(string)
		if chain != "solana" {
			return errors.New("invalid signer request")
		}
		if err := cfg.ensureChainAllowed(chain); err != nil {
			return err
		}
	case "sendSolanaInstruction":
		if cfg.readOnly {
			return errors.New("read-only signer mode")
		}
		if len(req.Request) == 0 {
			return errors.New("invalid signer request")
		}
		var body solanaInstructionRequest
		if err := json.Unmarshal(req.Request, &body); err != nil {
			return errors.New("invalid signer request")
		}
		if strings.TrimSpace(body.ProgramID) == "" || strings.TrimSpace(body.DataBase64) == "" || len(body.Keys) == 0 {
			return errors.New("invalid signer request")
		}
		if err := cfg.ensureChainAllowed("solana"); err != nil {
			return err
		}
	case "unlockCustody":
		if len(req.Request) == 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
		var body custodyUnlockRequest
		if err := json.Unmarshal(req.Request, &body); err != nil {
			return errors.New("invalid signer request")
		}
		if strings.TrimSpace(body.SessionID) == "" || strings.TrimSpace(body.Passphrase) == "" || strings.TrimSpace(body.WalletID) == "" {
			return errors.New("invalid signer request")
		}
		if normalizeCustodyHost(body.Host) == "" {
			return errors.New("invalid signer request")
		}
		for _, chain := range body.Chains {
			if normalizeChainName(chain) == "" {
				return errors.New("invalid signer request")
			}
		}
		expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(body.ExpiresAt))
		if err != nil || !expiresAt.After(time.Now()) {
			return errors.New("invalid signer request")
		}
	case "lockCustody":
		if len(req.Request) == 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
		var body custodyLockRequest
		if err := json.Unmarshal(req.Request, &body); err != nil {
			return errors.New("invalid signer request")
		}
		if strings.TrimSpace(body.Host) != "" && normalizeCustodyHost(body.Host) == "" {
			return errors.New("invalid signer request")
		}
	default:
		return errors.New("unsupported op")
	}
	return nil
}

func fingerprint(raw map[string]any) map[string]any {
	out := map[string]any{"op": raw["op"]}
	if chain, ok := raw["chain"]; ok {
		out["chain"] = chain
	}
	if walletID, ok := raw["walletId"]; ok {
		out["walletId"] = walletID
	}
	if req, ok := raw["request"].(map[string]any); ok {
		if ch, ok := req["chain"]; ok {
			out["chain"] = ch
		}
		for _, k := range []string{"to", "contract", "program", "amount"} {
			if v, ok := req[k]; ok {
				out[k] = v
			}
		}
		if _, ok := req["memo"]; ok {
			out["hasMemo"] = true
		}
		if _, ok := req["preparedId"]; ok {
			out["hasPreparedId"] = true
		}
		if wid, ok := req["walletId"]; ok {
			out["walletId"] = wid
		}
		if programID, ok := req["programId"]; ok {
			out["programId"] = programID
		}
		if keys, ok := req["keys"].([]any); ok {
			out["keyCount"] = len(keys)
		}
	}
	return out
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

func bytesTrimNewline(b []byte) []byte {
	return []byte(strings.TrimRight(string(b), "\r\n"))
}

func parseArgs() signerConfig {
	stateRoot := filepath.Join(userHomeDir(), ".fased", "wallet")
	socketDefault := filepath.Join(stateRoot, "local-signer.sock")
	cfg := signerConfig{
		socketPath:  socketDefault,
		pidFile:     "",
		auditLog:    "",
		readOnly:    os.Getenv("FASED_WALLET_LOCAL_SIGNER_READ_ONLY") == "1",
		rateWindow:  time.Duration(getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WINDOW_MS", 10_000)) * time.Millisecond,
		auditMax:    getenvInt64("FASED_WALLET_LOCAL_SIGNER_AUDIT_MAX_BYTES", 1_048_576),
		dropUID:     getenvInt("FASED_WALLET_LOCAL_SIGNER_DROP_UID", 0),
		dropGID:     getenvInt("FASED_WALLET_LOCAL_SIGNER_DROP_GID", 0),
		backendMode: firstNonEmpty(strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_BACKEND_MODE")), "native"),
		keystorePath: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_KEYSTORE_PATH")),
			filepath.Join(userHomeDir(), ".fased", "wallet", "keystore.v1.enc"),
		),
		solanaKeystorePath: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_SOLANA_KEYSTORE_PATH")),
			strings.TrimSpace(os.Getenv("FASED_WALLET_KEYSTORE_PATH")),
		),
		rpcURL: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL")),
			strings.TrimSpace(os.Getenv("FASED_WALLET_RPC_URL")),
		),
		solanaRPCURL: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_SOLANA_RPC_URL")),
			firstNonEmpty(
				strings.TrimSpace(os.Getenv("FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL")),
				strings.TrimSpace(os.Getenv("FASED_WALLET_RPC_URL")),
			),
		),
	}
	cfg.solanaKeystorePaths = parseWalletMapEnv("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
	cfg.solanaRPCURLs = parseWalletMapEnv("FASED_WALLET_SOLANA_RPC_URL__")
	fs := flag.NewFlagSet(os.Args[0], flag.ExitOnError)
	fs.StringVar(&cfg.socketPath, "socket", cfg.socketPath, "unix socket path")
	fs.StringVar(&cfg.pidFile, "pid-file", "", "pid file path (default <socket>.pid)")
	fs.StringVar(&cfg.auditLog, "audit-log", "", "audit log path (default <socket>.audit.jsonl)")
	fs.BoolVar(&cfg.readOnly, "read-only", cfg.readOnly, "read-only mode (health/getAddresses/getBalance only)")
	fs.StringVar(&cfg.backendMode, "backend-mode", cfg.backendMode, "signer mode: native (hybrid accepted as alias)")
	_ = fs.Parse(os.Args[1:])
	if cfg.pidFile == "" {
		cfg.pidFile = cfg.socketPath + ".pid"
	}
	if cfg.auditLog == "" {
		cfg.auditLog = cfg.socketPath + ".audit.jsonl"
	}
	cfg.rateLimit = map[string]int{
		"health":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_HEALTH", 300),
		"custodyStatus":         getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_CUSTODYSTATUS", 300),
		"unlockCustody":         getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_UNLOCKCUSTODY", 60),
		"lockCustody":           getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_LOCKCUSTODY", 120),
		"getAddresses":          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_GETADDRESSES", 120),
		"getBalance":            getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_GETBALANCE", 240),
		"prepareTx":             getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_PREPARETX", 120),
		"signTx":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_SIGNTX", 60),
		"sendTx":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_SENDTX", 40),
		"sendSolanaInstruction": getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_SENDSOLANAINSTRUCTION", 80),
	}
	cfg.chains = parseChainsEnv(os.Getenv("FASED_WALLET_CHAINS"))
	return cfg
}

func (cfg signerConfig) keystorePathFor(chain string) string {
	return cfg.keystorePathForWallet(chain, "")
}

func conventionalKeystoreFilenameFor(chain, walletID string) string {
	_ = chain
	normalized := normalizeWalletIDForFilename(walletID)
	if normalized == "" || normalized == "default" {
		return "keystore-solana.v1.enc"
	}
	return fmt.Sprintf("keystore-solana-%s.v1.enc", normalized)
}

func existingFile(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return ""
	}
	return path
}

func (cfg signerConfig) inferredScopedKeystorePath(chain, walletID string) string {
	if normalizeWalletID(walletID) == "default" {
		return ""
	}
	basePath := ""
	switch chain {
	case "solana":
		basePath = firstNonEmpty(cfg.solanaKeystorePath, cfg.keystorePath)
	default:
		basePath = cfg.keystorePath
	}
	materialDir := ""
	if strings.TrimSpace(basePath) != "" {
		materialDir = filepath.Dir(basePath)
	}
	if materialDir == "" {
		materialDir = filepath.Join(userHomeDir(), ".fased", "wallet")
	}
	return existingFile(filepath.Join(materialDir, conventionalKeystoreFilenameFor(chain, walletID)))
}

func singleScopedValue(values map[string]string) string {
	var only string
	for wid, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || wid == "default" {
			continue
		}
		if only != "" && only != trimmed {
			return ""
		}
		only = trimmed
	}
	return only
}

func (cfg signerConfig) keystorePathForWallet(chain, walletID string) string {
	wid := normalizeWalletID(walletID)
	switch chain {
	case "solana":
		if p := strings.TrimSpace(cfg.solanaKeystorePaths[wid]); p != "" {
			return p
		}
		if wid != "default" {
			if p := strings.TrimSpace(cfg.solanaKeystorePaths["default"]); p != "" {
				return p
			}
		}
		if wid == "default" {
			if p := singleScopedValue(cfg.solanaKeystorePaths); p != "" {
				return p
			}
		}
		if p := cfg.inferredScopedKeystorePath("solana", walletID); p != "" {
			return p
		}
		return firstNonEmpty(cfg.solanaKeystorePath, cfg.keystorePath)
	default:
		return cfg.keystorePath
	}
}

func (cfg signerConfig) rpcURLFor(chain string) string {
	return cfg.rpcURLForWallet(chain, "")
}

func (cfg signerConfig) rpcURLForWallet(chain, walletID string) string {
	wid := normalizeWalletID(walletID)
	switch chain {
	case "solana":
		if u := strings.TrimSpace(cfg.solanaRPCURLs[wid]); u != "" {
			return u
		}
		if wid != "default" {
			if u := strings.TrimSpace(cfg.solanaRPCURLs["default"]); u != "" {
				return u
			}
		}
		if wid == "default" {
			if u := singleScopedValue(cfg.solanaRPCURLs); u != "" {
				return u
			}
		}
		return firstNonEmpty(cfg.solanaRPCURL, cfg.rpcURL)
	default:
		return cfg.rpcURL
	}
}

func parseChainsEnv(raw string) []string {
	parts := strings.Split(strings.TrimSpace(raw), ",")
	var out []string
	seen := map[string]bool{}
	for _, p := range parts {
		v := strings.ToLower(strings.TrimSpace(p))
		if v == "" {
			continue
		}
		if v != "solana" {
			continue
		}
		if !seen[v] {
			out = append(out, v)
			seen[v] = true
		}
	}
	if len(out) == 0 {
		return []string{"solana"}
	}
	return out
}

func (cfg signerConfig) chainAllowed(chain string) bool {
	for _, allowed := range cfg.chains {
		if allowed == strings.TrimSpace(strings.ToLower(chain)) {
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

func firstNonEmpty(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func userHomeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "/tmp"
}

func main() {
	cfg := parseArgs()
	if err := applyProcessHardening(cfg); err != nil {
		log.Fatal(err)
	}
	if err := run(cfg); err != nil {
		log.Fatal(err)
	}
}

func run(cfg signerConfig) error {
	_ = os.MkdirAll(filepath.Dir(cfg.socketPath), 0o700)
	_ = os.Remove(cfg.socketPath)
	if err := acquirePidLock(cfg.pidFile); err != nil {
		return err
	}
	defer os.Remove(cfg.pidFile)

	if cfg.backendMode == "hybrid" {
		cfg.backendMode = "native"
	}

	l, err := net.Listen("unix", cfg.socketPath)
	if err != nil {
		return err
	}
	defer l.Close()
	_ = os.Chmod(cfg.socketPath, 0o600)

	limiter := newRateLimiter(cfg.rateWindow, cfg.rateLimit)
	audit := &auditWriter{path: cfg.auditLog, maxBytes: cfg.auditMax}

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		_ = l.Close()
		_ = os.Remove(cfg.socketPath)
	}()

	log.Printf("fased-signerd listening on %s", cfg.socketPath)
	log.Printf("mode: %s", map[bool]string{true: "read-only", false: "read-write"}[cfg.readOnly])

	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			continue
		}
		go handleConn(conn, cfg, limiter, audit)
	}
}

func handleConn(conn net.Conn, cfg signerConfig, limiter *rateLimiter, audit *auditWriter) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(socketReadTimeout))
		line, err := readRequestLine(br, maxSignerRequestBytes)
		if err != nil {
			if errors.Is(err, errRequestTooLarge) {
				_, _ = conn.Write([]byte(`{"ok":false,"error":"signer request too large"}` + "\n"))
				audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "ok": false, "error": "request_too_large"})
				return
			}
			if nerr, ok := err.(net.Error); ok && nerr.Timeout() {
				_, _ = conn.Write([]byte(`{"ok":false,"error":"read timeout"}` + "\n"))
				audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "ok": false, "error": "read_timeout"})
				return
			}
			if !errors.Is(err, io.EOF) {
				_, _ = conn.Write([]byte(`{"ok":false,"error":"read error"}` + "\n"))
			}
			return
		}
		_ = conn.SetReadDeadline(time.Time{})
		line = bytesTrimNewline(line)
		var raw map[string]any
		if err := json.Unmarshal(line, &raw); err != nil {
			_, _ = conn.Write([]byte(`{"ok":false,"error":"invalid signer request"}` + "\n"))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "ok": false, "error": "invalid_json"})
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			_, _ = conn.Write([]byte(`{"ok":false,"error":"invalid signer request"}` + "\n"))
			continue
		}
		if err := mustValidate(req, cfg); err != nil {
			_, _ = conn.Write([]byte(fmt.Sprintf(`{"ok":false,"error":%q}`+"\n", err.Error())))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": err.Error(), "fp": fingerprint(raw)})
			continue
		}
		if !limiter.allow(req.Op) {
			_, _ = conn.Write([]byte(`{"ok":false,"error":"rate limit exceeded"}` + "\n"))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": "rate_limit", "fp": fingerprint(raw)})
			continue
		}
		{
			resp, err := handleHybridNative(req, raw, cfg)
			if err != nil {
				_, _ = conn.Write([]byte(fmt.Sprintf(`{"ok":false,"error":%q}`+"\n", err.Error())))
				audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": false, "error": "native", "fp": fingerprint(raw)})
				continue
			}
			_, _ = conn.Write(append(resp, '\n'))
			audit.write(map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "op": req.Op, "ok": true, "fp": fingerprint(raw), "mode": "native"})
			continue
		}
	}
}

func readRequestLine(br *bufio.Reader, maxBytes int) ([]byte, error) {
	var buf []byte
	for {
		frag, isPrefix, err := br.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(buf)+len(frag) > maxBytes {
			return nil, errRequestTooLarge
		}
		buf = append(buf, frag...)
		if !isPrefix {
			return buf, nil
		}
	}
}

func detectKeystoreTypeAndSolanaPubkey(keystorePath string) (string, string) {
	data, err := os.ReadFile(keystorePath)
	if err != nil {
		return "unknown", ""
	}
	var generic map[string]any
	if err := json.Unmarshal(data, &generic); err != nil {
		return "unknown", ""
	}
	if kind, _ := generic["kind"].(string); kind == "fased-solana-keypair" {
		pub, _ := generic["publicKey"].(string)
		return "solana-envelope", strings.TrimSpace(pub)
	}
	return "unknown", ""
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

type signerTxRequest struct {
	Chain              string `json:"chain"`
	WalletID           string `json:"walletId,omitempty"`
	To                 string `json:"to,omitempty"`
	Amount             string `json:"amount,omitempty"`
	Contract           string `json:"contract,omitempty"`
	Program            string `json:"program,omitempty"`
	Memo               string `json:"memo,omitempty"`
	SerializedTxBase64 string `json:"serializedTxBase64,omitempty"`
	PreparedID         string `json:"preparedId,omitempty"`
}

type solanaInstructionAccount struct {
	Pubkey     string `json:"pubkey"`
	IsSigner   bool   `json:"isSigner"`
	IsWritable bool   `json:"isWritable"`
}

type solanaInstructionRequest struct {
	WalletID   string                     `json:"walletId,omitempty"`
	ProgramID  string                     `json:"programId"`
	DataBase64 string                     `json:"dataBase64"`
	Keys       []solanaInstructionAccount `json:"keys"`
}

type signerTxRequestEnvelope struct {
	Request signerTxRequest `json:"request"`
}

func readPassphrase(walletID string) (string, error) {
	if custodySplitKeyActiveForWallet(walletID) {
		return readActiveCustodyPassphrase(walletID)
	}
	if p := strings.TrimSpace(os.Getenv("FASED_WALLET_PASSPHRASE_FILE")); p != "" {
		if err := validateSecretFile(p); err != nil {
			return "", err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	return strings.TrimSpace(os.Getenv("FASED_WALLET_PASSPHRASE")), nil
}

func validateSecretFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s must be a regular file", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must not be group/world accessible", path)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		if int(stat.Uid) != os.Geteuid() {
			return fmt.Errorf("%s must be owned by uid %d", path, os.Geteuid())
		}
	}
	return nil
}

func parseSolanaEnvelope(data []byte) (*solanaEnvelopeV1, error) {
	var env solanaEnvelopeV1
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	if env.Kind != "fased-solana-keypair" || env.Version != 1 || env.KDF != "scrypt" || env.Cipher != "aes-256-gcm" {
		return nil, errors.New("not a fased solana keystore envelope")
	}
	if env.Salt == "" || env.IV == "" || env.AuthTag == "" || env.Ciphertext == "" || env.PublicKey == "" {
		return nil, errors.New("invalid solana envelope")
	}
	return &env, nil
}

func decodeB64URL(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}

func decryptSolanaEnvelope(env *solanaEnvelopeV1, passphrase string) ([]byte, error) {
	if strings.TrimSpace(passphrase) == "" {
		return nil, errors.New("missing passphrase")
	}
	salt, err := decodeB64URL(env.Salt)
	if err != nil {
		return nil, err
	}
	iv, err := decodeB64URL(env.IV)
	if err != nil {
		return nil, err
	}
	tag, err := decodeB64URL(env.AuthTag)
	if err != nil {
		return nil, err
	}
	ciphertext, err := decodeB64URL(env.Ciphertext)
	if err != nil {
		return nil, err
	}
	key, err := scrypt.Key([]byte(passphrase), salt, 16384, 8, 1, 32)
	if err != nil {
		return nil, err
	}
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
		return nil, fmt.Errorf("invalid Solana keystore secret length: %d", len(plaintext))
	}
	return plaintext, nil
}

func base58Encode(in []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	if len(in) == 0 {
		return ""
	}
	x := new(big.Int).SetBytes(in)
	base := big.NewInt(58)
	zero := big.NewInt(0)
	mod := new(big.Int)
	var out []byte
	for x.Cmp(zero) > 0 {
		x.DivMod(x, base, mod)
		out = append(out, alphabet[mod.Int64()])
	}
	for _, b := range in {
		if b != 0 {
			break
		}
		out = append(out, alphabet[0])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

func deriveSolanaPubkeyBase58(secret64 []byte) (string, error) {
	if len(secret64) != 64 {
		return "", errors.New("invalid secret key length")
	}
	priv := ed25519.PrivateKey(secret64)
	pub := priv.Public().(ed25519.PublicKey)
	return base58Encode(pub), nil
}

func loadSolanaAddressFromEnvelope(keystorePath string, walletID string) (address string, keystoreType string, err error) {
	data, err := os.ReadFile(keystorePath)
	if err != nil {
		return "", "unknown", err
	}
	env, err := parseSolanaEnvelope(data)
	if err != nil {
		kt, pub := detectKeystoreTypeAndSolanaPubkey(keystorePath)
		return pub, kt, err
	}
	pass, err := readPassphrase(walletID)
	if err != nil {
		return strings.TrimSpace(env.PublicKey), "solana-envelope", err
	}
	if pass == "" {
		return strings.TrimSpace(env.PublicKey), "solana-envelope", errors.New("missing passphrase")
	}
	secret, err := decryptSolanaEnvelope(env, pass)
	if err != nil {
		return strings.TrimSpace(env.PublicKey), "solana-envelope", err
	}
	derived, err := deriveSolanaPubkeyBase58(secret)
	if err != nil {
		return strings.TrimSpace(env.PublicKey), "solana-envelope", err
	}
	if strings.TrimSpace(env.PublicKey) != "" && strings.TrimSpace(env.PublicKey) != derived {
		return derived, "solana-envelope", errors.New("solana envelope public key mismatch")
	}
	return derived, "solana-envelope", nil
}

func loadSolanaPrivateKeyFromEnvelope(keystorePath string, walletID string) (solana.PrivateKey, string, error) {
	data, err := os.ReadFile(keystorePath)
	if err != nil {
		return nil, "", err
	}
	env, err := parseSolanaEnvelope(data)
	if err != nil {
		return nil, "", err
	}
	pass, err := readPassphrase(walletID)
	if err != nil {
		return nil, "", err
	}
	secret, err := decryptSolanaEnvelope(env, pass)
	if err != nil {
		return nil, "", err
	}
	pk := solana.PrivateKey(secret)
	return pk, strings.TrimSpace(env.PublicKey), nil
}

func solanaRPCGetBalance(rpcURL, pubkey string) (uint64, error) {
	if strings.TrimSpace(rpcURL) == "" {
		return 0, errors.New("missing rpc url")
	}
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "getBalance",
		"params":  []any{pubkey},
	})
	resp, err := http.Post(rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("rpc status %d", resp.StatusCode)
	}
	var parsed struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result *struct {
			Value uint64 `json:"value"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return 0, err
	}
	if parsed.Error != nil {
		return 0, fmt.Errorf("rpc error: %s", parsed.Error.Message)
	}
	if parsed.Result == nil {
		return 0, errors.New("rpc result missing")
	}
	return parsed.Result.Value, nil
}

func parseLamports(raw string) (uint64, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, errors.New("missing amount")
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid lamports amount: %s", s)
	}
	return n, nil
}

func custodyStatusResult(walletID string) map[string]any {
	active, entry := currentCustodyStatus(walletID)
	res := map[string]any{
		"active": active,
	}
	if !active || entry == nil {
		return res
	}
	res["sessionId"] = entry.SessionID
	res["host"] = entry.Host
	res["expiresAt"] = entry.ExpiresAt.UTC().Format(time.RFC3339)
	res["walletId"] = entry.WalletID
	if strings.TrimSpace(entry.Role) != "" {
		res["role"] = entry.Role
	}
	if len(entry.Scope.Chains) > 0 {
		chains := make([]string, 0, len(entry.Scope.Chains))
		for chain := range entry.Scope.Chains {
			chains = append(chains, chain)
		}
		res["chains"] = chains
	}
	if len(entry.Scope.AllowPrograms) > 0 {
		programs := make([]string, 0, len(entry.Scope.AllowPrograms))
		for program := range entry.Scope.AllowPrograms {
			programs = append(programs, program)
		}
		res["allowPrograms"] = programs
	}
	if entry.Scope.SOLMaxPerTx != nil {
		res["solanaMaxPerTx"] = entry.Scope.SOLMaxPerTx.String()
	}
	if entry.Scope.SOLMaxDaily != nil {
		res["solanaMaxDaily"] = entry.Scope.SOLMaxDaily.String()
	}
	return res
}

func extractSolanaInstructionAmount(req solanaInstructionRequest) *big.Int {
	programID := normalizeProgramID(req.ProgramID)
	if programID != normalizeProgramID("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") &&
		programID != normalizeProgramID("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
		return nil
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.DataBase64))
	if err != nil || len(data) < 9 {
		return nil
	}
	if data[0] != 12 {
		return nil
	}
	return new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[1:9]))
}

func validateCustodyScopeForSendTx(txReq signerTxRequest) (*big.Int, error) {
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	entry := activeCustodyUnlock.sessions[normalizeWalletID(txReq.WalletID)]
	if entry == nil || entry.ExpiresAt.IsZero() || !entry.ExpiresAt.After(time.Now()) || len(entry.Passphrase) == 0 {
		return nil, errors.New("custody unlock required")
	}
	if len(entry.Scope.Chains) > 0 && !entry.Scope.Chains[normalizeChainName(txReq.Chain)] {
		return nil, fmt.Errorf("custody chain %s not allowed for wallet %s", txReq.Chain, entry.WalletID)
	}
	var amount *big.Int
	switch normalizeChainName(txReq.Chain) {
	case "solana":
		lamports, err := parseLamports(txReq.Amount)
		if err != nil {
			return nil, err
		}
		amount = new(big.Int).SetUint64(lamports)
		if entry.Scope.SOLMaxPerTx != nil && entry.Scope.SOLMaxPerTx.Sign() > 0 && amount.Cmp(entry.Scope.SOLMaxPerTx) > 0 {
			return nil, errors.New("custody solana per-tx cap exceeded")
		}
		if entry.Scope.SOLMaxDaily != nil && entry.Scope.SOLMaxDaily.Sign() > 0 {
			next := new(big.Int).Add(entry.SOLSpentDaily, amount)
			if next.Cmp(entry.Scope.SOLMaxDaily) > 0 {
				return nil, errors.New("custody solana daily cap exceeded")
			}
		}
	default:
		return nil, errors.New("unsupported chain")
	}
	return cloneBigInt(amount), nil
}

func validateCustodyScopeForSolanaInstruction(req solanaInstructionRequest) (*big.Int, error) {
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	entry := activeCustodyUnlock.sessions[normalizeWalletID(req.WalletID)]
	if entry == nil || entry.ExpiresAt.IsZero() || !entry.ExpiresAt.After(time.Now()) || len(entry.Passphrase) == 0 {
		return nil, errors.New("custody unlock required")
	}
	if len(entry.Scope.Chains) > 0 && !entry.Scope.Chains["solana"] {
		return nil, fmt.Errorf("custody chain solana not allowed for wallet %s", entry.WalletID)
	}
	programID := normalizeProgramID(req.ProgramID)
	if len(entry.Scope.AllowPrograms) == 0 || !entry.Scope.AllowPrograms[programID] {
		return nil, fmt.Errorf("custody program %s not allowed for wallet %s", strings.TrimSpace(req.ProgramID), entry.WalletID)
	}
	amount := extractSolanaInstructionAmount(req)
	if amount == nil {
		return nil, nil
	}
	if entry.Scope.SOLMaxPerTx != nil && entry.Scope.SOLMaxPerTx.Sign() > 0 && amount.Cmp(entry.Scope.SOLMaxPerTx) > 0 {
		return nil, errors.New("custody solana per-tx cap exceeded")
	}
	if entry.Scope.SOLMaxDaily != nil && entry.Scope.SOLMaxDaily.Sign() > 0 {
		next := new(big.Int).Add(entry.SOLSpentDaily, amount)
		if next.Cmp(entry.Scope.SOLMaxDaily) > 0 {
			return nil, errors.New("custody solana daily cap exceeded")
		}
	}
	return cloneBigInt(amount), nil
}

func recordCustodyUsage(walletID, chain string, amount *big.Int) {
	if amount == nil || amount.Sign() <= 0 {
		return
	}
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	entry := activeCustodyUnlock.sessions[normalizeWalletID(walletID)]
	if entry == nil {
		return
	}
	_ = applyDailySpendLocked(entry, normalizeChainName(chain), amount)
}

func solanaSendNativeTransferAndConfirm(rpcURL, keystorePath string, txReq signerTxRequest) (string, string, error) {
	if txReq.Chain != "solana" {
		return "", "", errors.New("invalid chain for native solana send")
	}
	if strings.TrimSpace(txReq.SerializedTxBase64) != "" {
		return solanaSendSerializedTransactionAndConfirm(rpcURL, keystorePath, txReq)
	}
	if strings.TrimSpace(txReq.To) == "" {
		return "", "", errors.New("missing recipient")
	}
	lamports, err := parseLamports(txReq.Amount)
	if err != nil {
		return "", "", err
	}
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, txReq.WalletID)
	if err != nil {
		return "", "", err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", errors.New("solana envelope public key mismatch")
	}
	toPub, err := solana.PublicKeyFromBase58(strings.TrimSpace(txReq.To))
	if err != nil {
		return "", "", err
	}
	client := rpc.New(strings.TrimSpace(rpcURL))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	bh, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", "", err
	}
	ix := system.NewTransferInstruction(lamports, fromPub, toPub).Build()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{ix},
		bh.Value.Blockhash,
		solana.TransactionPayer(fromPub),
	)
	if err != nil {
		return "", "", err
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(fromPub) {
			k := priv
			return &k
		}
		return nil
	})
	if err != nil {
		return "", "", err
	}
	sig, err := client.SendTransactionWithOpts(ctx, tx, rpc.TransactionOpts{
		SkipPreflight:       false,
		PreflightCommitment: rpc.CommitmentConfirmed,
	})
	if err != nil {
		return "", "", err
	}

	// Simple confirm polling loop
	confirmCtx, confirmCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer confirmCancel()
	tick := time.NewTicker(1500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-confirmCtx.Done():
			return sig.String(), fromPub.String(), fmt.Errorf("solana confirm timeout for %s", sig.String())
		case <-tick.C:
			st, err := client.GetSignatureStatuses(confirmCtx, true, sig)
			if err != nil {
				continue
			}
			if st == nil || st.Value == nil || len(st.Value) == 0 || st.Value[0] == nil {
				continue
			}
			if st.Value[0].Err != nil {
				return sig.String(), fromPub.String(), fmt.Errorf("solana tx failed: %v", st.Value[0].Err)
			}
			if st.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
				st.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
				return sig.String(), fromPub.String(), nil
			}
		}
	}
}

func solanaSendSerializedTransactionAndConfirm(rpcURL, keystorePath string, txReq signerTxRequest) (string, string, error) {
	signedTxBase64, signer, err := solanaSignSerializedTransaction(keystorePath, txReq)
	if err != nil {
		return "", signer, err
	}
	signedRaw, err := base64.StdEncoding.DecodeString(signedTxBase64)
	if err != nil {
		return "", signer, err
	}
	client := rpc.New(strings.TrimSpace(rpcURL))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sig, err := client.SendRawTransactionWithOpts(ctx, signedRaw, rpc.TransactionOpts{
		SkipPreflight:       false,
		PreflightCommitment: rpc.CommitmentConfirmed,
	})
	if err != nil {
		return "", "", err
	}
	confirmCtx, confirmCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer confirmCancel()
	tick := time.NewTicker(1500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-confirmCtx.Done():
			return sig.String(), signer, fmt.Errorf("solana confirm timeout for %s", sig.String())
		case <-tick.C:
			st, err := client.GetSignatureStatuses(confirmCtx, true, sig)
			if err != nil {
				continue
			}
			if st == nil || st.Value == nil || len(st.Value) == 0 || st.Value[0] == nil {
				continue
			}
			if st.Value[0].Err != nil {
				return sig.String(), signer, fmt.Errorf("solana tx failed: %v", st.Value[0].Err)
			}
			if st.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
				st.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
				return sig.String(), signer, nil
			}
		}
	}
}

func solanaSignSerializedTransaction(keystorePath string, txReq signerTxRequest) (string, string, error) {
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, txReq.WalletID)
	if err != nil {
		return "", "", err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", errors.New("solana envelope public key mismatch")
	}
	rawTx, err := base64.StdEncoding.DecodeString(strings.TrimSpace(txReq.SerializedTxBase64))
	if err != nil {
		return "", "", err
	}
	tx, err := solana.TransactionFromDecoder(bin.NewBinDecoder(rawTx))
	if err != nil {
		return "", "", err
	}
	signed := false
	_, err = tx.PartialSign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(fromPub) {
			signed = true
			k := priv
			return &k
		}
		return nil
	})
	if err != nil {
		return "", "", err
	}
	if !signed {
		return "", "", errors.New("serialized solana transaction does not require this wallet signer")
	}
	signedRaw, err := tx.MarshalBinary()
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(signedRaw), fromPub.String(), nil
}

func solanaSendInstructionAndConfirm(rpcURL, keystorePath string, req solanaInstructionRequest) (string, string, error) {
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, req.WalletID)
	if err != nil {
		return "", "", err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", errors.New("solana envelope public key mismatch")
	}
	programID, err := solana.PublicKeyFromBase58(strings.TrimSpace(req.ProgramID))
	if err != nil {
		return "", "", err
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.DataBase64))
	if err != nil {
		return "", "", err
	}
	accounts := make(solana.AccountMetaSlice, 0, len(req.Keys))
	for _, key := range req.Keys {
		pub, err := solana.PublicKeyFromBase58(strings.TrimSpace(key.Pubkey))
		if err != nil {
			return "", "", err
		}
		accounts = append(accounts, &solana.AccountMeta{
			PublicKey:  pub,
			IsSigner:   key.IsSigner,
			IsWritable: key.IsWritable,
		})
	}
	client := rpc.New(strings.TrimSpace(rpcURL))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	bh, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", "", err
	}
	ix := solana.NewInstruction(programID, accounts, data)
	tx, err := solana.NewTransaction(
		[]solana.Instruction{ix},
		bh.Value.Blockhash,
		solana.TransactionPayer(fromPub),
	)
	if err != nil {
		return "", "", err
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(fromPub) {
			k := priv
			return &k
		}
		return nil
	})
	if err != nil {
		return "", "", err
	}
	sig, err := client.SendTransactionWithOpts(ctx, tx, rpc.TransactionOpts{
		SkipPreflight:       false,
		PreflightCommitment: rpc.CommitmentConfirmed,
	})
	if err != nil {
		return "", "", err
	}
	confirmCtx, confirmCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer confirmCancel()
	tick := time.NewTicker(1500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-confirmCtx.Done():
			return sig.String(), fromPub.String(), fmt.Errorf("solana confirm timeout for %s", sig.String())
		case <-tick.C:
			st, err := client.GetSignatureStatuses(confirmCtx, true, sig)
			if err != nil {
				continue
			}
			if st == nil || st.Value == nil || len(st.Value) == 0 || st.Value[0] == nil {
				continue
			}
			if st.Value[0].Err != nil {
				return sig.String(), fromPub.String(), fmt.Errorf("solana tx failed: %v", st.Value[0].Err)
			}
			if st.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
				st.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
				return sig.String(), fromPub.String(), nil
			}
		}
	}
}

func randomPreparedID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("prepared-%d", time.Now().UnixNano())
	}
	return "prepared-" + hex.EncodeToString(b[:])
}

func handleHybridNative(req request, raw map[string]any, cfg signerConfig) ([]byte, error) {
	_ = raw
	switch req.Op {
	case "health":
		solanaKeystoreType, _ := detectKeystoreTypeAndSolanaPubkey(cfg.keystorePathFor("solana"))
		keystoreType := solanaKeystoreType
		if keystoreType == "" {
			keystoreType = "unknown"
		}
		res := map[string]any{
			"details":      "fased-signerd native ready",
			"readOnly":     cfg.readOnly,
			"keystoreType": keystoreType,
			"chains":       cfg.chains,
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "custodyStatus":
		b, _ := json.Marshal(map[string]any{"ok": true, "result": custodyStatusResult(req.WalletID)})
		return b, nil
	case "getAddresses":
		_, solPub := detectKeystoreTypeAndSolanaPubkey(cfg.keystorePathForWallet("solana", req.WalletID))
		if addr, _, err := loadSolanaAddressFromEnvelope(cfg.keystorePathForWallet("solana", req.WalletID), req.WalletID); err == nil && addr != "" {
			solPub = addr
		}
		res := map[string]any{}
		if cfg.chainAllowed("solana") && solPub != "" {
			res["solana"] = solPub
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "unlockCustody":
		if !custodySplitKeyActive() {
			return nil, errors.New("split-key custody is not active")
		}
		var body custodyUnlockRequest
		if err := json.Unmarshal(req.Request, &body); err != nil {
			return nil, errors.New("invalid signer request")
		}
		expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(body.ExpiresAt))
		if err != nil {
			return nil, errors.New("invalid signer request")
		}
		host := normalizeCustodyHost(body.Host)
		if host == "" {
			return nil, errors.New("invalid signer request")
		}
		body.Host = host
		setCustodyUnlock(body, expiresAt)
		b, _ := json.Marshal(map[string]any{"ok": true, "result": custodyStatusResult(body.WalletID)})
		return b, nil
	case "lockCustody":
		var body custodyLockRequest
		if len(req.Request) > 0 {
			if err := json.Unmarshal(req.Request, &body); err != nil {
				return nil, errors.New("invalid signer request")
			}
		}
		removed := clearCustodyUnlock(strings.TrimSpace(body.SessionID), strings.TrimSpace(body.Host), strings.TrimSpace(body.WalletID))
		active, _ := currentCustodyStatus(body.WalletID)
		res := map[string]any{
			"active":  active,
			"removed": removed,
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "getBalance":
		if err := cfg.ensureChainAllowed(req.Chain); err != nil {
			return nil, err
		}
		if req.Chain != "solana" {
			return nil, errors.New("unsupported hybrid native op")
		}
		addr, _, err := loadSolanaAddressFromEnvelope(cfg.keystorePathForWallet("solana", req.WalletID), req.WalletID)
		if err != nil && addr == "" {
			return nil, err
		}
		lamports, err := solanaRPCGetBalance(cfg.rpcURLForWallet("solana", req.WalletID), addr)
		if err != nil {
			return nil, err
		}
		res := map[string]any{
			"ok":      true,
			"chain":   "solana",
			"address": addr,
			"balance": strconv.FormatUint(lamports, 10),
			"unit":    "lamports",
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "prepareTx":
		var txReq signerTxRequest
		if err := json.Unmarshal(req.Request, &txReq); err != nil {
			return nil, errors.New("invalid signer request")
		}
		if txReq.Chain != "solana" {
			return nil, errors.New("unsupported chain")
		}
		if err := cfg.ensureChainAllowed(txReq.Chain); err != nil {
			return nil, err
		}
		if strings.TrimSpace(txReq.To) == "" {
			return nil, errors.New("missing recipient")
		}
		if _, err := parseLamports(txReq.Amount); err != nil {
			return nil, err
		}
		signer, _, _ := loadSolanaAddressFromEnvelope(cfg.keystorePathForWallet("solana", txReq.WalletID), txReq.WalletID)
		res := map[string]any{
			"ok":         true,
			"chain":      "solana",
			"preparedId": randomPreparedID(),
			"signer":     signer,
			"metadata": map[string]any{
				"mode": "native",
				"type": "native-transfer",
			},
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "sendTx":
		var txReq signerTxRequest
		if err := json.Unmarshal(req.Request, &txReq); err != nil {
			return nil, errors.New("invalid signer request")
		}
		if err := cfg.ensureChainAllowed(txReq.Chain); err != nil {
			return nil, err
		}
		usageAmount, err := validateCustodyScopeForSendTx(txReq)
		custodyActiveForWallet := custodySplitKeyActiveForWallet(txReq.WalletID)
		if custodyActiveForWallet && err != nil {
			return nil, err
		}
		if txReq.Chain != "solana" {
			return nil, errors.New("unsupported hybrid native op")
		}
		txHash, signer, err := solanaSendNativeTransferAndConfirm(cfg.rpcURLForWallet("solana", txReq.WalletID), cfg.keystorePathForWallet("solana", txReq.WalletID), txReq)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(txReq.WalletID, "solana", usageAmount)
		}
		res := map[string]any{
			"ok":     true,
			"chain":  "solana",
			"txHash": txHash,
			"signer": signer,
			"metadata": map[string]any{
				"mode": "native",
			},
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "signTx":
		var txReq signerTxRequest
		if err := json.Unmarshal(req.Request, &txReq); err != nil {
			return nil, errors.New("invalid signer request")
		}
		if err := cfg.ensureChainAllowed(txReq.Chain); err != nil {
			return nil, err
		}
		if txReq.Chain != "solana" || strings.TrimSpace(txReq.SerializedTxBase64) == "" {
			return nil, errors.New("signTx currently requires a serialized solana transaction")
		}
		usageAmount, err := validateCustodyScopeForSendTx(txReq)
		custodyActiveForWallet := custodySplitKeyActiveForWallet(txReq.WalletID)
		if custodyActiveForWallet && err != nil {
			return nil, err
		}
		signedTx, signer, err := solanaSignSerializedTransaction(cfg.keystorePathForWallet("solana", txReq.WalletID), txReq)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(txReq.WalletID, "solana", usageAmount)
		}
		res := map[string]any{
			"ok":             true,
			"chain":          "solana",
			"signedTxBase64": signedTx,
			"signer":         signer,
			"metadata": map[string]any{
				"mode": "native",
				"type": "serialized-sign-only",
			},
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	case "sendSolanaInstruction":
		if err := cfg.ensureChainAllowed("solana"); err != nil {
			return nil, err
		}
		var instructionReq solanaInstructionRequest
		if err := json.Unmarshal(req.Request, &instructionReq); err != nil {
			return nil, errors.New("invalid signer request")
		}
		usageAmount, err := validateCustodyScopeForSolanaInstruction(instructionReq)
		custodyActiveForWallet := custodySplitKeyActiveForWallet(instructionReq.WalletID)
		if custodyActiveForWallet && err != nil {
			return nil, err
		}
		txHash, signer, err := solanaSendInstructionAndConfirm(
			cfg.rpcURLForWallet("solana", instructionReq.WalletID),
			cfg.keystorePathForWallet("solana", instructionReq.WalletID),
			instructionReq,
		)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(instructionReq.WalletID, "solana", usageAmount)
		}
		res := map[string]any{
			"ok":     true,
			"chain":  "solana",
			"txHash": txHash,
			"signer": signer,
			"metadata": map[string]any{
				"mode": "native",
				"type": "program-instruction",
			},
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	default:
		return nil, errors.New("unsupported hybrid native op")
	}
}
