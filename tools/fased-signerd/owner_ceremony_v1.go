package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

const ownerCeremonyIntentTypeV1 = "solana.owner-ceremony.v1"

const ownerCeremonyAtomicAgentMiningVaultBindingV1 = "atomic_agent_mining_vault_binding"

type ownerCeremonyAccountV1 struct {
	Name           string `json:"name"`
	Pubkey         string `json:"pubkey"`
	IsSigner       bool   `json:"isSigner"`
	IsWritable     bool   `json:"isWritable"`
	SignerWalletID string `json:"signerWalletId,omitempty"`
}

type ownerCeremonyRequestV1 struct {
	RequestID    string                       `json:"requestId"`
	Cluster      string                       `json:"cluster"`
	Action       string                       `json:"action"`
	ProgramID    string                       `json:"programId"`
	DataBase64   string                       `json:"dataBase64"`
	Accounts     []ownerCeremonyAccountV1     `json:"accounts"`
	Instructions []ownerCeremonyInstructionV1 `json:"instructions,omitempty"`
}

type ownerCeremonyInstructionV1 struct {
	Action     string                   `json:"action"`
	ProgramID  string                   `json:"programId"`
	DataBase64 string                   `json:"dataBase64"`
	Accounts   []ownerCeremonyAccountV1 `json:"accounts"`
}

type ownerCeremonyResultV1 struct {
	RequestID           string   `json:"requestId"`
	Action              string   `json:"action"`
	ProgramID           string   `json:"programId"`
	ProgramIDs          []string `json:"programIds,omitempty"`
	FeePayer            string   `json:"feePayer"`
	RequiredSigners     []string `json:"requiredSigners"`
	WritableAccounts    []string `json:"writableAccounts"`
	IntentDigest        string   `json:"intentDigest"`
	UnsignedTxSHA256    string   `json:"unsignedTxSha256,omitempty"`
	SignedTxSHA256      string   `json:"signedTxSha256,omitempty"`
	Signature           string   `json:"signature,omitempty"`
	State               string   `json:"state"`
	SimulationSigVerify bool     `json:"simulationSigVerify"`
}

type ownerCeremonyContractV1 struct {
	ProgramID string
	DataSize  int
	Disc      [8]byte
	DiscSize  int
	Accounts  []agentIdentityAccountContractV1
}

func ownerCeremonyContractForActionV1(action string) (ownerCeremonyContractV1, bool) {
	action = strings.TrimSpace(action)
	if contract, ok := satcoinOwnerInstructionContractsV1[action]; ok {
		return contract, true
	}
	if action == "create_fased_agent_record" || action == "bind_agent_mining" {
		contract, ok := agentIdentityInstructionContractsV1[action]
		return ownerCeremonyContractV1{
			ProgramID: agentIdentityProgramIDV1, DataSize: contract.DataSize,
			Disc: contract.Discriminator, DiscSize: 8, Accounts: contract.Accounts,
		}, ok
	}
	if action == "bind_satcoin_vault" {
		contract, ok := agentCapitalInstructionContractsV1[action]
		accounts := make([]agentIdentityAccountContractV1, 0, len(contract.Accounts))
		for _, account := range contract.Accounts {
			accounts = append(accounts, agentIdentityAccountContractV1{
				Name: account.Name, IsSigner: account.IsSigner, IsWritable: account.IsWritable, Address: account.Address,
			})
		}
		return ownerCeremonyContractV1{
			ProgramID: agentCapitalProgramIDV1, DataSize: contract.DataSize,
			Disc: contract.Discriminator, DiscSize: 8, Accounts: accounts,
		}, ok
	}
	return ownerCeremonyContractV1{}, false
}

func ownerCeremonyRoleV1(accountName string) string {
	switch accountName {
	case "profile_controller":
		return "profile"
	case "recovery_authority":
		return "vault"
	case "permanent_mining_id", "controller", "active_miner_authority", "signer", "mining_controller", "current_miner_authority":
		return "mining"
	default:
		return ""
	}
}

type normalizedOwnerCeremonyV1 struct {
	Request       ownerCeremonyRequestV1
	Digest        string
	Program       solana.PublicKey
	Instruction   solana.Instruction
	Instructions  []solana.Instruction
	Programs      []solana.PublicKey
	FeePayer      solana.PublicKey
	FeePayerID    string
	SignerWallets []string
	SignerKeys    []solana.PublicKey
	RPCURLs       []string
	Writable      []string
}

func (s *signerServiceV2) normalizeOwnerCeremonyV1(input ownerCeremonyRequestV1) (normalizedOwnerCeremonyV1, error) {
	if strings.TrimSpace(input.Action) == ownerCeremonyAtomicAgentMiningVaultBindingV1 {
		return s.normalizeAtomicAgentMiningVaultBindingV1(input)
	}
	if len(input.Instructions) != 0 {
		return normalizedOwnerCeremonyV1{}, errors.New("single owner ceremony cannot include nested instructions")
	}
	requestID, err := validateRequestIDV2(input.RequestID)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	cluster, err := normalizeSolanaClusterV2(input.Cluster)
	if err != nil || cluster != "devnet" {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony v1 is restricted to Devnet")
	}
	contract, ok := ownerCeremonyContractForActionV1(input.Action)
	if !ok {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony action is not in the exact generated or Satcoin initialization contract")
	}
	program, err := solana.PublicKeyFromBase58(strings.TrimSpace(input.ProgramID))
	if err != nil || program.String() != contract.ProgramID {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony program does not match the generated contract")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(input.DataBase64))
	if err != nil || contract.DiscSize < 1 || contract.DiscSize > len(contract.Disc) || contract.DataSize < contract.DiscSize || len(data) != contract.DataSize || base64.StdEncoding.EncodeToString(data) != input.DataBase64 {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony instruction data is not canonical")
	}
	if subtle.ConstantTimeCompare(data[:contract.DiscSize], contract.Disc[:contract.DiscSize]) != 1 || len(input.Accounts) != len(contract.Accounts) {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony instruction discriminator or account count changed")
	}

	accounts := make(solana.AccountMetaSlice, 0, len(input.Accounts))
	signerWallets := []string{}
	signerKeys := []solana.PublicKey{}
	writable := []string{}
	seenSigner := map[string]string{}
	var rpcURLs []string
	for index, raw := range input.Accounts {
		expected := contract.Accounts[index]
		key, keyErr := solana.PublicKeyFromBase58(strings.TrimSpace(raw.Pubkey))
		if keyErr != nil || raw.Name != expected.Name || raw.IsSigner != expected.IsSigner || raw.IsWritable != expected.IsWritable {
			return normalizedOwnerCeremonyV1{}, fmt.Errorf("owner ceremony account %s does not match the generated contract", expected.Name)
		}
		if expected.Address != "" && key.String() != expected.Address {
			return normalizedOwnerCeremonyV1{}, fmt.Errorf("owner ceremony account %s has the wrong fixed address", expected.Name)
		}
		walletID := ""
		if strings.TrimSpace(raw.SignerWalletID) != "" {
			walletID = normalizeWalletID(raw.SignerWalletID)
		}
		if !raw.IsSigner && walletID != "" {
			return normalizedOwnerCeremonyV1{}, fmt.Errorf("owner ceremony non-signer account %s cannot name a signer wallet", expected.Name)
		}
		if raw.IsSigner {
			if walletID == "" || ownerCeremonyRoleV1(expected.Name) == "" {
				return normalizedOwnerCeremonyV1{}, fmt.Errorf("owner ceremony signer account %s is unsupported", expected.Name)
			}
			wallet, walletErr := s.keys.PublicRecord(walletID)
			policy, policyErr := s.store.getPolicy(walletID)
			if walletErr != nil || policyErr != nil || wallet.PublicKey != key.String() || policy.Role != ownerCeremonyRoleV1(expected.Name) {
				return normalizedOwnerCeremonyV1{}, fmt.Errorf("owner ceremony signer account %s is not bound to the required signer-owned role", expected.Name)
			}
			verified, rpcErr := s.keys.SolanaRPCURLsV2(walletID)
			if rpcErr == nil {
				verified, rpcErr = solanaRPCURLsForClusterV2(verified, cluster)
			}
			if rpcErr != nil {
				return normalizedOwnerCeremonyV1{}, fmt.Errorf("owner ceremony signer account %s has no verified Devnet RPC profile", expected.Name)
			}
			if rpcURLs == nil {
				rpcURLs = verified
			} else if !equalSortedStringsV2(rpcURLs, verified) {
				return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony authorities must use the same verified RPC profile")
			}
			if prior, exists := seenSigner[key.String()]; exists && prior != walletID {
				return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony maps one signer key to multiple wallet identities")
			}
			if _, exists := seenSigner[key.String()]; !exists {
				seenSigner[key.String()] = walletID
				signerWallets = append(signerWallets, walletID)
				signerKeys = append(signerKeys, key)
			}
		}
		if raw.IsWritable {
			writable = append(writable, key.String())
		}
		accounts = append(accounts, &solana.AccountMeta{PublicKey: key, IsSigner: raw.IsSigner, IsWritable: raw.IsWritable})
	}
	if err := validateSatcoinOwnerCeremonyV1(input.Action, program, data, accounts); err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	feePayerAccount := 0
	minimumSigners := 2
	if input.Action == "sat_init_agent_record" {
		feePayerAccount = 1
		minimumSigners = 1
	} else if input.Action == "sat_init_miner_capital" {
		minimumSigners = 1
	}
	if len(signerKeys) < minimumSigners || feePayerAccount >= len(accounts) || !accounts[feePayerAccount].IsSigner || !accounts[feePayerAccount].IsWritable {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony fee payer or required signer layout changed")
	}
	feePayer := accounts[feePayerAccount].PublicKey
	if input.Action == "create_fased_agent_record" && signerKeys[0].Equals(signerKeys[1]) {
		return normalizedOwnerCeremonyV1{}, errors.New("Profile controller and Recovery Authority must be distinct")
	}
	canonical := input
	canonical.RequestID, canonical.Cluster, canonical.Action, canonical.ProgramID = requestID, cluster, strings.TrimSpace(input.Action), program.String()
	canonical.DataBase64 = base64.StdEncoding.EncodeToString(data)
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	digest := sha256.Sum256(encoded)
	feePayerID := seenSigner[feePayer.String()]
	if feePayerID == "" {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony fee payer is not signer-owned")
	}
	return normalizedOwnerCeremonyV1{
		Request: canonical, Digest: "sha256:" + hex.EncodeToString(digest[:]), Program: program,
		Instruction:  solana.NewInstruction(program, accounts, data),
		Instructions: []solana.Instruction{solana.NewInstruction(program, accounts, data)}, Programs: []solana.PublicKey{program},
		FeePayer: feePayer, FeePayerID: feePayerID,
		SignerWallets: signerWallets, SignerKeys: signerKeys, RPCURLs: rpcURLs, Writable: writable,
	}, nil
}

func ownerCeremonyInstructionRequestV1(requestID, cluster string, input ownerCeremonyInstructionV1) ownerCeremonyRequestV1 {
	return ownerCeremonyRequestV1{
		RequestID: requestID, Cluster: cluster, Action: input.Action, ProgramID: input.ProgramID,
		DataBase64: input.DataBase64, Accounts: input.Accounts,
	}
}

func canonicalOwnerCeremonyInstructionV1(input ownerCeremonyRequestV1) ownerCeremonyInstructionV1 {
	return ownerCeremonyInstructionV1{
		Action: input.Action, ProgramID: input.ProgramID, DataBase64: input.DataBase64, Accounts: input.Accounts,
	}
}

func appendUniqueStringsV1(target []string, values ...string) []string {
	seen := make(map[string]struct{}, len(target)+len(values))
	for _, value := range target {
		seen[value] = struct{}{}
	}
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		target = append(target, value)
	}
	return target
}

func (s *signerServiceV2) normalizeAtomicAgentMiningVaultBindingV1(input ownerCeremonyRequestV1) (normalizedOwnerCeremonyV1, error) {
	requestID, err := validateRequestIDV2(input.RequestID)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	cluster, err := normalizeSolanaClusterV2(input.Cluster)
	if err != nil || cluster != "devnet" {
		return normalizedOwnerCeremonyV1{}, errors.New("owner ceremony v1 is restricted to Devnet")
	}
	if strings.TrimSpace(input.ProgramID) != "" || strings.TrimSpace(input.DataBase64) != "" || len(input.Accounts) != 0 || len(input.Instructions) != 3 {
		return normalizedOwnerCeremonyV1{}, errors.New("atomic Agent mining/Vault binding requires exactly three nested instructions and no top-level instruction")
	}
	expectedActions := []string{"sat_migrate_agent_record_v2", "bind_agent_mining", "bind_satcoin_vault"}
	for index, action := range expectedActions {
		if strings.TrimSpace(input.Instructions[index].Action) != action {
			return normalizedOwnerCeremonyV1{}, errors.New("atomic Agent mining/Vault binding instruction order changed")
		}
	}

	miningBinding, err := s.normalizeOwnerCeremonyV1(ownerCeremonyInstructionRequestV1(requestID+"-agent", cluster, input.Instructions[1]))
	if err != nil {
		return normalizedOwnerCeremonyV1{}, fmt.Errorf("atomic Agent mining binding is invalid: %w", err)
	}
	vaultBinding, err := s.normalizeOwnerCeremonyV1(ownerCeremonyInstructionRequestV1(requestID+"-vault", cluster, input.Instructions[2]))
	if err != nil {
		return normalizedOwnerCeremonyV1{}, fmt.Errorf("atomic Satcoin Vault binding is invalid: %w", err)
	}
	if len(miningBinding.SignerKeys) != 2 || len(vaultBinding.SignerKeys) != 2 ||
		!miningBinding.FeePayer.Equals(vaultBinding.FeePayer) ||
		!miningBinding.SignerKeys[0].Equals(vaultBinding.SignerKeys[0]) ||
		!miningBinding.SignerKeys[1].Equals(vaultBinding.SignerKeys[1]) ||
		!equalSortedStringsV2(miningBinding.RPCURLs, vaultBinding.RPCURLs) {
		return normalizedOwnerCeremonyV1{}, errors.New("atomic Agent mining/Vault binding authorities or RPC profiles changed")
	}
	profile := miningBinding.SignerKeys[0]
	mining := miningBinding.SignerKeys[1]
	if profile.Equals(mining) {
		return normalizedOwnerCeremonyV1{}, errors.New("Profile controller and Mining controller must be distinct")
	}

	migration := input.Instructions[0]
	satcoinProgram := solana.MustPublicKeyFromBase58("H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF")
	program, err := solana.PublicKeyFromBase58(strings.TrimSpace(migration.ProgramID))
	if err != nil || !program.Equals(satcoinProgram) {
		return normalizedOwnerCeremonyV1{}, errors.New("atomic Satcoin migration program changed")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(migration.DataBase64))
	if err != nil || len(data) != 9 || data[0] != 132 || binary.LittleEndian.Uint64(data[1:]) != 1 || base64.StdEncoding.EncodeToString(data) != migration.DataBase64 {
		return normalizedOwnerCeremonyV1{}, errors.New("atomic Satcoin migration data changed")
	}
	expectedMigrationAccounts := []struct {
		name       string
		key        solana.PublicKey
		isSigner   bool
		isWritable bool
	}{
		{"controller", mining, true, false},
		{"permanent_mining_id", mining, false, false},
		{"sat_agent_record", solana.PublicKey{}, false, true},
		{"sat_miner_capital_state", solana.PublicKey{}, false, false},
		{"sat_protocol_generation_state", solana.PublicKey{}, false, false},
	}
	record, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_agent_record"), mining[:]}, program)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	capital, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_miner_capital_state"), mining[:]}, program)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	generation, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_protocol_generation_state_v2")}, program)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	expectedMigrationAccounts[2].key = record
	expectedMigrationAccounts[3].key = capital
	expectedMigrationAccounts[4].key = generation
	if len(migration.Accounts) != len(expectedMigrationAccounts) {
		return normalizedOwnerCeremonyV1{}, errors.New("atomic Satcoin migration account count changed")
	}
	migrationMetas := make(solana.AccountMetaSlice, 0, len(migration.Accounts))
	for index, expected := range expectedMigrationAccounts {
		raw := migration.Accounts[index]
		key, keyErr := solana.PublicKeyFromBase58(strings.TrimSpace(raw.Pubkey))
		if keyErr != nil || raw.Name != expected.name || raw.IsSigner != expected.isSigner || raw.IsWritable != expected.isWritable || !key.Equals(expected.key) {
			return normalizedOwnerCeremonyV1{}, fmt.Errorf("atomic Satcoin migration account %s changed", expected.name)
		}
		if expected.isSigner {
			if normalizeWalletID(raw.SignerWalletID) != miningBinding.SignerWallets[1] {
				return normalizedOwnerCeremonyV1{}, errors.New("atomic Satcoin migration signer wallet changed")
			}
		} else if strings.TrimSpace(raw.SignerWalletID) != "" {
			return normalizedOwnerCeremonyV1{}, errors.New("atomic Satcoin migration non-signer names a signer wallet")
		}
		migrationMetas = append(migrationMetas, &solana.AccountMeta{PublicKey: key, IsSigner: raw.IsSigner, IsWritable: raw.IsWritable})
	}

	miningAccounts := input.Instructions[1].Accounts
	vaultAccounts := input.Instructions[2].Accounts
	if len(miningAccounts) != 7 || len(vaultAccounts) != 15 ||
		miningAccounts[0].Pubkey != profile.String() || vaultAccounts[0].Pubkey != profile.String() ||
		miningAccounts[1].Pubkey != mining.String() || vaultAccounts[1].Pubkey != mining.String() || vaultAccounts[2].Pubkey != mining.String() ||
		miningAccounts[2].Pubkey != vaultAccounts[3].Pubkey ||
		miningAccounts[3].Pubkey != record.String() || vaultAccounts[6].Pubkey != record.String() ||
		miningAccounts[4].Pubkey != vaultAccounts[4].Pubkey ||
		vaultAccounts[5].Pubkey != mining.String() || vaultAccounts[7].Pubkey != capital.String() ||
		vaultAccounts[13].Pubkey != program.String() {
		return normalizedOwnerCeremonyV1{}, errors.New("atomic Agent mining/Vault binding cross-instruction identity changed")
	}

	canonical := input
	canonical.RequestID, canonical.Cluster, canonical.Action = requestID, cluster, ownerCeremonyAtomicAgentMiningVaultBindingV1
	canonical.Instructions = []ownerCeremonyInstructionV1{
		{Action: expectedActions[0], ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data), Accounts: migration.Accounts},
		canonicalOwnerCeremonyInstructionV1(miningBinding.Request),
		canonicalOwnerCeremonyInstructionV1(vaultBinding.Request),
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedOwnerCeremonyV1{}, err
	}
	digest := sha256.Sum256(encoded)
	writable := appendUniqueStringsV1(nil, record.String())
	writable = appendUniqueStringsV1(writable, miningBinding.Writable...)
	writable = appendUniqueStringsV1(writable, vaultBinding.Writable...)
	migrationInstruction := solana.NewInstruction(program, migrationMetas, data)
	return normalizedOwnerCeremonyV1{
		Request: canonical, Digest: "sha256:" + hex.EncodeToString(digest[:]), Program: program,
		Instruction:  migrationInstruction,
		Instructions: []solana.Instruction{migrationInstruction, miningBinding.Instruction, vaultBinding.Instruction},
		Programs:     []solana.PublicKey{program, miningBinding.Program, vaultBinding.Program},
		FeePayer:     miningBinding.FeePayer, FeePayerID: miningBinding.FeePayerID,
		SignerWallets: append([]string(nil), miningBinding.SignerWallets...),
		SignerKeys:    append([]solana.PublicKey(nil), miningBinding.SignerKeys...),
		RPCURLs:       append([]string(nil), miningBinding.RPCURLs...), Writable: writable,
	}, nil
}

func buildOwnerCeremonyTransactionV1(normalized normalizedOwnerCeremonyV1, blockhash solana.Hash) (*solana.Transaction, error) {
	if len(normalized.Instructions) == 0 {
		return nil, errors.New("owner ceremony has no exact instruction set")
	}
	tx, err := solana.NewTransaction(normalized.Instructions, blockhash, solana.TransactionPayer(normalized.FeePayer))
	if err != nil {
		return nil, err
	}
	if tx.Message.IsVersioned() || int(tx.Message.Header.NumRequiredSignatures) != len(normalized.SignerKeys) || len(tx.Message.AccountKeys) == 0 || !tx.Message.AccountKeys[0].Equals(normalized.FeePayer) {
		return nil, errors.New("owner ceremony signer layout is not exact")
	}
	tx.Signatures = make([]solana.Signature, len(normalized.SignerKeys))
	return tx, nil
}

func simulateOwnerCeremonyV1(rpcURLs []string, tx *solana.Transaction, sigVerify bool) error {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		response, requestErr := client.SimulateTransactionWithOpts(ctx, tx, &rpc.SimulateTransactionOpts{SigVerify: sigVerify, Commitment: rpc.CommitmentConfirmed})
		cancel()
		if requestErr != nil || response == nil || response.Value == nil {
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		if response.Value.Err != nil {
			return fmt.Errorf("owner ceremony simulation failed: %v", response.Value.Err)
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return nil
	}
	return errors.New("owner ceremony simulation could not reach a verified Devnet RPC")
}

func ownerCeremonyResultFromV1(normalized normalizedOwnerCeremonyV1, operation signerOperationV2, tx *solana.Transaction, sigVerify bool) (ownerCeremonyResultV1, error) {
	result := ownerCeremonyResultV1{
		RequestID: normalized.Request.RequestID, Action: normalized.Request.Action, ProgramID: normalized.Program.String(),
		FeePayer: normalized.FeePayer.String(), RequiredSigners: make([]string, 0, len(normalized.SignerKeys)),
		WritableAccounts: append([]string(nil), normalized.Writable...), IntentDigest: normalized.Digest,
		SignedTxSHA256: operation.TransactionDigest, Signature: operation.Signature, State: operation.State,
		SimulationSigVerify: sigVerify,
	}
	for _, program := range normalized.Programs {
		result.ProgramIDs = append(result.ProgramIDs, program.String())
	}
	for _, key := range normalized.SignerKeys {
		result.RequiredSigners = append(result.RequiredSigners, key.String())
	}
	if tx != nil {
		raw, err := tx.MarshalBinary()
		if err != nil {
			return ownerCeremonyResultV1{}, err
		}
		digest := sha256.Sum256(raw)
		result.UnsignedTxSHA256 = "sha256:" + hex.EncodeToString(digest[:])
	}
	return result, nil
}

func (s *signerStoreV2) reserveOwnerCeremonyV1(normalized normalizedOwnerCeremonyV1) (signerOperationV2, bool, error) {
	var operation signerOperationV2
	existing := false
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerOperationsV2)
		if raw := bucket.Get([]byte(normalized.Request.RequestID)); raw != nil {
			if err := json.Unmarshal(raw, &operation); err != nil {
				return err
			}
			if operation.IntentType != ownerCeremonyIntentTypeV1 || operation.WalletID != normalized.FeePayerID || operation.IntentDigest != normalized.Digest {
				return errors.New("requestId is already bound to a different immutable owner ceremony")
			}
			existing = true
			return nil
		}
		if tx.Bucket(bucketSignerOperationArchiveV2).Get(operationReplayArchiveKeyV2(normalized.Request.RequestID)) != nil {
			return errors.New("requestId is in the durable replay archive and cannot be reused")
		}
		now := timestampV2(s.now())
		operation = signerOperationV2{
			RequestID: normalized.Request.RequestID, WalletID: normalized.FeePayerID,
			IntentType: ownerCeremonyIntentTypeV1, IntentDigest: normalized.Digest,
			PolicyHash: "owner-ceremony-v1", Asset: "owner-ceremony", Amount: "0",
			State: operationReserved, ReservedAt: now, UpdatedAt: now,
		}
		encoded, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(operation.RequestID), encoded)
	})
	return operation, existing, err
}

func (s *signerServiceV2) prepareOwnerCeremonyV1(input ownerCeremonyRequestV1) (ownerCeremonyResultV1, error) {
	normalized, err := s.normalizeOwnerCeremonyV1(input)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	blockhash, err := signerLatestBlockhashWithFallbackV2(normalized.RPCURLs)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	tx, err := buildOwnerCeremonyTransactionV1(normalized, blockhash)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	if err := simulateOwnerCeremonyV1(normalized.RPCURLs, tx, false); err != nil {
		return ownerCeremonyResultV1{}, err
	}
	operation, _, err := s.store.reserveOwnerCeremonyV1(normalized)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	return ownerCeremonyResultFromV1(normalized, operation, tx, false)
}

func (s *signerServiceV2) executeOwnerCeremonyV1(input ownerCeremonyRequestV1) (ownerCeremonyResultV1, error) {
	normalized, err := s.normalizeOwnerCeremonyV1(input)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	operation, _, err := s.store.reserveOwnerCeremonyV1(normalized)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	if operation.State != operationReserved {
		return ownerCeremonyResultFromV1(normalized, operation, nil, operation.State != "")
	}
	operation, attempt, claimed, err := s.store.claimReservedOperation(operation.RequestID)
	if err != nil || !claimed {
		return ownerCeremonyResultFromV1(normalized, operation, nil, false)
	}
	blockhash, err := signerLatestBlockhashWithFallbackV2(normalized.RPCURLs)
	if err != nil {
		_, _ = s.store.releaseReservedOperationClaim(operation.RequestID, attempt, err)
		return ownerCeremonyResultV1{}, err
	}
	tx, err := buildOwnerCeremonyTransactionV1(normalized, blockhash)
	if err != nil {
		_, _ = s.store.markFailedClaim(operation.RequestID, attempt, err)
		return ownerCeremonyResultV1{}, err
	}
	privateKeys := make([]solana.PrivateKey, 0, len(normalized.SignerWallets))
	defer func() {
		for _, key := range privateKeys {
			zeroBytes(key)
		}
	}()
	for _, walletID := range normalized.SignerWallets {
		key, _, keyErr := s.keys.privateKey(walletID)
		if keyErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, keyErr)
			return ownerCeremonyResultV1{}, keyErr
		}
		privateKeys = append(privateKeys, key)
	}
	_, err = tx.PartialSign(func(publicKey solana.PublicKey) *solana.PrivateKey {
		for index := range privateKeys {
			if privateKeys[index].PublicKey().Equals(publicKey) {
				return &privateKeys[index]
			}
		}
		return nil
	})
	if err != nil || tx.VerifySignatures() != nil {
		failure := errors.New("owner ceremony could not produce every exact required signature")
		_, _ = s.store.markFailedClaim(operation.RequestID, attempt, failure)
		return ownerCeremonyResultV1{}, failure
	}
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	for index, signature := range tx.Signatures {
		if index >= len(tx.Message.AccountKeys) || signature.IsZero() || !ed25519.Verify(ed25519.PublicKey(tx.Message.AccountKeys[index][:]), message, signature[:]) {
			return ownerCeremonyResultV1{}, errors.New("owner ceremony signature verification failed")
		}
	}
	if err := simulateOwnerCeremonyV1(normalized.RPCURLs, tx, true); err != nil {
		_, _ = s.store.markFailedClaim(operation.RequestID, attempt, err)
		return ownerCeremonyResultV1{}, err
	}
	raw, err := tx.MarshalBinary()
	if err != nil || len(raw) == 0 || len(raw) > 1232 {
		return ownerCeremonyResultV1{}, errors.New("owner ceremony signed transaction is invalid or too large")
	}
	digest := sha256.Sum256(raw)
	operation, err = s.store.markBroadcastClaim(operation.RequestID, attempt, tx.Signatures[0].String(), "sha256:"+hex.EncodeToString(digest[:]), base64.StdEncoding.EncodeToString(raw))
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	if err := broadcastSignedOnceV2(normalized.RPCURLs, raw, tx.Signatures[0]); err != nil {
		operation, _ = s.store.markUnknown(operation.RequestID, errors.New("owner ceremony broadcast result is ambiguous"))
		return ownerCeremonyResultFromV1(normalized, operation, nil, true)
	}
	if err := confirmSignerSolanaSignatureAcrossRPCsV2(normalized.RPCURLs, tx.Signatures[0]); err != nil {
		operation, _ = s.store.markUnknown(operation.RequestID, err)
		return ownerCeremonyResultFromV1(normalized, operation, nil, true)
	}
	operation, err = s.store.markConfirmed(operation.RequestID)
	if err != nil {
		return ownerCeremonyResultV1{}, err
	}
	return ownerCeremonyResultFromV1(normalized, operation, nil, true)
}
