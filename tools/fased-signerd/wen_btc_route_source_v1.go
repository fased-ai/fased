package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

// Provider swapInstruction representation. This accepts an instruction, never a
// provider transaction, setup sequence, payer replacement or lookup authority.
type signerWENBTCProviderInstructionV1 struct {
	ProgramID string                 `json:"programId"`
	Accounts  []signerTypedAccountV2 `json:"accounts"`
	Data      string                 `json:"data"`
}

// Review candidate only. Publication into admission.json is a separate protected
// operation. The quote's contextSlot is provider-reported and is not chain proof.
type signerWENBTCRouteCandidateV1 struct {
	providerInstructionSHA256 string
	routeBytes                []byte
	routeSHA256               string
	validity                  signerWENBTCRouteValidityV1
}

func buildWENBTCRouteCandidateV1(a signerWENBTCArtifactsV1, wallet solana.PublicKey, review signerWENBTCReviewV1, quoteRaw, instructionRaw []byte, referenceSlot, now uint64) (*signerWENBTCRouteCandidateV1, error) {
	bad := errors.New("WEN BTC provider route candidate rejected")
	if review.Intent.Operation != "acquisition" || len(quoteRaw) == 0 || len(quoteRaw) > 65536 || len(instructionRaw) == 0 || len(instructionRaw) > 32768 || wallet.String() != review.WalletPublicKey || a.program.String() != review.Pins.ProgramID || wenHashV1(a.offer[:]) != review.Pins.OfferSHA256 {
		return nil, bad
	}
	// Extra quote metadata does not grant authority. Decode only economic fields,
	// then independently compare those fields with the serialized instruction.
	var quote struct {
		InputMint   string `json:"inputMint"`
		OutputMint  string `json:"outputMint"`
		InAmount    string `json:"inAmount"`
		OutAmount   string `json:"outAmount"`
		Threshold   string `json:"otherAmountThreshold"`
		SwapMode    string `json:"swapMode"`
		Slippage    uint64 `json:"slippageBps"`
		Slot        uint64 `json:"contextSlot"`
		PlatformFee *struct {
			Amount string `json:"amount"`
			BPS    uint64 `json:"feeBps"`
		} `json:"platformFee"`
	}
	if json.Unmarshal(quoteRaw, &quote) != nil {
		return nil, bad
	}
	amount := func(s string) (uint64, bool) {
		n, e := strconv.ParseUint(s, 10, 64)
		return n, e == nil && strconv.FormatUint(n, 10) == s
	}
	in, ok1 := amount(quote.InAmount)
	out, ok2 := amount(quote.OutAmount)
	floor, ok3 := amount(quote.Threshold)
	if !ok1 || !ok2 || !ok3 || out == 0 || floor < a.numbers[13] || floor > out || in != a.numbers[10] || quote.InputMint != a.keys[3].String() || quote.OutputMint != a.keys[4].String() || quote.SwapMode != "ExactIn" || quote.Slippage > 50 {
		return nil, bad
	}
	if quote.PlatformFee != nil && (quote.PlatformFee.Amount != "0" || quote.PlatformFee.BPS != 0) {
		return nil, bad
	}
	if err := review.validateRouteValidity(); err != nil {
		return nil, err
	}
	// The owner chooses expiry; the provider cannot extend it or override age.
	review.RouteValidity = &signerWENBTCRouteValidityV1{ObservedSlot: quote.Slot, ExpiresSlot: review.RouteValidity.ExpiresSlot}
	if err := review.checkRouteSlot(referenceSlot); err != nil {
		return nil, err
	}
	var ix signerWENBTCProviderInstructionV1
	if decodeSignerAdminStrictJSON(instructionRaw, &ix) != nil {
		return nil, bad
	}
	program, err := solana.PublicKeyFromBase58(ix.ProgramID)
	if err != nil || program.String() != ix.ProgramID {
		return nil, bad
	}
	data, err := base64.StdEncoding.DecodeString(ix.Data)
	if err != nil || base64.StdEncoding.EncodeToString(data) != ix.Data {
		return nil, bad
	}
	route := signerWENBTCRouteV1{Program: program, Data: data, Accounts: ix.Accounts}
	if route, err = a.normalizeProviderSource(wallet, route); err != nil {
		return nil, err
	}
	if _, _, err = a.acquisitionInstruction(wallet, route, now); err != nil {
		return nil, err
	}
	at := 13 + 4*int(binary.LittleEndian.Uint32(data[9:13]))
	if binary.LittleEndian.Uint64(data[at+8:]) != out || uint64(binary.LittleEndian.Uint16(data[at+16:])) != quote.Slippage {
		return nil, bad
	}
	// Prevent a provider quote advertising a better guaranteed minimum than the
	// route actually enforces, without overflowing uint64 multiplication.
	enforced := (out/10000)*(10000-quote.Slippage) + (out%10000)*(10000-quote.Slippage)/10000
	if floor != enforced {
		return nil, bad
	}
	raw, err := json.Marshal(route)
	if err != nil {
		return nil, err
	}
	return &signerWENBTCRouteCandidateV1{providerInstructionSHA256: wenHashV1(instructionRaw), routeBytes: raw, routeSHA256: wenHashV1(raw), validity: *review.RouteValidity}, nil
}

// Jupiter's documented API does not expose a source-token-account override.
// Accept only the ATA of the exact WEN swap authority as an alternate source;
// translate that role to WEN's custody PDA before the complete route verifier.
// No authority, pool, destination, instruction bytes or tail alias is rewritten.
func (a signerWENBTCArtifactsV1) normalizeProviderSource(wallet solana.PublicKey, route signerWENBTCRouteV1) (signerWENBTCRouteV1, error) {
	bad := errors.New("WEN BTC provider source account mismatch")
	if len(route.Accounts) < 14 || wallet.IsZero() {
		return signerWENBTCRouteV1{}, bad
	}
	nonce := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonce, a.numbers[0])
	record, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-subscription-v1"), a.keys[0][:], a.keys[2][:], nonce}, a.program)
	if err != nil {
		return signerWENBTCRouteV1{}, err
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-swap-v1"), record[:]}, a.program)
	if err != nil {
		return signerWENBTCRouteV1{}, err
	}
	source, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-sub-route-cash-v1"), record[:]}, a.program)
	if err != nil {
		return signerWENBTCRouteV1{}, err
	}
	ata, _, err := solana.FindAssociatedTokenAddress(authority, a.keys[3])
	if err != nil {
		return signerWENBTCRouteV1{}, err
	}
	if route.Accounts[2].Pubkey != authority.String() || (route.Accounts[3].Pubkey != source.String() && route.Accounts[3].Pubkey != ata.String()) {
		return signerWENBTCRouteV1{}, bad
	}
	if route.Accounts[3].Pubkey == ata.String() {
		for i, account := range route.Accounts {
			if i != 3 && account.Pubkey == ata.String() {
				return signerWENBTCRouteV1{}, bad
			}
		}
		route.Accounts = append([]signerTypedAccountV2(nil), route.Accounts...)
		route.Accounts[3].Pubkey = source.String()
	}
	return route, nil
}
