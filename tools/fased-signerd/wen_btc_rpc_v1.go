package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"reflect"
	"strconv"
)

type signerWENBTCReadRPCV1 interface {
	GetGenesisHash(context.Context) (solana.Hash, error)
	GetMultipleAccountsWithOpts(context.Context, []solana.PublicKey, *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error)
	GetSlot(context.Context, rpc.CommitmentType) (uint64, error)
}

type signerWENBTCReadResultV1 struct {
	exposure    signerWENBTCExposureV1 // Internal budget requirements, not a reservation.
	rentLengths []uint64               // Internal account-creation costs from the verified batch.

	Slot          uint64               `json:"slot,string"`
	ReferenceSlot uint64               `json:"referenceSlot,string"`
	Now           uint64               `json:"now,string"`
	Data          []byte               `json:"dataBase64"`
	Accounts      []signerSATAccountV2 `json:"accounts"`
	// A readback is not transaction admission. Valuation/caps and all monetary
	// effects still require simulation and protected transaction verification.
}

// Called only with signer-owned endpoint/configuration. No external RPC handler
// exposes this helper or enables signing. All calls share one bounded context.
func readWENBTCAcceptanceV1(ctx context.Context, endpoint, root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint, maxSlotLag uint64) (signerWENBTCReadResultV1, error) {
	normalized, err := normalizeSignerRPCURLV2(endpoint, "WEN BTC signer RPC")
	if err != nil {
		return signerWENBTCReadResultV1{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	return readWENBTCAcceptanceRPCV1(ctx, newSignerOwnedSolanaRPCClientV2(normalized), root, pins, intent, wallet, nowHint, maxSlotLag)
}

func readWENBTCAcceptanceRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint, maxSlotLag uint64) (signerWENBTCReadResultV1, error) {
	return readWENBTCSubscriptionRPCV1(ctx, client, root, pins, intent, wallet, nowHint, maxSlotLag, nil)
}

func readWENBTCAcquisitionV1(ctx context.Context, endpoint, root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint, maxSlotLag uint64, route signerWENBTCRouteV1) (signerWENBTCReadResultV1, error) {
	normalized, err := normalizeSignerRPCURLV2(endpoint, "WEN BTC signer RPC")
	if err != nil {
		return signerWENBTCReadResultV1{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	return readWENBTCSubscriptionRPCV1(ctx, newSignerOwnedSolanaRPCClientV2(normalized), root, pins, intent, wallet, nowHint, maxSlotLag, &route)
}

func readWENBTCSubscriptionRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint, maxSlotLag uint64, route *signerWENBTCRouteV1) (signerWENBTCReadResultV1, error) {
	var out signerWENBTCReadResultV1
	if err := validateWENBTCIntentV1(intent); err != nil {
		return out, err
	}
	min, _ := strconv.ParseUint(intent.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(intent.ExpiresSlot, 10, 64)
	load := loadWENBTCAcceptanceV1
	if route != nil {
		copied := *route
		copied.Data = append([]byte(nil), route.Data...)
		copied.Accounts = append([]signerSATAccountV2(nil), route.Accounts...)
		route = &copied
		load = loadWENBTCAcquisitionV1
	}
	a, err := load(root, pins, intent, wallet, min, nowHint)
	if err != nil {
		return out, err
	}
	build := a.acceptanceInstruction
	if route != nil {
		build = func(now uint64) ([]byte, []signerSATAccountV2, error) {
			return a.acquisitionInstruction(wallet, *route, now)
		}
	}
	_, draft, err := build(nowHint)
	if err != nil {
		return out, err
	}
	addresses := make([]solana.PublicKey, 0, 35)
	roleIndices := make([]int, len(draft))
	index := map[solana.PublicKey]int{}
	for i, k := range draft {
		key := solana.MustPublicKeyFromBase58(k.Pubkey)
		pos, exists := index[key]
		if !exists {
			pos = len(addresses)
			index[key] = pos
			addresses = append(addresses, key)
		}
		roleIndices[i] = pos
	}
	// Same coherent transport budget as the portable reader, before deployment/clock.
	if len(addresses) > 32 {
		return out, errors.New("WEN BTC batch exceeds account budget")
	}
	programIndex := len(addresses)
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pd, _, err := solana.FindProgramAddress([][]byte{a.program[:]}, loader)
	if err != nil {
		return out, err
	}
	addresses = append(addresses, a.program, pd, solana.SysVarClockPubkey)
	seen := map[solana.PublicKey]bool{}
	for _, k := range addresses {
		if seen[k] {
			return out, errors.New("WEN BTC readback account alias")
		}
		seen[k] = true
	}
	genesis, err := client.GetGenesisHash(ctx)
	if err != nil {
		return out, err
	}
	if genesis.String() != pins.Genesis {
		return out, errors.New("WEN BTC RPC genesis mismatch")
	}
	page, err := client.GetMultipleAccountsWithOpts(ctx, addresses, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if err != nil {
		return out, err
	}
	if page == nil || len(page.Value) != len(addresses) || page.Context.Slot < min || page.Context.Slot >= expires {
		return out, errors.New("WEN BTC invalid finalized batch")
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(addresses))
	for i, v := range page.Value {
		if v == nil {
			continue
		}
		if v.Data == nil {
			return out, errors.New("WEN BTC missing binary account data")
		}
		accounts[i] = &signerWENBTCAccountV1{Address: addresses[i], Owner: v.Owner, Slot: slot, Executable: v.Executable, Data: append([]byte(nil), v.Data.GetBinary()...)}
	}
	clock := accounts[programIndex+2]
	sysvar := solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111")
	if clock == nil || clock.Owner != sysvar || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, errors.New("WEN BTC invalid batch clock")
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > uint64(1<<63-1) {
		return out, errors.New("WEN BTC negative chain time")
	}
	data, keys, err := build(now)
	if err != nil {
		return out, err
	}
	if !reflect.DeepEqual(draft, keys) {
		return out, errors.New("WEN BTC epoch changed; refresh readback")
	}
	if err = verifyWENBTCDeploymentV1(pins, slot, accounts[programIndex], accounts[programIndex+1]); err != nil {
		return out, err
	}
	role := func(i int) *signerWENBTCAccountV1 { return accounts[roleIndices[i]] }
	if route == nil {
		if err = a.verifyAcceptanceSourceV1(slot, role(1)); err != nil {
			return out, err
		}
		for _, i := range []int{5, 9, 16} {
			if role(i) != nil {
				return out, errors.New("WEN BTC subscription already accepted")
			}
		}
		if err = a.verifyAdmissionV1(slot, now, role(26)); err != nil {
			return out, err
		}
	} else if err = a.verifyAcquisitionAccountsV1(slot, now, role(1), role(2), role(3), role(4)); err != nil {
		return out, err
	}
	reference, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return out, err
	}
	if reference < slot || reference-slot > maxSlotLag || reference >= expires {
		return out, errors.New("WEN BTC stale finalized batch")
	}
	genesis, err = client.GetGenesisHash(ctx)
	if err != nil {
		return out, err
	}
	if genesis.String() != pins.Genesis {
		return out, errors.New("WEN BTC RPC genesis changed")
	}
	lengths := []uint64{165, 165}
	if route == nil {
		lengths = []uint64{192, 165, 288, 178}
		for _, item := range []struct {
			role int
			size uint64
		}{{10, 144}, {12, 1120}} {
			if account := role(item.role); account == nil || len(account.Data) == 0 {
				lengths = append(lengths, item.size)
			}
		}
	}
	exposure, err := wenBTCExposureV1(a, intent, wallet)
	if err != nil {
		return out, err
	}
	return signerWENBTCReadResultV1{exposure: exposure, Slot: slot, ReferenceSlot: reference, Now: now, Data: data, Accounts: keys, rentLengths: lengths}, nil
}

func (a signerWENBTCArtifactsV1) verifyAdmissionV1(slot, now uint64, account *signerWENBTCAccountV1) error {
	bad := errors.New("WEN BTC admission readback mismatch")
	if account == nil || account.Address != a.admission || account.Owner != a.program || account.Executable || account.Slot != slot || len(account.Data) != 280 {
		return bad
	}
	d := account.Data
	scheduled := binary.LittleEndian.Uint64(d[240:248])
	ready := binary.LittleEndian.Uint64(d[248:256])
	expires := binary.LittleEndian.Uint64(d[256:264])
	if scheduled > ^uint64(0)-172800 || ready != scheduled+172800 || now < ready || now >= expires || a.numbers[14] > expires {
		return bad
	}
	scope := []int{0, 3, 4, 5, 7, 8, 9}
	payload := []byte("wen-btc-sub-admission-scope-v1")
	for _, i := range scope {
		payload = append(payload, a.keys[i][:]...)
	}
	payload = append(payload, d[256:264]...)
	digest := sha256.Sum256(payload)
	address, bump, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-sub-admission-v1"), digest[:]}, a.program)
	if err != nil || address != a.admission {
		return bad
	}
	expected := make([]byte, 280)
	copy(expected, []byte("WENBTCA1"))
	expected[8] = 1
	expected[11] = bump
	for j, i := range scope {
		copy(expected[16+j*32:], a.keys[i][:])
	}
	copy(expected[240:264], d[240:264])
	if !bytes.Equal(expected, d) {
		return bad
	}
	return nil
}
