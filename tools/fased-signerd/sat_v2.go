package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

type signerSATAccountV2 struct {
	Pubkey     string `json:"pubkey"`
	IsSigner   bool   `json:"isSigner"`
	IsWritable bool   `json:"isWritable"`
}

type signerSATContextV2 struct {
	TargetAuthority      string   `json:"targetAuthority,omitempty"`
	DisputeAuthority     string   `json:"disputeAuthority,omitempty"`
	IntervalStartCycleID string   `json:"intervalStartCycleId,omitempty"`
	RegistryPageIndex    string   `json:"registryPageIndex,omitempty"`
	MinerAuthorities     []string `json:"minerAuthorities,omitempty"`
	PermanentMiningIDs   []string `json:"permanentMiningIds,omitempty"`
	FrontCycleIDs        []string `json:"frontCycleIds,omitempty"`
	BackCycleIDs         []string `json:"backCycleIds,omitempty"`
}

type signerSATInstructionV2 struct {
	Action     string               `json:"action"`
	ProgramID  string               `json:"programId"`
	DataBase64 string               `json:"dataBase64"`
	Keys       []signerSATAccountV2 `json:"keys"`
	Context    *signerSATContextV2  `json:"context,omitempty"`
}

type normalizedSATInstructionV2 struct {
	Wire        signerSATInstructionV2
	Program     solana.PublicKey
	Data        []byte
	Accounts    solana.AccountMetaSlice
	Codec       signerSATCodecV2
	Instruction solana.Instruction
}

func normalizeSATIntentV2(input signerIntentV2, wallet solana.PublicKey) (normalizedIntentV2, error) {
	if input.Destination != "" || input.Lamports != "" || input.TokenProgram != "" || input.Mint != "" || input.Amount != "" || input.Jupiter != nil || input.Federation != nil || input.LookupTable != nil {
		return normalizedIntentV2{}, errors.New("typed SAT intent rejects transfer, Jupiter, and federation fields")
	}
	isVaultBond := input.Type == intentSolanaVaultBondAction
	cluster := ""
	var err error
	if isVaultBond {
		cluster, err = normalizeSolanaClusterV2(input.Cluster)
		if err != nil {
			return normalizedIntentV2{}, err
		}
	} else if input.Cluster != "" {
		return normalizedIntentV2{}, errors.New("typed SAT mining intent rejects a cluster field")
	}
	action := strings.TrimSpace(input.Action)
	if action == "" {
		return normalizedIntentV2{}, errors.New("typed SAT action is required")
	}
	if input.SATCommitment != nil && (input.Type != intentSolanaSATAction || (action != "revealCycle" && action != "revealCycleV2") || len(input.Instructions) != 0) {
		return normalizedIntentV2{}, errors.New("signer-owned SAT commitment references are valid only for one revealCycle generation")
	}
	addressLookupTables := []string(nil)
	if len(input.AddressLookupTables) > 0 {
		if action != "distributeCyclePage" || isVaultBond || len(input.AddressLookupTables) != 1 {
			return normalizedIntentV2{}, errors.New("one address lookup table is allowed only for typed SAT distributeCyclePage")
		}
		addressLookupTables, err = normalizeSortedStringsV2(input.AddressLookupTables, func(raw string) (string, error) {
			return normalizePublicKeyV2(raw, "SAT distribution address lookup table")
		})
		if err != nil {
			return normalizedIntentV2{}, err
		}
	}

	var rawInstructions []signerSATInstructionV2
	if action == "cleanupBatch" {
		if isVaultBond {
			return normalizedIntentV2{}, errors.New("typed Vault bond intent cannot contain an instruction batch")
		}
		if strings.TrimSpace(input.ProgramID) != "" || strings.TrimSpace(input.DataBase64) != "" || len(input.Keys) != 0 || input.Context != nil {
			return normalizedIntentV2{}, errors.New("SAT cleanupBatch cannot contain a top-level raw instruction")
		}
		if len(input.Instructions) == 0 || len(input.Instructions) > 6 {
			return normalizedIntentV2{}, errors.New("SAT cleanupBatch requires one to six typed instructions")
		}
		rawInstructions = input.Instructions
	} else {
		if len(input.Instructions) != 0 {
			return normalizedIntentV2{}, errors.New("single SAT action cannot contain an instruction batch")
		}
		rawInstructions = []signerSATInstructionV2{{
			Action: action, ProgramID: input.ProgramID, DataBase64: input.DataBase64,
			Keys: input.Keys, Context: input.Context,
		}}
	}

	normalized := make([]normalizedSATInstructionV2, 0, len(rawInstructions))
	programSet := map[string]bool{}
	for _, raw := range rawInstructions {
		instruction, err := normalizeSATInstructionV2(raw, wallet)
		if err != nil {
			return normalizedIntentV2{}, err
		}
		if action == "cleanupBatch" {
			switch instruction.Codec.Action {
			case "closeResolvedMinerCycleState", "closeResolvedCycleRegistryPage", "closeResolvedCycleArtifacts",
				"closeResolvedMinerCycleStateV2", "closeResolvedCycleRegistryPageV2", "closeResolvedCycleArtifactsV2":
			default:
				return normalizedIntentV2{}, fmt.Errorf("SAT cleanupBatch rejects action %s", instruction.Codec.Action)
			}
		} else if instruction.Codec.Action != action {
			return normalizedIntentV2{}, fmt.Errorf("SAT action mismatch: envelope=%s instruction=%s", action, instruction.Codec.Action)
		}
		if isVaultBond && instruction.Codec.Family != satFamilyBond {
			return normalizedIntentV2{}, fmt.Errorf("typed Vault bond intent rejects non-bond action %s", instruction.Codec.Action)
		}
		if !isVaultBond && instruction.Codec.Family == satFamilyBond {
			return normalizedIntentV2{}, fmt.Errorf("typed SAT mining intent rejects Vault bond action %s", instruction.Codec.Action)
		}
		programSet[instruction.Program.String()] = true
		normalized = append(normalized, instruction)
	}
	if action == "cleanupBatch" && len(programSet) != 1 {
		return normalizedIntentV2{}, errors.New("SAT cleanupBatch instructions must use one program")
	}

	canonical := signerIntentV2{Type: input.Type, Action: action, Cluster: cluster, AddressLookupTables: addressLookupTables, SATCommitment: input.SATCommitment}
	if action == "cleanupBatch" {
		canonical.Instructions = make([]signerSATInstructionV2, 0, len(normalized))
		for _, instruction := range normalized {
			canonical.Instructions = append(canonical.Instructions, instruction.Wire)
		}
	} else {
		wire := normalized[0].Wire
		canonical.ProgramID = wire.ProgramID
		canonical.DataBase64 = wire.DataBase64
		canonical.Keys = wire.Keys
		canonical.Context = wire.Context
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(encoded)

	primaryProgram := normalized[0].Program.String()
	policyOperation := "sat." + action + "@" + primaryProgram
	requiredRole := "mining"
	if isVaultBond {
		policyOperation = "vaultBond." + action + "@" + primaryProgram
		requiredRole = "vault"
	}
	asset := "sat:action"
	amount := big.NewInt(int64(len(normalized)))
	destination := primaryProgram
	if action != "cleanupBatch" {
		data := normalized[0].Data
		if resolvedDestination, ok := satDestinationForActionV2(normalized[0], wallet); ok {
			destination = resolvedDestination.String()
		}
		switch action {
		case "depositMinerCapital", "topUpRegistryReserve":
			amount = new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[1:9]))
			if amount.Sign() <= 0 {
				return normalizedIntentV2{}, fmt.Errorf("SAT %s amount must be positive", action)
			}
			asset = "solana:native"
		case "openBondPosition", "increaseBondPosition":
			amount = new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[1:9]))
			if amount.Sign() <= 0 {
				return normalizedIntentV2{}, fmt.Errorf("SAT %s amount must be positive", action)
			}
			asset = "solana:spl:" + normalized[0].Accounts[5].PublicKey.String()
		case "setActiveCommit":
			amount = new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[1:9]))
			if amount.Sign() <= 0 {
				return normalizedIntentV2{}, errors.New("SAT setActiveCommit capital exposure must be positive")
			}
			asset = "sat:capital:lamports"
		default:
			if mint, ok := satMintForActionV2(normalized[0]); ok {
				asset = "sat:mint:" + mint.String()
			}
		}
	}

	requiredPrograms := make([]string, 0, len(programSet)+4)
	for program := range programSet {
		requiredPrograms = append(requiredPrograms, program)
	}
	for _, instruction := range normalized {
		requiredPrograms = append(requiredPrograms, additionalSATProgramsV2(instruction)...)
	}
	if len(addressLookupTables) > 0 {
		requiredPrograms = append(requiredPrograms, satAddressLookupTableProgramIDV2.String())
	}
	requiredPrograms, err = normalizeSortedStringsV2(requiredPrograms, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "SAT required program")
	})
	if err != nil {
		return normalizedIntentV2{}, err
	}
	goInstructions := make([]solana.Instruction, 0, len(normalized))
	for _, instruction := range normalized {
		goInstructions = append(goInstructions, instruction.Instruction)
	}
	return normalizedIntentV2{
		Intent: canonical, Digest: "sha256:" + hex.EncodeToString(digest[:]), Asset: asset,
		Amount: amount, RequiredPrograms: requiredPrograms, Destination: destination,
		Instructions: goInstructions, AddressLookupTables: publicKeysFromStringsV2(addressLookupTables),
		PolicyOperation: policyOperation, RequiredRole: requiredRole,
	}, nil
}

func publicKeysFromStringsV2(values []string) []solana.PublicKey {
	if len(values) == 0 {
		return nil
	}
	out := make([]solana.PublicKey, 0, len(values))
	for _, value := range values {
		out = append(out, solana.MustPublicKeyFromBase58(value))
	}
	return out
}

func satDestinationForActionV2(instruction normalizedSATInstructionV2, wallet solana.PublicKey) (solana.PublicKey, bool) {
	index := -1
	switch instruction.Codec.Action {
	case "topUpRegistryReserve", "depositMinerCapital", "setActiveCommit":
		index = 1
	case "initMinerCapital":
		index = 3
	case "openBondPosition", "increaseBondPosition":
		index = 2
	case "claimUnallocatedStakingRewards", "claimProtocolDistributorSat":
		index = 4
	case "claimProtocolTreasury":
		index = 6
	case "refillRegistryReserveFromTreasury":
		index = 3
	case "closeResolvedMinerCycleState":
		index = 2
	case "withdrawMinerCapital", "finalizeBondUnlock", "claimBondStakingRewards", "claimCycleRewards", "claimCycleRewardsBatch", "claimCycleRewardsV2", "claimCycleRewardsBatchV2":
		return wallet, true
	}
	if index < 0 || index >= len(instruction.Accounts) {
		return solana.PublicKey{}, false
	}
	return instruction.Accounts[index].PublicKey, true
}

func satMintForActionV2(instruction normalizedSATInstructionV2) (solana.PublicKey, bool) {
	index := -1
	switch instruction.Codec.Action {
	case "finalizeBondUnlock", "claimBondStakingRewards":
		index = 7
	case "syncBondStakingRewards":
		index = 2
	case "claimUnallocatedStakingRewards":
		index = 5
	case "claimCycleRewards", "claimProtocolTreasury":
		index = 8
	case "claimCycleRewardsBatch", "claimProtocolDistributorSat":
		index = 6
	case "claimCycleRewardsV2":
		index = 11
	case "claimCycleRewardsBatchV2":
		index = 9
	}
	if index < 0 || index >= len(instruction.Accounts) {
		return solana.PublicKey{}, false
	}
	return instruction.Accounts[index].PublicKey, true
}

func normalizeSATInstructionV2(input signerSATInstructionV2, wallet solana.PublicKey) (normalizedSATInstructionV2, error) {
	action := strings.TrimSpace(input.Action)
	codec, ok := signerSATCodecsV2[action]
	if !ok {
		if generated, generatedOK := signerSATCodecsGeneration2[action]; generatedOK {
			variable := ""
			switch action {
			case "settleCyclePageV2", "scoreCyclePageV2":
				variable = "vnextKeeperIdentityPairs"
			case "distributeCyclePageV2":
				variable = "vnextDistributionGroups"
			case "claimCycleRewardsBatchV2":
				variable = "vnextClaimBatch"
			}
			codec = signerSATCodecV2{
				Action: action, Discriminator: generated.Discriminator,
				DataLength: generated.DataLength, Family: satFamilyMain,
				ContractKey: action, AccountShape: generated.AccountShape, Variable: variable,
			}
			ok = true
		}
	}
	if !ok {
		return normalizedSATInstructionV2{}, fmt.Errorf("unsupported typed SAT action %q", action)
	}
	// Generation 2 retains the initMinerCapital discriminator but extends its
	// account contract with the permanent identity and AgentRecord binding.
	if action == "initMinerCapital" {
		codec.AccountShape = "SW,--,--,-W,--"
	}
	programText, err := normalizePublicKeyV2(input.ProgramID, "SAT programId")
	if err != nil {
		return normalizedSATInstructionV2{}, err
	}
	program := solana.MustPublicKeyFromBase58(programText)
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(input.DataBase64))
	if err != nil {
		return normalizedSATInstructionV2{}, errors.New("SAT dataBase64 is not canonical base64")
	}
	if len(data) == 0 || data[0] != codec.Discriminator {
		return normalizedSATInstructionV2{}, fmt.Errorf("SAT %s discriminator mismatch", action)
	}
	if codec.DataLength >= 0 && len(data) != codec.DataLength {
		return normalizedSATInstructionV2{}, fmt.Errorf("SAT %s payload must contain %d bytes", action, codec.DataLength)
	}

	keys := make([]signerSATAccountV2, 0, len(input.Keys))
	accounts := make(solana.AccountMetaSlice, 0, len(input.Keys))
	for index, raw := range input.Keys {
		keyText, err := normalizePublicKeyV2(raw.Pubkey, fmt.Sprintf("SAT account %d", index))
		if err != nil {
			return normalizedSATInstructionV2{}, err
		}
		key := solana.MustPublicKeyFromBase58(keyText)
		keys = append(keys, signerSATAccountV2{Pubkey: keyText, IsSigner: raw.IsSigner, IsWritable: raw.IsWritable})
		accounts = append(accounts, &solana.AccountMeta{PublicKey: key, IsSigner: raw.IsSigner, IsWritable: raw.IsWritable})
	}
	context, err := normalizeSATContextV2(input.Context)
	if err != nil {
		return normalizedSATInstructionV2{}, err
	}
	normalized := normalizedSATInstructionV2{
		Wire:    signerSATInstructionV2{Action: action, ProgramID: programText, DataBase64: base64.StdEncoding.EncodeToString(data), Keys: keys, Context: context},
		Program: program, Data: data, Accounts: accounts, Codec: codec,
	}
	if err := validateSATInstructionV2(normalized, wallet); err != nil {
		return normalizedSATInstructionV2{}, err
	}
	normalized.Instruction = solana.NewInstruction(program, accounts, data)
	return normalized, nil
}

func normalizeSATContextV2(input *signerSATContextV2) (*signerSATContextV2, error) {
	if input == nil {
		return nil, nil
	}
	out := &signerSATContextV2{}
	var err error
	if strings.TrimSpace(input.TargetAuthority) != "" {
		out.TargetAuthority, err = normalizePublicKeyV2(input.TargetAuthority, "SAT targetAuthority")
		if err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(input.DisputeAuthority) != "" {
		out.DisputeAuthority, err = normalizePublicKeyV2(input.DisputeAuthority, "SAT disputeAuthority")
		if err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(input.IntervalStartCycleID) != "" {
		out.IntervalStartCycleID, err = normalizeSATUintStringV2(input.IntervalStartCycleID, "intervalStartCycleId")
		if err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(input.RegistryPageIndex) != "" {
		out.RegistryPageIndex, err = normalizeSATUintStringV2(input.RegistryPageIndex, "registryPageIndex")
		if err != nil {
			return nil, err
		}
	}
	out.MinerAuthorities, err = normalizeSATPublicKeysV2(input.MinerAuthorities, "minerAuthorities")
	if err != nil {
		return nil, err
	}
	out.PermanentMiningIDs, err = normalizeSATPublicKeysV2(input.PermanentMiningIDs, "permanentMiningIds")
	if err != nil {
		return nil, err
	}
	out.FrontCycleIDs, err = normalizeSATUintStringsV2(input.FrontCycleIDs, "frontCycleIds")
	if err != nil {
		return nil, err
	}
	out.BackCycleIDs, err = normalizeSATUintStringsV2(input.BackCycleIDs, "backCycleIds")
	if err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeSATUintStringV2(raw, field string) (string, error) {
	value, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return "", fmt.Errorf("SAT %s must be a uint64 string", field)
	}
	return strconv.FormatUint(value, 10), nil
}

func normalizeSATUintStringsV2(values []string, field string) ([]string, error) {
	if values == nil {
		return nil, nil
	}
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value, err := normalizeSATUintStringV2(raw, field)
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

func normalizeSATPublicKeysV2(values []string, field string) ([]string, error) {
	if values == nil {
		return nil, nil
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, raw := range values {
		value, err := normalizePublicKeyV2(raw, "SAT "+field)
		if err != nil {
			return nil, err
		}
		if seen[value] {
			return nil, fmt.Errorf("SAT %s contains duplicate public key %s", field, value)
		}
		seen[value] = true
		out = append(out, value)
	}
	return out, nil
}

func additionalSATProgramsV2(instruction normalizedSATInstructionV2) []string {
	programs := []string{}
	for _, account := range instruction.Accounts {
		if account.PublicKey.Equals(solana.SystemProgramID) || account.PublicKey.Equals(solana.TokenProgramID) || account.PublicKey.Equals(solana.SPLAssociatedTokenAccountProgramID) {
			programs = append(programs, account.PublicKey.String())
		}
	}
	switch instruction.Codec.Action {
	case "claimCycleRewards":
		programs = append(programs, instruction.Accounts[13].PublicKey.String())
	case "claimCycleRewardsBatch", "claimCycleRewardsBatchV2":
		count := int(instruction.Data[1])
		programs = append(programs, instruction.Accounts[8+2*count+3].PublicKey.String())
	case "claimProtocolTreasury":
		programs = append(programs, instruction.Accounts[13].PublicKey.String())
	case "claimProtocolDistributorSat":
		programs = append(programs, instruction.Accounts[11].PublicKey.String(), instruction.Accounts[12].PublicKey.String())
	}
	return programs
}

func sortedSATActionsV2() []string {
	actions := make([]string, 0, len(signerSATCodecsV2))
	for action := range signerSATCodecsV2 {
		actions = append(actions, action)
	}
	sort.Strings(actions)
	return actions
}

func validateSATInstructionV2(instruction normalizedSATInstructionV2, wallet solana.PublicKey) error {
	if err := validateSATCanonicalPaddingV2(instruction.Codec.Action, instruction.Data); err != nil {
		return err
	}
	if err := validateSATContextForActionV2(instruction.Codec.Action, instruction.Wire.Context); err != nil {
		return err
	}
	if err := validateSATAccountShapeV2(instruction); err != nil {
		return err
	}
	if len(instruction.Accounts) > 0 && instruction.Accounts[0].IsSigner && !instruction.Accounts[0].PublicKey.Equals(wallet) {
		return errors.New("SAT instruction signer account does not match the signer-owned wallet")
	}
	return validateSATSemanticsV2(instruction, wallet)
}

func validateSATCanonicalPaddingV2(action string, data []byte) error {
	var padding []byte
	switch action {
	case "validatorAttestation":
		padding = data[27:33]
	case "openDispute":
		padding = data[19:25]
	case "revealCycle":
		padding = data[len(data)-4:]
	case "claimCycleRewardsBatch":
		if len(data) < 17 || data[1] == 0 || len(data) != 9+int(data[1])*8 {
			return errors.New("SAT claimCycleRewardsBatch item count does not match its payload")
		}
		seenCycles := make(map[uint64]bool, int(data[1]))
		for index := 0; index < int(data[1]); index++ {
			cycleID := satU64V2(data, 9+index*8)
			if seenCycles[cycleID] {
				return errors.New("SAT claimCycleRewardsBatch rejects duplicate cycle IDs")
			}
			seenCycles[cycleID] = true
		}
		padding = data[2:9]
	case "compactPendingCycleRange":
		padding = data[19:25]
	}
	for _, value := range padding {
		if value != 0 {
			return fmt.Errorf("SAT %s reserved padding must be zero", action)
		}
	}
	return nil
}

func validateSATContextForActionV2(action string, context *signerSATContextV2) error {
	allowed := map[string]bool{}
	required := map[string]bool{}
	switch action {
	case "validatorAttestation", "openDispute":
		allowed["targetAuthority"], required["targetAuthority"] = true, true
	case "resolveDispute":
		allowed["disputeAuthority"], required["disputeAuthority"] = true, true
	case "sealCycleEntropy":
		allowed["intervalStartCycleId"], required["intervalStartCycleId"] = true, true
	case "revealCycle":
		allowed["intervalStartCycleId"], required["intervalStartCycleId"] = true, true
		allowed["registryPageIndex"], required["registryPageIndex"] = true, true
	case "revealCycleV2":
		allowed["registryPageIndex"], required["registryPageIndex"] = true, true
		allowed["permanentMiningIds"], required["permanentMiningIds"] = true, true
	case "commitCycleV2", "claimCycleRewardsV2", "claimCycleRewardsBatchV2", "closeResolvedMinerCycleStateV2":
		allowed["permanentMiningIds"], required["permanentMiningIds"] = true, true
	case "releaseUnrevealedCommitV2", "recordAgentCycleReceiptV2":
		allowed["minerAuthorities"], required["minerAuthorities"] = true, true
		allowed["permanentMiningIds"], required["permanentMiningIds"] = true, true
	case "settleCyclePage", "scoreCyclePage", "distributeCyclePage":
		allowed["minerAuthorities"] = true
	case "settleCyclePageV2", "scoreCyclePageV2", "distributeCyclePageV2":
		allowed["minerAuthorities"], required["minerAuthorities"] = true, true
		allowed["permanentMiningIds"], required["permanentMiningIds"] = true, true
	case "compactPendingCycleRange":
		allowed["frontCycleIds"], required["frontCycleIds"] = true, true
		allowed["backCycleIds"], required["backCycleIds"] = true, true
	}
	if context == nil {
		if len(required) > 0 {
			return fmt.Errorf("SAT %s semantic context is required", action)
		}
		return nil
	}
	present := map[string]bool{
		"targetAuthority":      context.TargetAuthority != "",
		"disputeAuthority":     context.DisputeAuthority != "",
		"intervalStartCycleId": context.IntervalStartCycleID != "",
		"registryPageIndex":    context.RegistryPageIndex != "",
		"minerAuthorities":     len(context.MinerAuthorities) > 0,
		"permanentMiningIds":   len(context.PermanentMiningIDs) > 0,
		"frontCycleIds":        context.FrontCycleIDs != nil,
		"backCycleIds":         context.BackCycleIDs != nil,
	}
	for field, isPresent := range present {
		if isPresent && !allowed[field] {
			return fmt.Errorf("SAT %s rejects context field %s", action, field)
		}
		if required[field] && !isPresent {
			return fmt.Errorf("SAT %s requires context field %s", action, field)
		}
	}
	if (action == "settleCyclePageV2" || action == "scoreCyclePageV2" || action == "distributeCyclePageV2") && len(context.MinerAuthorities) != len(context.PermanentMiningIDs) {
		return fmt.Errorf("SAT %s identity context length mismatch", action)
	}
	if len(allowed) == 0 {
		return fmt.Errorf("SAT %s does not accept semantic context", action)
	}
	return nil
}

func validateSATAccountShapeV2(instruction normalizedSATInstructionV2) error {
	shape := strings.Split(instruction.Codec.AccountShape, ",")
	expected := len(shape)
	fixedShapeLength := len(shape)
	context := instruction.Wire.Context
	switch instruction.Codec.Variable {
	case "":
		if len(instruction.Accounts) != expected {
			return fmt.Errorf("SAT %s requires %d accounts, got %d", instruction.Codec.Action, expected, len(instruction.Accounts))
		}
	case "minerCycles":
		count := 0
		if context != nil {
			count = len(context.MinerAuthorities)
		}
		expected += count
		if len(instruction.Accounts) != expected {
			return fmt.Errorf("SAT %s miner account count mismatch", instruction.Codec.Action)
		}
	case "registryPages":
		if len(instruction.Accounts) < expected || len(instruction.Accounts) > expected+64 {
			return fmt.Errorf("SAT %s registry page count is invalid", instruction.Codec.Action)
		}
	case "minerCyclePairs":
		count := 0
		if context != nil {
			count = len(context.MinerAuthorities)
		}
		expected += count * 2
		if len(instruction.Accounts) != expected {
			return fmt.Errorf("SAT %s miner account pair count mismatch", instruction.Codec.Action)
		}
	case "vnextKeeperIdentityPairs":
		fixedShapeLength -= 2
		expected -= 2
		count := 0
		if context != nil {
			count = len(context.MinerAuthorities)
		}
		expected += count * 2
		if len(instruction.Accounts) != expected {
			return fmt.Errorf("SAT %s vNext keeper identity account count mismatch", instruction.Codec.Action)
		}
	case "vnextDistributionGroups":
		fixedShapeLength -= 5
		expected -= 5
		count := 0
		if context != nil {
			count = len(context.MinerAuthorities)
		}
		expected += count * 5
		if len(instruction.Accounts) != expected {
			return fmt.Errorf("SAT %s vNext distribution account count mismatch", instruction.Codec.Action)
		}
	case "claimBatch":
		count := int(instruction.Data[1])
		expected += count*2 + 5
		if len(instruction.Accounts) != expected {
			return errors.New("SAT claimCycleRewardsBatch account count mismatch")
		}
	case "vnextClaimBatch":
		count := int(instruction.Data[1])
		expected = len(shape) - 2 + count*2
		if len(instruction.Accounts) != expected {
			return errors.New("SAT claimCycleRewardsBatchV2 account count mismatch")
		}
		for index := 0; index < 11; index++ {
			if err := expectSATFlagsV2(instruction, index, shape[index]); err != nil {
				return err
			}
		}
		for index := 0; index < count*2; index++ {
			if err := expectSATFlagsV2(instruction, 11+index, "-W"); err != nil {
				return err
			}
		}
		for index, flags := range shape[13:] {
			if err := expectSATFlagsV2(instruction, 11+count*2+index, flags); err != nil {
				return err
			}
		}
		return nil
	case "compactCycles":
		if context == nil {
			return errors.New("SAT compactPendingCycleRange context is required")
		}
		expected += len(context.FrontCycleIDs) + len(context.BackCycleIDs)
		if len(instruction.Accounts) != expected {
			return errors.New("SAT compactPendingCycleRange account count mismatch")
		}
	default:
		return errors.New("invalid generated SAT account shape")
	}
	for index, flags := range shape[:fixedShapeLength] {
		if err := expectSATFlagsV2(instruction, index, flags); err != nil {
			return err
		}
	}
	base := fixedShapeLength
	switch instruction.Codec.Variable {
	case "minerCycles", "registryPages", "compactCycles":
		for index := base; index < len(instruction.Accounts); index++ {
			flags := "--"
			if instruction.Codec.Variable == "minerCycles" {
				flags = "-W"
			}
			if err := expectSATFlagsV2(instruction, index, flags); err != nil {
				return err
			}
		}
	case "minerCyclePairs":
		for index := base; index < len(instruction.Accounts); index++ {
			if err := expectSATFlagsV2(instruction, index, "-W"); err != nil {
				return err
			}
		}
	case "vnextKeeperIdentityPairs":
		for index := base; index < len(instruction.Accounts); index++ {
			if err := expectSATFlagsV2(instruction, index, "-W"); err != nil {
				return err
			}
		}
	case "vnextDistributionGroups":
		for index := base; index < len(instruction.Accounts); index++ {
			flags := "-W"
			if (index-base)%5 == 2 {
				flags = "--"
			}
			if err := expectSATFlagsV2(instruction, index, flags); err != nil {
				return err
			}
		}
	case "claimBatch":
		count := int(instruction.Data[1])
		for index := base; index < base+count*2; index += 2 {
			if err := expectSATFlagsV2(instruction, index, "--"); err != nil {
				return err
			}
			if err := expectSATFlagsV2(instruction, index+1, "-W"); err != nil {
				return err
			}
		}
		for offset, flags := range []string{"--", "--", "--", "--", "-W"} {
			if err := expectSATFlagsV2(instruction, base+count*2+offset, flags); err != nil {
				return err
			}
		}
	}
	return nil
}

func expectSATFlagsV2(instruction normalizedSATInstructionV2, index int, flags string) error {
	if index < 0 || index >= len(instruction.Accounts) || len(flags) != 2 {
		return errors.New("invalid generated SAT account flag check")
	}
	wantSigner := flags[0] == 'S'
	wantWritable := flags[1] == 'W'
	account := instruction.Accounts[index]
	if account.IsSigner != wantSigner || account.IsWritable != wantWritable {
		return fmt.Errorf("SAT %s account %d signer/writable flags mismatch", instruction.Codec.Action, index)
	}
	return nil
}

func satU64BytesV2(data []byte, offset int) []byte { return data[offset : offset+8] }

func satU64V2(data []byte, offset int) uint64 {
	return binary.LittleEndian.Uint64(satU64BytesV2(data, offset))
}

func satPublicKeyV2(data []byte, offset int) solana.PublicKey {
	var key solana.PublicKey
	copy(key[:], data[offset:offset+32])
	return key
}

func satContextU64V2(raw string) uint64 { value, _ := strconv.ParseUint(raw, 10, 64); return value }

func satU64SeedV2(value uint64) []byte {
	out := make([]byte, 8)
	binary.LittleEndian.PutUint64(out, value)
	return out
}

func expectSATKeyV2(instruction normalizedSATInstructionV2, index int, expected solana.PublicKey, label string) error {
	if index >= len(instruction.Accounts) || !instruction.Accounts[index].PublicKey.Equals(expected) {
		return fmt.Errorf("SAT %s account %d must be %s", instruction.Codec.Action, index, label)
	}
	return nil
}

func expectSATPDAV2(instruction normalizedSATInstructionV2, index int, program solana.PublicKey, label string, seeds ...[]byte) error {
	expected, _, err := solana.FindProgramAddress(seeds, program)
	if err != nil {
		return fmt.Errorf("derive SAT %s PDA: %w", label, err)
	}
	return expectSATKeyV2(instruction, index, expected, label)
}

func expectSATATAV2(instruction normalizedSATInstructionV2, index int, owner, mint solana.PublicKey, label string) error {
	expected, err := findAssociatedTokenAddressV2(owner, mint, solana.TokenProgramID)
	if err != nil {
		return err
	}
	return expectSATKeyV2(instruction, index, expected, label)
}

func firstSATErrorV2(checks ...error) error {
	for _, err := range checks {
		if err != nil {
			return err
		}
	}
	return nil
}

func validateSATSemanticsV2(ix normalizedSATInstructionV2, wallet solana.PublicKey) error {
	p := ix.Program
	d := ix.Data
	c := ix.Wire.Context
	var minerAuthorities []string
	if c != nil {
		minerAuthorities = c.MinerAuthorities
	}
	system := solana.SystemProgramID
	token := solana.TokenProgramID
	ataProgram := solana.SPLAssociatedTokenAccountProgramID
	switch ix.Codec.Action {
	case "initializeCycle":
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "round bucket", []byte("sat_round_bucket")),
			expectSATPDAV2(ix, 2, p, "epoch", []byte("sat_epoch"), satU64BytesV2(d, 1)),
			expectSATKeyV2(ix, 3, system, "system program"),
		)
	case "validatorAttestation":
		target := solana.MustPublicKeyFromBase58(c.TargetAuthority)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "epoch", []byte("sat_epoch"), satU64BytesV2(d, 1)),
			expectSATPDAV2(ix, 2, p, "validator attestation", []byte("sat_validator_attestation"), wallet[:], target[:], satU64BytesV2(d, 1), satU64BytesV2(d, 9)),
			expectSATPDAV2(ix, 3, p, "mining stake", []byte("mining_stake"), target[:]),
			expectSATKeyV2(ix, 4, system, "system program"),
		)
	case "openDispute":
		target := solana.MustPublicKeyFromBase58(c.TargetAuthority)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "epoch", []byte("sat_epoch"), satU64BytesV2(d, 1)),
			expectSATPDAV2(ix, 2, p, "dispute", []byte("sat_dispute"), wallet[:], target[:], satU64BytesV2(d, 1), satU64BytesV2(d, 9)),
			expectSATPDAV2(ix, 3, p, "mining stake", []byte("mining_stake"), target[:]),
			expectSATKeyV2(ix, 4, system, "system program"),
		)
	case "resolveDispute":
		disputeAuthority := solana.MustPublicKeyFromBase58(c.DisputeAuthority)
		target := satPublicKeyV2(d, 25)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "mining pool", []byte("mining_pool")),
			expectSATPDAV2(ix, 2, p, "epoch", []byte("sat_epoch"), satU64BytesV2(d, 1)),
			expectSATPDAV2(ix, 3, p, "dispute", []byte("sat_dispute"), disputeAuthority[:], target[:], satU64BytesV2(d, 1), satU64BytesV2(d, 9)),
		)
	case "republishEpochRoots":
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "mining pool", []byte("mining_pool")),
			expectSATPDAV2(ix, 2, p, "epoch", []byte("sat_epoch"), satU64BytesV2(d, 1)),
		)
	case "topUpRegistryReserve":
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "registry reserve", []byte("sat_registry_reserve")),
			expectSATKeyV2(ix, 2, system, "system program"),
		)
	case "openCycle":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 4, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 5, p, "registry reserve", []byte("sat_registry_reserve")),
			expectSATKeyV2(ix, 6, system, "system program"),
			expectSATPDAV2(ix, 7, p, "treasury vault", []byte("sat_treasury_vault")),
		)
	case "initMinerCapital":
		authority := satPublicKeyV2(d, 1)
		if authority.IsZero() {
			return errors.New("SAT initMinerCapital authority cannot be zero")
		}
		permanentMiningID := ix.Accounts[1].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 2, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 3, p, "miner capital", []byte("sat_miner_capital_state"), authority[:]),
			expectSATKeyV2(ix, 4, system, "system program"),
		)
	case "depositMinerCapital", "withdrawMinerCapital":
		if satU64V2(d, 1) == 0 {
			return fmt.Errorf("SAT %s amount must be positive", ix.Codec.Action)
		}
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATKeyV2(ix, 2, system, "system program"),
		)
	case "setActiveCommit":
		if satU64V2(d, 1) == 0 {
			return errors.New("SAT setActiveCommit capital exposure must be positive")
		}
		return expectSATPDAV2(ix, 1, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:])
	case "updateBondTierPolicy":
		if !satPublicKeyV2(d, 1).Equals(wallet) {
			return errors.New("SAT bond tier update authority must match signer wallet")
		}
		return expectSATPDAV2(ix, 1, p, "bond tier policy", []byte("sat_bond_tier_policy"))
	case "openBondPosition", "increaseBondPosition":
		if satU64V2(d, 1) == 0 {
			return fmt.Errorf("SAT %s amount must be positive", ix.Codec.Action)
		}
		position := ix.Accounts[2].PublicKey
		mint := ix.Accounts[5].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "bond tier policy", []byte("sat_bond_tier_policy")),
			expectSATPDAV2(ix, 2, p, "bond position", []byte("sat_bond_position"), wallet[:]),
			expectSATATAV2(ix, 3, wallet, mint, "signer SAT token account"),
			expectSATATAV2(ix, 4, position, mint, "bond vault"),
			expectSATKeyV2(ix, 6, system, "system program"),
			expectSATKeyV2(ix, 7, token, "SPL token program"),
			expectSATKeyV2(ix, 8, ataProgram, "associated token program"),
		)
	case "requestBondUnlock", "cancelBondUnlock":
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "bond tier policy", []byte("sat_bond_tier_policy")),
			expectSATPDAV2(ix, 2, p, "bond position", []byte("sat_bond_position"), wallet[:]),
			expectSATPDAV2(ix, 3, p, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATPDAV2(ix, 4, p, "bond staking position", []byte("sat_bond_staking_position"), wallet[:]),
		)
	case "finalizeBondUnlock":
		position := ix.Accounts[2].PublicKey
		mint := ix.Accounts[7].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "bond tier policy", []byte("sat_bond_tier_policy")),
			expectSATPDAV2(ix, 2, p, "bond position", []byte("sat_bond_position"), wallet[:]),
			expectSATPDAV2(ix, 3, p, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATPDAV2(ix, 4, p, "bond staking position", []byte("sat_bond_staking_position"), wallet[:]),
			expectSATATAV2(ix, 5, position, mint, "bond vault"),
			expectSATATAV2(ix, 6, wallet, mint, "signer SAT token account"),
			expectSATKeyV2(ix, 8, system, "system program"),
			expectSATKeyV2(ix, 9, token, "SPL token program"),
			expectSATKeyV2(ix, 10, ataProgram, "associated token program"),
		)
	case "syncBondStakingRewards":
		distributor := ix.Accounts[0].PublicKey
		mint := ix.Accounts[2].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 0, p, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATATAV2(ix, 1, distributor, mint, "bond staking reward vault"),
		)
	case "syncBondStakingPosition":
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "bond tier policy", []byte("sat_bond_tier_policy")),
			expectSATPDAV2(ix, 2, p, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATPDAV2(ix, 3, p, "bond staking position", []byte("sat_bond_staking_position"), wallet[:]),
			expectSATPDAV2(ix, 4, p, "bond position", []byte("sat_bond_position"), wallet[:]),
			expectSATKeyV2(ix, 5, system, "system program"),
		)
	case "claimBondStakingRewards":
		distributor := ix.Accounts[2].PublicKey
		mint := ix.Accounts[7].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "bond tier policy", []byte("sat_bond_tier_policy")),
			expectSATPDAV2(ix, 2, p, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATPDAV2(ix, 3, p, "bond staking position", []byte("sat_bond_staking_position"), wallet[:]),
			expectSATPDAV2(ix, 4, p, "bond position", []byte("sat_bond_position"), wallet[:]),
			expectSATATAV2(ix, 5, distributor, mint, "bond staking reward vault"),
			expectSATATAV2(ix, 6, wallet, mint, "signer SAT token account"),
			expectSATKeyV2(ix, 8, system, "system program"),
			expectSATKeyV2(ix, 9, token, "SPL token program"),
			expectSATKeyV2(ix, 10, ataProgram, "associated token program"),
		)
	case "claimUnallocatedStakingRewards":
		distributor := ix.Accounts[1].PublicKey
		owner := ix.Accounts[4].PublicKey
		mint := ix.Accounts[5].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATATAV2(ix, 2, distributor, mint, "bond staking reward vault"),
			expectSATATAV2(ix, 3, owner, mint, "staking recipient token account"),
			expectSATKeyV2(ix, 6, system, "system program"),
			expectSATKeyV2(ix, 7, token, "SPL token program"),
			expectSATKeyV2(ix, 8, ataProgram, "associated token program"),
		)
	case "openCycleV2":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "global state v2", []byte("sat_global_state_v2")),
			expectSATPDAV2(ix, 2, p, "protocol generation v2", []byte("sat_protocol_generation_state_v2")),
			expectSATPDAV2(ix, 3, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 4, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 5, p, "treasury state v2", []byte("sat_treasury_state_v2")),
			expectSATPDAV2(ix, 6, p, "registry reserve v2", []byte("sat_registry_reserve_v2")),
			expectSATKeyV2(ix, 7, system, "system program"),
		)
	case "commitCycleV2":
		cycle := satU64BytesV2(d, 1)
		permanentMiningID := ix.Accounts[1].PublicKey
		if permanentMiningID.IsZero() {
			return errors.New("SAT commitCycleV2 permanent mining identity cannot be zero")
		}
		return firstSATErrorV2(
			expectSATPDAV2(ix, 2, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 3, p, "protocol generation v2", []byte("sat_protocol_generation_state_v2")),
			expectSATPDAV2(ix, 4, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 5, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), wallet[:], cycle),
			expectSATPDAV2(ix, 6, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 7, p, "keeper operating reserve", []byte("sat_keeper_operating_reserve"), permanentMiningID[:]),
			expectSATPDAV2(ix, 8, p, "agent reward remainder v2", []byte("sat_agent_reward_remainder_v2"), permanentMiningID[:]),
			expectSATKeyV2(ix, 9, system, "system program"),
		)
	case "closeCommitPhaseV2":
		return expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), satU64BytesV2(d, 1))
	case "sealCycleEntropyV2":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 2, p, "keeper snapshot", []byte("sat_keeper_snapshot"), cycle),
			expectSATKeyV2(ix, 3, solana.SysVarSlotHashesPubkey, "slot hashes sysvar"),
		)
	case "revealCycleV2":
		cycle := satU64BytesV2(d, 1)
		page := satU64SeedV2(satContextU64V2(c.RegistryPageIndex))
		if len(c.PermanentMiningIDs) != 1 {
			return errors.New("SAT revealCycleV2 requires one permanent mining identity")
		}
		permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[0])
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 4, p, "cycle settlement progress v3", []byte("sat_cycle_settlement_progress_v3"), cycle),
			expectSATPDAV2(ix, 5, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), wallet[:], cycle),
			expectSATPDAV2(ix, 6, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 7, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 8, p, "registry reserve v2", []byte("sat_registry_reserve_v2")),
			expectSATKeyV2(ix, 9, system, "system program"),
		)
	case "snapshotKeeperCapabilitiesV2":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 2, p, "keeper registry", []byte("sat_keeper_registry")),
			expectSATPDAV2(ix, 3, p, "keeper snapshot", []byte("sat_keeper_snapshot"), cycle),
			expectSATPDAV2(ix, 4, p, "registry reserve v2", []byte("sat_registry_reserve_v2")),
			expectSATKeyV2(ix, 5, system, "system program"),
		)
	case "releaseUnrevealedCommitV2":
		cycle := satU64BytesV2(d, 1)
		permanentMiningID := satPublicKeyV2(d, 9)
		if len(minerAuthorities) != 1 || len(c.PermanentMiningIDs) != 1 {
			return errors.New("SAT releaseUnrevealedCommitV2 requires one miner and permanent identity")
		}
		authority := solana.MustPublicKeyFromBase58(minerAuthorities[0])
		if c.PermanentMiningIDs[0] != permanentMiningID.String() || ix.Accounts[1].PublicKey != permanentMiningID {
			return errors.New("SAT releaseUnrevealedCommitV2 permanent identity mismatch")
		}
		return firstSATErrorV2(
			expectSATPDAV2(ix, 2, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 3, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 4, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), authority[:], cycle),
			expectSATPDAV2(ix, 5, p, "miner capital", []byte("sat_miner_capital_state"), authority[:]),
			expectSATPDAV2(ix, 6, p, "keeper operating reserve", []byte("sat_keeper_operating_reserve"), permanentMiningID[:]),
			expectSATPDAV2(ix, 7, p, "treasury state v2", []byte("sat_treasury_state_v2")),
			expectSATPDAV2(ix, 8, p, "treasury vault v2", []byte("sat_treasury_vault_v2")),
		)
	case "abortEmptyCycleV2":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
		)
	case "claimCycleRewardsV2":
		cycle := satU64BytesV2(d, 1)
		if len(c.PermanentMiningIDs) != 1 || ix.Accounts[1].PublicKey != wallet {
			return errors.New("SAT claimCycleRewardsV2 requires the active miner and one permanent identity")
		}
		permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[0])
		mint, mintProgram := ix.Accounts[11].PublicKey, ix.Accounts[16].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 2, p, "global state v2", []byte("sat_global_state_v2")),
			expectSATPDAV2(ix, 3, p, "protocol generation v2", []byte("sat_protocol_generation_state_v2")),
			expectSATPDAV2(ix, 4, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 5, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), wallet[:], cycle),
			expectSATPDAV2(ix, 6, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 7, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 8, p, "mint caller treasury", []byte("treasury")),
			expectSATPDAV2(ix, 9, p, "treasury state v2", []byte("sat_treasury_state_v2")),
			expectSATPDAV2(ix, 10, mintProgram, "mint authority", []byte("authority")),
			expectSATATAV2(ix, 12, wallet, mint, "fixed SAT reward destination"),
			expectSATKeyV2(ix, 13, system, "system program"),
			expectSATKeyV2(ix, 14, token, "SPL token program"),
			expectSATKeyV2(ix, 15, ataProgram, "associated token program"),
			expectSATPDAV2(ix, 17, p, "rebate vault v2", []byte("sat_rebate_vault_v2")),
		)
	case "claimCycleRewardsBatchV2":
		count := int(d[1])
		if len(c.PermanentMiningIDs) != 1 || ix.Accounts[1].PublicKey != wallet {
			return errors.New("SAT claimCycleRewardsBatchV2 requires the active miner and one permanent identity")
		}
		permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[0])
		checks := []error{
			expectSATPDAV2(ix, 2, p, "global state v2", []byte("sat_global_state_v2")),
			expectSATPDAV2(ix, 3, p, "protocol generation v2", []byte("sat_protocol_generation_state_v2")),
			expectSATPDAV2(ix, 4, p, "mint caller treasury", []byte("treasury")),
			expectSATPDAV2(ix, 5, p, "treasury state v2", []byte("sat_treasury_state_v2")),
			expectSATPDAV2(ix, 6, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 7, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
		}
		for index := 0; index < count; index++ {
			cycle := d[9+index*8 : 17+index*8]
			checks = append(checks,
				expectSATPDAV2(ix, 11+index*2, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
				expectSATPDAV2(ix, 12+index*2, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), wallet[:], cycle),
			)
		}
		programBase := 11 + count*2
		mint, mintProgram := ix.Accounts[9].PublicKey, ix.Accounts[programBase+3].PublicKey
		checks = append(checks,
			expectSATPDAV2(ix, 8, mintProgram, "mint authority", []byte("authority")),
			expectSATATAV2(ix, 10, wallet, mint, "fixed SAT reward destination"),
			expectSATKeyV2(ix, programBase, system, "system program"),
			expectSATKeyV2(ix, programBase+1, token, "SPL token program"),
			expectSATKeyV2(ix, programBase+2, ataProgram, "associated token program"),
			expectSATPDAV2(ix, programBase+4, p, "rebate vault v2", []byte("sat_rebate_vault_v2")),
		)
		return firstSATErrorV2(checks...)
	case "closeResolvedMinerCycleStateV2":
		cycle := satU64BytesV2(d, 1)
		authority := ix.Accounts[2].PublicKey
		if len(c.PermanentMiningIDs) != 1 {
			return errors.New("SAT closeResolvedMinerCycleStateV2 requires one permanent identity")
		}
		permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[0])
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 3, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), authority[:], cycle),
			expectSATPDAV2(ix, 4, p, "miner capital", []byte("sat_miner_capital_state"), authority[:]),
			expectSATPDAV2(ix, 5, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 6, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
		)
	case "closeResolvedCycleRegistryPageV2":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 4, p, "registry reserve v2", []byte("sat_registry_reserve_v2")),
		)
	case "closeResolvedCycleArtifactsV2":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle settlement progress v3", []byte("sat_cycle_settlement_progress_v3"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 4, p, "keeper snapshot", []byte("sat_keeper_snapshot"), cycle),
			expectSATPDAV2(ix, 5, p, "registry reserve v2", []byte("sat_registry_reserve_v2")),
		)
	case "recordAgentCycleReceiptV2":
		cycle := satU64BytesV2(d, 1)
		if len(minerAuthorities) != 1 || len(c.PermanentMiningIDs) != 1 {
			return errors.New("SAT recordAgentCycleReceiptV2 requires one miner and permanent identity")
		}
		authority := solana.MustPublicKeyFromBase58(minerAuthorities[0])
		permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[0])
		if ix.Accounts[1].PublicKey != permanentMiningID {
			return errors.New("SAT recordAgentCycleReceiptV2 permanent identity mismatch")
		}
		return firstSATErrorV2(
			expectSATPDAV2(ix, 2, p, "agent record", []byte("sat_agent_record"), permanentMiningID[:]),
			expectSATPDAV2(ix, 3, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 4, p, "miner cycle state v2", []byte("sat_miner_cycle_state_v2"), authority[:], cycle),
			expectSATPDAV2(ix, 5, p, "cycle settlement progress v3", []byte("sat_cycle_settlement_progress_v3"), cycle),
		)
	case "commitCycle":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "miner cycle state", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 3, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATKeyV2(ix, 4, system, "system program"),
		)
	case "closeCommitPhase":
		return expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), satU64BytesV2(d, 1))
	case "sealCycleEntropy":
		interval := satU64SeedV2(satContextU64V2(c.IntervalStartCycleID))
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), satU64BytesV2(d, 1)),
			expectSATPDAV2(ix, 2, p, "unlock interval", []byte("sat_unlock_interval_state"), interval),
			expectSATKeyV2(ix, 3, solana.SysVarSlotHashesPubkey, "slot hashes sysvar"),
		)
	case "releaseUnrevealedCommit":
		cycle := satU64BytesV2(d, 1)
		miner := satPublicKeyV2(d, 9)
		if miner.IsZero() {
			return errors.New("SAT releaseUnrevealedCommit miner authority cannot be zero")
		}
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "miner cycle state", []byte("sat_miner_cycle_state"), miner[:], cycle),
			expectSATPDAV2(ix, 3, p, "miner capital", []byte("sat_miner_capital_state"), miner[:]),
			expectSATPDAV2(ix, 4, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 5, p, "treasury vault", []byte("sat_treasury_vault")),
		)
	case "abortEmptyCycle":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
		)
	case "revealCycle":
		cycle := satU64BytesV2(d, 1)
		page := satU64SeedV2(satContextU64V2(c.RegistryPageIndex))
		interval := satU64SeedV2(satContextU64V2(c.IntervalStartCycleID))
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 4, p, "cycle settlement progress", []byte("sat_cycle_settlement_progress_v2"), cycle),
			expectSATPDAV2(ix, 5, p, "miner cycle state", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 6, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 7, p, "unlock interval", []byte("sat_unlock_interval_state"), interval),
			expectSATPDAV2(ix, 8, p, "registry reserve", []byte("sat_registry_reserve")),
			expectSATKeyV2(ix, 9, system, "system program"),
		)
	case "settleCyclePage":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		checks := []error{
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 4, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 5, p, "cycle settlement progress", []byte("sat_cycle_settlement_progress_v2"), cycle),
			expectSATPDAV2(ix, 6, p, "registry reserve", []byte("sat_registry_reserve")),
			expectSATPDAV2(ix, 7, p, "treasury state", []byte("sat_treasury_state")),
			expectSATKeyV2(ix, 8, system, "system program"),
			expectSATPDAV2(ix, 9, p, "signer miner cycle", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 10, p, "signer miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 11, p, "rebate vault", []byte("sat_rebate_vault")),
		}
		for index, authorityText := range minerAuthorities {
			authority := solana.MustPublicKeyFromBase58(authorityText)
			checks = append(checks, expectSATPDAV2(ix, 12+index, p, "settlement miner cycle", []byte("sat_miner_cycle_state"), authority[:], cycle))
		}
		return firstSATErrorV2(checks...)
	case "settleCyclePageV2", "scoreCyclePageV2":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		progressIndex, pageIndex := 5, 4
		minerBase := 8
		if ix.Codec.Action == "scoreCyclePageV2" {
			progressIndex, pageIndex = 4, 3
			minerBase = 7
		}
		checks := []error{
			expectSATPDAV2(ix, 2, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, pageIndex, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, progressIndex, p, "cycle settlement progress v3", []byte("sat_cycle_settlement_progress_v3"), cycle),
		}
		if ix.Codec.Action == "settleCyclePageV2" {
			checks = append(checks, expectSATPDAV2(ix, 3, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle))
		}
		checks = append(checks, expectSATPDAV2(ix, progressIndex+1, p, "keeper snapshot", []byte("sat_keeper_snapshot"), cycle))
		for index, authorityText := range minerAuthorities {
			authority := solana.MustPublicKeyFromBase58(authorityText)
			permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[index])
			offset := minerBase + index*2
			checks = append(checks,
				expectSATPDAV2(ix, offset, p, "miner cycle v2", []byte("sat_miner_cycle_state_v2"), authority[:], cycle),
				expectSATPDAV2(ix, offset+1, p, "keeper operating reserve", []byte("sat_keeper_operating_reserve"), permanentMiningID[:]),
			)
		}
		return firstSATErrorV2(checks...)
	case "finalizeCycleSettlementV2":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 2, p, "global state v2", []byte("sat_global_state_v2")),
			expectSATPDAV2(ix, 3, p, "protocol generation v2", []byte("sat_protocol_generation_state_v2")),
			expectSATPDAV2(ix, 4, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 5, p, "cycle settlement progress v3", []byte("sat_cycle_settlement_progress_v3"), cycle),
			expectSATPDAV2(ix, 6, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 7, p, "treasury state v2", []byte("sat_treasury_state_v2")),
			expectSATPDAV2(ix, 8, p, "rebate vault v2", []byte("sat_rebate_vault_v2")),
			expectSATPDAV2(ix, 9, p, "treasury vault v2", []byte("sat_treasury_vault_v2")),
			expectSATPDAV2(ix, 12, p, "keeper snapshot", []byte("sat_keeper_snapshot"), cycle),
		)
	case "distributeCyclePageV2":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		checks := []error{
			expectSATPDAV2(ix, 2, p, "cycle state v2", []byte("sat_cycle_state_v2"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 4, p, "cycle settlement progress v3", []byte("sat_cycle_settlement_progress_v3"), cycle),
			expectSATPDAV2(ix, 5, p, "treasury state v2", []byte("sat_treasury_state_v2")),
			expectSATPDAV2(ix, 6, p, "rebate vault v2", []byte("sat_rebate_vault_v2")),
			expectSATPDAV2(ix, 7, p, "treasury vault v2", []byte("sat_treasury_vault_v2")),
			expectSATPDAV2(ix, 8, p, "keeper snapshot", []byte("sat_keeper_snapshot"), cycle),
		}
		const base = 10
		for index, authorityText := range minerAuthorities {
			authority := solana.MustPublicKeyFromBase58(authorityText)
			permanentMiningID := solana.MustPublicKeyFromBase58(c.PermanentMiningIDs[index])
			offset := base + index*5
			checks = append(checks,
				expectSATPDAV2(ix, offset, p, "distribution miner cycle v2", []byte("sat_miner_cycle_state_v2"), authority[:], cycle),
				expectSATPDAV2(ix, offset+1, p, "distribution miner capital", []byte("sat_miner_capital_state"), authority[:]),
				expectSATPDAV2(ix, offset+2, p, "distribution agent record", []byte("sat_agent_record"), permanentMiningID[:]),
				expectSATPDAV2(ix, offset+3, p, "distribution reward remainder v2", []byte("sat_agent_reward_remainder_v2"), permanentMiningID[:]),
				expectSATPDAV2(ix, offset+4, p, "distribution keeper operating reserve", []byte("sat_keeper_operating_reserve"), permanentMiningID[:]),
			)
		}
		return firstSATErrorV2(checks...)
	case "claimProtocolTreasury":
		owner, mint := ix.Accounts[6].PublicKey, ix.Accounts[8].PublicKey
		mintProgram := ix.Accounts[13].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "treasury", []byte("treasury")),
			expectSATPDAV2(ix, 3, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 4, p, "treasury vault", []byte("sat_treasury_vault")),
			expectSATPDAV2(ix, 5, p, "registry reserve", []byte("sat_registry_reserve")),
			expectSATPDAV2(ix, 7, mintProgram, "mint authority", []byte("authority")),
			expectSATATAV2(ix, 9, owner, mint, "protocol treasury recipient"),
			expectSATKeyV2(ix, 10, system, "system program"),
			expectSATKeyV2(ix, 11, token, "SPL token program"),
			expectSATKeyV2(ix, 12, ataProgram, "associated token program"),
		)
	case "refillRegistryReserveFromTreasury":
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 2, p, "treasury vault", []byte("sat_treasury_vault")),
			expectSATPDAV2(ix, 3, p, "registry reserve", []byte("sat_registry_reserve")),
			expectSATKeyV2(ix, 4, system, "system program"),
		)
	case "claimProtocolDistributorSat":
		owner, mint := ix.Accounts[4].PublicKey, ix.Accounts[6].PublicKey
		mintProgram := ix.Accounts[11].PublicKey
		bondProgram := ix.Accounts[12].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "treasury", []byte("treasury")),
			expectSATPDAV2(ix, 3, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 4, bondProgram, "bond staking distributor", []byte("sat_bond_staking_distributor")),
			expectSATPDAV2(ix, 5, mintProgram, "mint authority", []byte("authority")),
			expectSATATAV2(ix, 7, owner, mint, "protocol distributor recipient"),
			expectSATKeyV2(ix, 8, system, "system program"),
			expectSATKeyV2(ix, 9, token, "SPL token program"),
			expectSATKeyV2(ix, 10, ataProgram, "associated token program"),
		)
	case "retargetUnlock":
		cycleID := satU64V2(d, 1)
		intervalSize := uint64(12)
		intervalStart := uint64(0)
		if cycleID+1 > intervalSize {
			intervalStart = cycleID + 1 - intervalSize
		}
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "cycle state", []byte("sat_cycle_state"), satU64BytesV2(d, 1)),
			expectSATPDAV2(ix, 3, p, "unlock interval", []byte("sat_unlock_interval_state"), satU64SeedV2(intervalStart)),
		)
	case "closeResolvedMinerCycleState":
		cycle, authority := satU64BytesV2(d, 1), ix.Accounts[2].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 3, p, "miner cycle state", []byte("sat_miner_cycle_state"), authority[:], cycle),
			expectSATPDAV2(ix, 4, p, "miner capital", []byte("sat_miner_capital_state"), authority[:]),
			expectSATPDAV2(ix, 5, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
		)
	case "closeResolvedCycleRegistryPage":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 4, p, "registry reserve", []byte("sat_registry_reserve")),
		)
	case "closeResolvedCycleArtifacts":
		cycle := satU64BytesV2(d, 1)
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle settlement progress", []byte("sat_cycle_settlement_progress_v2"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 4, p, "registry reserve", []byte("sat_registry_reserve")),
		)
	case "compactPendingCycleRange":
		frontCount, backCount := int(d[17]), int(d[18])
		if frontCount != len(c.FrontCycleIDs) || backCount != len(c.BackCycleIDs) {
			return errors.New("SAT compactPendingCycleRange context count does not match payload")
		}
		if frontCount+backCount == 0 || frontCount > 32 || backCount > 32 {
			return errors.New("SAT compactPendingCycleRange requires one to 32 cycles per boundary")
		}
		firstCycle, lastCycle := satU64V2(d, 1), satU64V2(d, 9)
		if firstCycle == 0 || lastCycle < firstCycle {
			return errors.New("SAT compactPendingCycleRange pending range is invalid")
		}
		if uint64(frontCount+backCount) > lastCycle-firstCycle+1 {
			return errors.New("SAT compactPendingCycleRange boundary cycles overlap")
		}
		for index, cycleText := range c.FrontCycleIDs {
			if satContextU64V2(cycleText) != firstCycle+uint64(index) {
				return errors.New("SAT compactPendingCycleRange front cycles must be contiguous from the expected first cycle")
			}
		}
		for index, cycleText := range c.BackCycleIDs {
			if satContextU64V2(cycleText) != lastCycle-uint64(index) {
				return errors.New("SAT compactPendingCycleRange back cycles must be contiguous from the expected last cycle")
			}
		}
		checks := []error{expectSATPDAV2(ix, 1, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:])}
		index := 2
		for _, cycleText := range append(append([]string{}, c.FrontCycleIDs...), c.BackCycleIDs...) {
			cycle := satU64SeedV2(satContextU64V2(cycleText))
			checks = append(checks, expectSATPDAV2(ix, index, p, "pending miner cycle", []byte("sat_miner_cycle_state"), wallet[:], cycle))
			index++
		}
		return firstSATErrorV2(checks...)
	case "finalizeCycleSettlement":
		cycle := satU64BytesV2(d, 1)
		checks := []error{
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle settlement progress", []byte("sat_cycle_settlement_progress_v2"), cycle),
			expectSATPDAV2(ix, 4, p, "cycle registry meta", []byte("sat_cycle_registry_meta"), cycle),
			expectSATPDAV2(ix, 5, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 6, p, "signer miner cycle", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 7, p, "signer miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 8, p, "rebate vault", []byte("sat_rebate_vault")),
		}
		for index := 9; index < len(ix.Accounts); index++ {
			checks = append(checks, expectSATPDAV2(ix, index, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, satU64SeedV2(uint64(index-9))))
		}
		return firstSATErrorV2(checks...)
	case "scoreCyclePage":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		checks := []error{
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 3, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 4, p, "cycle settlement progress", []byte("sat_cycle_settlement_progress_v2"), cycle),
			expectSATPDAV2(ix, 5, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 6, p, "signer miner cycle", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 7, p, "signer miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 8, p, "rebate vault", []byte("sat_rebate_vault")),
		}
		for index, authorityText := range minerAuthorities {
			authority := solana.MustPublicKeyFromBase58(authorityText)
			checks = append(checks, expectSATPDAV2(ix, 9+index, p, "score miner cycle", []byte("sat_miner_cycle_state"), authority[:], cycle))
		}
		return firstSATErrorV2(checks...)
	case "distributeCyclePage":
		cycle, page := satU64BytesV2(d, 1), satU64BytesV2(d, 9)
		checks := []error{
			expectSATPDAV2(ix, 1, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 2, p, "cycle registry page", []byte("sat_cycle_registry_page"), cycle, page),
			expectSATPDAV2(ix, 3, p, "cycle settlement progress", []byte("sat_cycle_settlement_progress_v2"), cycle),
			expectSATPDAV2(ix, 4, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 5, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 6, p, "signer miner cycle", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 7, p, "signer miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 8, p, "rebate vault", []byte("sat_rebate_vault")),
			expectSATPDAV2(ix, 9, p, "treasury vault", []byte("sat_treasury_vault")),
		}
		for index, authorityText := range minerAuthorities {
			authority := solana.MustPublicKeyFromBase58(authorityText)
			base := 10 + index*2
			checks = append(checks,
				expectSATPDAV2(ix, base, p, "distribution miner cycle", []byte("sat_miner_cycle_state"), authority[:], cycle),
				expectSATPDAV2(ix, base+1, p, "distribution miner capital", []byte("sat_miner_capital_state"), authority[:]),
			)
		}
		return firstSATErrorV2(checks...)
	case "claimCycleRewards":
		cycle := satU64BytesV2(d, 1)
		mintProgram, mint := ix.Accounts[13].PublicKey, ix.Accounts[8].PublicKey
		return firstSATErrorV2(
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "cycle state", []byte("sat_cycle_state"), cycle),
			expectSATPDAV2(ix, 3, p, "miner cycle state", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			expectSATPDAV2(ix, 4, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 5, p, "treasury", []byte("treasury")),
			expectSATPDAV2(ix, 6, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 7, mintProgram, "mint authority", []byte("authority")),
			expectSATATAV2(ix, 9, wallet, mint, "cycle reward recipient"),
			expectSATKeyV2(ix, 10, system, "system program"),
			expectSATKeyV2(ix, 11, token, "SPL token program"),
			expectSATKeyV2(ix, 12, ataProgram, "associated token program"),
			expectSATPDAV2(ix, 14, p, "rebate vault", []byte("sat_rebate_vault")),
		)
	case "claimCycleRewardsBatch":
		count := int(d[1])
		mint, suffix := ix.Accounts[6].PublicKey, 8+count*2
		mintProgram := ix.Accounts[suffix+3].PublicKey
		checks := []error{
			expectSATPDAV2(ix, 1, p, "global state", []byte("sat_global_state")),
			expectSATPDAV2(ix, 2, p, "treasury", []byte("treasury")),
			expectSATPDAV2(ix, 3, p, "treasury state", []byte("sat_treasury_state")),
			expectSATPDAV2(ix, 4, p, "miner capital", []byte("sat_miner_capital_state"), wallet[:]),
			expectSATPDAV2(ix, 5, mintProgram, "mint authority", []byte("authority")),
			expectSATATAV2(ix, 7, wallet, mint, "batch reward recipient"),
		}
		for index := 0; index < count; index++ {
			cycle := d[9+index*8 : 17+index*8]
			checks = append(checks,
				expectSATPDAV2(ix, 8+index*2, p, "batch cycle state", []byte("sat_cycle_state"), cycle),
				expectSATPDAV2(ix, 9+index*2, p, "batch miner cycle", []byte("sat_miner_cycle_state"), wallet[:], cycle),
			)
		}
		checks = append(checks,
			expectSATKeyV2(ix, suffix, system, "system program"),
			expectSATKeyV2(ix, suffix+1, token, "SPL token program"),
			expectSATKeyV2(ix, suffix+2, ataProgram, "associated token program"),
			expectSATPDAV2(ix, suffix+4, p, "rebate vault", []byte("sat_rebate_vault")),
		)
		return firstSATErrorV2(checks...)
	default:
		return fmt.Errorf("typed SAT action %s has no semantic validator", ix.Codec.Action)
	}
}
