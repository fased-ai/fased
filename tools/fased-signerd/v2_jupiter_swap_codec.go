package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"

	solana "github.com/gagliardetto/solana-go"
)

// These discriminators and layouts are generated from Jupiter's public v6
// IDL. Unknown, exact-out, token-ledger, and fee-bearing variants are denied
// until they have their own semantic intent and validator.
var (
	jupiterRouteDiscriminatorV2              = [8]byte{229, 23, 203, 151, 122, 227, 173, 42}
	jupiterSharedRouteDiscriminatorV2        = [8]byte{193, 32, 155, 51, 65, 214, 156, 129}
	jupiterRouteV2DiscriminatorV2            = [8]byte{187, 100, 250, 204, 49, 196, 175, 20}
	jupiterSharedRouteV2DiscriminatorV2      = [8]byte{209, 152, 83, 147, 124, 254, 216, 233}
	jupiterCreateTokenAccountDiscriminatorV2 = [8]byte{147, 241, 123, 100, 244, 132, 174, 118}
	jupiterCloseWSOLAccountDiscriminatorV2   = [8]byte{203, 129, 103, 133, 197, 125, 107, 86}
	jupiterEventAuthorityV2                  = solana.MustPublicKeyFromBase58("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf")
)

type decodedJupiterRouteV2 struct {
	Shared              bool
	InstructionV2       bool
	InputAmount         uint64
	QuotedOutputAmount  uint64
	SlippageBPS         uint16
	PlatformFeeBPS      uint16
	PositiveSlippageBPS uint16
}

func discriminatorV2(data []byte) ([8]byte, error) {
	var discriminator [8]byte
	if len(data) < len(discriminator) {
		return discriminator, errors.New("Jupiter instruction discriminator is missing")
	}
	copy(discriminator[:], data[:8])
	return discriminator, nil
}

func decodeJupiterRouteV2(data []byte) (decodedJupiterRouteV2, error) {
	discriminator, err := discriminatorV2(data)
	if err != nil {
		return decodedJupiterRouteV2{}, err
	}
	switch discriminator {
	case jupiterRouteDiscriminatorV2, jupiterSharedRouteDiscriminatorV2:
		// Legacy exact-in layouts end in fixed fields after a variable Borsh
		// route plan: in_amount, quoted_out_amount, slippage_bps, fee_bps.
		const fixedTail = 8 + 8 + 2 + 1
		vectorOffset := 8
		shared := discriminator == jupiterSharedRouteDiscriminatorV2
		if shared {
			vectorOffset++ // shared-account route id
		}
		if len(data) < vectorOffset+4+fixedTail {
			return decodedJupiterRouteV2{}, errors.New("legacy Jupiter route data is truncated")
		}
		steps := binary.LittleEndian.Uint32(data[vectorOffset : vectorOffset+4])
		if steps == 0 || steps > 64 || len(data)-fixedTail < vectorOffset+4+int(steps)*4 {
			return decodedJupiterRouteV2{}, errors.New("legacy Jupiter route plan is empty or malformed")
		}
		tail := data[len(data)-fixedTail:]
		return decodedJupiterRouteV2{
			Shared:             shared,
			InputAmount:        binary.LittleEndian.Uint64(tail[:8]),
			QuotedOutputAmount: binary.LittleEndian.Uint64(tail[8:16]),
			SlippageBPS:        binary.LittleEndian.Uint16(tail[16:18]),
			PlatformFeeBPS:     uint16(tail[18]),
		}, nil
	case jupiterRouteV2DiscriminatorV2, jupiterSharedRouteV2DiscriminatorV2:
		// RouteV2 moves the fixed semantic fields in front of the route plan.
		offset := 8
		shared := discriminator == jupiterSharedRouteV2DiscriminatorV2
		if shared {
			offset++ // shared-account route id
		}
		const fixedHeader = 8 + 8 + 2 + 2 + 2
		if len(data) < offset+fixedHeader+4 {
			return decodedJupiterRouteV2{}, errors.New("Jupiter RouteV2 data is truncated")
		}
		steps := binary.LittleEndian.Uint32(data[offset+fixedHeader : offset+fixedHeader+4])
		if steps == 0 || steps > 64 || len(data) < offset+fixedHeader+4+int(steps)*5 {
			return decodedJupiterRouteV2{}, errors.New("Jupiter RouteV2 plan is empty or malformed")
		}
		return decodedJupiterRouteV2{
			Shared:              shared,
			InstructionV2:       true,
			InputAmount:         binary.LittleEndian.Uint64(data[offset : offset+8]),
			QuotedOutputAmount:  binary.LittleEndian.Uint64(data[offset+8 : offset+16]),
			SlippageBPS:         binary.LittleEndian.Uint16(data[offset+16 : offset+18]),
			PlatformFeeBPS:      binary.LittleEndian.Uint16(data[offset+18 : offset+20]),
			PositiveSlippageBPS: binary.LittleEndian.Uint16(data[offset+20 : offset+22]),
		}, nil
	default:
		return decodedJupiterRouteV2{}, errors.New("unsupported Jupiter swap instruction variant")
	}
}

func minimumJupiterOutputV2(quoted uint64, slippageBPS uint16) (*big.Int, error) {
	if quoted == 0 || slippageBPS > 10_000 {
		return nil, errors.New("Jupiter quoted output/slippage is invalid")
	}
	// Jupiter enforces ceil(quote * (10_000 - slippage_bps) / 10_000).
	numerator := new(big.Int).Mul(
		new(big.Int).SetUint64(quoted),
		new(big.Int).SetUint64(uint64(10_000-slippageBPS)),
	)
	numerator.Add(numerator, big.NewInt(9_999))
	return numerator.Div(numerator, big.NewInt(10_000)), nil
}

func validateJupiterRouteSemanticsV2(
	data []byte,
	metas []*solana.AccountMeta,
	wallet solana.PublicKey,
	intent *signerJupiterIntentV2,
) error {
	route, err := decodeJupiterRouteV2(data)
	if err != nil {
		return err
	}
	exactInput, ok := new(big.Int).SetString(intent.InputAmount, 10)
	if !ok || !exactInput.IsUint64() || route.InputAmount != exactInput.Uint64() {
		return errors.New("Jupiter instruction input amount does not equal the reviewed exact input")
	}
	if intent.MaxInputAmount != intent.InputAmount {
		return errors.New("Jupiter exact-in swap cannot use a distinct maximum input")
	}
	if route.PlatformFeeBPS != 0 || route.PositiveSlippageBPS != 0 {
		return errors.New("Jupiter platform/positive-slippage fees are not authorized")
	}
	minimum, err := minimumJupiterOutputV2(route.QuotedOutputAmount, route.SlippageBPS)
	if err != nil {
		return err
	}
	reviewedMinimum, ok := new(big.Int).SetString(intent.MinimumOutputAmount, 10)
	if !ok || minimum.Cmp(reviewedMinimum) < 0 {
		return errors.New("Jupiter on-chain slippage threshold is below the reviewed minimum output")
	}
	if route.Shared {
		return validateJupiterSharedRouteAccountsV2(metas, wallet, intent, route.InstructionV2)
	}
	return validateJupiterRouteAccountsV2(metas, wallet, intent, route.InstructionV2)
}

func requireJupiterMetaV2(metas []*solana.AccountMeta, index int, address string, signer, writable bool, name string) error {
	if index < 0 || index >= len(metas) {
		return fmt.Errorf("Jupiter %s account is missing", name)
	}
	meta := metas[index]
	if address != "" && meta.PublicKey.String() != address {
		return fmt.Errorf("Jupiter %s account does not match reviewed semantics", name)
	}
	if signer && !meta.IsSigner {
		return fmt.Errorf("Jupiter %s must be a signer", name)
	}
	if writable && !meta.IsWritable {
		return fmt.Errorf("Jupiter %s must be writable", name)
	}
	return nil
}

func requireJupiterInfrastructureV2(meta *solana.AccountMeta, allowed ...solana.PublicKey) error {
	for _, address := range allowed {
		if meta.PublicKey.Equals(address) {
			return nil
		}
	}
	return fmt.Errorf("unsupported Jupiter infrastructure account %s", meta.PublicKey)
}

func validateJupiterRouteAccountsV2(metas []*solana.AccountMeta, wallet solana.PublicKey, intent *signerJupiterIntentV2, routeV2 bool) error {
	if routeV2 {
		if len(metas) < 10 {
			return errors.New("Jupiter RouteV2 account layout is truncated")
		}
		checks := []struct {
			index    int
			address  string
			signer   bool
			writable bool
			name     string
		}{
			{0, wallet.String(), true, false, "wallet authority"},
			{1, intent.SourceTokenAccount, false, true, "source token"},
			{2, intent.DestinationTokenAccount, false, true, "destination token"},
			{3, intent.InputMint, false, false, "source mint"},
			{4, intent.OutputMint, false, false, "destination mint"},
			{8, jupiterEventAuthorityV2.String(), false, false, "event authority"},
			{9, jupiterAggregatorV6V2, false, false, "program"},
		}
		for _, check := range checks {
			if err := requireJupiterMetaV2(metas, check.index, check.address, check.signer, check.writable, check.name); err != nil {
				return err
			}
		}
		if err := requireJupiterInfrastructureV2(metas[5], solana.TokenProgramID, solana.Token2022ProgramID); err != nil {
			return err
		}
		if err := requireJupiterInfrastructureV2(metas[6], solana.TokenProgramID, solana.Token2022ProgramID); err != nil {
			return err
		}
		return validateOptionalJupiterDestinationV2(metas[7], wallet, intent)
	}
	if len(metas) < 9 {
		return errors.New("legacy Jupiter route account layout is truncated")
	}
	checks := []struct {
		index    int
		address  string
		signer   bool
		writable bool
		name     string
	}{
		{1, wallet.String(), true, false, "wallet authority"},
		{2, intent.SourceTokenAccount, false, true, "source token"},
		{3, intent.DestinationTokenAccount, false, true, "destination token"},
		{5, intent.OutputMint, false, false, "destination mint"},
		{7, jupiterEventAuthorityV2.String(), false, false, "event authority"},
		{8, jupiterAggregatorV6V2, false, false, "program"},
	}
	for _, check := range checks {
		if err := requireJupiterMetaV2(metas, check.index, check.address, check.signer, check.writable, check.name); err != nil {
			return err
		}
	}
	if err := requireJupiterInfrastructureV2(metas[0], solana.TokenProgramID, solana.Token2022ProgramID); err != nil {
		return err
	}
	if !metas[6].PublicKey.Equals(solana.MustPublicKeyFromBase58(jupiterAggregatorV6V2)) {
		return errors.New("Jupiter platform-fee account must be absent when fees are disabled")
	}
	return validateOptionalJupiterDestinationV2(metas[4], wallet, intent)
}

func validateJupiterSharedRouteAccountsV2(metas []*solana.AccountMeta, wallet solana.PublicKey, intent *signerJupiterIntentV2, routeV2 bool) error {
	if routeV2 {
		if len(metas) < 12 {
			return errors.New("Jupiter shared RouteV2 account layout is truncated")
		}
		checks := []struct {
			index    int
			address  string
			signer   bool
			writable bool
			name     string
		}{
			{1, wallet.String(), true, false, "wallet authority"},
			{2, intent.SourceTokenAccount, false, true, "source token"},
			{5, intent.DestinationTokenAccount, false, true, "destination token"},
			{6, intent.InputMint, false, false, "source mint"},
			{7, intent.OutputMint, false, false, "destination mint"},
			{10, jupiterEventAuthorityV2.String(), false, false, "event authority"},
			{11, jupiterAggregatorV6V2, false, false, "program"},
		}
		for _, check := range checks {
			if err := requireJupiterMetaV2(metas, check.index, check.address, check.signer, check.writable, check.name); err != nil {
				return err
			}
		}
		if err := requireJupiterInfrastructureV2(metas[8], solana.TokenProgramID, solana.Token2022ProgramID); err != nil {
			return err
		}
		return requireJupiterInfrastructureV2(metas[9], solana.TokenProgramID, solana.Token2022ProgramID)
	}
	if len(metas) < 13 {
		return errors.New("legacy Jupiter shared-route account layout is truncated")
	}
	checks := []struct {
		index    int
		address  string
		signer   bool
		writable bool
		name     string
	}{
		{2, wallet.String(), true, false, "wallet authority"},
		{3, intent.SourceTokenAccount, false, true, "source token"},
		{6, intent.DestinationTokenAccount, false, true, "destination token"},
		{7, intent.InputMint, false, false, "source mint"},
		{8, intent.OutputMint, false, false, "destination mint"},
		{11, jupiterEventAuthorityV2.String(), false, false, "event authority"},
		{12, jupiterAggregatorV6V2, false, false, "program"},
	}
	for _, check := range checks {
		if err := requireJupiterMetaV2(metas, check.index, check.address, check.signer, check.writable, check.name); err != nil {
			return err
		}
	}
	if err := requireJupiterInfrastructureV2(metas[0], solana.TokenProgramID, solana.Token2022ProgramID); err != nil {
		return err
	}
	jupiterProgram := solana.MustPublicKeyFromBase58(jupiterAggregatorV6V2)
	if !metas[9].PublicKey.Equals(jupiterProgram) {
		return errors.New("Jupiter platform-fee account must be absent when fees are disabled")
	}
	return requireJupiterInfrastructureV2(metas[10], solana.Token2022ProgramID, jupiterProgram)
}

func validateOptionalJupiterDestinationV2(meta *solana.AccountMeta, wallet solana.PublicKey, intent *signerJupiterIntentV2) error {
	jupiterProgram := solana.MustPublicKeyFromBase58(jupiterAggregatorV6V2)
	if meta.PublicKey.Equals(jupiterProgram) {
		return nil
	}
	if intent.OutputMint == solanaNativeMintV2 && meta.PublicKey.Equals(wallet) && meta.IsWritable {
		return nil
	}
	if meta.PublicKey.String() == intent.DestinationTokenAccount && meta.IsWritable {
		return nil
	}
	return errors.New("Jupiter optional destination is not the reviewed wallet/token account")
}

func validateJupiterAuxiliaryInstructionV2(data []byte, metas []*solana.AccountMeta, wallet solana.PublicKey, intent *signerJupiterIntentV2) (bool, error) {
	discriminator, err := discriminatorV2(data)
	if err != nil {
		return false, err
	}
	switch discriminator {
	case jupiterCreateTokenAccountDiscriminatorV2:
		return false, errors.New("Jupiter signer-funded token-account creation is denied; prepare token accounts before review")
	case jupiterCloseWSOLAccountDiscriminatorV2:
		if len(data) != 8 || len(metas) != 4 {
			return false, errors.New("invalid Jupiter close-WSOL instruction")
		}
		account := metas[0].PublicKey.String()
		if (intent.InputMint != solanaNativeMintV2 || account != intent.SourceTokenAccount) &&
			(intent.OutputMint != solanaNativeMintV2 || account != intent.DestinationTokenAccount) {
			return false, errors.New("Jupiter close-WSOL targets an unreviewed account")
		}
		if err := requireJupiterMetaV2(metas, 1, wallet.String(), true, true, "WSOL close destination"); err != nil {
			return false, err
		}
		if !metas[2].PublicKey.Equals(solana.TokenProgramID) || !metas[3].PublicKey.Equals(solana.SystemProgramID) {
			return false, errors.New("Jupiter close-WSOL infrastructure programs are invalid")
		}
		return false, nil
	default:
		if bytes.Equal(discriminator[:], jupiterRouteDiscriminatorV2[:]) ||
			bytes.Equal(discriminator[:], jupiterSharedRouteDiscriminatorV2[:]) ||
			bytes.Equal(discriminator[:], jupiterRouteV2DiscriminatorV2[:]) ||
			bytes.Equal(discriminator[:], jupiterSharedRouteV2DiscriminatorV2[:]) {
			return true, validateJupiterRouteSemanticsV2(data, metas, wallet, intent)
		}
		return false, errors.New("unsupported Jupiter v6 auxiliary/action instruction")
	}
}
