package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func nativeExecutorFixture(t *testing.T, owners ...solana.PublicKey) (signerWENNativeClaimIntentV1, wenStakingPinsV1, *wenReadRPCFake) {
	wallet := solana.PublicKey{5}
	if len(owners) > 0 {
		wallet = owners[0]
	}
	v, s := nativeStateFixture(t, wallet)
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	code := []byte{9, 8, 7}
	program := make([]byte, 36)
	binary.LittleEndian.PutUint32(program, 2)
	copy(program[4:], pd[:])
	data := make([]byte, 48)
	binary.LittleEndian.PutUint32(data, 3)
	binary.LittleEndian.PutUint64(data[4:], 1)
	copy(data[45:], code)
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock, 150)
	binary.LittleEndian.PutUint64(clock[32:], s.Now)
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, DeploymentSlot: 1, CodeSHA256: wenHashV1(code)}
	ix, _ := buildWENNativeClaimInstructionV1(v, wallet)
	keys := []solana.PublicKey{}
	for _, i := range []int{4, 3, 5, 6, 7} {
		keys = append(keys, ix.Accounts()[i].PublicKey)
	}
	keys = append(keys, p, pd, solana.SysVarClockPubkey)
	for _, i := range []int{10, 8, 9, 11, 1, 2} {
		keys = append(keys, ix.Accounts()[i].PublicKey)
	}
	account := func(owner solana.PublicKey, d []byte, ex bool) *rpc.Account {
		return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(d), Executable: ex}
	}
	values := []*rpc.Account{}
	for _, a := range []*signerWENBTCAccountV1{s.Source, s.Receipt, s.Cohort, s.History} {
		values = append(values, account(a.Owner, a.Data, false))
	}
	values = append(values, nil, account(solana.BPFLoaderUpgradeableProgramID, program, true), account(solana.BPFLoaderUpgradeableProgramID, data, false), account(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false))
	mint, vault, destination := s.Mint, s.Inventory, s.Destination
	token := &signerWENBTCAccountV1{Owner: solana.BPFLoaderUpgradeableProgramID, Executable: true}
	for _, a := range []*signerWENBTCAccountV1{mint, vault, destination, token} {
		values = append(values, account(a.Owner, a.Data, a.Executable))
	}
	bv := btcClaimIntentFixture()
	bv.ProgramID = v.ProgramID
	bv.Sale = v.Sale
	saleAccount, activation := claimActivationFixture(t, bv)
	for _, a := range []*signerWENBTCAccountV1{saleAccount, activation} {
		values = append(values, account(a.Owner, a.Data, false))
	}
	f := wenReadRPCFake{t: t, genesis: solana.Hash{1}, addresses: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: values}, change: "ok"}
	return v, pins, &f
}
