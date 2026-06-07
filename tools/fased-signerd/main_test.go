package main

import (
	"bufio"
	"encoding/base64"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	token "github.com/gagliardetto/solana-go/programs/token"
)

func TestKeystorePathForWalletFallsBackToDefaultWalletMapping(t *testing.T) {
	cfg := signerConfig{
		keystorePath:       "/wallet/generic.v1.enc",
		solanaKeystorePath: "/wallet/solana-generic.v1.enc",
		solanaKeystorePaths: map[string]string{
			"default": "/wallet/solana-default.v1.enc",
		},
	}

	got := cfg.keystorePathForWallet("solana", "solana-1")
	if got != "/wallet/solana-default.v1.enc" {
		t.Fatalf("expected default wallet-specific Solana keystore, got %q", got)
	}
}

func TestKeystorePathForWalletFallsBackToConventionalNamedFile(t *testing.T) {
	dir := t.TempDir()
	expected := filepath.Join(dir, "keystore-solana-solana-1.v1.enc")
	if err := os.WriteFile(expected, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write keystore: %v", err)
	}
	cfg := signerConfig{
		keystorePath:       filepath.Join(dir, "keystore.v1.enc"),
		solanaKeystorePath: filepath.Join(dir, "keystore-solana.v1.enc"),
	}

	got := cfg.keystorePathForWallet("solana", "solana-1")
	if got != expected {
		t.Fatalf("expected conventional named Solana keystore, got %q", got)
	}
}

func TestRPCURLForWalletFallsBackToDefaultWalletMapping(t *testing.T) {
	cfg := signerConfig{
		rpcURL:       "https://generic.invalid",
		solanaRPCURL: "https://solana-generic.invalid",
		solanaRPCURLs: map[string]string{
			"default": "https://solana-default.invalid",
		},
	}

	got := cfg.rpcURLForWallet("solana", "solana-1")
	if got != "https://solana-default.invalid" {
		t.Fatalf("expected default wallet-specific Solana RPC URL, got %q", got)
	}
}

func TestKeystorePathForWalletUsesSingleScopedMappingWhenWalletIDMissing(t *testing.T) {
	cfg := signerConfig{
		solanaKeystorePath: "/wallet/keystore-solana.v1.enc",
		solanaKeystorePaths: map[string]string{
			"solana_1": "/wallet/keystore-solana-solana-1.v1.enc",
		},
	}

	got := cfg.keystorePathForWallet("solana", "")
	if got != "/wallet/keystore-solana-solana-1.v1.enc" {
		t.Fatalf("expected single scoped Solana keystore, got %q", got)
	}
}

func TestRPCURLForWalletUsesSingleScopedMappingWhenWalletIDMissing(t *testing.T) {
	cfg := signerConfig{
		solanaRPCURL: "https://generic.invalid",
		solanaRPCURLs: map[string]string{
			"solana_1": "https://scoped.invalid",
		},
	}

	got := cfg.rpcURLForWallet("solana", "")
	if got != "https://scoped.invalid" {
		t.Fatalf("expected single scoped Solana RPC URL, got %q", got)
	}
}

func TestMustValidateRejectsDisallowedChain(t *testing.T) {
	cfg := signerConfig{chains: []string{"unsupported"}}

	req := request{
		Op:    "getBalance",
		Chain: "solana",
	}
	if err := mustValidate(req, cfg); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("expected disallowed chain error, got %v", err)
	}
}

func TestMustValidateRejectsDisallowedSolanaInstruction(t *testing.T) {
	cfg := signerConfig{chains: []string{"unsupported"}}

	req := request{
		Op: "sendSolanaInstruction",
		Request: []byte(`{
			"programId":"11111111111111111111111111111111",
			"dataBase64":"AQ==",
			"keys":[{"pubkey":"11111111111111111111111111111111","isSigner":false,"isWritable":false}]
		}`),
	}
	if err := mustValidate(req, cfg); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("expected disallowed chain error, got %v", err)
	}
}

func TestReadRequestLineRejectsOversizedPayload(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader(strings.Repeat("a", 32) + "\n"))
	if _, err := readRequestLine(reader, 16); err != errRequestTooLarge {
		t.Fatalf("expected errRequestTooLarge, got %v", err)
	}
}

func TestReadPassphraseRejectsLooseFilePermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passphrase")
	if err := os.WriteFile(path, []byte("secret\n"), 0o644); err != nil {
		t.Fatalf("write passphrase: %v", err)
	}
	t.Setenv("FASED_WALLET_PASSPHRASE_FILE", path)
	t.Setenv("FASED_WALLET_PASSPHRASE", "")

	if _, err := readPassphrase(""); err == nil || !strings.Contains(err.Error(), "must not be group/world accessible") {
		t.Fatalf("expected strict permission error, got %v", err)
	}
}

func TestReadPassphraseAcceptsOwnerOnlyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passphrase")
	if err := os.WriteFile(path, []byte("secret\n"), 0o600); err != nil {
		t.Fatalf("write passphrase: %v", err)
	}
	t.Setenv("FASED_WALLET_PASSPHRASE_FILE", path)
	t.Setenv("FASED_WALLET_PASSPHRASE", "")

	got, err := readPassphrase("")
	if err != nil {
		t.Fatalf("readPassphrase error: %v", err)
	}
	if got != "secret" {
		t.Fatalf("expected trimmed passphrase, got %q", got)
	}
}

func TestReadPassphraseRequiresCustodyUnlockWhenSplitKeyActive(t *testing.T) {
	t.Setenv("FASED_WALLET_CUSTODY_MODE", "split-key")
	t.Setenv("FASED_WALLET_CUSTODY_WALLETS", "wallet-a")
	t.Setenv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1")
	t.Setenv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1")
	t.Setenv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1")
	t.Setenv("FASED_WALLET_PASSPHRASE", "ignored")
	clearCustodyUnlock("", "", "")

	if _, err := readPassphrase("wallet-a"); err == nil || !strings.Contains(err.Error(), "custody unlock required") {
		t.Fatalf("expected custody unlock required error, got %v", err)
	}
}

func TestReadPassphraseUsesActiveCustodyUnlockWhenSplitKeyActive(t *testing.T) {
	t.Setenv("FASED_WALLET_CUSTODY_MODE", "split-key")
	t.Setenv("FASED_WALLET_CUSTODY_WALLETS", "wallet-a")
	t.Setenv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1")
	t.Setenv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1")
	t.Setenv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1")
	t.Setenv("FASED_WALLET_PASSPHRASE", "ignored")
	clearCustodyUnlock("", "", "")
	defer clearCustodyUnlock("", "", "")

	setCustodyUnlock(custodyUnlockRequest{
		SessionID:  "session-1",
		Host:       "127.0.0.1",
		WalletID:   "wallet-a",
		Role:       "payment",
		Chains:     []string{"solana"},
		Passphrase: "custody-secret",
	}, time.Now().Add(time.Minute))

	got, err := readPassphrase("wallet-a")
	if err != nil {
		t.Fatalf("readPassphrase error: %v", err)
	}
	if got != "custody-secret" {
		t.Fatalf("expected custody passphrase, got %q", got)
	}
}

func TestReadPassphraseDoesNotApplyCustodyGloballyWithoutWalletList(t *testing.T) {
	t.Setenv("FASED_WALLET_CUSTODY_MODE", "split-key")
	t.Setenv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1")
	t.Setenv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1")
	t.Setenv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1")
	t.Setenv("FASED_WALLET_PASSPHRASE", "single-key-secret")
	clearCustodyUnlock("", "", "")
	defer clearCustodyUnlock("", "", "")

	got, err := readPassphrase("wallet-a")
	if err != nil {
		t.Fatalf("expected missing custody wallet list to leave wallet single-key, got %v", err)
	}
	if got != "single-key-secret" {
		t.Fatalf("expected global passphrase when no custody wallet list is configured, got %q", got)
	}
}

func TestReadPassphraseOnlyRequiresCustodyForConfiguredWallets(t *testing.T) {
	t.Setenv("FASED_WALLET_CUSTODY_MODE", "split-key")
	t.Setenv("FASED_WALLET_CUSTODY_WALLETS", "wallet-a")
	t.Setenv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1")
	t.Setenv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1")
	t.Setenv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1")
	t.Setenv("FASED_WALLET_PASSPHRASE", "single-key-secret")
	clearCustodyUnlock("", "", "")
	defer clearCustodyUnlock("", "", "")

	if _, err := readPassphrase("wallet-a"); err == nil || !strings.Contains(err.Error(), "custody unlock required") {
		t.Fatalf("expected custody unlock for split-key wallet, got %v", err)
	}
	got, err := readPassphrase("wallet-b")
	if err != nil {
		t.Fatalf("expected single-key wallet to use global passphrase, got %v", err)
	}
	if got != "single-key-secret" {
		t.Fatalf("expected global passphrase for non-custody wallet, got %q", got)
	}
}

func TestHandleHybridNativeCustodyLockClearsUnlockState(t *testing.T) {
	clearCustodyUnlock("", "", "")
	defer clearCustodyUnlock("", "", "")
	setCustodyUnlock(custodyUnlockRequest{
		SessionID:  "session-1",
		Host:       "127.0.0.1",
		WalletID:   "wallet-a",
		Role:       "payment",
		Chains:     []string{"solana"},
		Passphrase: "custody-secret",
	}, time.Now().Add(time.Minute))

	cfg := signerConfig{chains: []string{"solana"}}
	resp, err := handleHybridNative(
		request{
			Op:      "lockCustody",
			Request: []byte(`{"sessionId":"session-1","host":"127.0.0.1","walletId":"wallet-a"}`),
		},
		map[string]any{"op": "lockCustody"},
		cfg,
	)
	if err != nil {
		t.Fatalf("handleHybridNative error: %v", err)
	}
	if !strings.Contains(string(resp), `"removed":true`) {
		t.Fatalf("expected removed=true response, got %s", resp)
	}
	active, _ := currentCustodyStatus("wallet-a")
	if active {
		t.Fatal("expected custody unlock state to be cleared")
	}
}

func TestSignerPolicyRejectsDirectSigningDisabled(t *testing.T) {
	cfg := signerConfig{
		walletDirectSigning: map[string]bool{"agent_wallet": false},
	}

	_, _, err := validateSignerPolicyForNativeSend(cfg, signerTxRequest{
		Chain:    "solana",
		WalletID: "agent-wallet",
		Amount:   "1",
	})
	if err == nil || !strings.Contains(err.Error(), "direct signing disabled") {
		t.Fatalf("expected direct signing disabled error, got %v", err)
	}
}

func TestSignerPolicyRejectsMiningNativeTransfer(t *testing.T) {
	cfg := signerConfig{
		walletRoles:         map[string]string{"mining": "mining"},
		walletDirectSigning: map[string]bool{"mining": true},
	}

	_, _, err := validateSignerPolicyForNativeSend(cfg, signerTxRequest{
		Chain:    "solana",
		WalletID: "mining",
		Amount:   "1",
	})
	if err == nil || !strings.Contains(err.Error(), "mining wallet") {
		t.Fatalf("expected mining native transfer error, got %v", err)
	}
}

func TestSignerPolicyEnforcesSolanaAmountCaps(t *testing.T) {
	cfg := signerConfig{
		walletDirectSigning: map[string]bool{"agent": true},
		walletCapsEnabled:   map[string]bool{"agent": true},
		solanaMaxPerTx:      map[string]*big.Int{"agent": big.NewInt(10)},
	}

	_, _, err := validateSignerPolicyForNativeSend(cfg, signerTxRequest{
		Chain:    "solana",
		WalletID: "agent",
		Amount:   "11",
	})
	if err == nil || !strings.Contains(err.Error(), "per-tx cap") {
		t.Fatalf("expected cap error, got %v", err)
	}
}

func TestSignerPolicyEnforcesProgramAllowlist(t *testing.T) {
	cfg := signerConfig{
		walletDirectSigning: map[string]bool{"agent": true},
		solanaAllowPrograms: map[string]map[string]bool{
			"agent": {
				normalizeProgramID("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"): true,
			},
		},
	}

	_, err := validateSignerPolicyForProgramSend(
		cfg,
		"agent",
		"11111111111111111111111111111111",
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("expected program allowlist error, got %v", err)
	}
}

func mustSerializedTestTx(t *testing.T, payer solana.PublicKey, instructions ...solana.Instruction) string {
	t.Helper()
	tx, err := solana.NewTransaction(instructions, solana.Hash{}, solana.TransactionPayer(payer))
	if err != nil {
		t.Fatalf("build transaction: %v", err)
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal transaction: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func mustDecodeSerializedTestTx(t *testing.T, serialized string) *solana.Transaction {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(serialized)
	if err != nil {
		t.Fatalf("decode transaction: %v", err)
	}
	tx, err := solana.TransactionFromDecoder(bin.NewBinDecoder(raw))
	if err != nil {
		t.Fatalf("decode transaction: %v", err)
	}
	return tx
}

func TestSignerPolicyAgentSerializedTransferCheckedMatchesExpected(t *testing.T) {
	signer := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	serialized := mustSerializedTestTx(t, signer,
		token.NewTransferCheckedInstruction(42, 6, source, mint, destination, signer, nil).Build(),
	)
	tx := mustDecodeSerializedTestTx(t, serialized)
	cfg := signerConfig{
		walletRoles:         map[string]string{"agent": "agent"},
		walletDirectSigning: map[string]bool{"agent": true},
	}

	_, _, err := validateSignerPolicyForSerializedTx(cfg, signerTxRequest{
		Chain:              "solana",
		WalletID:           "agent",
		Amount:             "42",
		TokenMint:          mint.String(),
		Source:             source.String(),
		Destination:        destination.String(),
		SerializedTxBase64: serialized,
	}, tx, signer.String())
	if err != nil {
		t.Fatalf("expected serialized transferChecked to pass, got %v", err)
	}
}

func TestSignerPolicyAgentSerializedTransferCheckedRejectsAmountMismatch(t *testing.T) {
	signer := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	serialized := mustSerializedTestTx(t, signer,
		token.NewTransferCheckedInstruction(42, 6, source, mint, destination, signer, nil).Build(),
	)
	tx := mustDecodeSerializedTestTx(t, serialized)
	cfg := signerConfig{
		walletRoles:         map[string]string{"agent": "agent"},
		walletDirectSigning: map[string]bool{"agent": true},
	}

	_, _, err := validateSignerPolicyForSerializedTx(cfg, signerTxRequest{
		Chain:              "solana",
		WalletID:           "agent",
		Amount:             "41",
		TokenMint:          mint.String(),
		SerializedTxBase64: serialized,
	}, tx, signer.String())
	if err == nil || !strings.Contains(err.Error(), "amount does not match") {
		t.Fatalf("expected amount mismatch error, got %v", err)
	}
}

func TestSignerPolicyAgentSerializedTransferCheckedRejectsMintMismatch(t *testing.T) {
	signer := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	otherMint := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	serialized := mustSerializedTestTx(t, signer,
		token.NewTransferCheckedInstruction(42, 6, source, mint, destination, signer, nil).Build(),
	)
	tx := mustDecodeSerializedTestTx(t, serialized)
	cfg := signerConfig{
		walletRoles:         map[string]string{"agent": "agent"},
		walletDirectSigning: map[string]bool{"agent": true},
	}

	_, _, err := validateSignerPolicyForSerializedTx(cfg, signerTxRequest{
		Chain:              "solana",
		WalletID:           "agent",
		Amount:             "42",
		TokenMint:          otherMint.String(),
		SerializedTxBase64: serialized,
	}, tx, signer.String())
	if err == nil || !strings.Contains(err.Error(), "mint does not match") {
		t.Fatalf("expected mint mismatch error, got %v", err)
	}
}

func TestSignerPolicyAgentSerializedRejectsUncheckedTransferWhenMintExpected(t *testing.T) {
	signer := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	serialized := mustSerializedTestTx(t, signer,
		token.NewTransferInstruction(42, source, destination, signer, nil).Build(),
	)
	tx := mustDecodeSerializedTestTx(t, serialized)
	cfg := signerConfig{
		walletRoles:         map[string]string{"agent": "agent"},
		walletDirectSigning: map[string]bool{"agent": true},
	}

	_, _, err := validateSignerPolicyForSerializedTx(cfg, signerTxRequest{
		Chain:              "solana",
		WalletID:           "agent",
		Amount:             "42",
		TokenMint:          mint.String(),
		SerializedTxBase64: serialized,
	}, tx, signer.String())
	if err == nil || !strings.Contains(err.Error(), "transferChecked") {
		t.Fatalf("expected transferChecked requirement error, got %v", err)
	}
}

func TestSignerPolicyAgentSerializedRejectsRiskySPLInstruction(t *testing.T) {
	signer := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	delegate := solana.NewWallet().PublicKey()
	serialized := mustSerializedTestTx(t, signer,
		token.NewApproveInstruction(42, source, delegate, signer, nil).Build(),
	)
	tx := mustDecodeSerializedTestTx(t, serialized)
	cfg := signerConfig{
		walletRoles:         map[string]string{"agent": "agent"},
		walletDirectSigning: map[string]bool{"agent": true},
	}

	_, _, err := validateSignerPolicyForSerializedTx(cfg, signerTxRequest{
		Chain:              "solana",
		WalletID:           "agent",
		Amount:             "42",
		SerializedTxBase64: serialized,
	}, tx, signer.String())
	if err == nil || !strings.Contains(err.Error(), "Approve") {
		t.Fatalf("expected risky SPL instruction error, got %v", err)
	}
}
