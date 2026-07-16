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

const (
	maxSolanaInstructionBatchSize = 6
	satCleanupPurpose             = "sat-cleanup"
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

type signerPolicyUsageState struct {
	mu     sync.Mutex
	bucket string
	solana map[string]*big.Int
}

var signerPolicyUsage = signerPolicyUsageState{
	solana: map[string]*big.Int{},
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
	socketPath                 string
	controlSocketPath          string
	socketMode                 uint32
	socketGroup                string
	pidFile                    string
	auditLog                   string
	stateDBPath                string
	masterKeyPath              string
	webauthnRPID               string
	webauthnOrigins            string
	readOnly                   bool
	rateWindow                 time.Duration
	rateLimit                  map[string]int
	auditMax                   int64
	dropUID                    int
	dropGID                    int
	backendMode                string
	chains                     []string
	keystorePath               string
	solanaKeystorePath         string
	solanaKeystorePaths        map[string]string
	rpcURL                     string
	solanaRPCURL               string
	solanaRPCURLs              map[string]string
	solanaWriteRPCFallbackURL  string
	solanaWriteRPCFallbackURLs map[string]string
	walletRoles                map[string]string
	walletDirectSigning        map[string]bool
	walletCapsEnabled          map[string]bool
	walletPolicyConfigErrors   map[string]string
	solanaAllowPrograms        map[string]map[string]bool
	solanaMaxPerTx             map[string]*big.Int
	solanaMaxDaily             map[string]*big.Int
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

func parseScopedStringEnv(name string) map[string]string {
	out := map[string]string{}
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		out["default"] = value
	}
	prefix := name + "__"
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		k := kv[:i]
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		value := strings.TrimSpace(kv[i+1:])
		if value == "" {
			continue
		}
		out[normalizeWalletID(strings.TrimPrefix(k, prefix))] = value
	}
	return out
}

func parseScopedBoolEnv(name string) (map[string]bool, map[string]string) {
	raw := parseScopedStringEnv(name)
	out := map[string]bool{}
	errorsByWallet := map[string]string{}
	for walletID, value := range raw {
		normalized := strings.TrimSpace(strings.ToLower(value))
		switch normalized {
		case "1", "true", "yes", "on":
			out[walletID] = true
		case "0", "false", "no", "off":
			out[walletID] = false
		default:
			errorsByWallet[walletID] = fmt.Sprintf("%s must be an explicit boolean", name)
		}
	}
	return out, errorsByWallet
}

func mergePolicyConfigErrors(target map[string]string, source map[string]string) {
	for walletID, message := range source {
		if existing := target[walletID]; existing != "" {
			target[walletID] = existing + "; " + message
		} else {
			target[walletID] = message
		}
	}
}

func parseScopedBigIntEnv(name string) map[string]*big.Int {
	raw := parseScopedStringEnv(name)
	out := map[string]*big.Int{}
	for walletID, value := range raw {
		parsed := parseCapBigInt(value)
		if parsed != nil {
			out[walletID] = parsed
		}
	}
	return out
}

func parseScopedProgramAllowlistEnv(name string) map[string]map[string]bool {
	raw := parseScopedStringEnv(name)
	out := map[string]map[string]bool{}
	for walletID, value := range raw {
		programs := map[string]bool{}
		for _, part := range strings.Split(value, ",") {
			program := normalizeProgramID(part)
			if program != "" {
				programs[program] = true
			}
		}
		if len(programs) > 0 {
			out[walletID] = programs
		}
	}
	return out
}

func mustValidate(req request, cfg signerConfig) error {
	switch req.Op {
	case "health", "v2.capabilities":
		if len(req.Request) > 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
	case "v2.webauthn.credentials.list":
		if len(req.Request) > 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
	case "v2.webauthn.registration.begin", "v2.webauthn.registration.finish":
		if len(req.Request) == 0 || req.Chain != "" || req.WalletID != "" {
			return errors.New("invalid signer request")
		}
	case "v2.review.authorization.begin", "v2.review.authorization.finish":
		if len(req.Request) == 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
	case "v2.policy.get", "v2.wallet.get", "v2.wallet.reencrypt":
		if len(req.Request) > 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
			return errors.New("invalid signer request")
		}
	case "v2.policy.put", "v2.wallet.create", "v2.wallet.import", "v2.wallet.importLegacy", "v2.execute", "v2.operation.get", "v2.operation.reconcile":
		if len(req.Request) == 0 || req.Chain != "" || strings.TrimSpace(req.WalletID) == "" {
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
	case "sendSolanaInstructions":
		if cfg.readOnly {
			return errors.New("read-only signer mode")
		}
		if len(req.Request) == 0 {
			return errors.New("invalid signer request")
		}
		var body solanaInstructionsRequest
		if err := json.Unmarshal(req.Request, &body); err != nil {
			return errors.New("invalid signer request")
		}
		if _, err := normalizeSolanaInstructionBatch(body); err != nil {
			return err
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
	socketModeRaw := firstNonEmpty(strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_SOCKET_MODE")), "0600")
	cfg := signerConfig{
		socketPath:        socketDefault,
		controlSocketPath: filepath.Join(stateRoot, "local-signer-control.sock"),
		socketMode:        0o600,
		socketGroup:       strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_SOCKET_GROUP")),
		pidFile:           "",
		auditLog:          "",
		stateDBPath: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_STATE_DB")),
			filepath.Join(stateRoot, "signerd-v2.db"),
		),
		masterKeyPath: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_MASTER_KEY")),
			filepath.Join(stateRoot, "signerd-v2.master.key"),
		),
		webauthnRPID:    strings.TrimSpace(os.Getenv("FASED_WALLET_WEBAUTHN_RP_ID")),
		webauthnOrigins: strings.TrimSpace(os.Getenv("FASED_WALLET_WEBAUTHN_ORIGINS")),
		readOnly:        os.Getenv("FASED_WALLET_LOCAL_SIGNER_READ_ONLY") == "1",
		rateWindow:      time.Duration(getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WINDOW_MS", 10_000)) * time.Millisecond,
		auditMax:        getenvInt64("FASED_WALLET_LOCAL_SIGNER_AUDIT_MAX_BYTES", 1_048_576),
		dropUID:         getenvInt("FASED_WALLET_LOCAL_SIGNER_DROP_UID", 0),
		dropGID:         getenvInt("FASED_WALLET_LOCAL_SIGNER_DROP_GID", 0),
		backendMode:     firstNonEmpty(strings.TrimSpace(os.Getenv("FASED_WALLET_LOCAL_SIGNER_BACKEND_MODE")), "native"),
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
		solanaWriteRPCFallbackURL: firstNonEmpty(
			strings.TrimSpace(os.Getenv("FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL")),
			strings.TrimSpace(os.Getenv("FASED_WALLET_SOLANA_RPC_FALLBACK_URL")),
		),
	}
	cfg.solanaKeystorePaths = parseWalletMapEnv("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
	cfg.solanaRPCURLs = parseWalletMapEnv("FASED_WALLET_SOLANA_RPC_URL__")
	cfg.solanaWriteRPCFallbackURLs = parseWalletMapEnv("FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL__")
	cfg.walletRoles = parseScopedStringEnv("FASED_WALLET_LOCAL_SIGNER_ROLE")
	cfg.walletPolicyConfigErrors = map[string]string{}
	var directSigningErrors map[string]string
	cfg.walletDirectSigning, directSigningErrors = parseScopedBoolEnv("FASED_WALLET_LOCAL_SIGNER_DIRECT_SIGNING")
	mergePolicyConfigErrors(cfg.walletPolicyConfigErrors, directSigningErrors)
	var capsEnabledErrors map[string]string
	cfg.walletCapsEnabled, capsEnabledErrors = parseScopedBoolEnv("FASED_WALLET_LOCAL_SIGNER_CAPS_ENABLED")
	mergePolicyConfigErrors(cfg.walletPolicyConfigErrors, capsEnabledErrors)
	cfg.solanaAllowPrograms = parseScopedProgramAllowlistEnv("FASED_WALLET_LOCAL_SIGNER_SOLANA_ALLOW_PROGRAMS")
	cfg.solanaMaxPerTx = parseScopedBigIntEnv("FASED_WALLET_LOCAL_SIGNER_SOLANA_MAX_PER_TX")
	cfg.solanaMaxDaily = parseScopedBigIntEnv("FASED_WALLET_LOCAL_SIGNER_SOLANA_MAX_DAILY")
	fs := flag.NewFlagSet(os.Args[0], flag.ExitOnError)
	fs.StringVar(&cfg.socketPath, "socket", cfg.socketPath, "unix socket path")
	fs.StringVar(&cfg.controlSocketPath, "control-socket", cfg.controlSocketPath, "administrative unix socket path")
	fs.StringVar(&cfg.stateDBPath, "state-db", cfg.stateDBPath, "signer-owned bbolt state database path")
	fs.StringVar(&cfg.masterKeyPath, "master-key", cfg.masterKeyPath, "signer-owned 0600 master key file path")
	fs.StringVar(&cfg.webauthnRPID, "webauthn-rp-id", cfg.webauthnRPID, "root-configured WebAuthn relying party ID")
	fs.StringVar(&cfg.webauthnOrigins, "webauthn-origins", cfg.webauthnOrigins, "comma-separated exact WebAuthn origin allowlist")
	fs.StringVar(&socketModeRaw, "socket-mode", socketModeRaw, "application socket mode (octal, default 0600)")
	fs.StringVar(&cfg.socketGroup, "socket-group", cfg.socketGroup, "private group allowed to use the application socket")
	fs.StringVar(&cfg.pidFile, "pid-file", "", "pid file path (default <socket>.pid)")
	fs.StringVar(&cfg.auditLog, "audit-log", "", "audit log path (default <socket>.audit.jsonl)")
	fs.BoolVar(&cfg.readOnly, "read-only", cfg.readOnly, "read-only mode (health/getAddresses/getBalance only)")
	fs.StringVar(&cfg.backendMode, "backend-mode", cfg.backendMode, "signer mode: native (hybrid accepted as alias)")
	_ = fs.Parse(os.Args[1:])
	mode, err := parseModeV2(socketModeRaw)
	if err != nil {
		fs.Usage()
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
		"v2.policy.get":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_POLICY", 120),
		"v2.policy.put":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_POLICY", 120),
		"v2.wallet.get":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 120),
		"v2.wallet.create":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.import":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.importLegacy":          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.wallet.reencrypt":             getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WALLET", 30),
		"v2.execute":                      getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_EXECUTE", 60),
		"v2.operation.get":                getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_OPERATION", 300),
		"v2.operation.reconcile":          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_OPERATION", 120),
		"v2.webauthn.registration.begin":  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 20),
		"v2.webauthn.registration.finish": getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 20),
		"v2.webauthn.credentials.list":    getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_WEBAUTHN_ADMIN", 60),
		"v2.review.authorization.begin":   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_REVIEW_AUTH", 60),
		"v2.review.authorization.finish":  getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_REVIEW_AUTH", 60),
		"custodyStatus":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_CUSTODYSTATUS", 300),
		"unlockCustody":                   getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_UNLOCKCUSTODY", 60),
		"lockCustody":                     getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_LOCKCUSTODY", 120),
		"getAddresses":                    getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_GETADDRESSES", 120),
		"getBalance":                      getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_GETBALANCE", 240),
		"prepareTx":                       getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_PREPARETX", 120),
		"signTx":                          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_SIGNTX", 60),
		"sendTx":                          getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_SENDTX", 40),
		"sendSolanaInstruction":           getenvInt("FASED_WALLET_LOCAL_SIGNER_RATE_SENDSOLANAINSTRUCTION", 80),
		"sendSolanaInstructions": getenvInt(
			"FASED_WALLET_LOCAL_SIGNER_RATE_SENDSOLANAINSTRUCTIONS",
			40,
		),
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

func (cfg signerConfig) solanaWriteRPCFallbackURLForWallet(walletID string) string {
	wid := normalizeWalletID(walletID)
	if u := strings.TrimSpace(cfg.solanaWriteRPCFallbackURLs[wid]); u != "" {
		return u
	}
	if wid != "default" {
		if u := strings.TrimSpace(cfg.solanaWriteRPCFallbackURLs["default"]); u != "" {
			return u
		}
	}
	if wid == "default" {
		if u := singleScopedValue(cfg.solanaWriteRPCFallbackURLs); u != "" {
			return u
		}
	}
	return strings.TrimSpace(cfg.solanaWriteRPCFallbackURL)
}

func (cfg signerConfig) solanaWriteRPCURLsForWallet(walletID string) []string {
	primary := strings.TrimSpace(cfg.rpcURLForWallet("solana", walletID))
	fallback := strings.TrimSpace(cfg.solanaWriteRPCFallbackURLForWallet(walletID))
	urls := make([]string, 0, 2)
	for _, candidate := range []string{primary, fallback} {
		if candidate == "" {
			continue
		}
		duplicate := false
		for _, existing := range urls {
			if existing == candidate {
				duplicate = true
				break
			}
		}
		if !duplicate {
			urls = append(urls, candidate)
		}
	}
	return urls
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
	if err := acquirePidLock(cfg.pidFile); err != nil {
		return err
	}
	defer os.Remove(cfg.pidFile)

	if cfg.backendMode == "hybrid" {
		cfg.backendMode = "native"
	}

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
	webauthnService, err := newSignerWebAuthnServiceV2(store, cfg.webauthnRPID, cfg.webauthnOrigins)
	if err != nil {
		return err
	}
	service := &signerServiceV2{store: store, keys: keys, webauthn: webauthnService}

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
	audit := &auditWriter{path: cfg.auditLog, maxBytes: cfg.auditMax}

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
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
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				if errors.Is(acceptErr, net.ErrClosed) {
					errCh <- nil
					return
				}
				continue
			}
			go handleConn(conn, cfg, limiter, audit, service, control)
		}
	}
	go serve(applicationListener, false)
	go serve(controlListener, true)
	return <-errCh
}

func handleConn(conn net.Conn, cfg signerConfig, limiter *rateLimiter, audit *auditWriter, service *signerServiceV2, control bool) {
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
			var resp []byte
			var err error
			if req.Op == "health" || strings.HasPrefix(req.Op, "v2.") {
				resp, err = service.handle(req, cfg, control)
			} else {
				resp, err = handleHybridNative(req, raw, cfg)
			}
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
	Chain                string   `json:"chain"`
	WalletID             string   `json:"walletId,omitempty"`
	To                   string   `json:"to,omitempty"`
	Amount               string   `json:"amount,omitempty"`
	Contract             string   `json:"contract,omitempty"`
	Program              string   `json:"program,omitempty"`
	TokenMint            string   `json:"tokenMint,omitempty"`
	Source               string   `json:"source,omitempty"`
	Destination          string   `json:"destination,omitempty"`
	AllowSPLInstructions []string `json:"allowSplInstructions,omitempty"`
	Memo                 string   `json:"memo,omitempty"`
	SerializedTxBase64   string   `json:"serializedTxBase64,omitempty"`
	PreparedID           string   `json:"preparedId,omitempty"`
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

type solanaInstructionsRequest struct {
	WalletID     string                     `json:"walletId,omitempty"`
	Purpose      string                     `json:"purpose"`
	Instructions []solanaInstructionRequest `json:"instructions"`
}

type signerTxRequestEnvelope struct {
	Request signerTxRequest `json:"request"`
}

func isSatCleanupInstructionData(dataBase64 string) bool {
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataBase64))
	if err != nil || len(data) == 0 {
		return false
	}
	switch data[0] {
	case 69, 70, 71:
		return true
	default:
		return false
	}
}

func normalizeSolanaInstructionBatch(req solanaInstructionsRequest) ([]solanaInstructionRequest, error) {
	if strings.TrimSpace(req.Purpose) != satCleanupPurpose {
		return nil, errors.New("unsupported solana instruction batch purpose")
	}
	if len(req.Instructions) == 0 || len(req.Instructions) > maxSolanaInstructionBatchSize {
		return nil, errors.New("invalid solana instruction batch size")
	}
	walletID := strings.TrimSpace(req.WalletID)
	out := make([]solanaInstructionRequest, 0, len(req.Instructions))
	for _, inst := range req.Instructions {
		if strings.TrimSpace(inst.WalletID) != "" && walletID != "" && strings.TrimSpace(inst.WalletID) != walletID {
			return nil, errors.New("mixed wallet ids in solana instruction batch")
		}
		if walletID == "" {
			walletID = strings.TrimSpace(inst.WalletID)
		}
		inst.WalletID = walletID
		if strings.TrimSpace(inst.ProgramID) == "" || strings.TrimSpace(inst.DataBase64) == "" || len(inst.Keys) == 0 {
			return nil, errors.New("invalid solana instruction in batch")
		}
		if !isSatCleanupInstructionData(inst.DataBase64) {
			return nil, errors.New("solana instruction batch only supports SAT cleanup instructions")
		}
		out = append(out, inst)
	}
	return out, nil
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

func validateCustodyScopeForSolanaInstructions(requests []solanaInstructionRequest) (*big.Int, error) {
	if len(requests) == 0 {
		return nil, errors.New("invalid solana instruction batch")
	}
	activeCustodyUnlock.mu.Lock()
	defer activeCustodyUnlock.mu.Unlock()
	cleanupExpiredCustodyUnlocksLocked(time.Now())
	walletID := normalizeWalletID(requests[0].WalletID)
	entry := activeCustodyUnlock.sessions[walletID]
	if entry == nil || entry.ExpiresAt.IsZero() || !entry.ExpiresAt.After(time.Now()) || len(entry.Passphrase) == 0 {
		return nil, errors.New("custody unlock required")
	}
	if len(entry.Scope.Chains) > 0 && !entry.Scope.Chains["solana"] {
		return nil, fmt.Errorf("custody chain solana not allowed for wallet %s", entry.WalletID)
	}
	total := big.NewInt(0)
	for _, req := range requests {
		if normalizeWalletID(req.WalletID) != walletID {
			return nil, errors.New("mixed wallet ids in solana instruction batch")
		}
		programID := normalizeProgramID(req.ProgramID)
		if len(entry.Scope.AllowPrograms) == 0 || !entry.Scope.AllowPrograms[programID] {
			return nil, fmt.Errorf("custody program %s not allowed for wallet %s", strings.TrimSpace(req.ProgramID), entry.WalletID)
		}
		amount := extractSolanaInstructionAmount(req)
		if amount != nil {
			total = new(big.Int).Add(total, amount)
		}
	}
	if total.Sign() == 0 {
		return nil, nil
	}
	if entry.Scope.SOLMaxPerTx != nil && entry.Scope.SOLMaxPerTx.Sign() > 0 && total.Cmp(entry.Scope.SOLMaxPerTx) > 0 {
		return nil, errors.New("custody solana per-tx cap exceeded")
	}
	if entry.Scope.SOLMaxDaily != nil && entry.Scope.SOLMaxDaily.Sign() > 0 {
		next := new(big.Int).Add(entry.SOLSpentDaily, total)
		if next.Cmp(entry.Scope.SOLMaxDaily) > 0 {
			return nil, errors.New("custody solana daily cap exceeded")
		}
	}
	return total, nil
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

type resolvedSignerPolicy struct {
	WalletID                string
	Role                    string
	RoleConfigured          bool
	DirectSigning           bool
	DirectSigningConfigured bool
	CapsEnabled             bool
	CapsConfigured          bool
	ConfigError             string
	AllowPrograms           map[string]bool
	SolanaMaxPerTx          *big.Int
	SolanaMaxDaily          *big.Int
}

func normalizeSignerRole(raw string) string {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "agent":
		return "agent"
	case "mining":
		return "mining"
	case "vault":
		return "vault"
	default:
		return ""
	}
}

func hasStringPolicy(values map[string]string, walletID string) bool {
	wid := normalizeWalletID(walletID)
	if value, ok := values[wid]; ok && strings.TrimSpace(value) != "" {
		return true
	}
	value, ok := values["default"]
	return ok && strings.TrimSpace(value) != ""
}

func hasBoolPolicy(values map[string]bool, walletID string) bool {
	wid := normalizeWalletID(walletID)
	if _, ok := values[wid]; ok {
		return true
	}
	_, ok := values["default"]
	return ok
}

func lookupStringPolicy(values map[string]string, walletID string, fallback string) string {
	wid := normalizeWalletID(walletID)
	if value, ok := values[wid]; ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	if value, ok := values["default"]; ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func lookupBoolPolicy(values map[string]bool, walletID string, fallback bool) bool {
	wid := normalizeWalletID(walletID)
	if value, ok := values[wid]; ok {
		return value
	}
	if value, ok := values["default"]; ok {
		return value
	}
	return fallback
}

func lookupBigIntPolicy(values map[string]*big.Int, walletID string) *big.Int {
	wid := normalizeWalletID(walletID)
	if value := values[wid]; value != nil {
		return cloneBigInt(value)
	}
	if value := values["default"]; value != nil {
		return cloneBigInt(value)
	}
	return nil
}

func lookupProgramPolicy(values map[string]map[string]bool, walletID string) map[string]bool {
	wid := normalizeWalletID(walletID)
	if value := values[wid]; len(value) > 0 {
		return value
	}
	if value := values["default"]; len(value) > 0 {
		return value
	}
	return nil
}

func lookupPolicyConfigError(values map[string]string, walletID string) string {
	wid := normalizeWalletID(walletID)
	if value := strings.TrimSpace(values[wid]); value != "" {
		return value
	}
	return strings.TrimSpace(values["default"])
}

func resolveSignerPolicy(cfg signerConfig, walletID string) resolvedSignerPolicy {
	return resolvedSignerPolicy{
		WalletID:                normalizeWalletID(walletID),
		Role:                    normalizeSignerRole(lookupStringPolicy(cfg.walletRoles, walletID, "")),
		RoleConfigured:          hasStringPolicy(cfg.walletRoles, walletID),
		DirectSigning:           lookupBoolPolicy(cfg.walletDirectSigning, walletID, false),
		DirectSigningConfigured: hasBoolPolicy(cfg.walletDirectSigning, walletID),
		CapsEnabled:             lookupBoolPolicy(cfg.walletCapsEnabled, walletID, false),
		CapsConfigured:          hasBoolPolicy(cfg.walletCapsEnabled, walletID),
		ConfigError:             lookupPolicyConfigError(cfg.walletPolicyConfigErrors, walletID),
		AllowPrograms:           lookupProgramPolicy(cfg.solanaAllowPrograms, walletID),
		SolanaMaxPerTx:          lookupBigIntPolicy(cfg.solanaMaxPerTx, walletID),
		SolanaMaxDaily:          lookupBigIntPolicy(cfg.solanaMaxDaily, walletID),
	}
}

func validateSignerPolicyConfigured(policy resolvedSignerPolicy) error {
	if policy.ConfigError != "" {
		return fmt.Errorf("signer policy configuration is invalid for wallet %s: %s", policy.WalletID, policy.ConfigError)
	}
	if !policy.RoleConfigured || policy.Role == "" {
		return fmt.Errorf("signer policy role is not configured for wallet %s", policy.WalletID)
	}
	if !policy.DirectSigningConfigured {
		return fmt.Errorf("signer policy direct-signing setting is not configured for wallet %s", policy.WalletID)
	}
	if !policy.CapsConfigured {
		return fmt.Errorf("signer policy caps setting is not configured for wallet %s", policy.WalletID)
	}
	if policy.CapsEnabled {
		if policy.SolanaMaxPerTx == nil || policy.SolanaMaxPerTx.Sign() <= 0 {
			return fmt.Errorf("signer policy solana per-tx cap is not configured for wallet %s", policy.WalletID)
		}
		if policy.SolanaMaxDaily == nil || policy.SolanaMaxDaily.Sign() <= 0 {
			return fmt.Errorf("signer policy solana daily cap is not configured for wallet %s", policy.WalletID)
		}
	}
	return nil
}

func parsePolicyAmount(raw string, required bool) (*big.Int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		if required {
			return nil, errors.New("signer policy amount required")
		}
		return nil, nil
	}
	value, ok := new(big.Int).SetString(trimmed, 10)
	if !ok || value.Sign() < 0 {
		return nil, errors.New("invalid signer policy amount")
	}
	return value, nil
}

func recordSignerPolicyUsage(policy resolvedSignerPolicy, chain string, amount *big.Int) {
	if !policy.CapsEnabled || amount == nil || amount.Sign() <= 0 || normalizeChainName(chain) != "solana" {
		return
	}
	signerPolicyUsage.mu.Lock()
	defer signerPolicyUsage.mu.Unlock()
	bucket := currentDayBucket(time.Now())
	if signerPolicyUsage.bucket != bucket {
		signerPolicyUsage.bucket = bucket
		signerPolicyUsage.solana = map[string]*big.Int{}
	}
	current := signerPolicyUsage.solana[policy.WalletID]
	if current == nil {
		current = big.NewInt(0)
	}
	signerPolicyUsage.solana[policy.WalletID] = new(big.Int).Add(current, amount)
}

func validateSignerPolicyAmount(policy resolvedSignerPolicy, chain string, amount *big.Int) error {
	if !policy.CapsEnabled || amount == nil || amount.Sign() <= 0 || normalizeChainName(chain) != "solana" {
		return nil
	}
	if policy.SolanaMaxPerTx != nil && policy.SolanaMaxPerTx.Sign() > 0 && amount.Cmp(policy.SolanaMaxPerTx) > 0 {
		return errors.New("signer policy solana per-tx cap exceeded")
	}
	if policy.SolanaMaxDaily != nil && policy.SolanaMaxDaily.Sign() > 0 {
		signerPolicyUsage.mu.Lock()
		defer signerPolicyUsage.mu.Unlock()
		bucket := currentDayBucket(time.Now())
		if signerPolicyUsage.bucket != bucket {
			signerPolicyUsage.bucket = bucket
			signerPolicyUsage.solana = map[string]*big.Int{}
		}
		current := signerPolicyUsage.solana[policy.WalletID]
		if current == nil {
			current = big.NewInt(0)
		}
		next := new(big.Int).Add(current, amount)
		if next.Cmp(policy.SolanaMaxDaily) > 0 {
			return errors.New("signer policy solana daily cap exceeded")
		}
	}
	return nil
}

func validateSignerPolicyProgram(policy resolvedSignerPolicy, programID string) error {
	if len(policy.AllowPrograms) == 0 {
		return fmt.Errorf("signer policy program allowlist is not configured for wallet %s", policy.WalletID)
	}
	normalized := normalizeProgramID(programID)
	if normalized == "" || !policy.AllowPrograms[normalized] {
		return fmt.Errorf("signer policy program %s not allowed for wallet %s", strings.TrimSpace(programID), policy.WalletID)
	}
	return nil
}

func normalizeSolanaPublicKey(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	key, err := solana.PublicKeyFromBase58(trimmed)
	if err != nil {
		return "", err
	}
	return key.String(), nil
}

func expectedSerializedTokenMint(txReq signerTxRequest) (string, error) {
	for _, raw := range []string{txReq.TokenMint, txReq.Contract} {
		key, err := normalizeSolanaPublicKey(raw)
		if err != nil {
			return "", fmt.Errorf("invalid expected token mint: %w", err)
		}
		if key != "" {
			return key, nil
		}
	}
	return "", nil
}

func expectedSerializedSource(txReq signerTxRequest) (string, error) {
	key, err := normalizeSolanaPublicKey(txReq.Source)
	if err != nil {
		return "", fmt.Errorf("invalid expected source account: %w", err)
	}
	return key, nil
}

func expectedSerializedDestination(txReq signerTxRequest) (string, error) {
	key, err := normalizeSolanaPublicKey(txReq.Destination)
	if err != nil {
		return "", fmt.Errorf("invalid expected destination account: %w", err)
	}
	return key, nil
}

func isSPLTokenProgram(programID string) bool {
	normalized := normalizeProgramID(programID)
	return normalized == normalizeProgramID(solana.TokenProgramID.String()) ||
		normalized == normalizeProgramID(solana.Token2022ProgramID.String())
}

func allowSerializedSPLInstruction(txReq signerTxRequest, name string) bool {
	needle := strings.TrimSpace(strings.ToLower(name))
	if needle == "" {
		return false
	}
	for _, value := range txReq.AllowSPLInstructions {
		if strings.TrimSpace(strings.ToLower(value)) == needle {
			return true
		}
	}
	return false
}

func riskySPLInstructionName(kind byte) string {
	switch kind {
	case 4:
		return "Approve"
	case 6:
		return "SetAuthority"
	case 7:
		return "MintTo"
	case 8:
		return "Burn"
	case 10:
		return "FreezeAccount"
	case 11:
		return "ThawAccount"
	case 13:
		return "ApproveChecked"
	case 14:
		return "MintToChecked"
	case 15:
		return "BurnChecked"
	default:
		return ""
	}
}

func accountKeyAt(accounts []*solana.AccountMeta, index int) string {
	if index < 0 || index >= len(accounts) || accounts[index] == nil {
		return ""
	}
	return accounts[index].PublicKey.String()
}

func instructionHasSigner(accounts []*solana.AccountMeta, signer string) bool {
	for _, account := range accounts {
		if account != nil && account.IsSigner && account.PublicKey.String() == signer {
			return true
		}
	}
	return false
}

func decodeSPLAmount(data []byte) (*big.Int, error) {
	if len(data) < 9 {
		return nil, errors.New("SPL transfer instruction data is too short")
	}
	return new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[1:9])), nil
}

func addAmount(total *big.Int, amount *big.Int) *big.Int {
	if total == nil {
		total = big.NewInt(0)
	}
	if amount == nil {
		return total
	}
	return new(big.Int).Add(total, amount)
}

func validateAgentSerializedSPLSemantics(txReq signerTxRequest, tx *solana.Transaction, signer string, declaredAmount *big.Int) error {
	expectedMint, err := expectedSerializedTokenMint(txReq)
	if err != nil {
		return err
	}
	expectedSource, err := expectedSerializedSource(txReq)
	if err != nil {
		return err
	}
	expectedDestination, err := expectedSerializedDestination(txReq)
	if err != nil {
		return err
	}

	var checkedTotal *big.Int
	sawSignerSPLTransfer := false
	for _, inst := range tx.Message.Instructions {
		programID, err := tx.ResolveProgramIDIndex(inst.ProgramIDIndex)
		if err != nil {
			return fmt.Errorf("cannot resolve serialized solana program id: %w", err)
		}
		if !isSPLTokenProgram(programID.String()) {
			continue
		}
		accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
		if err != nil {
			return fmt.Errorf("cannot resolve serialized SPL instruction accounts: %w", err)
		}
		data := []byte(inst.Data)
		if len(data) == 0 {
			return errors.New("serialized SPL instruction has no data")
		}
		kind := data[0]
		switch kind {
		case 3: // Transfer: source, destination, owner; mint is not encoded.
			if len(accounts) < 3 {
				return errors.New("serialized SPL transfer has too few accounts")
			}
			authority := accountKeyAt(accounts, 2)
			if authority != signer {
				if instructionHasSigner(accounts, signer) {
					return errors.New("serialized SPL transfer authority does not match wallet signer")
				}
				continue
			}
			sawSignerSPLTransfer = true
			if expectedMint != "" && !allowSerializedSPLInstruction(txReq, "Transfer") {
				return errors.New("serialized Agent SPL transfer must use transferChecked when tokenMint is declared")
			}
			amount, err := decodeSPLAmount(data)
			if err != nil {
				return err
			}
			if expectedSource != "" && accountKeyAt(accounts, 0) != expectedSource {
				return errors.New("serialized SPL transfer source does not match expected source")
			}
			if expectedDestination != "" && accountKeyAt(accounts, 1) != expectedDestination {
				return errors.New("serialized SPL transfer destination does not match expected destination")
			}
			if expectedMint == "" || allowSerializedSPLInstruction(txReq, "Transfer") {
				checkedTotal = addAmount(checkedTotal, amount)
			}
		case 12: // TransferChecked: source, mint, destination, owner.
			if len(accounts) < 4 {
				return errors.New("serialized SPL transferChecked has too few accounts")
			}
			authority := accountKeyAt(accounts, 3)
			if authority != signer {
				if instructionHasSigner(accounts, signer) {
					return errors.New("serialized SPL transferChecked authority does not match wallet signer")
				}
				continue
			}
			amount, err := decodeSPLAmount(data)
			if err != nil {
				return err
			}
			sawSignerSPLTransfer = true
			mint := accountKeyAt(accounts, 1)
			if expectedMint != "" && mint != expectedMint {
				return errors.New("serialized SPL transferChecked mint does not match expected tokenMint")
			}
			if expectedSource != "" && accountKeyAt(accounts, 0) != expectedSource {
				return errors.New("serialized SPL transferChecked source does not match expected source")
			}
			if expectedDestination != "" && accountKeyAt(accounts, 2) != expectedDestination {
				return errors.New("serialized SPL transferChecked destination does not match expected destination")
			}
			if expectedMint == "" || mint == expectedMint {
				checkedTotal = addAmount(checkedTotal, amount)
			}
		default:
			name := riskySPLInstructionName(kind)
			if name != "" && instructionHasSigner(accounts, signer) && !allowSerializedSPLInstruction(txReq, name) {
				return fmt.Errorf("serialized Agent transaction contains risky SPL instruction %s", name)
			}
		}
	}
	if sawSignerSPLTransfer && declaredAmount == nil {
		return errors.New("serialized Agent SPL transfer requires declared amount")
	}
	if checkedTotal != nil && declaredAmount != nil && checkedTotal.Cmp(declaredAmount) != 0 {
		return errors.New("serialized SPL transferChecked amount does not match declared amount")
	}
	return nil
}

func validateSignerPolicyForNativeSend(cfg signerConfig, txReq signerTxRequest) (*big.Int, resolvedSignerPolicy, error) {
	policy := resolveSignerPolicy(cfg, txReq.WalletID)
	if err := validateSignerPolicyConfigured(policy); err != nil {
		return nil, policy, err
	}
	if !policy.DirectSigning {
		return nil, policy, errors.New("signer policy direct signing disabled")
	}
	if policy.Role == "mining" {
		return nil, policy, errors.New("mining wallet cannot use generic native transfer signer path")
	}
	amount, err := parsePolicyAmount(txReq.Amount, policy.CapsEnabled)
	if err != nil {
		return nil, policy, err
	}
	if err := validateSignerPolicyAmount(policy, txReq.Chain, amount); err != nil {
		return nil, policy, err
	}
	return amount, policy, nil
}

func validateSignerPolicyForProgramSend(cfg signerConfig, walletID string, programID string, amount *big.Int) (resolvedSignerPolicy, error) {
	policy := resolveSignerPolicy(cfg, walletID)
	if err := validateSignerPolicyConfigured(policy); err != nil {
		return policy, err
	}
	if !policy.DirectSigning {
		return policy, errors.New("signer policy direct signing disabled")
	}
	if err := validateSignerPolicyProgram(policy, programID); err != nil {
		return policy, err
	}
	if err := validateSignerPolicyAmount(policy, "solana", amount); err != nil {
		return policy, err
	}
	return policy, nil
}

func validateSignerPolicyForProgramBatchSend(cfg signerConfig, walletID string, requests []solanaInstructionRequest, amount *big.Int) (resolvedSignerPolicy, error) {
	policy := resolveSignerPolicy(cfg, walletID)
	if err := validateSignerPolicyConfigured(policy); err != nil {
		return policy, err
	}
	if !policy.DirectSigning {
		return policy, errors.New("signer policy direct signing disabled")
	}
	for _, req := range requests {
		if err := validateSignerPolicyProgram(policy, req.ProgramID); err != nil {
			return policy, err
		}
	}
	if err := validateSignerPolicyAmount(policy, "solana", amount); err != nil {
		return policy, err
	}
	return policy, nil
}

func validateSignerPolicyForSerializedTx(cfg signerConfig, txReq signerTxRequest, tx *solana.Transaction, signer string) (*big.Int, resolvedSignerPolicy, error) {
	policy := resolveSignerPolicy(cfg, txReq.WalletID)
	if err := validateSignerPolicyConfigured(policy); err != nil {
		return nil, policy, err
	}
	if !policy.DirectSigning {
		return nil, policy, errors.New("signer policy direct signing disabled")
	}
	if len(policy.AllowPrograms) == 0 {
		return nil, policy, fmt.Errorf("signer policy program allowlist is not configured for wallet %s", policy.WalletID)
	}
	requiredSigner := false
	for _, signerKey := range tx.Message.Signers() {
		if signerKey.String() == signer {
			requiredSigner = true
			break
		}
	}
	if !requiredSigner {
		return nil, policy, errors.New("serialized solana transaction does not require this wallet signer")
	}
	for _, inst := range tx.Message.Instructions {
		programID, err := tx.ResolveProgramIDIndex(inst.ProgramIDIndex)
		if err != nil {
			return nil, policy, fmt.Errorf("cannot resolve serialized solana program id: %w", err)
		}
		if err := validateSignerPolicyProgram(policy, programID.String()); err != nil {
			return nil, policy, err
		}
	}
	amount, err := parsePolicyAmount(txReq.Amount, policy.CapsEnabled)
	if err != nil {
		return nil, policy, err
	}
	if policy.Role == "agent" {
		if err := validateAgentSerializedSPLSemantics(txReq, tx, signer, amount); err != nil {
			return nil, policy, err
		}
	}
	if err := validateSignerPolicyAmount(policy, txReq.Chain, amount); err != nil {
		return nil, policy, err
	}
	return amount, policy, nil
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
	for _, rpcURL := range rpcURLs {
		trimmed := strings.TrimSpace(rpcURL)
		if trimmed == "" {
			continue
		}
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
	if len(rpcURLs) == 0 {
		return nil, errors.New("missing Solana write RPC URL")
	}
	return nil, fmt.Errorf(
		"all Solana write RPC endpoints are in circuit cooldown; retry in %s",
		shortestBackoff.Round(time.Second),
	)
}

func solanaLatestBlockhashWithFallback(rpcURLs []string) (solana.Hash, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return solana.Hash{}, err
	}
	var failures []string
	for index, rpcURL := range active {
		client := rpc.New(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
		cancel()
		if requestErr == nil {
			markSolanaWriteRPCSuccess(rpcURL)
			return result.Value.Blockhash, nil
		}
		markSolanaWriteRPCFailure(rpcURL, requestErr)
		failures = append(failures, fmt.Sprintf("endpoint %d: %v", index+1, requestErr))
	}
	return solana.Hash{}, fmt.Errorf("Solana latest-blockhash failed: %s", strings.Join(failures, "; "))
}

func confirmSolanaSignatureAcrossRPCs(rpcURLs []string, signature solana.Signature) error {
	confirmCtx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCConfirmTimeout())
	defer cancel()
	tick := time.NewTicker(750 * time.Millisecond)
	defer tick.Stop()
	for {
		active, activeErr := activeSolanaWriteRPCURLs(rpcURLs)
		if activeErr == nil {
			for _, rpcURL := range active {
				client := rpc.New(rpcURL)
				requestCtx, requestCancel := context.WithTimeout(confirmCtx, solanaWriteRPCRequestTimeout())
				status, err := client.GetSignatureStatuses(requestCtx, true, signature)
				requestCancel()
				if err != nil {
					markSolanaWriteRPCFailure(rpcURL, err)
					continue
				}
				markSolanaWriteRPCSuccess(rpcURL)
				if status == nil || status.Value == nil || len(status.Value) == 0 || status.Value[0] == nil {
					continue
				}
				if status.Value[0].Err != nil {
					return fmt.Errorf("Solana transaction failed: %v", status.Value[0].Err)
				}
				if status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
					status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
					return nil
				}
			}
		}
		select {
		case <-confirmCtx.Done():
			return fmt.Errorf("Solana confirmation timeout for %s", signature.String())
		case <-tick.C:
		}
	}
}

func sendRawSolanaTransactionAndConfirm(rpcURLs []string, signedRaw []byte) (string, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return "", err
	}
	var signature *solana.Signature
	var failures []string
	for index, rpcURL := range active {
		client := rpc.New(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		sentSignature, requestErr := client.SendRawTransactionWithOpts(ctx, signedRaw, rpc.TransactionOpts{
			SkipPreflight:       false,
			PreflightCommitment: rpc.CommitmentConfirmed,
		})
		cancel()
		if requestErr != nil {
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			failures = append(failures, fmt.Sprintf("endpoint %d: %v", index+1, requestErr))
			continue
		}
		markSolanaWriteRPCSuccess(rpcURL)
		if signature == nil {
			signature = &sentSignature
		} else if *signature != sentSignature {
			return "", errors.New("Solana RPC endpoints returned different signatures for identical transaction bytes")
		}
	}
	if signature == nil {
		return "", fmt.Errorf("Solana transaction broadcast failed: %s", strings.Join(failures, "; "))
	}
	if err := confirmSolanaSignatureAcrossRPCs(rpcURLs, *signature); err != nil {
		return signature.String(), err
	}
	return signature.String(), nil
}

func sendSignedSolanaTransactionAndConfirm(rpcURLs []string, tx *solana.Transaction) (string, error) {
	signedRaw, err := tx.MarshalBinary()
	if err != nil {
		return "", err
	}
	return sendRawSolanaTransactionAndConfirm(rpcURLs, signedRaw)
}

func solanaSendNativeTransferAndConfirm(rpcURLs []string, keystorePath string, txReq signerTxRequest, cfg signerConfig) (string, string, *big.Int, resolvedSignerPolicy, error) {
	if txReq.Chain != "solana" {
		return "", "", nil, resolvedSignerPolicy{}, errors.New("invalid chain for native solana send")
	}
	if strings.TrimSpace(txReq.SerializedTxBase64) != "" {
		return solanaSendSerializedTransactionAndConfirm(rpcURLs, keystorePath, txReq, cfg)
	}
	usageAmount, policy, err := validateSignerPolicyForNativeSend(cfg, txReq)
	if err != nil {
		return "", "", nil, policy, err
	}
	if strings.TrimSpace(txReq.To) == "" {
		return "", "", nil, policy, errors.New("missing recipient")
	}
	lamports, err := parseLamports(txReq.Amount)
	if err != nil {
		return "", "", nil, policy, err
	}
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, txReq.WalletID)
	if err != nil {
		return "", "", nil, policy, err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", nil, policy, errors.New("solana envelope public key mismatch")
	}
	toPub, err := solana.PublicKeyFromBase58(strings.TrimSpace(txReq.To))
	if err != nil {
		return "", "", nil, policy, err
	}
	blockhash, err := solanaLatestBlockhashWithFallback(rpcURLs)
	if err != nil {
		return "", "", nil, policy, err
	}
	ix := system.NewTransferInstruction(lamports, fromPub, toPub).Build()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{ix},
		blockhash,
		solana.TransactionPayer(fromPub),
	)
	if err != nil {
		return "", "", nil, policy, err
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(fromPub) {
			k := priv
			return &k
		}
		return nil
	})
	if err != nil {
		return "", "", nil, policy, err
	}
	sig, err := sendSignedSolanaTransactionAndConfirm(rpcURLs, tx)
	if err != nil {
		return sig, fromPub.String(), usageAmount, policy, err
	}
	return sig, fromPub.String(), usageAmount, policy, nil
}

func solanaSendSerializedTransactionAndConfirm(rpcURLs []string, keystorePath string, txReq signerTxRequest, cfg signerConfig) (string, string, *big.Int, resolvedSignerPolicy, error) {
	signedTxBase64, signer, usageAmount, policy, err := solanaSignSerializedTransaction(keystorePath, txReq, cfg)
	if err != nil {
		return "", signer, nil, policy, err
	}
	signedRaw, err := base64.StdEncoding.DecodeString(signedTxBase64)
	if err != nil {
		return "", signer, nil, policy, err
	}
	sig, err := sendRawSolanaTransactionAndConfirm(rpcURLs, signedRaw)
	if err != nil {
		return sig, signer, usageAmount, policy, err
	}
	return sig, signer, usageAmount, policy, nil
}

func solanaSignSerializedTransaction(keystorePath string, txReq signerTxRequest, cfg signerConfig) (string, string, *big.Int, resolvedSignerPolicy, error) {
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, txReq.WalletID)
	if err != nil {
		return "", "", nil, resolvedSignerPolicy{}, err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", nil, resolvedSignerPolicy{}, errors.New("solana envelope public key mismatch")
	}
	rawTx, err := base64.StdEncoding.DecodeString(strings.TrimSpace(txReq.SerializedTxBase64))
	if err != nil {
		return "", "", nil, resolvedSignerPolicy{}, err
	}
	tx, err := solana.TransactionFromDecoder(bin.NewBinDecoder(rawTx))
	if err != nil {
		return "", "", nil, resolvedSignerPolicy{}, err
	}
	usageAmount, policy, err := validateSignerPolicyForSerializedTx(cfg, txReq, tx, fromPub.String())
	if err != nil {
		return "", "", nil, policy, err
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
		return "", "", nil, policy, err
	}
	if !signed {
		return "", "", nil, policy, errors.New("serialized solana transaction does not require this wallet signer")
	}
	signedRaw, err := tx.MarshalBinary()
	if err != nil {
		return "", "", nil, policy, err
	}
	return base64.StdEncoding.EncodeToString(signedRaw), fromPub.String(), usageAmount, policy, nil
}

func buildSolanaInstruction(req solanaInstructionRequest) (solana.Instruction, error) {
	programID, err := solana.PublicKeyFromBase58(strings.TrimSpace(req.ProgramID))
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.DataBase64))
	if err != nil {
		return nil, err
	}
	accounts := make(solana.AccountMetaSlice, 0, len(req.Keys))
	for _, key := range req.Keys {
		pub, err := solana.PublicKeyFromBase58(strings.TrimSpace(key.Pubkey))
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, &solana.AccountMeta{
			PublicKey:  pub,
			IsSigner:   key.IsSigner,
			IsWritable: key.IsWritable,
		})
	}
	return solana.NewInstruction(programID, accounts, data), nil
}

func solanaSendInstructionAndConfirm(rpcURLs []string, keystorePath string, req solanaInstructionRequest, cfg signerConfig) (string, string, *big.Int, resolvedSignerPolicy, error) {
	usageAmount := extractSolanaInstructionAmount(req)
	policy, err := validateSignerPolicyForProgramSend(cfg, req.WalletID, req.ProgramID, usageAmount)
	if err != nil {
		return "", "", nil, policy, err
	}
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, req.WalletID)
	if err != nil {
		return "", "", nil, policy, err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", nil, policy, errors.New("solana envelope public key mismatch")
	}
	ix, err := buildSolanaInstruction(req)
	if err != nil {
		return "", "", nil, policy, err
	}
	blockhash, err := solanaLatestBlockhashWithFallback(rpcURLs)
	if err != nil {
		return "", "", nil, policy, err
	}
	tx, err := solana.NewTransaction(
		[]solana.Instruction{ix},
		blockhash,
		solana.TransactionPayer(fromPub),
	)
	if err != nil {
		return "", "", nil, policy, err
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(fromPub) {
			k := priv
			return &k
		}
		return nil
	})
	if err != nil {
		return "", "", nil, policy, err
	}
	sig, err := sendSignedSolanaTransactionAndConfirm(rpcURLs, tx)
	if err != nil {
		return sig, fromPub.String(), usageAmount, policy, err
	}
	return sig, fromPub.String(), usageAmount, policy, nil
}

func solanaSendInstructionsAndConfirm(rpcURLs []string, keystorePath string, requests []solanaInstructionRequest, cfg signerConfig) (string, string, *big.Int, resolvedSignerPolicy, error) {
	if len(requests) == 0 {
		return "", "", nil, resolvedSignerPolicy{}, errors.New("invalid solana instruction batch")
	}
	usageAmount := big.NewInt(0)
	for _, req := range requests {
		if amount := extractSolanaInstructionAmount(req); amount != nil {
			usageAmount = new(big.Int).Add(usageAmount, amount)
		}
	}
	if usageAmount.Sign() == 0 {
		usageAmount = nil
	}
	policy, err := validateSignerPolicyForProgramBatchSend(cfg, requests[0].WalletID, requests, usageAmount)
	if err != nil {
		return "", "", nil, policy, err
	}
	priv, expectedPub, err := loadSolanaPrivateKeyFromEnvelope(keystorePath, requests[0].WalletID)
	if err != nil {
		return "", "", nil, policy, err
	}
	fromPub := priv.PublicKey()
	if expectedPub != "" && fromPub.String() != expectedPub {
		return "", "", nil, policy, errors.New("solana envelope public key mismatch")
	}
	instructions := make([]solana.Instruction, 0, len(requests))
	for _, req := range requests {
		ix, err := buildSolanaInstruction(req)
		if err != nil {
			return "", "", nil, policy, err
		}
		instructions = append(instructions, ix)
	}
	blockhash, err := solanaLatestBlockhashWithFallback(rpcURLs)
	if err != nil {
		return "", "", nil, policy, err
	}
	tx, err := solana.NewTransaction(
		instructions,
		blockhash,
		solana.TransactionPayer(fromPub),
	)
	if err != nil {
		return "", "", nil, policy, err
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(fromPub) {
			k := priv
			return &k
		}
		return nil
	})
	if err != nil {
		return "", "", nil, policy, err
	}
	sig, err := sendSignedSolanaTransactionAndConfirm(rpcURLs, tx)
	if err != nil {
		return sig, fromPub.String(), usageAmount, policy, err
	}
	return sig, fromPub.String(), usageAmount, policy, nil
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
		txHash, signer, policyUsageAmount, signerPolicy, err := solanaSendNativeTransferAndConfirm(
			cfg.solanaWriteRPCURLsForWallet(txReq.WalletID),
			cfg.keystorePathForWallet("solana", txReq.WalletID),
			txReq,
			cfg,
		)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(txReq.WalletID, "solana", usageAmount)
		}
		recordSignerPolicyUsage(signerPolicy, "solana", policyUsageAmount)
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
		signedTx, signer, policyUsageAmount, signerPolicy, err := solanaSignSerializedTransaction(
			cfg.keystorePathForWallet("solana", txReq.WalletID),
			txReq,
			cfg,
		)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(txReq.WalletID, "solana", usageAmount)
		}
		recordSignerPolicyUsage(signerPolicy, "solana", policyUsageAmount)
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
		txHash, signer, policyUsageAmount, signerPolicy, err := solanaSendInstructionAndConfirm(
			cfg.solanaWriteRPCURLsForWallet(instructionReq.WalletID),
			cfg.keystorePathForWallet("solana", instructionReq.WalletID),
			instructionReq,
			cfg,
		)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(instructionReq.WalletID, "solana", usageAmount)
		}
		recordSignerPolicyUsage(signerPolicy, "solana", policyUsageAmount)
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
	case "sendSolanaInstructions":
		if err := cfg.ensureChainAllowed("solana"); err != nil {
			return nil, err
		}
		var batchReq solanaInstructionsRequest
		if err := json.Unmarshal(req.Request, &batchReq); err != nil {
			return nil, errors.New("invalid signer request")
		}
		instructions, err := normalizeSolanaInstructionBatch(batchReq)
		if err != nil {
			return nil, err
		}
		usageAmount, err := validateCustodyScopeForSolanaInstructions(instructions)
		custodyActiveForWallet := custodySplitKeyActiveForWallet(instructions[0].WalletID)
		if custodyActiveForWallet && err != nil {
			return nil, err
		}
		txHash, signer, policyUsageAmount, signerPolicy, err := solanaSendInstructionsAndConfirm(
			cfg.solanaWriteRPCURLsForWallet(instructions[0].WalletID),
			cfg.keystorePathForWallet("solana", instructions[0].WalletID),
			instructions,
			cfg,
		)
		if err != nil {
			return nil, err
		}
		if custodyActiveForWallet {
			recordCustodyUsage(instructions[0].WalletID, "solana", usageAmount)
		}
		recordSignerPolicyUsage(signerPolicy, "solana", policyUsageAmount)
		res := map[string]any{
			"ok":     true,
			"chain":  "solana",
			"txHash": txHash,
			"signer": signer,
			"metadata": map[string]any{
				"mode":             "native",
				"type":             "program-instruction-batch",
				"purpose":          satCleanupPurpose,
				"instructionCount": len(instructions),
			},
		}
		b, _ := json.Marshal(map[string]any{"ok": true, "result": res})
		return b, nil
	default:
		return nil, errors.New("unsupported hybrid native op")
	}
}
