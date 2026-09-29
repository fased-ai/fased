package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenCampaignSetupRequestV1 struct {
	Program, Economy, Issuer solana.PublicKey
	Nonce                    uint64
	Terms                    wenCampaignSetupTermsV1
}
type wenCampaignSetupSnapshotV1 struct {
	Setup                     wenCampaignSetupV1
	Slot, ReferenceSlot, Rent uint64
	RentByAllocation          []uint64
}

// Addresses and the membership index are derived here, never supplied by the
// application. The second page authenticates the complete setup and deployment.
func readWENCampaignSetupV1(ctx context.Context, c wenCampaignReadRPCV1, pins signerWENBTCPinsV1, q wenCampaignSetupRequestV1, owner solana.PublicKey, min, expires, lag uint64) (wenCampaignSetupSnapshotV1, error) {
	var out wenCampaignSetupSnapshotV1
	bad := errors.New("campaign setup readback rejected")
	if c == nil || pins.ProgramID != q.Program.String() || pins.DeploymentSlot == 0 || min < pins.DeploymentSlot || expires <= min || expires-min > 32 || lag == 0 || lag > 32 || !wenReservationHashV1(pins.CodeSHA256) {
		return out, bad
	}
	if pins.UpgradeAuthority != nil {
		a := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &a
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if genesis.String() != pins.Genesis {
		return out, bad
	}
	derive := func(seeds ...[]byte) (solana.PublicKey, error) {
		k, _, e := solana.FindProgramAddress(seeds, q.Program)
		return k, e
	}
	mint, e := derive([]byte("wen-sat-mint-v1"), q.Economy[:])
	if e != nil {
		return out, e
	}
	collector, e := derive([]byte("wen-sat-collector-v1"), q.Economy[:])
	if e != nil {
		return out, e
	}
	position, e := derive([]byte("wen-retail-position-v2"), owner[:], mint[:])
	if e != nil {
		return out, e
	}
	registry, e := derive([]byte("wen-retail-members-v2"), q.Issuer[:], mint[:])
	if e != nil {
		return out, e
	}
	var nonce [8]byte
	binary.LittleEndian.PutUint64(nonce[:], q.Nonce)
	window, e := derive([]byte("wen-retail-window-v2"), q.Issuer[:], mint[:], nonce[:])
	if e != nil {
		return out, e
	}
	first, e := c.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{registry}, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return out, e
	}
	if first == nil || len(first.Value) != 1 || first.Context.Slot < min || first.Context.Slot >= expires {
		return out, bad
	}
	firstSlot, registryPresent := first.Context.Slot, first.Value[0] != nil
	// Copy the first observation before another client call can reuse buffers.
	plain := func(k solana.PublicKey, a *rpc.Account) (wenCampaignSetupAccountV1, error) {
		if a == nil {
			return wenCampaignSetupAccountV1{Address: k, Owner: solana.SystemProgramID}, nil
		}
		if a.Data == nil {
			return wenCampaignSetupAccountV1{}, bad
		}
		return wenCampaignSetupAccountV1{Address: k, Owner: a.Owner, Executable: a.Executable, Lamports: a.Lamports, Data: append([]byte(nil), a.Data.GetBinary()...)}, nil
	}
	g, e := plain(registry, first.Value[0])
	if e != nil {
		return out, e
	}
	index := uint64(0)
	if registryPresent {
		if g.Owner != q.Program || g.Executable || len(g.Data) != 112 || string(g.Data[:8]) != "WENRMEM2" || g.Data[8] != 1 || g.Data[9] != 0 || !bytes.Equal(g.Data[12:16], make([]byte, 4)) || !bytes.Equal(g.Data[16:48], q.Issuer[:]) || !bytes.Equal(g.Data[48:80], mint[:]) {
			return out, bad
		}
		index = binary.LittleEndian.Uint64(g.Data[80:88])
	}
	if index == math.MaxUint64 {
		return out, bad
	}
	binary.LittleEndian.PutUint64(nonce[:], index)
	member, e := derive([]byte("wen-retail-member-v2"), registry[:], nonce[:])
	if e != nil {
		return out, e
	}
	loader := solana.BPFLoaderUpgradeableProgramID
	pd, _, e := solana.FindProgramAddress([][]byte{q.Program[:]}, loader)
	if e != nil {
		return out, e
	}
	keys := []solana.PublicKey{position, window, registry, member, mint, q.Program, pd, solana.SysVarClockPubkey}
	seen := map[solana.PublicKey]bool{}
	for _, k := range keys {
		if seen[k] {
			return out, bad
		}
		seen[k] = true
	}
	next := firstSlot
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &next})
	if e != nil {
		return out, e
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < next || page.Context.Slot >= expires || page.Context.Slot-firstSlot > lag {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]wenCampaignSetupAccountV1, len(keys))
	wrapped := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil && i != 0 && i != 2 && i != 3 {
			return out, bad
		}
		accounts[i], e = plain(keys[i], a)
		if e != nil {
			return out, e
		}
		v := accounts[i]
		wrapped[i] = &signerWENBTCAccountV1{Address: v.Address, Owner: v.Owner, Executable: v.Executable, Data: v.Data, Slot: slot}
	}
	if registryPresent != (page.Value[2] != nil) || !reflect.DeepEqual(g, accounts[2]) {
		return out, bad
	}
	if e = verifyWENBTCDeploymentV1(pins, slot, wrapped[5], wrapped[6]); e != nil {
		return out, e
	}
	if e = validateWENSatMintV1(wrapped[4], mint, q.Economy, collector, slot); e != nil {
		return out, e
	}
	clock := accounts[7]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > math.MaxInt64 {
		return out, bad
	}
	setup := wenCampaignSetupV1{Program: q.Program, Economy: q.Economy, Owner: owner, Issuer: q.Issuer, Now: now, Terms: q.Terms, Position: accounts[0], Window: accounts[1], Registry: accounts[2], Member: accounts[3]}
	_, allocations, e := buildWENCampaignAtomicSetupV1(setup)
	if e != nil {
		return out, e
	}
	var rents []uint64
	var total uint64
	for _, a := range allocations {
		rent, e := c.GetMinimumBalanceForRentExemption(ctx, a.Bytes, rpc.CommitmentFinalized)
		if e != nil {
			return out, e
		}
		if rent > math.MaxUint64-total {
			return out, bad
		}
		total += rent
		rents = append(rents, rent)
	}
	if setup.Terms.Deposit > math.MaxUint64-total {
		return out, bad
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return out, e
	}
	if reference < slot || reference-firstSlot > lag || reference >= expires {
		return out, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if after != genesis {
		return out, bad
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	return wenCampaignSetupSnapshotV1{Setup: setup, Slot: firstSlot, ReferenceSlot: reference, Rent: total, RentByAllocation: rents}, nil
}

func sameWENCampaignSetupStateV1(a, b wenCampaignSetupSnapshotV1) bool {
	a.Slot = 0
	a.ReferenceSlot = 0
	a.Setup.Now = 0
	b.Slot = 0
	b.ReferenceSlot = 0
	b.Setup.Now = 0
	return reflect.DeepEqual(a, b)
}
