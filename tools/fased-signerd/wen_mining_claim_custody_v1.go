package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"math"
	"strconv"
)

// These observations must be obtained together with the settlement snapshot.
// Lamports must come from the same claim account RPC record, never the intent.
type wenMiningClaimCustodyV1 struct {
	ClaimLamports                          uint64
	Rent, Ledger, Mint, Vault, Destination *signerWENBTCAccountV1
}
type wenMiningClaimPayoutV1 struct{ Gross, Fee, Net, Reserved, RentMinimum uint64 }

func validateWENMiningClaimCustodyV1(v signerWENMiningClaimIntentV1, owner solana.PublicKey, s wenMiningClaimSnapshotV1, custody wenMiningClaimCustodyV1) (wenMiningClaimPayoutV1, error) {
	var out wenMiningClaimPayoutV1
	bad := errors.New("mining claim custody rejected")
	claim, e := validateWENMiningClaimSettlementV1(v, owner, s)
	if e != nil {
		return out, e
	}
	ix, _ := buildWENMiningClaimInstructionV1(v, owner)
	a := ix.Accounts()
	p := ix.ProgramID()
	sale := a[1].PublicKey
	if v.Operation == "sol" {
		r := custody.Rent
		if r == nil || r.Address != solana.MustPublicKeyFromBase58("SysvarRent111111111111111111111111111111111") || r.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || r.Slot != s.Slot || r.Executable || len(r.Data) != 17 || r.Data[16] > 100 {
			return out, bad
		}
		rate := binary.LittleEndian.Uint64(r.Data)
		threshold := math.Float64frombits(binary.LittleEndian.Uint64(r.Data[8:]))
		const maxExact = uint64(1<<53 - 1)
		if rate > maxExact/320 || math.IsNaN(threshold) || math.IsInf(threshold, 0) || threshold < 0 {
			return out, bad
		}
		minimum := math.Trunc(float64(rate*320) * threshold)
		if math.IsInf(minimum, 0) || minimum < 0 || minimum > float64(maxExact) {
			return out, bad
		}
		rent := uint64(minimum)
		if custody.ClaimLamports < rent || custody.ClaimLamports-rent < claim.SOLGross {
			return out, bad
		}
		return wenMiningClaimPayoutV1{Gross: claim.SOLGross, Net: claim.SOLGross, RentMinimum: rent}, nil
	}
	ledger, b, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-reserved-v1"), sale[:]}, p)
	r := custody.Ledger
	if r == nil || r.Address != ledger || r.Owner != p || r.Executable || r.Slot != s.Slot || len(r.Data) != 112 {
		return out, bad
	}
	d := r.Data
	if string(d[:8]) != "WENMRSL1" || d[8] != 1 || d[9] != 0 || d[10] != 0 || d[11] != b || !bytes.Equal(d[12:16], make([]byte, 4)) || !bytes.Equal(d[16:48], sale[:]) || !bytes.Equal(d[48:80], a[9].PublicKey[:]) {
		return out, bad
	}
	n := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o:]) }
	next, active, reserved := n(d, 80), n(d, 88), n(d, 96)
	paid, allocation := n(s.Receipt.Data, 320), n(s.Receipt.Data, 296)
	id, _ := strconv.ParseUint(v.ID, 10, 64)
	if active > next || id >= next || active == 0 || allocation < paid || reserved < allocation-paid || allocation-paid < claim.SATGross {
		return out, bad
	}
	collector, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-collector-v1"), sale[:]}, p)
	mint := a[11].PublicKey
	if e = validateWENSatMintV1(custody.Mint, mint, sale, collector, s.Slot); e != nil {
		return out, e
	}
	if _, _, e = validateWENSatCustodyV1(custody.Vault, a[9].PublicKey, mint, a[7].PublicKey, s.Slot, reserved); e != nil {
		return out, e
	}
	balance, withheld, e := validateWENSatCustodyV1(custody.Destination, a[10].PublicKey, mint, owner, s.Slot, 0)
	if e != nil {
		return out, e
	}
	fee, net := wenSatTransferV1(claim.SATGross)
	minimum, _ := strconv.ParseUint(v.MinimumReceived, 10, 64)
	if net < minimum || net > ^uint64(0)-balance || fee > ^uint64(0)-withheld {
		return out, bad
	}
	return wenMiningClaimPayoutV1{Gross: claim.SATGross, Fee: fee, Net: net, Reserved: reserved}, nil
}
