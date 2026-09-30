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
)

type wenBondReadPolicyV2 struct {
	Deployment                                              signerWENBTCPinsV1
	Nonce, MinimumNet, MinimumSlot, ExpiresSlot, MaxSlotLag uint64
}
type wenBondClaimSnapshotV2 struct {
	Claim                    wenBondClaimV2
	Slot, ReferenceSlot, Now uint64
	StateSHA256              string
}

func wenBondClaimReadKeysV2(p wenBondPinsV2, nonce uint64) ([]solana.PublicKey, error) {
	var err error
	derive := func(seed string, rest ...[]byte) solana.PublicKey {
		k, _, e := wenBondKeyV2(p.Program, seed, rest...)
		if e != nil {
			err = e
		}
		return k
	}
	q := derive("wen-bond-net-quote-v1", p.Sale[:], p.Owner[:], wenBondU64V2(nonce))
	r := derive("wen-paid-primary-v1", p.Sale[:], q[:])
	source := derive("wen-bond-owner-v1", p.Sale[:], p.Owner[:])
	domain := derive("wen-accounting-domain-v1", p.Sale[:], []byte{2})
	pd, _, e := solana.FindProgramAddress([][]byte{p.Program[:]}, solana.BPFLoaderUpgradeableProgramID)
	if e != nil {
		return nil, e
	}
	keys := []solana.PublicKey{q, r, p.Sale, derive("wen-activation-v1", p.Sale[:]), derive("wen-sat-promises-v1", p.Sale[:]), derive("wen-sat-mint-v1", p.Sale[:]), derive("wen-subscription-custody-v1", r[:]), p.Destination, domain, derive("wen-accounting-source-v1", domain[:], source[:]), solana.Token2022ProgramID, p.Program, pd, solana.SysVarClockPubkey}
	if err != nil {
		return nil, err
	}
	seen := map[solana.PublicKey]bool{}
	for _, k := range keys {
		if k.IsZero() || seen[k] {
			return nil, errors.New("Bond read account aliases")
		}
		seen[k] = true
	}
	return keys, nil
}

// Sale v2 adds the mining cutover epoch only. Its mint field is the quoted
// USDC cash mint, not the separately derived SAT mint used by claims.
func validateWENBondLaunchV2(p wenBondPinsV2, slot, now uint64, sale, activation *signerWENBTCAccountV1) error {
	var cashMint solana.PublicKey
	switch p.Profile {
	case "mainnet":
		cashMint = solana.MustPublicKeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	case "devnet-synthetic-fixture":
		cashMint = solana.MustPublicKeyFromBase58("DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc")
	default:
		return errors.New("Bond launch profile rejected")
	}
	if sale == nil || len(sale.Data) < 112 || !bytes.Equal(sale.Data[48:80], p.Policy[:]) || !bytes.Equal(sale.Data[80:112], cashMint[:]) {
		return errors.New("Bond launch policy rejected")
	}
	return validateWENLaunchActivationV1(p.Program, p.Sale, slot, now, sale, activation)
}
func validateWENBondDomainV2(p wenBondPinsV2, slot uint64, root, entry *signerWENBTCAccountV1) error {
	bad := errors.New("Bond accounting domain rejected")
	source, _, e := wenBondKeyV2(p.Program, "wen-bond-owner-v1", p.Sale[:], p.Owner[:])
	if e != nil {
		return e
	}
	rk, rb, e := wenBondKeyV2(p.Program, "wen-accounting-domain-v1", p.Sale[:], []byte{2})
	if e != nil {
		return e
	}
	ek, eb, e := wenBondKeyV2(p.Program, "wen-accounting-source-v1", rk[:], source[:])
	if e != nil {
		return e
	}
	if root == nil || entry == nil || root.Address != rk || entry.Address != ek || root.Owner != p.Program || entry.Owner != p.Program || root.Executable || entry.Executable || root.Slot != slot || entry.Slot != slot || len(root.Data) != 104 || len(entry.Data) != 128 {
		return bad
	}
	d, v := root.Data, entry.Data
	x, y := make([]byte, 104), make([]byte, 128)
	copy(x, []byte("WENDOM01"))
	copy(x[8:], []byte{1, 0, 2, rb})
	copy(x[16:], p.Sale[:])
	binary.LittleEndian.PutUint64(x[48:], 1)
	copy(x[56:72], d[56:72])
	x[72] = 1
	copy(y, []byte("WENDS001"))
	copy(y[8:], []byte{1, 0, 0, eb})
	copy(y[16:], rk[:])
	copy(y[48:], source[:])
	copy(y[80:88], v[80:88])
	count, revision, index := binary.LittleEndian.Uint64(d[56:]), binary.LittleEndian.Uint64(d[64:]), binary.LittleEndian.Uint64(v[80:])
	if !bytes.Equal(d, x) || !bytes.Equal(v, y) || revision < count || index >= count {
		return bad
	}
	return nil
}

// One finalized batch, two network checks, and an independently fresh reference.
// The endpoint/client and policy must be selected by protected host code. This
// returns unsigned observations only, never a reservation or signing permit.
func readWENBondClaimV2(ctx context.Context, c signerWENBTCReadRPCV1, p wenBondPinsV2, policy wenBondReadPolicyV2) (wenBondClaimSnapshotV2, error) {
	var out wenBondClaimSnapshotV2
	bad := errors.New("Bond finalized claim read rejected")
	d := policy.Deployment
	if c == nil || d.ProgramID != p.Program.String() || d.DeploymentSlot == 0 || policy.MinimumNet == 0 || policy.MinimumSlot < d.DeploymentSlot || policy.ExpiresSlot <= policy.MinimumSlot || policy.ExpiresSlot-policy.MinimumSlot > 32 || policy.MaxSlotLag == 0 || policy.MaxSlotLag > 32 || !wenReservationHashV1(d.CodeSHA256) {
		return out, bad
	}
	switch p.Profile {
	case "mainnet":
		if d.Genesis != "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" {
			return out, bad
		}
	case "devnet-synthetic-fixture":
		if d.Genesis != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" {
			return out, bad
		}
	default:
		return out, bad
	}
	if d.UpgradeAuthority != nil {
		x := *d.UpgradeAuthority
		d.UpgradeAuthority = &x
	}
	keys, e := wenBondClaimReadKeysV2(p, policy.Nonce)
	if e != nil {
		return out, e
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if genesis.String() != d.Genesis {
		return out, bad
	}
	min := policy.MinimumSlot
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return out, e
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || page.Context.Slot >= policy.ExpiresSlot {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if e = verifyWENBTCDeploymentV1(d, slot, accounts[11], accounts[12]); e != nil {
		return out, e
	}
	clock := accounts[13]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > uint64(1<<63-1) {
		return out, bad
	}
	record := func(a *signerWENBTCAccountV1) wenBondAccountV2 {
		return wenBondAccountV2{Key: a.Address, Owner: a.Owner, Executable: a.Executable, Data: a.Data}
	}
	claim, e := inspectWENBondClaimV2(p, record(accounts[0]), record(accounts[1]), policy.Nonce, now, policy.MinimumNet)
	if e != nil {
		return out, e
	}
	if binary.LittleEndian.Uint64(accounts[0].Data[232:]) > slot {
		return out, bad
	}
	if e = validateWENBondLaunchV2(p, slot, now, accounts[2], accounts[3]); e != nil {
		return out, e
	}
	if e = validateWENBondClaimFundingV2(p, claim, slot, accounts[4], accounts[5], accounts[6], accounts[7]); e != nil {
		return out, e
	}
	if e = validateWENBondDomainV2(p, slot, accounts[8], accounts[9]); e != nil {
		return out, e
	}
	token := accounts[10]
	if !token.Executable || (token.Owner != solana.BPFLoaderUpgradeableProgramID && token.Owner != solana.MustPublicKeyFromBase58("BPFLoader2111111111111111111111111111111111")) {
		return out, bad
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return out, e
	}
	if reference < slot || reference-slot > policy.MaxSlotLag || reference >= policy.ExpiresSlot {
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
	h := sha256.New()
	for i, a := range accounts {
		if i == 13 {
			continue
		}
		h.Write(a.Address[:])
		h.Write(a.Owner[:])
		if a.Executable {
			h.Write([]byte{1})
		} else {
			h.Write([]byte{0})
		}
		h.Write(wenBondU64V2(uint64(len(a.Data))))
		h.Write(a.Data)
	}
	return wenBondClaimSnapshotV2{Claim: claim, Slot: slot, ReferenceSlot: reference, Now: now, StateSHA256: hex.EncodeToString(h.Sum(nil))}, nil
}
