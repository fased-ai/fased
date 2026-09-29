package main

import (
	"errors"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

// Required exposures, not an authorization or durable reservation. Acceptance
// spends wallet cash; acquisition consumes that already funded protocol custody.
// Refundable rent remains reserved working capital until actual closure receipts.
type signerWENBTCExposureV1 struct {
	WalletCashRaw  uint64
	CustodyCashRaw uint64
	NativeLamports uint64
	CashMint       solana.PublicKey
	CustodyAccount solana.PublicKey
}

func wenBTCExposureV1(a signerWENBTCArtifactsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey) (signerWENBTCExposureV1, error) {
	var out signerWENBTCExposureV1
	if err := validateWENBTCIntentV1(intent); err != nil {
		return out, err
	}
	bad := errors.New("WEN BTC exposure differs from reviewed funding")
	if wallet.IsZero() || a.program.String() != intent.ProgramID || wenHashV1(a.offer[:]) != intent.OfferSHA256 {
		return out, bad
	}
	if err := a.validateTerms(0); err != nil {
		return out, err
	}
	cash, _ := strconv.ParseUint(intent.MaxCashRaw, 10, 64)
	cost, _ := strconv.ParseUint(intent.MaxCostRaw, 10, 64)
	fee, _ := strconv.ParseUint(intent.MaxFeeLamports, 10, 64)
	rent, _ := strconv.ParseUint(intent.MaxRentLamports, 10, 64)
	out.CashMint = a.keys[3]
	out.NativeLamports = fee + rent
	if intent.Operation == "acceptance" {
		if wallet != a.keys[2] || a.numbers[4] > cash {
			return signerWENBTCExposureV1{}, bad
		}
		out.WalletCashRaw = a.numbers[4]
	} else {
		if a.numbers[10] > cash || a.numbers[12] > cost || a.numbers[12] > ^uint64(0)-a.numbers[10] {
			return signerWENBTCExposureV1{}, bad
		}
		out.CustodyCashRaw = a.numbers[10] + a.numbers[12]
		out.CustodyAccount = a.keys[6]
	}
	return out, nil
}
