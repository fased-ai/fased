package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenMiningClaimReadbackV1 struct {
	Slot      uint64
	StateHash string
	Payout    wenMiningClaimPayoutV1
}

// Protected configuration owns client and deployment pins. Descriptor admission
// is composed by the review loader; this read alone never enables signing.
func readWENMiningClaimRPCV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, v signerWENMiningClaimIntentV1, owner solana.PublicKey, maxSlotLag uint64) (wenMiningClaimReadbackV1, error) {
	var zero wenMiningClaimReadbackV1
	bad := errors.New("mining claim finalized readback rejected")
	ix, e := buildWENMiningClaimInstructionV1(v, owner)
	if e != nil {
		return zero, e
	}
	if maxSlotLag == 0 || maxSlotLag > 32 || pins.ProgramID != v.ProgramID || pins.Genesis != v.Genesis || pins.DescriptorSHA256 != v.DescriptorSHA256 || pins.CapabilitySHA256 != v.CapabilitySHA256 || !wenReservationHashV1(pins.CodeSHA256) || pins.DeploymentSlot == 0 {
		return zero, bad
	}
	if pins.UpgradeAuthority != nil {
		x := *pins.UpgradeAuthority
		pins.UpgradeAuthority = &x
	}
	min, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expiry, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	if min < pins.DeploymentSlot {
		return zero, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return zero, e
	}
	if genesis.String() != pins.Genesis {
		return zero, bad
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	sale := a[1].PublicKey
	activation, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), sale[:]}, p)
	pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	keys := []solana.PublicKey{a[2].PublicKey, a[5].PublicKey, a[3].PublicKey, a[4].PublicKey, a[6].PublicKey, sale, activation, p, pd, solana.SysVarClockPubkey}
	if v.Operation == "sol" {
		keys = append(keys, solana.SysVarRentPubkey)
	} else {
		for _, i := range []int{8, 9, 11, 10, 12} {
			keys = append(keys, a[i].PublicKey)
		}
	}
	seen := map[solana.PublicKey]bool{}
	for _, k := range keys {
		if seen[k] {
			return zero, bad
		}
		seen[k] = true
	}
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return zero, e
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || page.Context.Slot >= expiry {
		return zero, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return zero, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Slot: slot, Executable: a.Executable, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if e = verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, DeploymentSlot: pins.DeploymentSlot, CodeSHA256: pins.CodeSHA256, UpgradeAuthority: pins.UpgradeAuthority}, slot, accounts[7], accounts[8]); e != nil {
		return zero, e
	}
	clock := accounts[9]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return zero, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	s, e := validateWENMiningClaimContextV1(v, owner, slot, now, accounts[0], accounts[1], wenMiningClaimSnapshotV1{Roster: accounts[2], Receipt: accounts[3], Claim: accounts[4]})
	if e != nil {
		return zero, e
	}
	if e = validateWENLaunchActivationV1(p, sale, slot, now, accounts[5], accounts[6]); e != nil {
		return zero, e
	}
	if !bytes.Equal(accounts[0].Data[80:112], accounts[5].Data[48:80]) {
		return zero, bad
	}
	custody := wenMiningClaimCustodyV1{ClaimLamports: page.Value[4].Lamports}
	if v.Operation == "sol" {
		custody.Rent = accounts[10]
	} else {
		custody.Ledger = accounts[10]
		custody.Vault = accounts[11]
		custody.Mint = accounts[12]
		custody.Destination = accounts[13]
		token := accounts[14]
		if !token.Executable || (token.Owner != solana.BPFLoaderUpgradeableProgramID && token.Owner != solana.MustPublicKeyFromBase58("BPFLoader2111111111111111111111111111111111")) {
			return zero, bad
		}
	}
	payout, e := validateWENMiningClaimCustodyV1(v, owner, s, custody)
	if e != nil {
		return zero, e
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return zero, e
	}
	if reference < slot || reference-slot > maxSlotLag || reference >= expiry {
		return zero, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return zero, e
	}
	if after != genesis {
		return zero, bad
	}
	if e = ctx.Err(); e != nil {
		return zero, e
	}
	// Include lamports and every observed account except the advancing Clock.
	hash := sha256.New()
	for i, a := range accounts {
		if i == 9 {
			continue
		}
		hash.Write(a.Address[:])
		hash.Write(a.Owner[:])
		flag := byte(0)
		if a.Executable {
			flag = 1
		}
		hash.Write([]byte{flag})
		var n [8]byte
		binary.LittleEndian.PutUint64(n[:], page.Value[i].Lamports)
		hash.Write(n[:])
		binary.LittleEndian.PutUint64(n[:], uint64(len(a.Data)))
		hash.Write(n[:])
		hash.Write(a.Data)
	}
	return wenMiningClaimReadbackV1{slot, hex.EncodeToString(hash.Sum(nil)), payout}, nil
}
