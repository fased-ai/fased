package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

var (
	addressLookupTableProgramV2 = solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111")
	computeBudgetProgramV2      = solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111")
	memoProgramV1V2             = solana.MustPublicKeyFromBase58("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo")
	memoProgramV2V2             = solana.MustPublicKeyFromBase58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
)

type jupiterTokenAccountV2 struct {
	Mint   solana.PublicKey
	Owner  solana.PublicKey
	Amount uint64
}

type jupiterValidatedTransactionV2 struct {
	Transaction       *solana.Transaction
	RawUnsigned       []byte
	Programs          []string
	Writable          []string
	WalletSignerIndex int
}

type jupiterTransactionSnapshotV2 struct {
	Accounts map[string]*rpc.Account
	Post     map[string]*rpc.Account
}

func validateAndSimulateJupiterTransactionV2(
	rpcURLs []string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	envelopeInput signerSolanaTransactionEnvelopeV2,
) (jupiterValidatedTransactionV2, error) {
	envelope, err := normalizeTransactionEnvelopeV2(envelopeInput)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if intent.Intent.Jupiter == nil {
		return jupiterValidatedTransactionV2{}, errors.New("typed Jupiter semantics are required")
	}
	if !equalSortedStringsV2(envelope.Programs, intent.Intent.Jupiter.Programs) {
		return jupiterValidatedTransactionV2{}, errors.New("caller program manifest does not match the reviewed semantic intent")
	}
	if intent.Intent.Type == intentSolanaJupiterSwap && envelope.Submission != jupiterSubmissionRPCV2 {
		return jupiterValidatedTransactionV2{}, errors.New("Jupiter swaps must use signer-owned RPC submission")
	}
	if intent.Intent.Type != intentSolanaJupiterSwap && envelope.Submission != jupiterSubmissionReturnV2 {
		return jupiterValidatedTransactionV2{}, errors.New("Jupiter Trigger transactions must use typed returnSigned submission")
	}

	raw, err := base64.StdEncoding.DecodeString(envelope.SerializedTxBase64)
	if err != nil || len(raw) == 0 || len(raw) > 1232 {
		return jupiterValidatedTransactionV2{}, errors.New("serialized Solana transaction is invalid or exceeds the signer limit")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil {
		return jupiterValidatedTransactionV2{}, fmt.Errorf("decode serialized Solana transaction: %w", err)
	}
	walletSignerIndex, err := validateJupiterRequiredSignersV2(tx, wallet, intent)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}

	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	var failures []string
	for index, rpcURL := range active {
		candidate, candidateErr := validateAndSimulateJupiterAtRPCV2(rpcURL, tx, raw, wallet, walletSignerIndex, intent, envelope)
		if candidateErr == nil {
			markSolanaWriteRPCSuccess(rpcURL)
			return candidate, nil
		}
		markSolanaWriteRPCFailure(rpcURL, candidateErr)
		failures = append(failures, fmt.Sprintf("endpoint %d: %v", index+1, candidateErr))
		// Semantic rejection is deterministic. A different RPC must never be used
		// to turn a rejected transaction into an approved one.
		if !isJupiterRPCReadFailureV2(candidateErr) {
			break
		}
	}
	return jupiterValidatedTransactionV2{}, fmt.Errorf("typed Jupiter validation failed: %s", strings.Join(failures, "; "))
}

func validateJupiterRequiredSignersV2(tx *solana.Transaction, wallet solana.PublicKey, intent normalizedIntentV2) (int, error) {
	required := int(tx.Message.Header.NumRequiredSignatures)
	if required <= 0 || required > len(tx.Message.AccountKeys) || len(tx.Signatures) != required {
		return -1, errors.New("typed Jupiter transaction has an invalid required-signature layout")
	}
	for _, signature := range tx.Signatures {
		if !signature.IsZero() {
			return -1, errors.New("typed Jupiter transaction must contain only empty signatures before review")
		}
	}
	expected := map[string]bool{wallet.String(): true}
	allowVaultPayer := false
	if intent.Intent.Type == intentSolanaTriggerCancel || intent.Intent.Type == intentSolanaTriggerWithdraw {
		if intent.Intent.Jupiter == nil || intent.Intent.Jupiter.Trigger == nil || intent.Intent.Jupiter.Trigger.Vault == "" {
			return -1, errors.New("Trigger withdrawal lacks its reviewed vault signer")
		}
		expected[intent.Intent.Jupiter.Trigger.Vault] = true
		allowVaultPayer = true
	}
	if required != len(expected) {
		return -1, errors.New("typed Jupiter required signers do not exactly match the reviewed signer set")
	}
	walletIndex := -1
	seen := map[string]bool{}
	for index := 0; index < required; index++ {
		key := tx.Message.AccountKeys[index].String()
		if !expected[key] || seen[key] {
			return -1, errors.New("typed Jupiter transaction contains an unexpected or duplicate signer")
		}
		seen[key] = true
		if key == wallet.String() {
			walletIndex = index
		}
	}
	if walletIndex < 0 {
		return -1, errors.New("typed Jupiter transaction omits the signer-owned wallet")
	}
	payer := tx.Message.AccountKeys[0]
	if !payer.Equals(wallet) && !(allowVaultPayer && payer.String() == intent.Intent.Jupiter.Trigger.Vault) {
		return -1, errors.New("typed Jupiter transaction payer is outside the reviewed wallet/vault")
	}
	return walletIndex, nil
}

type jupiterRPCReadErrorV2 struct{ err error }

func (e jupiterRPCReadErrorV2) Error() string { return e.err.Error() }
func (e jupiterRPCReadErrorV2) Unwrap() error { return e.err }
func isJupiterRPCReadFailureV2(err error) bool {
	var target jupiterRPCReadErrorV2
	return errors.As(err, &target)
}

func validateAndSimulateJupiterAtRPCV2(
	rpcURL string,
	tx *solana.Transaction,
	raw []byte,
	wallet solana.PublicKey,
	walletSignerIndex int,
	intent normalizedIntentV2,
	envelope signerSolanaTransactionEnvelopeV2,
) (jupiterValidatedTransactionV2, error) {
	// Re-decode for each endpoint because lookup resolution mutates Message.
	candidate, err := solana.TransactionFromBytes(raw)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	client := rpc.New(rpcURL)
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	defer cancel()
	if err := resolveAndVerifyLookupsV2(ctx, client, &candidate.Message); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	allKeys, err := candidate.Message.GetAllKeys()
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if len(allKeys) == 0 || len(allKeys) > 100 {
		return jupiterValidatedTransactionV2{}, errors.New("typed Jupiter transaction has an unsupported account count")
	}
	if err := rejectDuplicateTransactionAccountsV2(allKeys); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	accountMap, err := fetchJupiterAccountsV2(ctx, client, allKeys)
	if err != nil {
		return jupiterValidatedTransactionV2{}, jupiterRPCReadErrorV2{err}
	}
	programs, err := collectJupiterProgramsV2(candidate, accountMap)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if !equalSortedStringsV2(programs, envelope.Programs) {
		return jupiterValidatedTransactionV2{}, errors.New("caller program manifest does not match decoded transaction programs")
	}
	writableKeys, err := candidate.Message.Writable()
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	writable := publicKeyStringsSortedV2(writableKeys)
	if !equalSortedStringsV2(writable, envelope.WritableAccounts) {
		return jupiterValidatedTransactionV2{}, errors.New("caller writable-account manifest does not match decoded transaction")
	}
	if len(writableKeys) == 0 || len(writableKeys) > 64 {
		return jupiterValidatedTransactionV2{}, errors.New("typed Jupiter transaction has an unsupported writable-account count")
	}
	if err := validateJupiterWritableOwnersV2(writableKeys, accountMap, programs, intent); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if err := validateJupiterInstructionsV2(candidate, wallet, intent, accountMap); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}

	observed := uniquePublicKeysV2(append(append([]solana.PublicKey(nil), writableKeys...), wallet))
	post, err := simulateJupiterAccountsV2(ctx, client, candidate, observed)
	if err != nil {
		return jupiterValidatedTransactionV2{}, jupiterRPCReadErrorV2{err}
	}
	if err := validateJupiterBalanceSemanticsV2(wallet, intent, jupiterTransactionSnapshotV2{Accounts: accountMap, Post: post}); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	return jupiterValidatedTransactionV2{
		Transaction:       candidate,
		RawUnsigned:       raw,
		Programs:          programs,
		Writable:          writable,
		WalletSignerIndex: walletSignerIndex,
	}, nil
}

func resolveAndVerifyLookupsV2(ctx context.Context, client *rpc.Client, message *solana.Message) error {
	lookups := message.GetAddressTableLookups()
	if len(lookups) == 0 {
		return nil
	}
	tables := make(map[solana.PublicKey]solana.PublicKeySlice, len(lookups))
	seen := map[string]bool{}
	for _, lookup := range lookups {
		key := lookup.AccountKey.String()
		if seen[key] {
			return errors.New("duplicate address lookup table is not supported")
		}
		seen[key] = true
		account, err := client.GetAccountInfo(ctx, lookup.AccountKey)
		if err != nil {
			return jupiterRPCReadErrorV2{fmt.Errorf("fetch address lookup table: %w", err)}
		}
		if account == nil || account.Value == nil || !account.Value.Owner.Equals(addressLookupTableProgramV2) || account.Value.Executable {
			return errors.New("address lookup table owner/executable state is invalid")
		}
		raw := account.GetBinary()
		if len(raw) < addresslookuptable.LOOKUP_TABLE_META_SIZE ||
			(len(raw)-addresslookuptable.LOOKUP_TABLE_META_SIZE)%32 != 0 ||
			(len(raw)-addresslookuptable.LOOKUP_TABLE_META_SIZE)/32 > addresslookuptable.LOOKUP_TABLE_MAX_ADDRESSES {
			return errors.New("address lookup table has a non-canonical serialized length")
		}
		state, err := addresslookuptable.DecodeAddressLookupTableState(raw)
		if err != nil || state.TypeIndex != 1 || !state.IsActive() {
			return errors.New("address lookup table is malformed or deactivated")
		}
		if int(state.LastExtendedSlotStartIndex) > len(state.Addresses) {
			return errors.New("address lookup table extension metadata is inconsistent")
		}
		indexSeen := map[uint8]string{}
		for _, index := range lookup.WritableIndexes {
			if int(index) >= len(state.Addresses) || indexSeen[index] != "" {
				return errors.New("address lookup table contains duplicate or out-of-range indexes")
			}
			indexSeen[index] = "writable"
		}
		for _, index := range lookup.ReadonlyIndexes {
			if int(index) >= len(state.Addresses) || indexSeen[index] != "" {
				return errors.New("address lookup table contains duplicate or out-of-range indexes")
			}
			indexSeen[index] = "readonly"
		}
		tables[lookup.AccountKey] = state.Addresses
	}
	if err := message.SetAddressTables(tables); err != nil {
		return fmt.Errorf("set verified address lookup tables: %w", err)
	}
	return message.ResolveLookups()
}

func rejectDuplicateTransactionAccountsV2(keys solana.PublicKeySlice) error {
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		value := key.String()
		if seen[value] {
			return fmt.Errorf("duplicate transaction account %s is not supported", value)
		}
		seen[value] = true
	}
	return nil
}

func fetchJupiterAccountsV2(ctx context.Context, client *rpc.Client, keys []solana.PublicKey) (map[string]*rpc.Account, error) {
	result := make(map[string]*rpc.Account, len(keys))
	for start := 0; start < len(keys); start += 100 {
		end := start + 100
		if end > len(keys) {
			end = len(keys)
		}
		response, err := client.GetMultipleAccounts(ctx, keys[start:end]...)
		if err != nil {
			return nil, fmt.Errorf("fetch transaction accounts: %w", err)
		}
		if response == nil || len(response.Value) != end-start {
			return nil, errors.New("transaction account RPC response length mismatch")
		}
		for index, account := range response.Value {
			result[keys[start+index].String()] = account
		}
	}
	return result, nil
}

func collectJupiterProgramsV2(tx *solana.Transaction, accounts map[string]*rpc.Account) ([]string, error) {
	programSet := map[string]bool{}
	for _, instruction := range tx.Message.Instructions {
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		if err != nil {
			return nil, errors.New("transaction contains unresolved program id")
		}
		programSet[program.String()] = true
		metas, err := instruction.ResolveInstructionAccounts(&tx.Message)
		if err != nil {
			return nil, errors.New("transaction contains unresolved instruction accounts")
		}
		for _, meta := range metas {
			if account := accounts[meta.PublicKey.String()]; account != nil && account.Executable {
				programSet[meta.PublicKey.String()] = true
			}
		}
	}
	programs := make([]string, 0, len(programSet))
	for program := range programSet {
		programs = append(programs, program)
	}
	sort.Strings(programs)
	return programs, nil
}

func publicKeyStringsSortedV2(keys []solana.PublicKey) []string {
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, key.String())
	}
	sort.Strings(values)
	return values
}

func uniquePublicKeysV2(keys []solana.PublicKey) []solana.PublicKey {
	seen := map[string]bool{}
	out := make([]solana.PublicKey, 0, len(keys))
	for _, key := range keys {
		if seen[key.String()] {
			continue
		}
		seen[key.String()] = true
		out = append(out, key)
	}
	return out
}

func validateJupiterWritableOwnersV2(keys []solana.PublicKey, accounts map[string]*rpc.Account, programs []string, intent normalizedIntentV2) error {
	allowedOwners := map[string]bool{
		solana.SystemProgramID.String():    true,
		solana.TokenProgramID.String():     true,
		solana.Token2022ProgramID.String(): true,
	}
	for _, program := range programs {
		allowedOwners[program] = true
	}
	for _, key := range keys {
		account := accounts[key.String()]
		if account == nil {
			continue // creation is checked against post-state and instruction shapes.
		}
		if account.Executable {
			return fmt.Errorf("executable account %s cannot be writable", key)
		}
		if !allowedOwners[account.Owner.String()] {
			return fmt.Errorf("writable account %s has unknown owner %s", key, account.Owner)
		}
	}
	return nil
}

func validateJupiterInstructionsV2(
	tx *solana.Transaction,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	accounts map[string]*rpc.Account,
) error {
	jupiter := intent.Intent.Jupiter
	if jupiter == nil {
		return errors.New("missing Jupiter semantics")
	}
	applicationInstructions := 0
	computeLimit := uint64(1_400_000)
	computePrice := uint64(0)
	seenCompute := map[byte]bool{}
	for index := range tx.Message.Instructions {
		instruction := &tx.Message.Instructions[index]
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		if err != nil {
			return err
		}
		metas, err := instruction.ResolveInstructionAccounts(&tx.Message)
		if err != nil {
			return err
		}
		data := []byte(instruction.Data)
		switch {
		case program.Equals(computeBudgetProgramV2):
			if err := validateComputeBudgetInstructionV2(data, metas, seenCompute, &computeLimit, &computePrice); err != nil {
				return err
			}
		case program.Equals(solana.SystemProgramID):
			action, err := validateJupiterSystemInstructionV2(data, metas, wallet, intent)
			if err != nil {
				return err
			}
			if action {
				applicationInstructions++
			}
		case program.Equals(solana.SPLAssociatedTokenAccountProgramID):
			if err := validateJupiterATAInstructionV2(data, metas, wallet, intent); err != nil {
				return err
			}
		case program.Equals(solana.TokenProgramID) || program.Equals(solana.Token2022ProgramID):
			action, err := validateJupiterTokenInstructionV2(data, metas, wallet, intent, program, accounts)
			if err != nil {
				return err
			}
			if action {
				applicationInstructions++
			}
		case program.Equals(memoProgramV1V2) || program.Equals(memoProgramV2V2):
			if intent.Intent.Type != intentSolanaTriggerAuth ||
				jupiter.Trigger == nil || jupiter.Trigger.Program != program.String() ||
				len(data) == 0 || len(data) > 512 ||
				!strings.Contains(string(data), "Jupiter Trigger Order API") ||
				!instructionContainsSignerV2(metas, wallet) {
				return errors.New("memo instruction is allowed only for a bounded Trigger auth challenge signed by the wallet")
			}
			applicationInstructions++
		case program.String() == jupiterAggregatorV6V2 && intent.Intent.Type == intentSolanaJupiterSwap:
			action, err := validateJupiterAuxiliaryInstructionV2(data, metas, wallet, jupiter)
			if err != nil {
				return err
			}
			if action {
				applicationInstructions++
			}
		default:
			return fmt.Errorf("unsupported top-level instruction program %s", program)
		}
	}
	if applicationInstructions != 1 {
		return errors.New("typed Jupiter transaction must contain exactly one action instruction")
	}
	maxFee, _ := new(big.Int).SetString(jupiter.MaxFeeLamports, 10)
	priorityFee := new(big.Int).Mul(new(big.Int).SetUint64(computeLimit), new(big.Int).SetUint64(computePrice))
	priorityFee.Add(priorityFee, big.NewInt(999_999)).Div(priorityFee, big.NewInt(1_000_000))
	if maxFee == nil || priorityFee.Cmp(maxFee) > 0 {
		return errors.New("compute-unit price exceeds the reviewed fee ceiling")
	}
	return nil
}

func validateComputeBudgetInstructionV2(data []byte, metas []*solana.AccountMeta, seen map[byte]bool, limit, price *uint64) error {
	if len(metas) != 0 || len(data) == 0 || seen[data[0]] {
		return errors.New("invalid or duplicate compute-budget instruction")
	}
	seen[data[0]] = true
	switch data[0] {
	case 1: // request heap frame
		if len(data) != 5 || binary.LittleEndian.Uint32(data[1:]) > 256*1024 {
			return errors.New("unsupported compute heap-frame request")
		}
	case 2: // set compute-unit limit
		if len(data) != 5 {
			return errors.New("invalid compute-unit-limit instruction")
		}
		value := uint64(binary.LittleEndian.Uint32(data[1:]))
		if value == 0 || value > 1_400_000 {
			return errors.New("compute-unit limit is outside the signer ceiling")
		}
		*limit = value
	case 3: // set compute-unit price
		if len(data) != 9 {
			return errors.New("invalid compute-unit-price instruction")
		}
		*price = binary.LittleEndian.Uint64(data[1:])
	case 4: // loaded accounts data size limit
		if len(data) != 5 || binary.LittleEndian.Uint32(data[1:]) > 64*1024*1024 {
			return errors.New("unsupported loaded-account-data limit")
		}
	default:
		return errors.New("unknown compute-budget instruction")
	}
	return nil
}

func validateJupiterSystemInstructionV2(data []byte, metas []*solana.AccountMeta, wallet solana.PublicKey, normalized normalizedIntentV2) (bool, error) {
	intent := normalized.Intent.Jupiter
	if len(data) != 12 || binary.LittleEndian.Uint32(data[:4]) != 2 || len(metas) != 2 {
		return false, errors.New("only an exact System transfer for native-token wrapping/deposit is supported")
	}
	if !metas[0].IsSigner || !metas[0].IsWritable || !metas[1].IsWritable || metas[1].IsSigner {
		return false, errors.New("System transfer signer/account flags are invalid")
	}
	target := intent.SourceTokenAccount
	isAction := false
	amount := new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[4:]))
	switch normalized.Intent.Type {
	case intentSolanaTriggerCreate, intentSolanaTriggerDeposit:
		if intent.Trigger == nil || intent.Trigger.Program != solana.SystemProgramID.String() ||
			intent.InputMint != solanaNativeMintV2 ||
			!metas[0].PublicKey.Equals(wallet) ||
			metas[0].PublicKey.String() != intent.SourceTokenAccount {
			return false, errors.New("native Trigger deposit source/program does not match reviewed semantics")
		}
		target = intent.DestinationTokenAccount
		exact, _ := new(big.Int).SetString(intent.InputAmount, 10)
		if amount.Cmp(exact) != 0 {
			return false, errors.New("native Trigger deposit amount does not equal the reviewed amount")
		}
		isAction = true
	case intentSolanaTriggerCancel, intentSolanaTriggerWithdraw:
		if intent.Trigger == nil || intent.Trigger.Program != solana.SystemProgramID.String() ||
			intent.OutputMint != solanaNativeMintV2 ||
			metas[0].PublicKey.String() != intent.Trigger.Vault ||
			metas[0].PublicKey.String() != intent.SourceTokenAccount ||
			!metas[1].PublicKey.Equals(wallet) ||
			metas[1].PublicKey.String() != intent.DestinationTokenAccount {
			return false, errors.New("native Trigger withdrawal accounts/program do not match reviewed semantics")
		}
		exact, _ := new(big.Int).SetString(intent.MinimumOutputAmount, 10)
		if amount.Cmp(exact) != 0 {
			return false, errors.New("native Trigger withdrawal amount does not equal the locked order refund")
		}
		target = intent.DestinationTokenAccount
		isAction = true
	default:
		if !metas[0].PublicKey.Equals(wallet) || intent.InputMint != solanaNativeMintV2 {
			return false, errors.New("System transfer source does not match the reviewed wallet")
		}
		maxInput, _ := new(big.Int).SetString(intent.MaxInputAmount, 10)
		maxFee, _ := new(big.Int).SetString(intent.MaxFeeLamports, 10)
		ceiling := new(big.Int).Add(maxInput, maxFee)
		if amount.Sign() <= 0 || amount.Cmp(ceiling) > 0 {
			return false, errors.New("System transfer exceeds the reviewed native-input and fee ceiling")
		}
	}
	if metas[1].PublicKey.String() != target {
		return false, errors.New("System transfer does not target the exact reviewed account")
	}
	return isAction, nil
}

func validateJupiterATAInstructionV2(data []byte, metas []*solana.AccountMeta, wallet solana.PublicKey, normalized normalizedIntentV2) error {
	if (len(data) != 0 && !(len(data) == 1 && (data[0] == 0 || data[0] == 1))) || len(metas) < 6 || len(metas) > 7 {
		return errors.New("unsupported associated-token-account instruction")
	}
	if !metas[0].PublicKey.Equals(wallet) || !metas[0].IsSigner || !metas[0].IsWritable || !metas[1].IsWritable || metas[1].IsSigner {
		return errors.New("associated-token-account payer/account flags are invalid")
	}
	if !metas[4].PublicKey.Equals(solana.SystemProgramID) || (!metas[5].PublicKey.Equals(solana.TokenProgramID) && !metas[5].PublicKey.Equals(solana.Token2022ProgramID)) {
		return errors.New("associated-token-account infrastructure programs are invalid")
	}
	expected, err := findAssociatedTokenAddressV2(metas[2].PublicKey, metas[3].PublicKey, metas[5].PublicKey)
	if err != nil || !expected.Equals(metas[1].PublicKey) {
		return errors.New("associated-token-account address does not match owner/mint/token program")
	}
	jupiter := normalized.Intent.Jupiter
	if jupiter == nil {
		return errors.New("associated-token-account instruction lacks reviewed Jupiter semantics")
	}
	type allowedATA struct {
		account string
		owner   string
		mint    string
	}
	allowed := []allowedATA{
		{account: jupiter.SourceTokenAccount, owner: wallet.String(), mint: jupiter.InputMint},
		{account: jupiter.DestinationTokenAccount, owner: wallet.String(), mint: jupiter.OutputMint},
	}
	if jupiter.Trigger != nil {
		switch normalized.Intent.Type {
		case intentSolanaTriggerCreate, intentSolanaTriggerDeposit:
			allowed[1] = allowedATA{account: jupiter.DestinationTokenAccount, owner: jupiter.Trigger.Vault, mint: jupiter.InputMint}
		case intentSolanaTriggerCancel, intentSolanaTriggerWithdraw:
			allowed[0] = allowedATA{account: jupiter.SourceTokenAccount, owner: jupiter.Trigger.Vault, mint: jupiter.OutputMint}
			allowed[1] = allowedATA{account: jupiter.DestinationTokenAccount, owner: wallet.String(), mint: jupiter.OutputMint}
		}
	}
	for _, candidate := range allowed {
		if candidate.account != "" && metas[1].PublicKey.String() == candidate.account &&
			metas[2].PublicKey.String() == candidate.owner && metas[3].PublicKey.String() == candidate.mint {
			return nil
		}
	}
	return errors.New("associated-token-account creation is outside reviewed accounts/mints/owners")
}

func validateJupiterTokenInstructionV2(
	data []byte,
	metas []*solana.AccountMeta,
	wallet solana.PublicKey,
	normalized normalizedIntentV2,
	program solana.PublicKey,
	accounts map[string]*rpc.Account,
) (bool, error) {
	intent := normalized.Intent.Jupiter
	if len(data) == 0 {
		return false, errors.New("empty token instruction")
	}
	switch data[0] {
	case 3: // Transfer
		if len(data) != 9 || len(metas) != 3 || !metas[0].IsWritable || !metas[1].IsWritable || !metas[2].IsSigner {
			return false, errors.New("invalid typed Trigger token Transfer")
		}
		if metas[0].PublicKey.String() != intent.SourceTokenAccount || metas[1].PublicKey.String() != intent.DestinationTokenAccount {
			return false, errors.New("Trigger token Transfer accounts do not match reviewed source/destination")
		}
		if err := validateDirectTriggerTokenTransferV2(
			binary.LittleEndian.Uint64(data[1:]),
			metas[2].PublicKey,
			wallet,
			normalized,
			program,
			accounts,
		); err != nil {
			return false, err
		}
		return intent.Trigger != nil && intent.Trigger.Program == program.String(), nil
	case 12: // TransferChecked
		if len(data) != 10 || len(metas) != 4 || !metas[0].IsWritable || !metas[2].IsWritable || !metas[3].IsSigner {
			return false, errors.New("invalid typed Trigger TransferChecked")
		}
		mint := intent.InputMint
		if normalized.Intent.Type == intentSolanaTriggerCancel || normalized.Intent.Type == intentSolanaTriggerWithdraw {
			mint = intent.OutputMint
		}
		if metas[0].PublicKey.String() != intent.SourceTokenAccount || metas[2].PublicKey.String() != intent.DestinationTokenAccount || metas[1].PublicKey.String() != mint {
			return false, errors.New("Trigger TransferChecked mint/accounts do not match reviewed semantics")
		}
		if mintAccount := accounts[metas[1].PublicKey.String()]; mintAccount == nil || !mintAccount.Owner.Equals(program) || mintAccount.Executable {
			return false, errors.New("Trigger TransferChecked mint is not owned by the reviewed token program")
		}
		if err := validateDirectTriggerTokenTransferV2(
			binary.LittleEndian.Uint64(data[1:9]),
			metas[3].PublicKey,
			wallet,
			normalized,
			program,
			accounts,
		); err != nil {
			return false, err
		}
		return intent.Trigger != nil && intent.Trigger.Program == program.String(), nil
	case 17: // SyncNative
		target := intent.SourceTokenAccount
		if normalized.Intent.Type == intentSolanaTriggerCreate || normalized.Intent.Type == intentSolanaTriggerDeposit {
			target = intent.DestinationTokenAccount
		}
		if len(data) != 1 || len(metas) != 1 || metas[0].PublicKey.String() != target || !metas[0].IsWritable {
			return false, errors.New("SyncNative must target the exact reviewed native-input account")
		}
	case 9: // CloseAccount
		if len(data) != 1 || len(metas) != 3 || !metas[0].IsWritable || !metas[1].PublicKey.Equals(wallet) || !metas[1].IsWritable || !metas[2].PublicKey.Equals(wallet) || !metas[2].IsSigner {
			return false, errors.New("CloseAccount must close the reviewed temporary account back to the wallet")
		}
		if metas[0].PublicKey.String() != intent.SourceTokenAccount && metas[0].PublicKey.String() != intent.DestinationTokenAccount {
			return false, errors.New("CloseAccount targets an unknown token account")
		}
	default:
		return false, errors.New("unknown top-level SPL Token instruction")
	}
	return false, nil
}

func validateDirectTriggerTokenTransferV2(
	amount uint64,
	authority solana.PublicKey,
	wallet solana.PublicKey,
	normalized normalizedIntentV2,
	program solana.PublicKey,
	accounts map[string]*rpc.Account,
) error {
	intent := normalized.Intent.Jupiter
	if intent == nil || intent.Trigger == nil || intent.Trigger.Program != program.String() {
		return errors.New("direct token transfer is not the reviewed Trigger action")
	}
	for _, address := range []string{intent.SourceTokenAccount, intent.DestinationTokenAccount} {
		if account := accounts[address]; account != nil && (!account.Owner.Equals(program) || account.Executable) {
			return errors.New("Trigger token account owner does not match the decoded token program")
		}
	}
	value := new(big.Int).SetUint64(amount)
	switch normalized.Intent.Type {
	case intentSolanaTriggerCreate, intentSolanaTriggerDeposit:
		if !authority.Equals(wallet) {
			return errors.New("Trigger deposit token authority is not the signer-owned wallet")
		}
		exact, _ := new(big.Int).SetString(intent.InputAmount, 10)
		if exact == nil || value.Cmp(exact) != 0 {
			return errors.New("Trigger deposit token amount does not equal the reviewed amount")
		}
	case intentSolanaTriggerCancel, intentSolanaTriggerWithdraw:
		if authority.String() != intent.Trigger.Vault {
			return errors.New("Trigger withdrawal token authority is not the reviewed vault signer")
		}
		exact, _ := new(big.Int).SetString(intent.MinimumOutputAmount, 10)
		if exact == nil || value.Cmp(exact) != 0 {
			return errors.New("Trigger withdrawal amount does not equal the locked order refund")
		}
	default:
		return errors.New("direct Trigger token transfer is unsupported for this operation")
	}
	return nil
}

func validateJupiterInstructionAmountV2(amount uint64, intent *signerJupiterIntentV2) error {
	exact, _ := new(big.Int).SetString(intent.InputAmount, 10)
	maximum, _ := new(big.Int).SetString(intent.MaxInputAmount, 10)
	value := new(big.Int).SetUint64(amount)
	if exact == nil || maximum == nil || value.Cmp(exact) < 0 || value.Cmp(maximum) > 0 || (exact.Cmp(maximum) == 0 && value.Cmp(exact) != 0) {
		return errors.New("Trigger instruction amount does not match exact/max reviewed input")
	}
	return nil
}

func instructionContainsSignerV2(metas []*solana.AccountMeta, wallet solana.PublicKey) bool {
	for _, meta := range metas {
		if meta.PublicKey.Equals(wallet) && meta.IsSigner {
			return true
		}
	}
	return false
}

func instructionContainsAccountV2(metas []*solana.AccountMeta, address string) bool {
	if address == "" {
		return true
	}
	for _, meta := range metas {
		if meta.PublicKey.String() == address {
			return true
		}
	}
	return false
}

func validateJupiterApplicationAccountsV2(metas []*solana.AccountMeta, wallet solana.PublicKey, intent normalizedIntentV2) error {
	if !instructionContainsSignerV2(metas, wallet) {
		return errors.New("Jupiter action instruction does not bind the exact wallet signer")
	}
	for _, meta := range metas {
		if meta.IsSigner && !meta.PublicKey.Equals(wallet) {
			return errors.New("Jupiter action instruction contains an unexpected signer")
		}
	}
	jupiter := intent.Intent.Jupiter
	for _, address := range []string{jupiter.SourceTokenAccount, jupiter.DestinationTokenAccount} {
		if !instructionContainsAccountV2(metas, address) {
			return fmt.Errorf("Jupiter action instruction omits reviewed account %s", address)
		}
	}
	if jupiter.Trigger != nil {
		addresses := []string{jupiter.Trigger.Vault, jupiter.Trigger.Order}
		if jupiter.Trigger.Program == solana.TokenProgramID.String() ||
			jupiter.Trigger.Program == solana.Token2022ProgramID.String() ||
			jupiter.Trigger.Program == solana.SystemProgramID.String() {
			// Direct typed deposits bind the vault through the independently
			// decoded destination token-account owner instead of an owner meta.
			addresses[0] = ""
		}
		for _, address := range addresses {
			if !instructionContainsAccountV2(metas, address) {
				return fmt.Errorf("Trigger action instruction omits reviewed identity %s", address)
			}
		}
	}
	return nil
}

func simulateJupiterAccountsV2(ctx context.Context, client *rpc.Client, tx *solana.Transaction, addresses []solana.PublicKey) (map[string]*rpc.Account, error) {
	response, err := client.SimulateTransactionWithOpts(ctx, tx, &rpc.SimulateTransactionOpts{
		SigVerify:  false,
		Commitment: rpc.CommitmentConfirmed,
		Accounts: &rpc.SimulateTransactionAccountsOpts{
			Encoding:  solana.EncodingBase64,
			Addresses: addresses,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("simulate typed Jupiter transaction: %w", err)
	}
	if response == nil || response.Value == nil || response.Value.Err != nil {
		return nil, fmt.Errorf("typed Jupiter transaction simulation failed: %v", responseValueErrorV2(response))
	}
	if len(response.Value.Accounts) != len(addresses) {
		return nil, errors.New("simulation account response length mismatch")
	}
	post := make(map[string]*rpc.Account, len(addresses))
	for index, key := range addresses {
		post[key.String()] = response.Value.Accounts[index]
	}
	return post, nil
}

func responseValueErrorV2(response *rpc.SimulateTransactionResponse) any {
	if response == nil || response.Value == nil {
		return "missing response"
	}
	return response.Value.Err
}

func parseJupiterTokenAccountV2(account *rpc.Account) (jupiterTokenAccountV2, bool) {
	if account == nil || (!account.Owner.Equals(solana.TokenProgramID) && !account.Owner.Equals(solana.Token2022ProgramID)) || account.Data == nil {
		return jupiterTokenAccountV2{}, false
	}
	data := account.Data.GetBinary()
	if len(data) < 165 || data[108] == 0 {
		return jupiterTokenAccountV2{}, false
	}
	var mint, owner solana.PublicKey
	copy(mint[:], data[:32])
	copy(owner[:], data[32:64])
	return jupiterTokenAccountV2{Mint: mint, Owner: owner, Amount: binary.LittleEndian.Uint64(data[64:72])}, true
}

func validateJupiterBalanceSemanticsV2(wallet solana.PublicKey, intent normalizedIntentV2, snapshot jupiterTransactionSnapshotV2) error {
	jupiter := intent.Intent.Jupiter
	if jupiter == nil {
		return errors.New("missing Jupiter semantics")
	}
	preWallet := snapshot.Accounts[wallet.String()]
	postWallet := snapshot.Post[wallet.String()]
	if preWallet == nil || postWallet == nil {
		return errors.New("simulation omitted the wallet payer account")
	}
	if preWallet.Executable || postWallet.Executable ||
		!preWallet.Owner.Equals(solana.SystemProgramID) || !postWallet.Owner.Equals(solana.SystemProgramID) ||
		(preWallet.Data != nil && len(preWallet.Data.GetBinary()) != 0) ||
		(postWallet.Data != nil && len(postWallet.Data.GetBinary()) != 0) {
		return errors.New("simulation changes or misrepresents the wallet System account identity")
	}
	preLamports := new(big.Int).SetUint64(preWallet.Lamports)
	postLamports := new(big.Int).SetUint64(postWallet.Lamports)
	netSpend := new(big.Int).Sub(preLamports, postLamports)
	maxFee, _ := new(big.Int).SetString(jupiter.MaxFeeLamports, 10)
	maxInput, _ := new(big.Int).SetString(jupiter.MaxInputAmount, 10)
	minimumOutput, _ := new(big.Int).SetString(jupiter.MinimumOutputAmount, 10)

	if jupiter.InputMint == solanaNativeMintV2 && maxInput.Sign() > 0 {
		ceiling := new(big.Int).Add(maxInput, maxFee)
		if netSpend.Cmp(maxInput) < 0 || netSpend.Cmp(ceiling) > 0 {
			return errors.New("native input plus fees exceeds the reviewed ceiling")
		}
	} else if netSpend.Sign() > 0 && netSpend.Cmp(maxFee) > 0 {
		return errors.New("wallet lamport/rent/fee spend exceeds the reviewed fee ceiling")
	}
	if jupiter.OutputMint == solanaNativeMintV2 && minimumOutput.Sign() > 0 {
		walletGain := new(big.Int).Sub(postLamports, preLamports)
		minimumAfterFee := new(big.Int).Sub(new(big.Int).Set(minimumOutput), maxFee)
		if walletGain.Cmp(minimumAfterFee) < 0 || walletGain.Cmp(minimumOutput) > 0 {
			return errors.New("simulated native output is below the reviewed minimum")
		}
	}

	if jupiter.InputMint != "" && jupiter.InputMint != solanaNativeMintV2 {
		pre, ok := parseJupiterTokenAccountV2(snapshot.Accounts[jupiter.SourceTokenAccount])
		post, postOK := parseJupiterTokenAccountV2(snapshot.Post[jupiter.SourceTokenAccount])
		if !ok || !postOK || pre.Mint.String() != jupiter.InputMint || !pre.Owner.Equals(wallet) || !post.Mint.Equals(pre.Mint) || !post.Owner.Equals(pre.Owner) || post.Amount > pre.Amount {
			return errors.New("input token account does not match the reviewed wallet/mint or simulated direction")
		}
		spent := new(big.Int).SetUint64(pre.Amount - post.Amount)
		exact, _ := new(big.Int).SetString(jupiter.InputAmount, 10)
		if spent.Cmp(exact) < 0 || spent.Cmp(maxInput) > 0 || (exact.Cmp(maxInput) == 0 && spent.Cmp(exact) != 0) {
			return errors.New("simulated token input does not match exact/max reviewed input")
		}
	}

	if jupiter.OutputMint != "" && jupiter.OutputMint != solanaNativeMintV2 && minimumOutput.Sign() > 0 {
		pre, preOK := parseJupiterTokenAccountV2(snapshot.Accounts[jupiter.DestinationTokenAccount])
		post, postOK := parseJupiterTokenAccountV2(snapshot.Post[jupiter.DestinationTokenAccount])
		if !postOK || post.Mint.String() != jupiter.OutputMint {
			return errors.New("output token account mint does not match reviewed output")
		}
		expectedOwner := wallet.String()
		if (intent.Intent.Type == intentSolanaTriggerCreate || intent.Intent.Type == intentSolanaTriggerDeposit) && jupiter.Trigger != nil {
			expectedOwner = jupiter.Trigger.Vault
		}
		if post.Owner.String() != expectedOwner {
			return errors.New("output token account owner does not match reviewed wallet/vault")
		}
		preAmount := uint64(0)
		if preOK {
			if !pre.Mint.Equals(post.Mint) || !pre.Owner.Equals(post.Owner) {
				return errors.New("output token account identity changed during simulation")
			}
			preAmount = pre.Amount
		}
		if post.Amount < preAmount || new(big.Int).SetUint64(post.Amount-preAmount).Cmp(minimumOutput) < 0 {
			return errors.New("simulated token output is below the reviewed minimum")
		}
	}
	if (intent.Intent.Type == intentSolanaTriggerCancel || intent.Intent.Type == intentSolanaTriggerWithdraw) && jupiter.Trigger != nil {
		if jupiter.OutputMint == solanaNativeMintV2 {
			preVault := snapshot.Accounts[jupiter.SourceTokenAccount]
			postVault := snapshot.Post[jupiter.SourceTokenAccount]
			if preVault == nil || postVault == nil || preVault.Executable || postVault.Executable ||
				!preVault.Owner.Equals(solana.SystemProgramID) || !postVault.Owner.Equals(solana.SystemProgramID) ||
				jupiter.SourceTokenAccount != jupiter.Trigger.Vault || postVault.Lamports > preVault.Lamports {
				return errors.New("native Trigger withdrawal source is not the reviewed System vault")
			}
			decrease := new(big.Int).SetUint64(preVault.Lamports - postVault.Lamports)
			maximum := new(big.Int).Add(new(big.Int).Set(minimumOutput), maxFee)
			if decrease.Cmp(minimumOutput) < 0 || decrease.Cmp(maximum) > 0 {
				return errors.New("native Trigger vault decrease is outside refund plus fee bounds")
			}
		} else {
			pre, preOK := parseJupiterTokenAccountV2(snapshot.Accounts[jupiter.SourceTokenAccount])
			post, postOK := parseJupiterTokenAccountV2(snapshot.Post[jupiter.SourceTokenAccount])
			if !preOK || pre.Mint.String() != jupiter.OutputMint || pre.Owner.String() != jupiter.Trigger.Vault {
				return errors.New("Trigger withdrawal source does not match reviewed vault/mint")
			}
			postAmount := uint64(0)
			if postOK {
				if !post.Mint.Equals(pre.Mint) || !post.Owner.Equals(pre.Owner) || post.Amount > pre.Amount {
					return errors.New("Trigger withdrawal source identity/direction changed during simulation")
				}
				postAmount = post.Amount
			}
			if new(big.Int).SetUint64(pre.Amount-postAmount).Cmp(minimumOutput) != 0 {
				return errors.New("Trigger vault withdrawal does not equal the locked order refund")
			}
		}
	}
	if intent.Intent.Type == intentSolanaTriggerCreate || intent.Intent.Type == intentSolanaTriggerDeposit {
		exact, _ := new(big.Int).SetString(jupiter.InputAmount, 10)
		if jupiter.Trigger == nil {
			return errors.New("Trigger deposit lacks reviewed vault semantics")
		}
		if jupiter.InputMint == solanaNativeMintV2 {
			preVault := snapshot.Accounts[jupiter.DestinationTokenAccount]
			postVault := snapshot.Post[jupiter.DestinationTokenAccount]
			if preVault == nil || postVault == nil || preVault.Executable || postVault.Executable ||
				!preVault.Owner.Equals(solana.SystemProgramID) || !postVault.Owner.Equals(solana.SystemProgramID) ||
				jupiter.DestinationTokenAccount != jupiter.Trigger.Vault || postVault.Lamports < preVault.Lamports ||
				new(big.Int).SetUint64(postVault.Lamports-preVault.Lamports).Cmp(exact) != 0 {
				return errors.New("native Trigger vault deposit does not equal reviewed input amount")
			}
		} else {
			pre, preOK := parseJupiterTokenAccountV2(snapshot.Accounts[jupiter.DestinationTokenAccount])
			post, postOK := parseJupiterTokenAccountV2(snapshot.Post[jupiter.DestinationTokenAccount])
			if !postOK || post.Mint.String() != jupiter.InputMint || post.Owner.String() != jupiter.Trigger.Vault {
				return errors.New("Trigger deposit destination does not match reviewed input mint/vault")
			}
			preAmount := uint64(0)
			if preOK {
				if !pre.Mint.Equals(post.Mint) || !pre.Owner.Equals(post.Owner) {
					return errors.New("Trigger vault token-account identity changed during simulation")
				}
				preAmount = pre.Amount
			}
			if post.Amount < preAmount || new(big.Int).SetUint64(post.Amount-preAmount).Cmp(exact) != 0 {
				return errors.New("Trigger vault deposit does not equal reviewed input amount")
			}
		}
	}

	for key := range snapshot.Post {
		preAccount := snapshot.Accounts[key]
		pre, ok := parseJupiterTokenAccountV2(preAccount)
		if !ok || !pre.Owner.Equals(wallet) || key == jupiter.SourceTokenAccount {
			continue
		}
		post, postOK := parseJupiterTokenAccountV2(snapshot.Post[key])
		if !postOK || !post.Mint.Equals(pre.Mint) || !post.Owner.Equals(pre.Owner) || post.Amount < pre.Amount {
			return fmt.Errorf("simulation decreases an unreviewed wallet token account %s", key)
		}
	}
	return nil
}

func signValidatedJupiterTransactionV2(validated jupiterValidatedTransactionV2, privateKey solana.PrivateKey) ([]byte, solana.Signature, error) {
	if validated.Transaction == nil {
		return nil, solana.Signature{}, errors.New("validated transaction is missing")
	}
	wallet := privateKey.PublicKey()
	_, err := validated.Transaction.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(wallet) {
			copy := privateKey
			return &copy
		}
		return nil
	})
	if err != nil {
		return nil, solana.Signature{}, fmt.Errorf("sign typed Jupiter transaction: %w", err)
	}
	if validated.WalletSignerIndex < 0 || validated.WalletSignerIndex >= len(validated.Transaction.Signatures) ||
		validated.Transaction.Signatures[validated.WalletSignerIndex].IsZero() {
		return nil, solana.Signature{}, errors.New("typed Jupiter transaction signature is missing")
	}
	for index, signature := range validated.Transaction.Signatures {
		if index != validated.WalletSignerIndex && !signature.IsZero() {
			return nil, solana.Signature{}, errors.New("signer modified an additional Trigger signer slot")
		}
	}
	raw, err := validated.Transaction.MarshalBinary()
	if err != nil {
		return nil, solana.Signature{}, err
	}
	if len(raw) > 1232 || len(raw) > math.MaxUint16 {
		return nil, solana.Signature{}, errors.New("signed transaction is too large")
	}
	return raw, validated.Transaction.Signatures[validated.WalletSignerIndex], nil
}
