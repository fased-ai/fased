package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

const (
	moneyFoundationContractGenerationV1 = 1
	moneyFoundationDevnetGenesisV1      = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" // pragma: allowlist secret
	moneyFoundationSATMintV1            = "BbZ7cUmbD9s43jeqK65Jjg8QWo5VNMZovKURVEYx4DqU" // pragma: allowlist secret
	moneyFoundationWSOLMintV1           = "So11111111111111111111111111111111111111112"
	moneyFoundationMeteoraProgramV1     = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"  // pragma: allowlist secret
	moneyFoundationPoolConfigV1         = "9xKsCsiv8eeBohobb8Z1snLZzVKKATGqmY69vJHyCzvu" // pragma: allowlist secret
	moneyFoundationMaxProtectedV1       = 64
)

var (
	moneyFoundationInitializePoolDiscriminatorV1 = []byte{0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28}
	moneyFoundationClaimFeeDiscriminatorV1       = []byte{0xb4, 0x26, 0x9a, 0x11, 0x85, 0x21, 0xa2, 0xd3}
	moneyFoundationRemoveAllDiscriminatorV1      = []byte{0x0a, 0x33, 0x3d, 0x23, 0x70, 0x69, 0x18, 0x55}
	moneyFoundationClosePositionDiscriminatorV1  = []byte{0x7b, 0x86, 0x51, 0x00, 0x31, 0x44, 0x62, 0x62}
)

type signerMoneyFoundationIntentV2 struct {
	ContractGeneration        uint64   `json:"contractGeneration"`
	PolicyGeneration          string   `json:"policyGeneration"`
	PolicyDigestSHA256        string   `json:"policyDigestSha256"`
	Action                    string   `json:"action"`
	SourceClass               string   `json:"sourceClass"`
	SourceOwner               string   `json:"sourceOwner"`
	DestinationOwner          string   `json:"destinationOwner"`
	Lifecycle                 string   `json:"lifecycle"`
	FundingAuthorized         bool     `json:"fundingAuthorized"`
	PublicEntryEnabled        bool     `json:"publicEntryEnabled"`
	LiquidityTreasury         string   `json:"liquidityTreasury"`
	EmergencyAuthority        string   `json:"emergencyAuthority"`
	EmergencyUnwindNotBefore  string   `json:"emergencyUnwindNotBeforeSlot"`
	SATMint                   string   `json:"satMint"`
	SATTokenProgram           string   `json:"satTokenProgram"`
	WrappedSOLMint            string   `json:"wrappedSolMint"`
	VenueProgram              string   `json:"venueProgram"`
	PoolConfig                string   `json:"poolConfig"`
	Pool                      string   `json:"pool"`
	PositionMint              string   `json:"positionMint"`
	PositionTokenAccount      string   `json:"positionTokenAccount"`
	SATVault                  string   `json:"satVault"`
	SOLVault                  string   `json:"solVault"`
	InitialSATRaw             string   `json:"initialSatRaw"`
	InitialSOLLamports        string   `json:"initialSolLamports"`
	InputRaw                  string   `json:"inputRaw"`
	MinimumSATRaw             string   `json:"minimumSatRaw"`
	MinimumSOLLamports        string   `json:"minimumSolLamports"`
	MaxSlippageBPS            uint16   `json:"maxSlippageBps"`
	MaxPriceImpactBPS         uint16   `json:"maxPriceImpactBps"`
	MaxCombinedFeeBPS         uint16   `json:"maxCombinedFeeBps"`
	SimulationSlot            string   `json:"simulationSlot"`
	ExpiresSlot               string   `json:"expiresSlot"`
	SourceDescriptorSHA256    string   `json:"sourceDescriptorSha256"`
	ProtectedCapitalAddresses []string `json:"protectedCapitalAddresses"`
}

type moneyFoundationAddressesV2 struct {
	Pool                 solana.PublicKey
	Position             solana.PublicKey
	PositionTokenAccount solana.PublicKey
	SATVault             solana.PublicKey
	SOLVault             solana.PublicKey
	TreasurySATAccount   solana.PublicKey
	TreasurySOLAccount   solana.PublicKey
	SATBadge             solana.PublicKey
	SOLBadge             solana.PublicKey
	PoolAuthority        solana.PublicKey
	EventAuthority       solana.PublicKey
}

func moneyFoundationU64V2(raw, field string, positive bool) (*big.Int, error) {
	value := strings.TrimSpace(raw)
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok || parsed.Sign() < 0 || parsed.BitLen() > 64 || (positive && parsed.Sign() == 0) {
		return nil, fmt.Errorf("%s must be a %suint64 decimal string", field, map[bool]string{true: "positive ", false: ""}[positive])
	}
	return parsed, nil
}

func moneyFoundationDigestV2(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if len(value) != 64 {
		return "", fmt.Errorf("%s must be a lowercase sha256 digest", field)
	}
	if _, err := hex.DecodeString(value); err != nil || strings.ToLower(value) != value {
		return "", fmt.Errorf("%s must be a lowercase sha256 digest", field)
	}
	return value, nil
}

func moneyFoundationPDAV2(program solana.PublicKey, seeds ...[]byte) (solana.PublicKey, error) {
	address, _, err := solana.FindProgramAddress(seeds, program)
	return address, err
}

func deriveMoneyFoundationAddressesV2(wallet, positionMint solana.PublicKey) (moneyFoundationAddressesV2, error) {
	program := solana.MustPublicKeyFromBase58(moneyFoundationMeteoraProgramV1)
	config := solana.MustPublicKeyFromBase58(moneyFoundationPoolConfigV1)
	sat := solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)
	wsol := solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)
	first, second := sat, wsol
	// Meteora's SDK deliberately places the lexicographically larger mint first.
	if bytes.Compare(first[:], second[:]) < 0 {
		first, second = second, first
	}
	pool, err := moneyFoundationPDAV2(program, []byte("pool"), config[:], first[:], second[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	position, err := moneyFoundationPDAV2(program, []byte("position"), positionMint[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	positionTokenAccount, err := moneyFoundationPDAV2(program, []byte("position_nft_account"), positionMint[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	satVault, err := moneyFoundationPDAV2(program, []byte("token_vault"), sat[:], pool[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	solVault, err := moneyFoundationPDAV2(program, []byte("token_vault"), wsol[:], pool[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	satBadge, err := moneyFoundationPDAV2(program, []byte("token_badge"), sat[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	solBadge, err := moneyFoundationPDAV2(program, []byte("token_badge"), wsol[:])
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	poolAuthority, err := moneyFoundationPDAV2(program, []byte("pool_authority"))
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	eventAuthority, err := moneyFoundationPDAV2(program, []byte("__event_authority"))
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	treasurySAT, err := findAssociatedTokenAddressV2(wallet, sat, solana.TokenProgramID)
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	treasurySOL, err := findAssociatedTokenAddressV2(wallet, wsol, solana.TokenProgramID)
	if err != nil {
		return moneyFoundationAddressesV2{}, err
	}
	return moneyFoundationAddressesV2{
		Pool: pool, Position: position, PositionTokenAccount: positionTokenAccount,
		SATVault: satVault, SOLVault: solVault, TreasurySATAccount: treasurySAT,
		TreasurySOLAccount: treasurySOL, SATBadge: satBadge, SOLBadge: solBadge,
		PoolAuthority: poolAuthority, EventAuthority: eventAuthority,
	}, nil
}

func normalizeMoneyFoundationIntentV2(input signerIntentV2, wallet solana.PublicKey) (normalizedIntentV2, error) {
	if input.Type != intentSolanaMoneyFoundation || input.Cluster == "" || input.MoneyFoundation == nil ||
		input.Destination != "" || input.Lamports != "" || input.TokenProgram != "" || input.Mint != "" ||
		input.Amount != "" || input.Memo != "" || input.Action != "" || input.ProgramID != "" ||
		input.DataBase64 != "" || len(input.Keys) != 0 || input.Context != nil || input.SATCommitment != nil ||
		len(input.Instructions) != 0 || len(input.AddressLookupTables) != 0 || input.LookupTable != nil ||
		input.Jupiter != nil || input.AuthorityWalletID != "" || input.Federation != nil {
		return normalizedIntentV2{}, errors.New("typed money-foundation intent contains unsupported or missing fields")
	}
	cluster, err := normalizeSolanaClusterV2(input.Cluster)
	if err != nil || cluster != "devnet" {
		return normalizedIntentV2{}, errors.New("money-foundation v1 is restricted to the exact Devnet canary")
	}
	m := *input.MoneyFoundation
	if m.ContractGeneration != moneyFoundationContractGenerationV1 || (m.Action != "ADD_POL" && m.Action != "EMERGENCY_UNWIND") {
		return normalizedIntentV2{}, errors.New("money-foundation contract generation or action is unsupported")
	}
	if m.PolicyDigestSHA256, err = moneyFoundationDigestV2(m.PolicyDigestSHA256, "policyDigestSha256"); err != nil {
		return normalizedIntentV2{}, err
	}
	if m.SourceDescriptorSHA256, err = moneyFoundationDigestV2(m.SourceDescriptorSHA256, "sourceDescriptorSha256"); err != nil {
		return normalizedIntentV2{}, err
	}
	policyGeneration, err := moneyFoundationU64V2(m.PolicyGeneration, "policyGeneration", true)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	m.PolicyGeneration = policyGeneration.String()
	simulationSlot, err := moneyFoundationU64V2(m.SimulationSlot, "simulationSlot", true)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	expiresSlot, err := moneyFoundationU64V2(m.ExpiresSlot, "expiresSlot", true)
	if err != nil || expiresSlot.Cmp(simulationSlot) <= 0 {
		return normalizedIntentV2{}, errors.New("money-foundation expiresSlot must follow simulationSlot")
	}
	m.SimulationSlot, m.ExpiresSlot = simulationSlot.String(), expiresSlot.String()
	notBefore, err := moneyFoundationU64V2(m.EmergencyUnwindNotBefore, "emergencyUnwindNotBeforeSlot", false)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	m.EmergencyUnwindNotBefore = notBefore.String()
	if m.MaxSlippageBPS > 1000 || m.MaxPriceImpactBPS > 1000 || m.MaxCombinedFeeBPS > 1000 {
		return normalizedIntentV2{}, errors.New("money-foundation risk bounds exceed the v1 contract")
	}
	fixed := map[string]string{
		"satMint": m.SATMint, "satTokenProgram": m.SATTokenProgram, "wrappedSolMint": m.WrappedSOLMint,
		"venueProgram": m.VenueProgram, "poolConfig": m.PoolConfig,
	}
	expected := map[string]string{
		"satMint": moneyFoundationSATMintV1, "satTokenProgram": solana.TokenProgramID.String(),
		"wrappedSolMint": moneyFoundationWSOLMintV1, "venueProgram": moneyFoundationMeteoraProgramV1,
		"poolConfig": moneyFoundationPoolConfigV1,
	}
	for field, raw := range fixed {
		key, keyErr := normalizePublicKeyV2(raw, field)
		if keyErr != nil || key != expected[field] {
			return normalizedIntentV2{}, fmt.Errorf("money-foundation %s does not match the pinned canary", field)
		}
	}
	for field, raw := range map[string]*string{
		"sourceOwner": &m.SourceOwner, "destinationOwner": &m.DestinationOwner,
		"liquidityTreasury": &m.LiquidityTreasury, "emergencyAuthority": &m.EmergencyAuthority,
		"pool": &m.Pool, "positionMint": &m.PositionMint, "positionTokenAccount": &m.PositionTokenAccount,
		"satVault": &m.SATVault, "solVault": &m.SOLVault,
	} {
		*raw, err = normalizePublicKeyV2(*raw, field)
		if err != nil {
			return normalizedIntentV2{}, err
		}
	}
	if m.SourceOwner != wallet.String() || m.DestinationOwner != wallet.String() || m.LiquidityTreasury != wallet.String() {
		return normalizedIntentV2{}, errors.New("money-foundation source, destination, and liquidity treasury must be the signer-owned Vault wallet")
	}
	positionMint := solana.MustPublicKeyFromBase58(m.PositionMint)
	addresses, err := deriveMoneyFoundationAddressesV2(wallet, positionMint)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	if m.Pool != addresses.Pool.String() || m.PositionTokenAccount != addresses.PositionTokenAccount.String() ||
		m.SATVault != addresses.SATVault.String() || m.SOLVault != addresses.SOLVault.String() {
		return normalizedIntentV2{}, errors.New("money-foundation pool, position account, or token vault derivation changed")
	}
	if len(m.ProtectedCapitalAddresses) == 0 || len(m.ProtectedCapitalAddresses) > moneyFoundationMaxProtectedV1 {
		return normalizedIntentV2{}, errors.New("money-foundation protected-capital set is empty or unbounded")
	}
	protected, err := normalizeSortedStringsV2(m.ProtectedCapitalAddresses, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "protected capital address")
	})
	if err != nil || len(protected) != len(m.ProtectedCapitalAddresses) {
		return normalizedIntentV2{}, errors.New("money-foundation protected-capital set is invalid or contains duplicates")
	}
	m.ProtectedCapitalAddresses = protected
	initialSAT, err := moneyFoundationU64V2(m.InitialSATRaw, "initialSatRaw", true)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	initialSOL, err := moneyFoundationU64V2(m.InitialSOLLamports, "initialSolLamports", true)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	inputAmount, err := moneyFoundationU64V2(m.InputRaw, "inputRaw", true)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	minimumSAT, err := moneyFoundationU64V2(m.MinimumSATRaw, "minimumSatRaw", false)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	minimumSOL, err := moneyFoundationU64V2(m.MinimumSOLLamports, "minimumSolLamports", false)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	m.InitialSATRaw, m.InitialSOLLamports, m.InputRaw = initialSAT.String(), initialSOL.String(), inputAmount.String()
	m.MinimumSATRaw, m.MinimumSOLLamports = minimumSAT.String(), minimumSOL.String()
	var asset string
	var amount *big.Int
	var additional []signerReservationRequirementV2
	switch m.Action {
	case "ADD_POL":
		if m.SourceClass != "OWNER_SEED" && m.SourceClass != "PROTOCOL_SURPLUS" {
			return normalizedIntentV2{}, errors.New("ADD_POL requires an owner-seed or protocol-surplus source")
		}
		if !m.FundingAuthorized || m.Lifecycle == "DISABLED" || inputAmount.Cmp(initialSAT) != 0 || minimumSAT.Sign() != 0 || minimumSOL.Sign() != 0 {
			return normalizedIntentV2{}, errors.New("ADD_POL authorization or exact amount semantics are invalid")
		}
		asset, amount = "solana:native", initialSOL
		additional = []signerReservationRequirementV2{{
			Asset: "solana:spl:" + moneyFoundationSATMintV1, Amount: initialSAT, Destination: addresses.Pool.String(),
		}}
	case "EMERGENCY_UNWIND":
		if m.SourceClass != "EMERGENCY_TREASURY" || m.Lifecycle == "DISABLED" || simulationSlot.Cmp(notBefore) < 0 ||
			minimumSAT.Sign() <= 0 || minimumSOL.Sign() <= 0 {
			return normalizedIntentV2{}, errors.New("EMERGENCY_UNWIND source, lifecycle, timelock, or minimum outputs are invalid")
		}
		asset, amount = "money-foundation:position:"+m.PositionMint, big.NewInt(1)
	}
	canonical := signerIntentV2{Type: input.Type, Cluster: cluster, MoneyFoundation: &m}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(encoded)
	programs := []string{
		moneyFoundationMeteoraProgramV1, solana.SystemProgramID.String(), solana.TokenProgramID.String(),
		solana.Token2022ProgramID.String(), solana.SPLAssociatedTokenAccountProgramID.String(),
	}
	sort.Strings(programs)
	return normalizedIntentV2{
		Intent: canonical, Digest: "sha256:" + hex.EncodeToString(digest[:]), Asset: asset, Amount: amount,
		RequiredPrograms: programs, Destination: wallet.String(), NativeFeeReservation: new(big.Int).SetUint64(signerNativeFeeReservationV2),
		PolicyOperation: "moneyFoundation." + m.Action + "@" + moneyFoundationMeteoraProgramV1,
		RequiredRole:    "vault", AdditionalReservations: additional,
	}, nil
}

func moneyFoundationInstructionV2(tx *solana.Transaction, index int) (solana.PublicKey, []*solana.AccountMeta, []byte, error) {
	if tx == nil || index < 0 || index >= len(tx.Message.Instructions) {
		return solana.PublicKey{}, nil, nil, errors.New("money-foundation instruction index is invalid")
	}
	instruction := tx.Message.Instructions[index]
	program, err := tx.Message.Program(instruction.ProgramIDIndex)
	if err != nil {
		return solana.PublicKey{}, nil, nil, err
	}
	accounts, err := instruction.ResolveInstructionAccounts(&tx.Message)
	return program, accounts, instruction.Data, err
}

func equalMoneyFoundationAccountsV2(accounts []*solana.AccountMeta, expected ...solana.PublicKey) bool {
	if len(accounts) != len(expected) {
		return false
	}
	for index := range expected {
		if !accounts[index].PublicKey.Equals(expected[index]) {
			return false
		}
	}
	return true
}

func validateMoneyFoundationAddPOLV2(tx *solana.Transaction, wallet solana.PublicKey, m signerMoneyFoundationIntentV2, addresses moneyFoundationAddressesV2) error {
	if len(tx.Message.Instructions) != 5 {
		return errors.New("ADD_POL must contain the exact five-instruction Meteora pool-creation sequence")
	}
	sat := solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)
	wsol := solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)
	for index, expected := range []struct {
		ata  solana.PublicKey
		mint solana.PublicKey
	}{{addresses.TreasurySATAccount, sat}, {addresses.TreasurySOLAccount, wsol}} {
		program, accounts, data, err := moneyFoundationInstructionV2(tx, index)
		if err != nil || !program.Equals(solana.SPLAssociatedTokenAccountProgramID) || len(data) != 1 || data[0] != 1 ||
			!equalMoneyFoundationAccountsV2(accounts, wallet, expected.ata, wallet, expected.mint, solana.SystemProgramID, solana.TokenProgramID) {
			return errors.New("ADD_POL associated-token setup changed")
		}
	}
	expectedSOL, err := parseMoneyFoundationUint64V2(m.InitialSOLLamports)
	if err != nil {
		return err
	}
	program, accounts, data, err := moneyFoundationInstructionV2(tx, 2)
	if err != nil || !program.Equals(solana.SystemProgramID) || len(data) != 12 || binary.LittleEndian.Uint32(data[:4]) != 2 ||
		binary.LittleEndian.Uint64(data[4:]) != expectedSOL ||
		!equalMoneyFoundationAccountsV2(accounts, wallet, addresses.TreasurySOLAccount) {
		return errors.New("ADD_POL wrapped-SOL funding changed")
	}
	program, accounts, data, err = moneyFoundationInstructionV2(tx, 3)
	if err != nil || !program.Equals(solana.TokenProgramID) || len(data) != 1 || data[0] != 17 ||
		!equalMoneyFoundationAccountsV2(accounts, addresses.TreasurySOLAccount) {
		return errors.New("ADD_POL SyncNative instruction changed")
	}
	program, accounts, data, err = moneyFoundationInstructionV2(tx, 4)
	if err != nil || !program.Equals(solana.MustPublicKeyFromBase58(moneyFoundationMeteoraProgramV1)) ||
		len(data) < 8 || subtle.ConstantTimeCompare(data[:8], moneyFoundationInitializePoolDiscriminatorV1) != 1 {
		return errors.New("ADD_POL initialize_pool instruction changed")
	}
	positionMint := solana.MustPublicKeyFromBase58(m.PositionMint)
	position := addresses.Position
	expected := []solana.PublicKey{
		wallet, positionMint, addresses.PositionTokenAccount, wallet,
		solana.MustPublicKeyFromBase58(moneyFoundationPoolConfigV1), addresses.PoolAuthority,
		addresses.Pool, position, sat, wsol, addresses.SATVault, addresses.SOLVault,
		addresses.TreasurySATAccount, addresses.TreasurySOLAccount, solana.TokenProgramID, solana.TokenProgramID,
		solana.Token2022ProgramID, solana.SystemProgramID, addresses.EventAuthority,
		solana.MustPublicKeyFromBase58(moneyFoundationMeteoraProgramV1), addresses.SATBadge, addresses.SOLBadge,
	}
	if !equalMoneyFoundationAccountsV2(accounts, expected...) {
		return errors.New("ADD_POL initialize_pool accounts changed")
	}
	return nil
}

func validateMoneyFoundationEmergencyV2(tx *solana.Transaction, wallet solana.PublicKey, m signerMoneyFoundationIntentV2, addresses moneyFoundationAddressesV2) error {
	meteoraDiscriminators := [][]byte{}
	meteora := solana.MustPublicKeyFromBase58(moneyFoundationMeteoraProgramV1)
	sat := solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)
	wsol := solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)
	canonical := map[string]bool{
		wallet.String(): true, addresses.PoolAuthority.String(): true, addresses.Pool.String(): true,
		addresses.Position.String(): true, addresses.PositionTokenAccount.String(): true,
		addresses.TreasurySATAccount.String(): true, addresses.TreasurySOLAccount.String(): true,
		addresses.SATVault.String(): true, addresses.SOLVault.String(): true, m.PositionMint: true,
		sat.String(): true, wsol.String(): true, solana.TokenProgramID.String(): true,
		solana.Token2022ProgramID.String(): true, addresses.EventAuthority.String(): true,
		meteora.String(): true,
	}
	seenATA := map[string]bool{}
	seenCloseWSOL := false
	for index := range tx.Message.Instructions {
		program, accounts, data, err := moneyFoundationInstructionV2(tx, index)
		if err != nil {
			return err
		}
		switch {
		case program.Equals(solana.SPLAssociatedTokenAccountProgramID):
			if len(meteoraDiscriminators) != 0 || len(data) != 1 || data[0] != 1 {
				return errors.New("EMERGENCY_UNWIND associated-token setup is misplaced or non-idempotent")
			}
			matched := false
			for _, expected := range []struct {
				ata  solana.PublicKey
				mint solana.PublicKey
			}{{addresses.TreasurySATAccount, sat}, {addresses.TreasurySOLAccount, wsol}} {
				if equalMoneyFoundationAccountsV2(accounts, wallet, expected.ata, wallet, expected.mint, solana.SystemProgramID, solana.TokenProgramID) {
					if seenATA[expected.ata.String()] {
						return errors.New("EMERGENCY_UNWIND duplicates associated-token setup")
					}
					seenATA[expected.ata.String()] = true
					matched = true
					break
				}
			}
			if !matched {
				return errors.New("EMERGENCY_UNWIND creates an unreviewed token account")
			}
		case program.Equals(meteora):
			if seenCloseWSOL {
				return errors.New("EMERGENCY_UNWIND contains Meteora work after wrapped-SOL closure")
			}
			if len(data) < 8 {
				return errors.New("EMERGENCY_UNWIND contains a malformed Meteora instruction")
			}
			meteoraDiscriminators = append(meteoraDiscriminators, append([]byte(nil), data[:8]...))
			for _, account := range accounts {
				if !canonical[account.PublicKey.String()] {
					return fmt.Errorf("EMERGENCY_UNWIND reaches unreviewed account %s", account.PublicKey)
				}
				if account.IsSigner && !account.PublicKey.Equals(wallet) {
					return errors.New("EMERGENCY_UNWIND introduces an unexpected signer")
				}
			}
		case program.Equals(solana.TokenProgramID):
			if seenCloseWSOL || len(meteoraDiscriminators) != 3 || len(data) != 1 || data[0] != 9 ||
				!equalMoneyFoundationAccountsV2(accounts, addresses.TreasurySOLAccount, wallet, wallet) {
				return errors.New("EMERGENCY_UNWIND contains an unreviewed token instruction")
			}
			seenCloseWSOL = true
		default:
			return fmt.Errorf("EMERGENCY_UNWIND contains unreviewed program %s", program)
		}
	}
	if len(meteoraDiscriminators) != 3 ||
		subtle.ConstantTimeCompare(meteoraDiscriminators[0], moneyFoundationClaimFeeDiscriminatorV1) != 1 ||
		subtle.ConstantTimeCompare(meteoraDiscriminators[1], moneyFoundationRemoveAllDiscriminatorV1) != 1 ||
		subtle.ConstantTimeCompare(meteoraDiscriminators[2], moneyFoundationClosePositionDiscriminatorV1) != 1 {
		return errors.New("EMERGENCY_UNWIND must claim fees, remove all liquidity, and close the canonical position")
	}
	if !seenCloseWSOL {
		return errors.New("EMERGENCY_UNWIND must return wrapped SOL to the Vault wallet")
	}
	required := map[string]bool{
		addresses.Pool.String(): true, addresses.Position.String(): true, addresses.PositionTokenAccount.String(): true,
		addresses.SATVault.String(): true, addresses.SOLVault.String(): true, addresses.TreasurySATAccount.String(): true,
		addresses.TreasurySOLAccount.String(): true, m.PositionMint: true, wallet.String(): true,
	}
	for key := range required {
		found := false
		for _, account := range tx.Message.AccountKeys {
			if account.String() == key {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("EMERGENCY_UNWIND omits canonical account %s", key)
		}
	}
	return nil
}

func moneyFoundationTokenAmountV2(account *rpc.Account, mint, owner solana.PublicKey, allowMissing bool) (uint64, error) {
	if account == nil {
		if allowMissing {
			return 0, nil
		}
		return 0, errors.New("money-foundation token account is missing")
	}
	parsed, ok := parseJupiterTokenAccountV2(account)
	if !ok || !parsed.Mint.Equals(mint) || !parsed.Owner.Equals(owner) {
		return 0, errors.New("money-foundation token account identity or layout changed")
	}
	return parsed.Amount, nil
}

func moneyFoundationSystemLamportsV2(account *rpc.Account) (uint64, error) {
	if account == nil || account.Executable || !account.Owner.Equals(solana.SystemProgramID) ||
		(account.Data != nil && len(account.Data.GetBinary()) != 0) {
		return 0, errors.New("money-foundation Vault payer is not a canonical System account")
	}
	return account.Lamports, nil
}

func validateMoneyFoundationAccountDeltasV2(
	m signerMoneyFoundationIntentV2,
	wallet solana.PublicKey,
	pre []*rpc.Account,
	post []*rpc.Account,
	feeCeiling *big.Int,
) error {
	if len(pre) != 3 || len(post) != 3 || feeCeiling == nil || feeCeiling.Sign() < 0 {
		return errors.New("money-foundation value proof has an invalid account set")
	}
	satMint := solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)
	wsolMint := solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)
	preWallet, err := moneyFoundationSystemLamportsV2(pre[0])
	if err != nil {
		return err
	}
	postWallet, err := moneyFoundationSystemLamportsV2(post[0])
	if err != nil {
		return err
	}
	preSAT, err := moneyFoundationTokenAmountV2(pre[1], satMint, wallet, m.Action == "EMERGENCY_UNWIND")
	if err != nil {
		return err
	}
	postSAT, err := moneyFoundationTokenAmountV2(post[1], satMint, wallet, false)
	if err != nil {
		return err
	}
	preWSOL, err := moneyFoundationTokenAmountV2(pre[2], wsolMint, wallet, true)
	if err != nil {
		return err
	}
	postWSOL, err := moneyFoundationTokenAmountV2(post[2], wsolMint, wallet, true)
	if err != nil {
		return err
	}

	switch m.Action {
	case "ADD_POL":
		exactSAT, _ := parseMoneyFoundationUint64V2(m.InitialSATRaw)
		if postSAT > preSAT || preSAT-postSAT != exactSAT {
			return errors.New("ADD_POL simulation did not debit the exact reviewed SAT principal")
		}
		if postWSOL != preWSOL {
			return errors.New("ADD_POL simulation changed pre-existing wrapped SOL")
		}
	case "EMERGENCY_UNWIND":
		minimumSAT, _ := parseMoneyFoundationUint64V2(m.MinimumSATRaw)
		if postSAT < preSAT || postSAT-preSAT < minimumSAT {
			return errors.New("EMERGENCY_UNWIND simulated SAT return is below the reviewed minimum")
		}
		minimumSOL, _ := parseMoneyFoundationUint64V2(m.MinimumSOLLamports)
		preValue := new(big.Int).Add(new(big.Int).SetUint64(preWallet), new(big.Int).SetUint64(preWSOL))
		postValue := new(big.Int).Add(new(big.Int).SetUint64(postWallet), new(big.Int).SetUint64(postWSOL))
		postAfterFee := new(big.Int).Add(postValue, feeCeiling)
		minimumValue := new(big.Int).Add(preValue, new(big.Int).SetUint64(minimumSOL))
		if postAfterFee.Cmp(minimumValue) < 0 {
			return errors.New("EMERGENCY_UNWIND simulated SOL return is below the reviewed minimum")
		}
	default:
		return errors.New("money-foundation value proof action is unsupported")
	}
	return nil
}

// validateMoneyFoundationBalanceSemanticsV2 proves the actual simulated value
// movement rather than trusting the compiler's instruction labels. ADD_POL must
// debit exactly the reviewed SAT principal and may not consume pre-existing
// wrapped SOL. EMERGENCY_UNWIND must return at least both reviewed assets after
// allowing only the signer's bounded transaction fee.
func validateMoneyFoundationBalanceSemanticsV2(
	rpcURLs []string,
	tx *solana.Transaction,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	addresses moneyFoundationAddressesV2,
) error {
	m := intent.Intent.MoneyFoundation
	if m == nil {
		return errors.New("money-foundation balance semantics are missing")
	}
	tracked := []solana.PublicKey{wallet, addresses.TreasurySATAccount, addresses.TreasurySOLAccount}
	feeCeiling, err := signerFeeReservationForIntentV2(intent)
	if err != nil {
		return err
	}
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		preResponse, preErr := client.GetMultipleAccountsWithOpts(ctx, tracked, &rpc.GetMultipleAccountsOpts{
			Commitment: rpc.CommitmentConfirmed,
			Encoding:   solana.EncodingBase64,
		})
		if preErr != nil || preResponse == nil || len(preResponse.Value) != len(tracked) {
			cancel()
			if preErr == nil {
				preErr = errors.New("money-foundation pre-state RPC response length mismatch")
			}
			markSolanaWriteRPCFailure(rpcURL, preErr)
			continue
		}
		simulation, simulationErr := client.SimulateTransactionWithOpts(ctx, tx, &rpc.SimulateTransactionOpts{
			SigVerify:  false,
			Commitment: rpc.CommitmentConfirmed,
			Accounts: &rpc.SimulateTransactionAccountsOpts{
				Encoding:  solana.EncodingBase64,
				Addresses: tracked,
			},
		})
		cancel()
		if simulationErr != nil || simulation == nil || simulation.Value == nil {
			if simulationErr == nil {
				simulationErr = errors.New("money-foundation value simulation returned no result")
			}
			markSolanaWriteRPCFailure(rpcURL, simulationErr)
			continue
		}
		if simulation.Value.Err != nil {
			markSolanaWriteRPCSuccess(rpcURL)
			return fmt.Errorf("money-foundation value simulation failed: %v", simulation.Value.Err)
		}
		if len(simulation.Value.Accounts) != len(tracked) {
			simulationErr = errors.New("money-foundation post-state RPC response length mismatch")
			markSolanaWriteRPCFailure(rpcURL, simulationErr)
			continue
		}

		if err := validateMoneyFoundationAccountDeltasV2(*m, wallet, preResponse.Value, simulation.Value.Accounts, feeCeiling); err != nil {
			return err
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return nil
	}
	return errors.New("signer-owned Solana RPC money-foundation value validation failed")
}

func parseMoneyFoundationUint64V2(raw string) (uint64, error) {
	value, ok := new(big.Int).SetString(raw, 10)
	if !ok || value.Sign() < 0 || value.BitLen() > 64 {
		return 0, errors.New("money-foundation amount is invalid")
	}
	return value.Uint64(), nil
}

func validateAndSimulateMoneyFoundationReviewV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2, input signerSolanaTransactionEnvelopeV2) (jupiterValidatedTransactionV2, error) {
	if intent.Intent.Type != intentSolanaMoneyFoundation || intent.Intent.MoneyFoundation == nil {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed money-foundation intent is missing")
	}
	envelope, err := normalizeTransactionEnvelopeV2(input)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(envelope.SerializedTxBase64)
	if err != nil || len(raw) == 0 || len(raw) > 1232 {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed money-foundation transaction is invalid")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil || tx.Message.IsVersioned() || len(tx.Message.GetAddressTableLookups()) != 0 || len(tx.Message.AccountKeys) == 0 || !tx.Message.AccountKeys[0].Equals(wallet) {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed money-foundation transaction signer layout is invalid")
	}
	m := *intent.Intent.MoneyFoundation
	addresses, err := deriveMoneyFoundationAddressesV2(wallet, solana.MustPublicKeyFromBase58(m.PositionMint))
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	walletSignerIndex := 0
	ephemeralSignerIndex := -1
	if m.Action == "ADD_POL" {
		if tx.Message.Header.NumRequiredSignatures != 2 || len(tx.Signatures) != 2 || !tx.Message.AccountKeys[1].Equals(solana.MustPublicKeyFromBase58(m.PositionMint)) || !tx.Signatures[0].IsZero() || tx.Signatures[1].IsZero() {
			return jupiterValidatedTransactionV2{}, errors.New("ADD_POL requires only the Vault wallet and one pre-signed ephemeral position mint")
		}
		ephemeralSignerIndex = 1
		if err := validateMoneyFoundationAddPOLV2(tx, wallet, m, addresses); err != nil {
			return jupiterValidatedTransactionV2{}, err
		}
	} else {
		if tx.Message.Header.NumRequiredSignatures != 1 || len(tx.Signatures) != 1 || !tx.Signatures[0].IsZero() {
			return jupiterValidatedTransactionV2{}, errors.New("EMERGENCY_UNWIND must require only the signer-owned Vault wallet")
		}
		if err := validateMoneyFoundationEmergencyV2(tx, wallet, m, addresses); err != nil {
			return jupiterValidatedTransactionV2{}, err
		}
	}
	protected := map[string]bool{}
	for _, address := range m.ProtectedCapitalAddresses {
		protected[address] = true
	}
	for _, account := range tx.Message.AccountKeys {
		if protected[account.String()] {
			return jupiterValidatedTransactionV2{}, fmt.Errorf("money-foundation transaction reaches protected capital %s", account)
		}
	}
	decodedEnvelope, _, err := typedTransactionEnvelopeV2(tx)
	if err != nil || !equalSortedStringsV2(envelope.Programs, decodedEnvelope.Programs) || !equalSortedStringsV2(envelope.WritableAccounts, decodedEnvelope.WritableAccounts) {
		return jupiterValidatedTransactionV2{}, errors.New("money-foundation transaction manifest changed")
	}
	if err := simulateTypedTransferReviewV2(rpcURLs, tx); err != nil {
		return jupiterValidatedTransactionV2{}, fmt.Errorf("reviewed money-foundation simulation failed: %w", err)
	}
	if err := validateSignerNativeSpendV2(rpcURLs, tx, wallet, intent); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if err := validateMoneyFoundationBalanceSemanticsV2(rpcURLs, tx, wallet, intent, addresses); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	return jupiterValidatedTransactionV2{
		Transaction: tx, RawUnsigned: raw, Programs: decodedEnvelope.Programs, Writable: decodedEnvelope.WritableAccounts,
		WalletSignerIndex: walletSignerIndex, EphemeralSignerIndex: ephemeralSignerIndex,
	}, nil
}

func moneyFoundationSnapshotAddressesV2(intent normalizedIntentV2, wallet solana.PublicKey) ([]solana.PublicKey, error) {
	m := intent.Intent.MoneyFoundation
	if m == nil {
		return nil, errors.New("money-foundation intent is missing")
	}
	addresses, err := deriveMoneyFoundationAddressesV2(wallet, solana.MustPublicKeyFromBase58(m.PositionMint))
	if err != nil {
		return nil, err
	}
	out := []solana.PublicKey{
		solana.MustPublicKeyFromBase58(moneyFoundationPoolConfigV1), solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1),
		addresses.Pool, addresses.Position, addresses.PositionTokenAccount, addresses.SATVault, addresses.SOLVault,
		addresses.TreasurySATAccount, addresses.TreasurySOLAccount,
	}
	return out, nil
}

func resolveMoneyFoundationReviewStateV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2) (normalizedIntentV2, signerOwnedAccountSnapshotV2, []string, error) {
	verified, err := solanaRPCURLsForClusterV2(rpcURLs, intent.Intent.Cluster)
	if err != nil {
		return intent, signerOwnedAccountSnapshotV2{}, nil, err
	}
	addresses, err := moneyFoundationSnapshotAddressesV2(intent, wallet)
	if err != nil {
		return intent, signerOwnedAccountSnapshotV2{}, nil, err
	}
	snapshot, err := fetchVaultBondAccountSnapshotV2(verified, intent.Intent.Cluster, addresses)
	if err != nil {
		return intent, signerOwnedAccountSnapshotV2{}, nil, err
	}
	simulationSlot, _ := parseMoneyFoundationUint64V2(intent.Intent.MoneyFoundation.SimulationSlot)
	expiresSlot, _ := parseMoneyFoundationUint64V2(intent.Intent.MoneyFoundation.ExpiresSlot)
	if snapshot.Slot < simulationSlot || snapshot.Slot > expiresSlot {
		return intent, signerOwnedAccountSnapshotV2{}, nil, errors.New("money-foundation reviewed state is outside its exact slot window")
	}
	return intent, snapshot, verified, nil
}

func compareMoneyFoundationReviewStateV2(review signerReviewV2, current normalizedIntentV2, snapshot signerOwnedAccountSnapshotV2) error {
	if review.StateDigest == "" || subtle.ConstantTimeCompare([]byte(review.StateDigest), []byte(snapshot.Digest)) != 1 {
		return errors.New("money-foundation state changed after review")
	}
	if review.Asset != current.Asset || review.Amount != current.Amount.String() || review.Destination != current.Destination || review.PolicyOperation != current.PolicyOperation {
		return errors.New("money-foundation reviewed effect changed")
	}
	return nil
}

func moneyFoundationArtifactDigestV2(validated jupiterValidatedTransactionV2) string {
	digest := sha256.Sum256(validated.RawUnsigned)
	return "sha256:" + hex.EncodeToString(digest[:])
}
