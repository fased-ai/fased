package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenMiningDiscoveredClaimV1 struct {
	Intent         signerWENMiningClaimIntentV1 `json:"intent"`
	ObservedSlot   uint64                       `json:"observedSlot"`
	Status         string                       `json:"status"`
	SigningEnabled bool                         `json:"signingEnabled"`
}

// Internal adapter: descriptor/pins and wallet come from host review/configuration.
// Candidate data locates accounts only; full finalized readback authenticates all
// settlement, entry, deployment and custody facts before yielding a proposal.
func proposeDiscoveredWENMiningClaimV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, descriptor []byte, candidate wenMiningClaimCandidateV1, owner solana.PublicKey, operation string, minimum, expires, maxFee, maxLag uint64) (wenMiningDiscoveredClaimV1, error) {
	var zero wenMiningDiscoveredClaimV1
	bad := errors.New("discovered mining claim settlement rejected")
	if c == nil || owner.IsZero() || (operation != "sol" && operation != "sat") || minimum == 0 || expires <= minimum || expires-minimum > 32 || maxLag == 0 || maxLag > 32 || maxFee == 0 || maxFee > signerNativeFeeReservationV2 {
		return zero, bad
	}
	if e := validateWENMiningClaimDescriptorV1(descriptor, pins); e != nil {
		return zero, e
	}
	source := candidate.Intent
	if source.Genesis != pins.Genesis || source.ProgramID != pins.ProgramID {
		return zero, bad
	}
	parse := func(s string) (solana.PublicKey, error) {
		p, e := solana.PublicKeyFromBase58(s)
		if e != nil || p.IsZero() || p.String() != s {
			return p, bad
		}
		return p, nil
	}
	program, e := parse(source.ProgramID)
	if e != nil {
		return zero, e
	}
	sale, e := parse(source.Economy)
	if e != nil {
		return zero, e
	}
	offer, e := parse(source.Offer)
	if e != nil {
		return zero, e
	}
	entry, e := parse(source.Entry)
	if e != nil {
		return zero, e
	}
	nonce, e := strconv.ParseUint(source.Nonce, 10, 64)
	if e != nil || strconv.FormatUint(nonce, 10) != source.Nonce {
		return zero, bad
	}
	derive := func(seed string, parts ...[]byte) solana.PublicKey {
		k, _, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), program)
		return k
	}
	claim := derive("wen-mining-claim-v1", sale[:], entry[:])
	receipt := derive("wen-mining-progress-v1", sale[:], offer[:])
	roster := derive("wen-mining-roster-v1", sale[:], offer[:])
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	page, e := c.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{claim, receipt, roster}, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &minimum})
	if e != nil {
		return zero, e
	}
	if page == nil || len(page.Value) != 3 || page.Context.Slot < minimum || page.Context.Slot >= expires {
		return zero, bad
	}
	data := make([][]byte, 3)
	for i, a := range page.Value {
		if a == nil || a.Data == nil || a.Owner != program || a.Executable {
			return zero, bad
		}
		data[i] = a.Data.GetBinary()
	}
	if len(data[0]) != 192 || len(data[1]) != 352 || len(data[2]) < 200 || len(data[2]) > 65536 || (len(data[2])-160)%40 != 0 {
		return zero, bad
	}
	ordinal := -1
	for i := 160; i < len(data[2]); i += 40 {
		if bytes.Equal(data[2][i:i+32], entry[:]) {
			if ordinal != -1 {
				return zero, bad
			}
			ordinal = (i - 160) / 40
		}
	}
	if ordinal < 0 {
		return zero, bad
	}
	gross := binary.LittleEndian.Uint64(data[0][176:])
	if operation == "sat" {
		gross = binary.LittleEndian.Uint64(data[0][184:])
	}
	net := gross
	if operation == "sat" {
		_, net = wenSatTransferV1(gross)
	}
	number := func(n uint64) string { return strconv.FormatUint(n, 10) }
	v := signerWENMiningClaimIntentV1{Operation: operation, DescriptorSHA256: pins.DescriptorSHA256, CapabilitySHA256: pins.CapabilitySHA256, AccountStateSHA256: wenHashV1([]byte("untrusted-locator-only")), Genesis: pins.Genesis, ProgramID: pins.ProgramID, Economy: sale.String(), ID: number(binary.LittleEndian.Uint64(data[1][208:])), Nonce: number(nonce), Ordinal: number(uint64(ordinal)), ExpectedGross: number(gross), MinimumReceived: number(net), MaxFeeLamports: number(maxFee), MinFinalizedSlot: number(page.Context.Slot), ExpiresSlot: number(expires)}
	if operation == "sat" {
		mint := derive("wen-sat-mint-v1", sale[:])
		dest, _, e := solana.FindProgramAddress([][]byte{owner[:], solana.Token2022ProgramID[:], mint[:]}, solana.SPLAssociatedTokenAccountProgramID)
		if e != nil {
			return zero, e
		}
		s := dest.String()
		v.Destination = &s
	}
	ix, e := buildWENMiningClaimInstructionV1(v, owner)
	if e != nil {
		return zero, e
	}
	if ix.Accounts()[2].PublicKey != offer || ix.Accounts()[5].PublicKey != entry {
		return zero, bad
	}
	verified, e := readWENMiningClaimRPCV1(ctx, c, pins, v, owner, maxLag)
	if e != nil {
		return zero, e
	}
	if verified.Slot < page.Context.Slot || verified.Slot-page.Context.Slot > maxLag {
		return zero, bad
	}
	v.AccountStateSHA256 = verified.StateHash
	return wenMiningDiscoveredClaimV1{Intent: v, ObservedSlot: verified.Slot, Status: "requires-review"}, nil
}
