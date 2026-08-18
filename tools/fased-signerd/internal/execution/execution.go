// Package execution contains signer-owned execution primitives. It deliberately
// does not know about service policy, persistence, or private-key acquisition.
package execution

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"fased-signerd/internal/networkverify"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

// RPCPool coordinates write-RPC circuit state without exposing mutable endpoint
// state to callers.
type RPCPool struct {
	mu        sync.Mutex
	now       func() time.Time
	endpoints map[string]endpointState
}

type endpointState struct {
	consecutiveFailures int
	backoffUntil        time.Time
	quotaLikely         bool
}

// NewRPCPool constructs an independent write-RPC circuit pool. A nil clock uses
// time.Now; accepting a clock keeps circuit behavior deterministic in tests.
func NewRPCPool(clock func() time.Time) *RPCPool {
	if clock == nil {
		clock = time.Now
	}
	return &RPCPool{now: clock, endpoints: make(map[string]endpointState)}
}

func LooksLikeQuotaFailure(err error) bool {
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

func (p *RPCPool) MarkSuccess(rpcURL string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.endpoints, strings.TrimSpace(rpcURL))
}

func (p *RPCPool) MarkFailure(rpcURL string, err error) {
	key := strings.TrimSpace(rpcURL)
	if key == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.endpoints[key]
	state.consecutiveFailures++
	state.quotaLikely = LooksLikeQuotaFailure(err)
	if state.quotaLikely {
		state.backoffUntil = p.now().Add(30 * time.Second)
	} else if state.consecutiveFailures >= 2 {
		backoff := 5 * time.Second * time.Duration(1<<(state.consecutiveFailures-2))
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
		state.backoffUntil = p.now().Add(backoff)
	}
	p.endpoints[key] = state
}

func (p *RPCPool) ActiveURLs(rpcURLs []string) ([]string, error) {
	now := p.now()
	p.mu.Lock()
	defer p.mu.Unlock()
	active := make([]string, 0, len(rpcURLs))
	shortestBackoff := time.Duration(0)
	configured := 0
	for _, rpcURL := range rpcURLs {
		trimmed := strings.TrimSpace(rpcURL)
		if trimmed == "" {
			continue
		}
		configured++
		state := p.endpoints[trimmed]
		if state.backoffUntil.After(now) {
			remaining := state.backoffUntil.Sub(now)
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

func (p *RPCPool) BroadcastSignedOnce(rpcURLs []string, signedRaw []byte, expectedSignature solana.Signature, requestTimeout time.Duration) error {
	active, err := p.ActiveURLs(rpcURLs)
	if err != nil {
		return err
	}
	rpcURL := active[0]
	client := networkverify.NewSolanaRPCClient(rpcURL, requestTimeout)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	signature, err := client.SendRawTransactionWithOpts(ctx, signedRaw, rpc.TransactionOpts{
		SkipPreflight: false, PreflightCommitment: rpc.CommitmentConfirmed,
	})
	if err != nil {
		p.MarkFailure(rpcURL, err)
		return fmt.Errorf("Solana transaction broadcast result is ambiguous: %w", err)
	}
	p.MarkSuccess(rpcURL)
	if signature != expectedSignature {
		return errors.New("Solana RPC returned a different signature for the signed transaction")
	}
	return nil
}

func (p *RPCPool) LookupSignatureStatus(rpcURLs []string, signature solana.Signature, requestTimeout time.Duration) (string, error) {
	active, err := p.ActiveURLs(rpcURLs)
	if err != nil {
		return "unknown", err
	}
	for _, rpcURL := range active {
		client := networkverify.NewSolanaRPCClient(rpcURL, requestTimeout)
		ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
		status, requestErr := client.GetSignatureStatuses(ctx, true, signature)
		cancel()
		if requestErr != nil {
			p.MarkFailure(rpcURL, requestErr)
			continue
		}
		p.MarkSuccess(rpcURL)
		if status == nil || status.Value == nil || len(status.Value) == 0 || status.Value[0] == nil {
			continue
		}
		if status.Value[0].Err != nil {
			return "failed", nil
		}
		if status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed || status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
			return "confirmed", nil
		}
		return "pending", nil
	}
	return "unknown", nil
}

func (p *RPCPool) LatestBlockhashWithFallback(rpcURLs []string, requestTimeout time.Duration) (solana.Hash, error) {
	active, err := p.ActiveURLs(rpcURLs)
	if err != nil {
		return solana.Hash{}, err
	}
	for _, rpcURL := range active {
		client := networkverify.NewSolanaRPCClient(rpcURL, requestTimeout)
		ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
		result, requestErr := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
		cancel()
		if requestErr == nil {
			p.MarkSuccess(rpcURL)
			return result.Value.Blockhash, nil
		}
		p.MarkFailure(rpcURL, requestErr)
	}
	return solana.Hash{}, errors.New("signer-owned Solana RPC latest-blockhash lookup failed")
}

func (p *RPCPool) ConfirmSignatureAcrossRPCs(rpcURLs []string, signature solana.Signature, requestTimeout, confirmTimeout time.Duration) error {
	confirmCtx, cancel := context.WithTimeout(context.Background(), confirmTimeout)
	defer cancel()
	tick := time.NewTicker(750 * time.Millisecond)
	defer tick.Stop()
	for {
		active, activeErr := p.ActiveURLs(rpcURLs)
		if activeErr == nil {
			for _, rpcURL := range active {
				client := networkverify.NewSolanaRPCClient(rpcURL, requestTimeout)
				requestCtx, requestCancel := context.WithTimeout(confirmCtx, requestTimeout)
				status, err := client.GetSignatureStatuses(requestCtx, true, signature)
				requestCancel()
				if err != nil {
					p.MarkFailure(rpcURL, err)
					continue
				}
				p.MarkSuccess(rpcURL)
				if status == nil || status.Value == nil || len(status.Value) == 0 || status.Value[0] == nil {
					continue
				}
				if status.Value[0].Err != nil {
					return errors.New("Solana transaction failed on chain")
				}
				if status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed || status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
					return nil
				}
			}
		}
		select {
		case <-confirmCtx.Done():
			return errors.New("signer-owned Solana RPC confirmation timed out")
		case <-tick.C:
		}
	}
}

func NewSignedTypedTransaction(instructions []solana.Instruction, blockhash solana.Hash, privateKey solana.PrivateKey, addressTables map[solana.PublicKey]solana.PublicKeySlice) (*solana.Transaction, error) {
	from := privateKey.PublicKey()
	options := []solana.TransactionOption{solana.TransactionPayer(from)}
	if len(addressTables) > 0 {
		options = append(options, solana.TransactionAddressTables(addressTables))
	}
	tx, err := solana.NewTransaction(instructions, blockhash, options...)
	if err != nil {
		return nil, err
	}
	if len(addressTables) > 0 && (tx.Message.GetVersion() != solana.MessageVersionV0 || len(tx.Message.GetAddressTableLookups()) != 1 || tx.Message.NumLookups() == 0) {
		return nil, errors.New("typed SAT distribution did not compile to the required single-table v0 transaction")
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(from) {
			copy := privateKey
			return &copy
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return tx, nil
}

func SignValidatedJupiterTransaction(tx *solana.Transaction, walletSignerIndex int, privateKey solana.PrivateKey) ([]byte, solana.Signature, error) {
	if tx == nil {
		return nil, solana.Signature{}, errors.New("validated transaction is missing")
	}
	wallet := privateKey.PublicKey()
	_, err := tx.PartialSign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(wallet) {
			copy := privateKey
			return &copy
		}
		return nil
	})
	if err != nil {
		return nil, solana.Signature{}, fmt.Errorf("sign typed Jupiter transaction: %w", err)
	}
	if walletSignerIndex < 0 || walletSignerIndex >= len(tx.Signatures) || tx.Signatures[walletSignerIndex].IsZero() {
		return nil, solana.Signature{}, errors.New("typed Jupiter transaction signature is missing")
	}
	for index, signature := range tx.Signatures {
		if index != walletSignerIndex && !signature.IsZero() {
			return nil, solana.Signature{}, errors.New("signer modified an additional Trigger signer slot")
		}
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		return nil, solana.Signature{}, err
	}
	if len(raw) > 1232 || len(raw) > math.MaxUint16 {
		return nil, solana.Signature{}, errors.New("signed transaction is too large")
	}
	return raw, tx.Signatures[walletSignerIndex], nil
}

func SignDomainMessageBase64(privateKey solana.PrivateKey, message []byte) (string, error) {
	signature, err := privateKey.Sign(message)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(signature[:]), nil
}

func DecodeStoredSignedOperation(signedTxBase64, transactionDigest, signature string) ([]byte, *solana.Transaction, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signedTxBase64))
	if err != nil || len(raw) == 0 || len(raw) > 1644 {
		return nil, nil, errors.New("stored signed transaction artifact is invalid")
	}
	digest := sha256.Sum256(raw)
	if transactionDigest != "sha256:"+hex.EncodeToString(digest[:]) {
		return nil, nil, errors.New("stored signed transaction artifact digest mismatch")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil || len(tx.Signatures) == 0 || tx.Signatures[0].String() != signature {
		return nil, nil, errors.New("stored signed transaction artifact signature mismatch")
	}
	return raw, tx, nil
}
